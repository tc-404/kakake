import type { ConnectionConfig, ConnectionMode } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { ActionCaller } from './onebot.types.js';
import { OneBotWsServer } from './onebot-ws.server.js';
import { ForwardWsClient } from './forward-ws.client.js';
import { OneBotHttpServer } from './onebot-http.server.js';
import { OneBotHttpSseServer } from './onebot-http-sse.server.js';
import { OneBotHttpOutboundClient } from './onebot-http-outbound.client.js';
import { QqOfficialWsClient } from './qq-official-ws.client.js';
import type { QqOfficialEndpoint } from './qq-official-ws.client.js';
import {
  QqOfficialHttpsServer,
  qqOfficialHttpsCallbackUrl,
} from './qq-official-https.server.js';
import { WeixinBotClient, type WeixinBotEndpoint } from './weixin-bot.client.js';
import { KookGatewayClient, type KookGatewayEndpoint } from './kook-gateway.client.js';
import {
  credentialsFromQRConfirm,
  fetchWeixinBotQRCode,
  pollWeixinBotQRStatus,
} from './weixin-bot-api.js';
import { WEIXIN_ILINK_BASE_URL } from './weixin-bot.types.js';
import { configService } from '../core/config.service.js';
import {
  connectionModeLabel,
  connectionTypeLabel,
  connectionWsUrl,
  isKookConnection,
  isQqOfficialConnection,
  isReconnectableOnebotMode,
  isWeixinBotConnection,
  kookConnectionReady,
  kookConnectionSummary,
  qqOfficialConnectionSummary,
  weixinBotConnectionSummary,
  weixinBotLoggedIn,
} from '../core/types.js';
import {
  connectionHttpClientEventUrl,
  connectionHttpListenUrl,
  resolveApiBaseUrl,
} from './onebot-http.shared.js';
import { logAction, logQqOfficialAction, logQqOfficialEvent } from '../core/log-store.js';
import {
  formatOb11Action,
  formatOb11ActionResult,
  formatQqOfficialAction,
  formatQqOfficialActionResult,
} from '../core/log-format.js';
// event-bus 是零依赖叶子模块，静态导入不构成循环依赖（plugin.manager 也静态导入它）；
// 之前每次动作都动态 import 的写法纯属浪费（每调用创建一次 Promise）
import { eventBus } from '../event/event-bus.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import { appendQqOfficialAuthHint, fetchQqOfficialBotProfile } from './qq-official-api.js';
import {
  fetchAndStoreAvatarFromUrl,
  getConnectionAvatarMeta,
} from './connection-avatar.store.js';
import { clearImplCache } from '../proxy/resolve/impl-detect.js';

type ManagedEndpoint = OneBotEndpoint | QqOfficialEndpoint | WeixinBotEndpoint | KookGatewayEndpoint;

/**
 * 连接管理器 — OneBot / QQ 官方 / 微信 BOT / KOOK
 */
export class ConnectionManager {
  private endpoints = new Map<string, ManagedEndpoint>();

  /**
   * ActionCaller 记忆化：消息热路径上每条消息 × 每个插件实例都会取一次 caller，
   * 闭包只捕获 adapterName / connectionId，endpoint 是每次调用时实时解析的，
   * 因此同一 (adapterName, connectionId) 的 caller 可以安全复用。
   */
  private readonly actionCallerCache = new Map<string, ActionCaller>();

  constructor(private readonly logger: Logger) {}

  getEndpoint(id: string): ManagedEndpoint | undefined {
    return this.endpoints.get(id);
  }

  getOnebotEndpoint(id: string): OneBotEndpoint | undefined {
    const ep = this.endpoints.get(id);
    if (
      ep instanceof QqOfficialWsClient
      || ep instanceof QqOfficialHttpsServer
      || ep instanceof WeixinBotClient
      || ep instanceof KookGatewayClient
    ) {
      return undefined;
    }
    return ep as OneBotEndpoint | undefined;
  }

  getQqOfficialClient(id: string): QqOfficialEndpoint | undefined {
    const ep = this.endpoints.get(id);
    if (ep instanceof QqOfficialWsClient || ep instanceof QqOfficialHttpsServer) return ep;
    return undefined;
  }

  getWeixinBotClient(id: string): WeixinBotClient | undefined {
    const ep = this.endpoints.get(id);
    return ep instanceof WeixinBotClient ? ep : undefined;
  }

  getKookClient(id: string): KookGatewayClient | undefined {
    const ep = this.endpoints.get(id);
    return ep instanceof KookGatewayClient ? ep : undefined;
  }

  getForwardClient(id: string): ForwardWsClient | undefined {
    const ep = this.endpoints.get(id);
    return ep instanceof ForwardWsClient ? ep : undefined;
  }

  getHttpOutboundClient(id: string): OneBotHttpOutboundClient | undefined {
    const ep = this.endpoints.get(id);
    return ep instanceof OneBotHttpOutboundClient ? ep : undefined;
  }

  getActiveEndpoint(): OneBotEndpoint | undefined {
    for (const ep of this.endpoints.values()) {
      if (
        ep instanceof QqOfficialWsClient
        || ep instanceof QqOfficialHttpsServer
        || ep instanceof WeixinBotClient
        || ep instanceof KookGatewayClient
      ) {
        continue;
      }
      if (ep.isConnected) return ep as OneBotEndpoint;
    }
    return undefined;
  }

  dropTokenlessInbound(): void {
    for (const endpoint of this.endpoints.values()) {
      if (endpoint instanceof OneBotWsServer) {
        endpoint.dropTokenlessClient();
      } else if (endpoint instanceof OneBotHttpSseServer) {
        endpoint.dropTokenlessSseClients();
      }
    }
  }

  createActionCaller(adapterName = 'plugin_manager', connectionId?: string): ActionCaller {
    const cacheKey = `${adapterName}|${connectionId ?? ''}`;
    const cached = this.actionCallerCache.get(cacheKey);
    if (cached) return cached;
    const caller: ActionCaller = async (action, params, adapter?, _config?) => {
      const endpoint = connectionId
        ? this.getOnebotEndpoint(connectionId)
        : this.getActiveEndpoint();
      if (!endpoint?.isConnected) {
        const connHint = connectionId ? `连接 ${connectionId}` : 'OneBot';
        throw new Error(`[${adapterName}] ${connHint} 未连接，请检查连接管理中的 OneBot 配置`);
      }

      const tag = adapter || adapterName;
      const prefix = `[输出:${tag}]`;
      const outbound = formatOb11Action(action, params as Record<string, unknown> | undefined);
      logAction(prefix, outbound.message, outbound.detail);
      const emitActionResult = (ok: boolean, result?: unknown, error?: string): void => {
        eventBus.emit('onebot/action_result', {
          time: Date.now(),
          connectionId,
          adapter: tag,
          action,
          params: params ?? {},
          ok,
          result: result ?? null,
          error: error ?? null,
        });
      };

      try {
        const result = await endpoint.callAction(action, params as Record<string, unknown> | undefined);
        const ok = formatOb11ActionResult(action, result);
        logAction(prefix, ok.message, ok.detail, 'debug');
        emitActionResult(true, result);
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const fail = formatOb11ActionResult(action, null, msg);
        logAction(prefix, fail.message, fail.detail, 'error');
        emitActionResult(false, null, msg);
        throw error;
      }
    };
    if (this.actionCallerCache.size >= 500) {
      // 简单淘汰：丢掉最早入缓存的 100 条，防键空间无限膨胀
      let dropped = 0;
      for (const key of this.actionCallerCache.keys()) {
        this.actionCallerCache.delete(key);
        if (++dropped >= 100) break;
      }
    }
    this.actionCallerCache.set(cacheKey, caller);
    return caller;
  }

  createQqOfficialActionCaller(adapterName = 'gf_plugin_manager', connectionId?: string): ActionCaller {
    return async (action, params, adapter?) => {
      let client: QqOfficialEndpoint | undefined;
      if (connectionId) {
        client = this.getQqOfficialClient(connectionId);
      } else {
        for (const ep of this.endpoints.values()) {
          if (
            (ep instanceof QqOfficialWsClient || ep instanceof QqOfficialHttpsServer)
            && ep.isConnected
          ) {
            client = ep;
            break;
          }
        }
      }
      if (!client?.isConnected) {
        throw new Error(`[${adapter || adapterName}] QQ 官方连接未就绪`);
      }
      const tag = adapter || adapterName;
      const prefix = `[官方输出:${tag}]`;
      // 带上 appId 才能把路径里的群 openid 换成群名（官方 openid 按机器人隔离）
      const ctx = { appId: client.appId, method: String((params as Record<string, unknown>)?.__method ?? '') };
      logQqOfficialAction(
        prefix,
        formatQqOfficialAction(action, params as Record<string, unknown> | undefined, ctx),
        JSON.stringify(params ?? {}),
      );
      const emitActionResult = (ok: boolean, result?: unknown, error?: string): void => {
        eventBus.emit('qq_official/action_result', {
          time: Date.now(),
          connectionId,
          adapter: tag,
          action,
          params: params ?? {},
          ok,
          result: result ?? null,
          error: error ?? null,
        });
      };
      try {
        const result = await client.callAction(action, params as Record<string, unknown> | undefined);
        logQqOfficialAction(
          prefix,
          formatQqOfficialActionResult(action, result, undefined, ctx),
          JSON.stringify(result),
          'debug',
        );
        emitActionResult(true, result);
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logQqOfficialAction(
          prefix,
          formatQqOfficialActionResult(action, undefined, msg, ctx),
          undefined,
          'error',
        );
        emitActionResult(false, null, msg);
        throw error;
      }
    };
  }

  createWeixinBotActionCaller(adapterName = 'wx_plugin_manager', connectionId?: string): ActionCaller {
    return async (action, params, adapter?) => {
      let client: WeixinBotClient | undefined;
      if (connectionId) {
        client = this.getWeixinBotClient(connectionId);
      } else {
        for (const ep of this.endpoints.values()) {
          if (ep instanceof WeixinBotClient && ep.isConnected) {
            client = ep;
            break;
          }
        }
      }
      if (!client?.isConnected) {
        throw new Error(`[${adapter || adapterName}] 微信 BOT 连接未就绪`);
      }
      const tag = adapter || adapterName;
      const prefix = `[微信输出:${tag}]`;
      logAction(prefix, action, JSON.stringify(params ?? {}));
      const emitActionResult = (ok: boolean, result?: unknown, error?: string): void => {
        eventBus.emit('weixin_bot/action_result', {
          time: Date.now(),
          connectionId,
          adapter: tag,
          action,
          params: params ?? {},
          ok,
          result: result ?? null,
          error: error ?? null,
        });
      };
      try {
        const result = await client.callAction(action, params as Record<string, unknown> | undefined);
        logAction(prefix, `${action} ✓`, JSON.stringify(result), 'debug');
        emitActionResult(true, result);
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logAction(prefix, `${action} ✗ ${msg}`, undefined, 'error');
        emitActionResult(false, null, msg);
        throw error;
      }
    };
  }

  createKookBotActionCaller(adapterName = 'ss_plugin_manager', connectionId?: string): ActionCaller {
    return async (action, params, adapter?) => {
      let client: KookGatewayClient | undefined;
      if (connectionId) {
        client = this.getKookClient(connectionId);
      } else {
        for (const ep of this.endpoints.values()) {
          if (ep instanceof KookGatewayClient && ep.isConnected) {
            client = ep;
            break;
          }
        }
      }
      if (!client?.isConnected) {
        throw new Error(`[${adapter || adapterName}] KOOK 连接未就绪`);
      }
      const tag = adapter || adapterName;
      const prefix = `[KOOK输出:${tag}]`;
      logAction(prefix, action, JSON.stringify(params ?? {}));
      const emitActionResult = (ok: boolean, result?: unknown, error?: string): void => {
        eventBus.emit('kook/action_result', {
          time: Date.now(),
          connectionId,
          adapter: tag,
          action,
          params: params ?? {},
          ok,
          result: result ?? null,
          error: error ?? null,
        });
      };
      try {
        const result = await client.callAction(action, params as Record<string, unknown> | undefined);
        logAction(prefix, `${action} ✓`, JSON.stringify(result), 'debug');
        emitActionResult(true, result);
        return result;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        logAction(prefix, `${action} ✗ ${msg}`, undefined, 'error');
        emitActionResult(false, null, msg);
        throw error;
      }
    };
  }

  reload(): void {
    this.stopAll();
    for (const conn of configService.getConnections().connections) {
      if (conn.enable) this.start(conn);
    }
  }

  private emitStatus(): void {
    eventBus.emit('connection/status', {
      connections: this.getStatusList(),
    });
  }

  /** 供头像缓存等外部模块通知状态变更 */
  notifyStatus(): void {
    this.emitStatus();
  }

  private bindLifecycle(connectionId: string, hooks: {
    onReady?: () => void;
    onDisconnect?: () => void;
  }): { onReady: () => void; onDisconnect: () => void } {
    return {
      onReady: () => {
        eventBus.emit('connection/ready', { connectionId });
        this.emitStatus();
        hooks.onReady?.();
      },
      onDisconnect: () => {
        eventBus.emit('connection/disconnect', { connectionId });
        this.emitStatus();
        hooks.onDisconnect?.();
      },
    };
  }

  start(connection: ConnectionConfig): ManagedEndpoint {
    this.stop(connection.id);

    // 连接启用时尽量预建 plugins_two 账号目录
    void import('../plugin/plugin-account.service.js').then(({ pluginAccountService }) => {
      if (isQqOfficialConnection(connection)) {
        pluginAccountService.ensureOfficialAccount(connection.id);
      } else if (isWeixinBotConnection(connection)) {
        pluginAccountService.ensureWeixinAccount(connection.id);
      } else if (isKookConnection(connection)) {
        pluginAccountService.ensureKookAccount(connection.id);
      } else if (connection.botUin) {
        pluginAccountService.ensureAccountRuntimeRoot(connection.botUin);
      }
    });

    if (isKookConnection(connection)) {
      const life = this.bindLifecycle(connection.id, {});
      const client = new KookGatewayClient(connection, {
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
        onProfileUpdated: () => {
          this.persistKookBotProfile(connection.id);
          this.emitStatus();
        },
      });
      if (!kookConnectionReady(connection)) {
        this.logger.warn(`[${connection.name}] KOOK 未配置 Token，启用后无法连接`);
      }
      client.start();
      this.endpoints.set(connection.id, client);
      return client;
    }

    if (isWeixinBotConnection(connection)) {
      const life = this.bindLifecycle(connection.id, {});
      const client = new WeixinBotClient(connection, {
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
      });
      if (!weixinBotLoggedIn(connection)) {
        this.logger.warn(`[${connection.name}] 微信 BOT 未扫码登录，启用后请先完成扫码`);
      }
      client.start();
      this.endpoints.set(connection.id, client);
      return client;
    }

    if (isQqOfficialConnection(connection)) {
      const life = this.bindLifecycle(connection.id, {});
      if (connection.mode === 'https') {
        const server = new QqOfficialHttpsServer({
          connection,
          onReady: life.onReady,
          onDisconnect: life.onDisconnect,
          onProfileUpdated: () => {
            this.persistQqOfficialBotProfile(connection.id);
            this.emitStatus();
          },
          onWebhookVerified: () => this.emitStatus(),
        });
        server.start();
        this.endpoints.set(connection.id, server);
        return server;
      }
      const client = new QqOfficialWsClient({
        connection,
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
        onProfileUpdated: () => {
          this.persistQqOfficialBotProfile(connection.id);
          this.emitStatus();
        },
      });
      client.start();
      this.endpoints.set(connection.id, client);
      return client;
    }

    const mode = connection.mode ?? 'reverse';
    const life = this.bindLifecycle(connection.id, {});
    let endpoint: OneBotEndpoint;

    if (mode === 'forward') {
      const client = new ForwardWsClient({
        connection,
        logger: this.logger.child(`[${connection.name}] `),
        autoReconnect: true,
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
        onReconnectAbandoned: () => this.emitStatus(),
        onReconnectStatusChange: () => this.emitStatus(),
      });
      client.start();
      endpoint = client;
    } else if (mode === 'http') {
      const server = new OneBotHttpServer({
        connection,
        logger: this.logger.child(`[${connection.name}] `),
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
      });
      server.start();
      endpoint = server;
    } else if (mode === 'http_sse') {
      const server = new OneBotHttpSseServer({
        connection,
        logger: this.logger.child(`[${connection.name}] `),
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
      });
      server.start();
      endpoint = server;
    } else if (mode === 'http_client') {
      const client = new OneBotHttpOutboundClient({
        connection,
        logger: this.logger.child(`[${connection.name}] `),
        onReady: life.onReady,
        onDisconnect: life.onDisconnect,
        onReconnectAbandoned: () => this.emitStatus(),
        onReconnectStatusChange: () => this.emitStatus(),
      });
      client.start();
      endpoint = client;
    } else {
      const server = new OneBotWsServer({
        connection,
        logger: this.logger.child(`[${connection.name}] `),
        onClientConnect: life.onReady,
        onClientDisconnect: life.onDisconnect,
      });
      server.start();
      endpoint = server;
    }

    this.endpoints.set(connection.id, endpoint);
    return endpoint;
  }

  stop(id: string): void {
    const endpoint = this.endpoints.get(id);
    if (endpoint) {
      endpoint.stop();
      this.endpoints.delete(id);
    }
  }

  stopAll(): void {
    for (const endpoint of this.endpoints.values()) {
      endpoint.stop();
    }
    this.endpoints.clear();
    this.actionCallerCache.clear();
  }

  reconnect(id: string): void {
    const data = configService.getConnections();
    const conn = data.connections.find((c) => c.id === id);
    if (!conn?.enable) return;

    const qq = this.getQqOfficialClient(id);
    if (qq) {
      qq.stop();
      this.endpoints.delete(id);
      this.start(conn);
      return;
    }

    const wx = this.getWeixinBotClient(id);
    if (wx) {
      wx.stop();
      this.endpoints.delete(id);
      this.start(conn);
      return;
    }

    const kook = this.getKookClient(id);
    if (kook) {
      kook.stop();
      this.endpoints.delete(id);
      this.start(conn);
      return;
    }

    const forward = this.getForwardClient(id);
    if (forward) {
      forward.resetAndReconnect();
      return;
    }

    const httpOut = this.getHttpOutboundClient(id);
    if (httpOut) {
      httpOut.resetAndReconnect();
      return;
    }

    this.stop(id);
    this.start(conn);
  }

  applyForwardReconnectSettings(
    id: string,
    patch: Partial<Pick<ConnectionConfig, 'reconnectIntervalMs' | 'reconnectMaxAttempts'>>,
  ): void {
    // 原子读改写：避免与其他模块的并发配置写入互相覆盖
    const applied = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === id);
      if (!conn) return null;
      if (patch.reconnectIntervalMs !== undefined) {
        conn.reconnectIntervalMs = patch.reconnectIntervalMs;
      }
      if (patch.reconnectMaxAttempts !== undefined) {
        conn.reconnectMaxAttempts = patch.reconnectMaxAttempts;
      }
      return { reconnectIntervalMs: conn.reconnectIntervalMs, reconnectMaxAttempts: conn.reconnectMaxAttempts };
    });
    if (!applied) return;

    const clientPatch: Partial<ConnectionConfig> = {};
    if (patch.reconnectIntervalMs !== undefined) {
      clientPatch.reconnectIntervalMs = applied.reconnectIntervalMs;
    }
    if (patch.reconnectMaxAttempts !== undefined) {
      clientPatch.reconnectMaxAttempts = applied.reconnectMaxAttempts;
    }
    if (Object.keys(clientPatch).length === 0) return;

    const forward = this.getForwardClient(id);
    if (forward) {
      forward.applyConnectionPatch(clientPatch);
      return;
    }
    const httpOut = this.getHttpOutboundClient(id);
    if (httpOut) {
      httpOut.applyConnectionPatch(clientPatch);
    }
  }

  async updateQqOfficialConnection(
    id: string,
    patch: Partial<Pick<ConnectionConfig, 'name' | 'appId' | 'appSecret' | 'sandbox' | 'intents' | 'reconnectIntervalMs' | 'reconnectMaxAttempts' | 'webhookBaseUrl' | 'mode'>>,
  ): Promise<ConnectionConfig | undefined> {
    // 原子读改写：配置变更落盘在单 tick 内完成，await（profile 拉取/重连）都放在写盘之后
    const applied = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === id);
      if (!conn || !isQqOfficialConnection(conn)) return null;
      const wasEnabled = !!conn.enable;
      if (patch.name !== undefined) conn.name = patch.name.trim() || conn.name;
      if (patch.appId !== undefined) conn.appId = patch.appId.trim();
      if (patch.appSecret !== undefined) conn.appSecret = patch.appSecret.trim();
      if (patch.sandbox !== undefined) conn.sandbox = patch.sandbox;
      if (patch.intents !== undefined) conn.intents = patch.intents;
      if (patch.reconnectIntervalMs !== undefined) conn.reconnectIntervalMs = patch.reconnectIntervalMs;
      if (patch.reconnectMaxAttempts !== undefined) conn.reconnectMaxAttempts = patch.reconnectMaxAttempts;
      if (patch.webhookBaseUrl !== undefined) {
        const base = String(patch.webhookBaseUrl).trim().replace(/\/+$/, '');
        conn.webhookBaseUrl = base || undefined;
      }
      if (patch.mode === 'https' || patch.mode === undefined) {
        // mode 切换仅允许 https / 默认 WS；其它值忽略
        if (patch.mode === 'https') conn.mode = 'https';
      }
      const credsChanged = patch.appId !== undefined || patch.appSecret !== undefined;
      return { wasEnabled, credsChanged, appId: conn.appId, appSecret: conn.appSecret };
    });
    if (!applied) return undefined;
    if (applied.credsChanged && applied.appId && applied.appSecret) {
      await this.refreshQqOfficialBotProfile(id);
    }
    if (applied.wasEnabled) {
      this.reconnect(id);
    }
    return configService.getConnection(id);
  }

  private persistQqOfficialBotProfile(connectionId: string): void {
    const client = this.getQqOfficialClient(connectionId);
    const profile = client?.getBotProfile();
    if (!profile) return;
    // 原子读改写：profile 是同步取到的，落盘不再依赖共享缓存引用
    const appId = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === connectionId);
      if (!conn || !isQqOfficialConnection(conn)) return null;
      conn.botProfile = profile;
      // 刻意不回写 conn.name：用户起的名字不该被机器人昵称覆盖（展示名由 getStatusList 兜底）
      return conn.appId ?? '';
    });
    if (appId === null) return;
    void this.cacheQqOfficialAvatar(connectionId, profile.avatar, appId || profile.id);
  }

  /** 将 QQ 官方头像 URL 下载为本地 base64 缓存 */
  private async cacheQqOfficialAvatar(
    connectionId: string,
    avatarUrl: string | undefined,
    accountKey: string | undefined,
  ): Promise<void> {
    const url = String(avatarUrl || '').trim();
    const key = String(accountKey || '').trim();
    if (!url || !key) return;
    const wrote = await fetchAndStoreAvatarFromUrl(connectionId, url, key);
    if (wrote) this.emitStatus();
  }

  private persistKookBotProfile(connectionId: string): void {
    const client = this.getKookClient(connectionId);
    const user = client?.getBotUser();
    if (!user) return;
    // 原子读改写：变更判定与落盘在同一 tick 内完成
    const changed = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === connectionId);
      if (!conn || !isKookConnection(conn)) return false;
      const dirty = !(
        conn.kookBotUserId === user.id
        && conn.kookBotUsername === user.username
        && conn.kookBotIdentifyNum === (user.identify_num || undefined)
        && conn.kookBotAvatar === (user.avatar || undefined)
      );
      if (!dirty) return false;
      conn.kookBotUserId = user.id;
      conn.kookBotUsername = user.username;
      conn.kookBotIdentifyNum = user.identify_num || undefined;
      conn.kookBotAvatar = user.avatar || undefined;
      return true;
    });
    if (changed) {
      void import('../plugin/plugin-account.service.js').then(({ pluginAccountService }) => {
        pluginAccountService.ensureKookAccount(connectionId);
      }).catch(() => {});
    }
    // 缓存命中时是廉价 no-op；上次下载失败或换号后会重试/覆盖
    void this.cacheKookAvatar(connectionId, user.avatar, user.id);
  }

  /** 将 KOOK 头像 URL 下载为本地 base64 缓存 */
  private async cacheKookAvatar(
    connectionId: string,
    avatarUrl: string | undefined,
    accountKey: string | undefined,
  ): Promise<void> {
    const url = String(avatarUrl || '').trim();
    const key = String(accountKey || '').trim();
    if (!url || !key) return;
    const wrote = await fetchAndStoreAvatarFromUrl(connectionId, url, key);
    if (wrote) this.emitStatus();
  }

  async refreshQqOfficialBotProfile(connectionId: string) {
    // 只读快照用于取凭证与发起网络请求；await 期间其他模块的配置变更不受影响，
    // 拿到 profile 后再走原子读改写落盘——消除「await 中间持有过期快照覆盖他人写入」的竞态
    const snapshot = configService.getConnection(connectionId);
    if (!snapshot || !isQqOfficialConnection(snapshot) || !snapshot.appId || !snapshot.appSecret) {
      return null;
    }
    const client = this.getQqOfficialClient(connectionId);
    try {
      const profile = client
        ? await client.refreshBotProfile()
        : await fetchQqOfficialBotProfile(snapshot.appId, snapshot.appSecret, snapshot.sandbox);
      if (profile) {
        const appId = configService.mutateConnections((data) => {
          const conn = data.connections.find((c) => c.id === connectionId);
          if (!conn || !isQqOfficialConnection(conn)) return null;
          conn.botProfile = profile;
          return conn.appId ?? '';
        });
        if (appId === null) return profile;
        await this.cacheQqOfficialAvatar(connectionId, profile.avatar, appId || profile.id);
      }
      return profile;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, snapshot.sandbox);
      logQqOfficialEvent(`[官方:${snapshot.name}]`, '[QQ官方] 刷新机器人资料失败', {
        level: 'warn',
        detail: msg,
      });
      return null;
    }
  }

  private onebotListenUrl(c: ConnectionConfig): string {
    const mode = c.mode ?? 'reverse';
    if (mode === 'http' || mode === 'http_sse') return connectionHttpListenUrl(c);
    if (mode === 'http_client') return connectionHttpClientEventUrl(c.id);
    return connectionWsUrl(c);
  }

  getStatusList(): Array<{
    id: string;
    name: string;
    type: 'onebot' | 'qq_official' | 'weixin_bot' | 'kook';
    typeLabel: string;
    mode: ConnectionMode;
    modeLabel: string;
    host: string;
    port: number;
    listenUrl: string;
    apiUrl?: string;
    enable: boolean;
    connected: boolean;
    botUin?: string;
    accountKey?: string;
    appId?: string;
    sandbox?: boolean;
    /** QQ 官方：显式配置的 Intents（0/undefined = 内置默认） */
    intents?: number;
    /** QQ 官方 HTTPS：回调地址是否已被平台验证通过 */
    webhookVerified?: boolean;
    qqSummary?: string;
    weixinSummary?: string;
    weixinLoggedIn?: boolean;
    weixinAccountId?: string;
    kookSummary?: string;
    kookReady?: boolean;
    kookBotUserId?: string;
    reconnectIntervalMs?: number;
    reconnectMaxAttempts?: number;
    reconnectAttempts?: number;
    reconnecting?: boolean;
    reconnectAbandoned?: boolean;
    webhookBaseUrl?: string;
    botProfile?: {
      id: string;
      username: string;
      avatar: string;
      unionOpenid?: string;
      desc?: string;
      shareUrl?: string;
      fetchedAt: number;
    };
    hasAvatar?: boolean;
    avatarUpdatedAt?: string;
    createdAt?: number;
  }> {
    const list = configService.getConnections().connections.map((c) => {
      const endpoint = this.endpoints.get(c.id);
      const type = c.type ?? 'onebot';
      const avatarMeta = getConnectionAvatarMeta(c.id);
      const createdAt = c.createdAt;

      if (isKookConnection(c)) {
        const kook = endpoint instanceof KookGatewayClient ? endpoint : undefined;
        const ready = kookConnectionReady(c);
        const rs = kook?.getReconnectStatus();
        return {
          id: c.id,
          name: c.kookBotUsername || c.name,
          type: 'kook' as const,
          typeLabel: connectionTypeLabel('kook'),
          mode: 'forward' as const,
          modeLabel: 'KOOK 网关',
          host: '',
          port: 0,
          listenUrl: 'www.kookapp.cn/api/v3',
          enable: c.enable,
          connected: kook?.isConnected ?? false,
          kookSummary: kookConnectionSummary(c),
          kookReady: ready,
          kookBotUserId: c.kookBotUserId,
          accountKey: c.kookBotUserId,
          reconnectIntervalMs: rs?.intervalMs ?? c.reconnectIntervalMs ?? 5000,
          reconnectMaxAttempts: rs?.maxAttempts ?? c.reconnectMaxAttempts ?? 15,
          reconnectAttempts: rs?.attempts ?? 0,
          reconnecting: rs?.reconnecting ?? false,
          reconnectAbandoned: rs?.abandoned ?? false,
          hasAvatar: avatarMeta.hasAvatar,
          avatarUpdatedAt: avatarMeta.avatarUpdatedAt,
          createdAt,
        };
      }

      if (isWeixinBotConnection(c)) {
        const wx = endpoint instanceof WeixinBotClient ? endpoint : undefined;
        const loggedIn = weixinBotLoggedIn(c);
        return {
          id: c.id,
          name: c.name,
          type: 'weixin_bot' as const,
          typeLabel: connectionTypeLabel('weixin_bot'),
          mode: 'forward' as const,
          modeLabel: 'iLink 长轮询',
          host: '',
          port: 0,
          listenUrl: c.weixinBaseUrl || WEIXIN_ILINK_BASE_URL,
          enable: c.enable,
          connected: wx?.isConnected ?? false,
          weixinSummary: weixinBotConnectionSummary(c),
          weixinLoggedIn: loggedIn,
          weixinAccountId: c.weixinAccountId,
          accountKey: c.weixinAccountId,
          hasAvatar: false,
          createdAt,
        };
      }

      if (isQqOfficialConnection(c)) {
        // 用接口类型接收：重连状态仅 WS 有、回调验证状态仅 HTTPS 有（都是可选方法）
        const qq = (endpoint instanceof QqOfficialWsClient || endpoint instanceof QqOfficialHttpsServer)
          ? endpoint as QqOfficialEndpoint
          : undefined;
        const profile = qq?.getBotProfile() ?? c.botProfile;
        const displayName = profile?.username || c.name;
        const isHttps = c.mode === 'https';
        const rs = qq?.getReconnectStatus?.();
        return {
          id: c.id,
          name: displayName,
          type: 'qq_official' as const,
          typeLabel: connectionTypeLabel('qq_official'),
          mode: isHttps ? 'https' as const : 'forward' as const,
          modeLabel: isHttps ? '官方 HTTPS' : '官方 WS',
          host: '',
          port: 0,
          listenUrl: isHttps
            ? qqOfficialHttpsCallbackUrl(c.id, c.webhookBaseUrl)
            : (c.sandbox ? 'sandbox.api.sgroup.qq.com' : 'api.sgroup.qq.com'),
          enable: c.enable,
          connected: qq?.isConnected ?? false,
          appId: c.appId,
          sandbox: c.sandbox ?? true,
          intents: c.intents,
          webhookVerified: isHttps ? (qq?.getWebhookVerified?.() ?? false) : undefined,
          qqSummary: qqOfficialConnectionSummary(c),
          botProfile: profile ?? undefined,
          accountKey: c.appId,
          webhookBaseUrl: c.webhookBaseUrl,
          reconnectIntervalMs: rs?.intervalMs ?? c.reconnectIntervalMs ?? 5000,
          reconnectMaxAttempts: rs?.maxAttempts ?? c.reconnectMaxAttempts ?? 15,
          reconnectAttempts: rs?.attempts ?? 0,
          reconnecting: rs?.reconnecting ?? false,
          reconnectAbandoned: rs?.abandoned ?? false,
          hasAvatar: avatarMeta.hasAvatar,
          avatarUpdatedAt: avatarMeta.avatarUpdatedAt,
          createdAt,
        };
      }

      const mode = c.mode ?? 'reverse';
      const base = {
        id: c.id,
        name: c.name,
        type: 'onebot' as const,
        typeLabel: connectionTypeLabel('onebot'),
        mode,
        modeLabel: connectionModeLabel(mode),
        host: c.host || '127.0.0.1',
        port: c.port,
        listenUrl: this.onebotListenUrl(c),
        apiUrl: mode === 'http' || mode === 'http_sse' || mode === 'http_client'
          ? resolveApiBaseUrl(c)
          : undefined,
        // 接口代理：协议端实现名（auto = 连上后探测）
        onebotImpl: c.onebotImpl ?? 'auto',
        hasAccessToken: !!(c.accessToken && String(c.accessToken).length > 0),
        enable: c.enable,
        connected: endpoint?.isConnected ?? false,
        botUin: c.botUin,
        accountKey: c.botUin,
        hasAvatar: avatarMeta.hasAvatar,
        avatarUpdatedAt: avatarMeta.avatarUpdatedAt,
        createdAt,
      };

      if (!isReconnectableOnebotMode(mode)) return base;

      const forward = endpoint instanceof ForwardWsClient ? endpoint : undefined;
      const httpOut = endpoint instanceof OneBotHttpOutboundClient ? endpoint : undefined;
      const rs = forward?.getReconnectStatus() ?? httpOut?.getReconnectStatus();
      return {
        ...base,
        reconnectIntervalMs: rs?.intervalMs ?? c.reconnectIntervalMs ?? 5000,
        reconnectMaxAttempts: rs?.maxAttempts ?? c.reconnectMaxAttempts ?? 15,
        reconnectAttempts: rs?.attempts ?? 0,
        reconnecting: rs?.reconnecting ?? false,
        reconnectAbandoned: rs?.abandoned ?? false,
      };
    });

    // 在线 > 连接中 > 异常 > 关闭；同级按首次添加时间升序
    const rank = (item: (typeof list)[number]): number => {
      if (!item.enable) return 3;
      if (item.connected) return 0;
      if ('reconnectAbandoned' in item && item.reconnectAbandoned) return 2;
      return 1;
    };
    return list.slice().sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    });
  }

  /** 获取微信扫码登录二维码（qrcode_img_content 是登录 URL，需本地生成二维码图） */
  async startWeixinQrLogin(connectionId: string) {
    const conn = configService.getConnection(connectionId);
    if (!conn || !isWeixinBotConnection(conn)) {
      throw new Error('连接不存在或不是微信 BOT');
    }
    const qr = await fetchWeixinBotQRCode();
    const loginUrl = String(qr.qrcode_img_content || '').trim();
    if (!loginUrl) {
      throw new Error('未返回登录链接');
    }
    const QRCode = (await import('qrcode')).default;
    const qrImageDataUrl = await QRCode.toDataURL(loginUrl, {
      width: 280,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#111111', light: '#ffffff' },
    });
    return {
      qrcode: qr.qrcode,
      loginUrl,
      qrcodeImgContent: loginUrl,
      qrImageDataUrl,
    };
  }

  /** 轮询微信扫码状态；confirmed 时写入凭证并可选重启连接 */
  async pollWeixinQrLogin(connectionId: string, qrcode: string) {
    const data = configService.getConnections();
    const conn = data.connections.find((c) => c.id === connectionId);
    if (!conn || !isWeixinBotConnection(conn)) {
      throw new Error('连接不存在或不是微信 BOT');
    }
    const status = await pollWeixinBotQRStatus(qrcode);
    if (status.status !== 'confirmed') {
      return { status: status.status };
    }
    const creds = credentialsFromQRConfirm(status);
    // 原子读改写：扫码确认发生在 await 之后，此时磁盘上的连接可能已被用户改过
    // （改名/开关），必须基于最新状态写凭证，否则会回滚用户的并发修改。
    const confirmed = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === connectionId);
      if (!conn || !isWeixinBotConnection(conn)) return null;
      conn.weixinToken = creds.token;
      conn.weixinBaseUrl = creds.baseUrl;
      conn.weixinAccountId = creds.accountId;
      conn.weixinUserId = creds.userId;
      conn.weixinGetUpdatesBuf = '';
      if (
        !conn.name
        || conn.name === '微信BOT'
        || conn.name === '微信 AI×BOT'
        || conn.name === '未命名连接'
      ) {
        conn.name = `微信 AI×BOT · ${creds.accountId.slice(0, 8)}`;
      }
      return { enable: !!conn.enable, conn };
    });
    if (!confirmed) {
      throw new Error('连接不存在或不是微信 BOT');
    }

    void import('../plugin/plugin-account.service.js').then(({ pluginAccountService }) => {
      pluginAccountService.ensureWeixinAccount(connectionId);
    });

    if (confirmed.enable) {
      this.stop(connectionId);
      this.start(confirmed.conn);
    }

    return {
      status: 'confirmed' as const,
      accountId: creds.accountId,
      userId: creds.userId,
      connections: this.getStatusList(),
    };
  }

  /** 清除微信登录凭证并停止连接 */
  clearWeixinCredentials(connectionId: string): void {
    const existing = configService.getConnection(connectionId);
    if (!existing || !isWeixinBotConnection(existing)) return;
    this.stop(connectionId);
    // 原子读改写：凭证清空与「停用连接」一并落盘，不依赖共享缓存引用
    configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === connectionId);
      if (!conn || !isWeixinBotConnection(conn)) return false;
      conn.weixinToken = undefined;
      conn.weixinBaseUrl = undefined;
      conn.weixinAccountId = undefined;
      conn.weixinUserId = undefined;
      conn.weixinGetUpdatesBuf = undefined;
      if (conn.enable) {
        conn.enable = false;
      }
      return true;
    });
  }

  async updateWeixinBotConnection(
    id: string,
    patch: Partial<Pick<ConnectionConfig, 'name'>>,
  ): Promise<ConnectionConfig | undefined> {
    return configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === id);
      if (!conn || !isWeixinBotConnection(conn)) return undefined;
      if (patch.name !== undefined) conn.name = patch.name.trim() || conn.name;
      return conn;
    });
  }

  async updateKookConnection(
    id: string,
    patch: Partial<Pick<ConnectionConfig, 'name' | 'kookToken' | 'reconnectIntervalMs' | 'reconnectMaxAttempts'>>,
  ): Promise<ConnectionConfig | undefined> {
    // 原子读改写：Token 轮换（清 session 绑定字段）与改名在单 tick 内落盘
    const applied = configService.mutateConnections((data) => {
      const conn = data.connections.find((c) => c.id === id);
      if (!conn || !isKookConnection(conn)) return null;
      const wasEnabled = !!conn.enable;
      if (patch.name !== undefined) conn.name = patch.name.trim() || conn.name;
      if (patch.kookToken !== undefined) {
        conn.kookToken = String(patch.kookToken).trim();
        // Token 变了必须重建会话（session/resume 与旧 Token 绑定）
        conn.kookBotUserId = undefined;
        conn.kookBotUsername = undefined;
        conn.kookBotIdentifyNum = undefined;
        conn.kookBotAvatar = undefined;
      }
      if (patch.reconnectIntervalMs !== undefined) {
        conn.reconnectIntervalMs = Math.max(500, Math.floor(Number(patch.reconnectIntervalMs) || 5000));
      }
      if (patch.reconnectMaxAttempts !== undefined) {
        conn.reconnectMaxAttempts = Math.max(0, Math.floor(Number(patch.reconnectMaxAttempts) || 0));
      }
      return { wasEnabled };
    });
    if (!applied) return undefined;
    if (applied.wasEnabled) {
      this.reconnect(id);
    }
    return configService.getConnection(id);
  }

  /** OneBot：运行中也可改配置；保存后若启用则重连使配置生效 */
  updateOnebotConnectionProfile(
    id: string,
    patch: {
      name?: string;
      host?: string;
      port?: number;
      accessToken?: string;
      apiUrl?: string;
      /** 接口代理用：显式指定 OneBot 协议端实现（NapCat / SnowLuma） */
      onebotImpl?: 'auto' | 'napcat' | 'snowluma';
    },
  ): ConnectionConfig | undefined {
    // 原子读改写：校验抛错发生在写盘前（fn 内 throw 不落盘），语义与原实现一致
    const applied = configService.mutateConnections((data) => {
      const stored = data.connections.find((c) => c.id === id);
      if (!stored || isQqOfficialConnection(stored) || isWeixinBotConnection(stored)) {
        return null;
      }
      const wasEnabled = !!stored.enable;

      if (patch.name !== undefined) {
        const name = String(patch.name).trim();
        if (!name) throw new Error('名称不能为空');
        stored.name = name;
      }
      if (patch.host !== undefined) {
        const host = String(patch.host).trim();
        if (!host) throw new Error('地址不能为空');
        stored.host = host;
      }
      if (patch.port !== undefined) {
        const port = Math.floor(Number(patch.port));
        if (!Number.isFinite(port) || port < 1 || port > 65535) {
          throw new Error('端口无效');
        }
        stored.port = port;
      }
      if (patch.accessToken !== undefined) {
        stored.accessToken = String(patch.accessToken);
      }
      if (patch.apiUrl !== undefined) {
        const apiUrl = String(patch.apiUrl).trim();
        stored.apiUrl = apiUrl || undefined;
      }
      // 实现名只影响接口代理怎么选变体，不影响连接本身，因此不需要触发重连
      if (patch.onebotImpl !== undefined) {
        const impl = patch.onebotImpl === 'napcat' || patch.onebotImpl === 'snowluma'
          ? patch.onebotImpl
          : 'auto';
        stored.onebotImpl = impl;
        // 换实现名等于换了一副眼镜：之前的探测缓存立刻失效
        clearImplCache(id);
      }
      return { wasEnabled };
    });
    if (!applied) return undefined;
    if (applied.wasEnabled) {
      this.reconnect(id);
    }
    return configService.getConnection(id);
  }
}
