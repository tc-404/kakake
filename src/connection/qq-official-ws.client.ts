import WebSocket from 'ws';
import type { ConnectionConfig } from '../core/types.js';
import { isQqOfficialConnection, resolveQqOfficialApiBase } from '../core/types.js';
import { eventBus } from '../event/event-bus.js';
import { logQqOfficialEvent } from '../core/log-store.js';
import { formatLogArgs, formatQqOfficialEvent } from '../core/log-format.js';
import {
  QQ_OFFICIAL_INTENTS_FALLBACK_LADDER,
  describeQqOfficialIntents,
} from './qq-official-intents.js';
import {
  appendQqOfficialAuthHint,
  clipQqOfficialErrorBody,
  fetchQqOfficialAccessToken,
  formatQqOfficialEnvLabel,
  qqOfficialApiRequest,
  qqOfficialFetch,
  describeQqOfficialNetworkError,
  type QqOfficialBotProfile,
  mapQqOfficialMeToProfile,
} from './qq-official-api.js';

/** WebSocket 握手超时：不设的话握手卡死会让 connecting 永久为 true，重连彻底停摆 */
const WS_HANDSHAKE_TIMEOUT_MS = 20_000;

/** op=9（Invalid Session）后按协议等待 1~5 秒再 Identify，避免被判无效的死循环 */
const INVALID_SESSION_IDENTIFY_DELAY_MS = 2_000;

/** 连续多少次 op=9 就放弃原地 Identify，改为重建连接 */
const INVALID_SESSION_RECONNECT_AFTER = 3;

/** 心跳 ACK 宽限倍数：超过 interval × 该倍数仍无 ACK 即判定连接已失效（半开连接） */
const HEARTBEAT_ACK_GRACE_FACTOR = 2;

/** 平台终态关闭码：重连没有意义（机器人已下架/封禁，只能连沙箱或先处理下架） */
const QQ_TERMINAL_CLOSE_CODES = new Set([4914, 4915]);

/** QQ Gateway 关闭码含义（4000+ 为官方自定义），用于把静默断开变成可读原因 */
const QQ_WS_CLOSE_HINTS: Record<number, string> = {
  1000: '正常关闭',
  1001: '对端离开',
  1006: '连接异常中断（未收到关闭帧，多为网络中断/中间设备掐断）',
  4001: '无效的 opcode',
  4002: '解析 payload 失败',
  4006: '无效的 session id',
  4007: 'seq 错误',
  4008: '发送 payload 过快',
  4009: '连接过期，需要重连',
  4010: '无效的 shard',
  4011: '分片需要拆分',
  4012: '无效的 API 版本',
  4013: '无效的 intents',
  4014: 'intents 未获授权（去开放平台确认该机器人已开通对应事件权限）',
  4900: '内部错误，请重连',
  4914: '机器人已下架，只能连沙箱环境',
  4915: '机器人已封禁，只能连沙箱环境',
};

function describeQqWsClose(code: number, reason: string): string {
  const hint = QQ_WS_CLOSE_HINTS[code];
  const text = String(reason ?? '').trim();
  return [`code=${code}`, hint, text].filter(Boolean).join(' · ');
}

/** 拼接 Gateway 地址：原地址可能自带查询串，直接拼 '?' 会拼坏 */
function buildGatewayUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set('v', '1');
    u.searchParams.set('encoding', 'json');
    return u.toString();
  } catch {
    return `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}v=1&encoding=json`;
  }
}

interface QqGatewayBotResponse {
  url?: string;
  shards?: number;
  session_start_limit?: Record<string, number>;
}

interface QqGatewayPayload {
  op: number;
  s?: number | null;
  t?: string;
  d?: unknown;
}

export interface QqOfficialReconnectStatus {
  reconnecting: boolean;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  abandoned: boolean;
}

export interface QqOfficialEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  getBotProfile(): import('./qq-official-api.js').QqOfficialBotProfile | null;
  refreshBotProfile(): Promise<import('./qq-official-api.js').QqOfficialBotProfile | null>;
  /** 出站连接（WS）才有重连概念；HTTPS Webhook 不实现 */
  getReconnectStatus?(): QqOfficialReconnectStatus;
  /** 仅 HTTPS Webhook：回调地址是否已被平台验证通过 */
  getWebhookVerified?(): boolean;
}

export interface QqOfficialWsClientOptions {
  connection: ConnectionConfig;
  onReady?: () => void;
  onDisconnect?: () => void;
  onProfileUpdated?: () => void;
}

/**
 * QQ 开放平台官方机器人 — Gateway WebSocket 客户端
 * 参考 bot.q.qq.com API v2 / 社区 SDK（qq-official-bot、botgo）连接流程
 */
export class QqOfficialWsClient implements QqOfficialEndpoint {
  readonly id: string;
  readonly name: string;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private identifyTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 45000;
  /** 最近一次收到 op=11 心跳 ACK 的时间，用于识别半开连接 */
  private lastAckAt = 0;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private accessToken = '';
  private tokenExpiresAt = 0;
  private closed = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  /** 达到重连上限 / 命中终态关闭码：不再自动重连（界面显示“重连已停止”） */
  private abandoned = false;
  /** 是否处于已 READY 的会话中（决定 onDisconnect 是否该触发） */
  private ready = false;
  private shardCount = 1;
  /** 用户没显式配 intents 且被 4014 拒过 → 沿降级阶梯下退的当前档位（0＝默认组合） */
  private fallbackLevel = 0;
  private invalidSessions = 0;

  constructor(private readonly options: QqOfficialWsClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
    if (options.connection.botProfile) {
      this.botProfile = options.connection.botProfile;
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...args: unknown[]
  ): void {
    logQqOfficialEvent(`[官方:${this.name}]`, message, {
      level,
      detail: args.length ? formatLogArgs(args) : undefined,
    });
  }

  private logNetRetry(message: string): void {
    this.log('warn', '[QQ官方] 网络重试', message);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !!this.sessionId;
  }

  getReconnectStatus(): QqOfficialReconnectStatus {
    return {
      reconnecting: this.connecting || this.reconnectTimer !== null,
      attempts: this.reconnectAttempts,
      maxAttempts: this.resolveMaxAttempts(),
      intervalMs: this.resolveIntervalMs(),
      abandoned: this.abandoned,
    };
  }

  start(): void {
    if (!isQqOfficialConnection(this.options.connection)) {
      this.log('error', '[QQ官方] 连接配置类型错误');
      return;
    }
    this.closed = false;
    this.abandoned = false;
    this.fallbackLevel = 0;
    this.reconnectAttempts = 0;
    this.invalidSessions = 0;
    this.shardCount = 1;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sessionId = null;
    this.lastSeq = null;
    this.teardown(true);
  }

  private botProfile: QqOfficialBotProfile | null = null;

  getBotProfile(): QqOfficialBotProfile | null {
    return this.botProfile;
  }

  async refreshBotProfile(): Promise<QqOfficialBotProfile | null> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn) || !conn.appId || !conn.appSecret) return null;
    try {
      await this.ensureAccessToken();
      const me = await qqOfficialApiRequest<{
        id?: string;
        username?: string;
        avatar?: string;
        union_openid?: string;
        desc?: string;
        bio?: string;
        share_url?: string;
      }>({
        method: 'GET',
        path: '/users/@me',
        appId: conn.appId,
        accessToken: this.accessToken,
        sandbox: conn.sandbox,
        onRetry: (m) => this.logNetRetry(m),
      });
      this.botProfile = mapQqOfficialMeToProfile(me);
      conn.botProfile = this.botProfile;
      return this.botProfile;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, conn.sandbox);
      this.log('warn', '[QQ官方] 获取机器人资料失败', msg);
      return null;
    }
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) {
      throw new Error('非 QQ 官方连接');
    }
    if (!conn.appId) {
      throw new Error('QQ 官方连接缺少 AppID，无法调用官方接口');
    }
    await this.ensureAccessToken();
    const p = { ...(params ?? {}) };
    const method = (p.__method as string) || 'POST';
    delete p.__method;
    const body = method === 'GET' || Object.keys(p).length === 0 ? undefined : p;
    return qqOfficialApiRequest({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: action.startsWith('/') ? action : `/${action}`,
      appId: conn.appId,
      accessToken: this.accessToken,
      sandbox: conn.sandbox,
      body,
      onRetry: (m) => this.logNetRetry(m),
    });
  }

  private async connect(): Promise<void> {
    if (this.closed || this.abandoned || this.connecting) return;
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    if (!conn.appId || !conn.appSecret) {
      this.log('error', '[QQ官方] 缺少 AppID / AppSecret，停止连接');
      return;
    }
    this.connecting = true;

    try {
      await this.ensureAccessToken();
      const apiBase = resolveQqOfficialApiBase(conn.sandbox);
      const env = formatQqOfficialEnvLabel(conn.sandbox);
      const gwRes = await qqOfficialFetch(`${apiBase}/gateway/bot`, {
        method: 'GET',
        headers: {
          Authorization: `QQBot ${this.accessToken}`,
          'X-Union-Appid': conn.appId,
        },
        label: `GET [${env}] ${apiBase}/gateway/bot`,
        onRetry: (m) => this.logNetRetry(m),
      });
      const gwText = gwRes.ok ? await gwRes.text() : '';
      if (!gwRes.ok) {
        const body = clipQqOfficialErrorBody(gwText);
        throw new Error(appendQqOfficialAuthHint(
          `获取 Gateway 失败: HTTP ${gwRes.status} [${env}] ${apiBase}/gateway/bot${body ? ` ${body}` : ''}`,
          conn.sandbox,
        ));
      }
      let gw: QqGatewayBotResponse;
      try {
        gw = (gwText ? JSON.parse(gwText) : {}) as QqGatewayBotResponse;
      } catch {
        throw new Error(
          `Gateway 响应不是合法 JSON: HTTP ${gwRes.status} [${env}] ${apiBase}/gateway/bot ${clipQqOfficialErrorBody(gwText)}`,
        );
      }
      if (!gw.url) throw new Error(`Gateway 响应缺少 url [${env}] ${apiBase}`);

      // 多分片网关：本框架只订阅 shard 0，必须把这件事说清楚，否则表现为“事件静默丢失”
      const shards = Number(gw.shards);
      this.shardCount = Number.isInteger(shards) && shards > 0 ? shards : 1;
      if (this.shardCount > 1) {
        this.log('warn', `[QQ官方] 网关要求 ${this.shardCount} 个分片，当前只订阅 shard 0（多分片需多实例部署；缺失事件属于预期行为）`);
      }

      const wsUrl = buildGatewayUrl(gw.url);
      this.log('info', `[QQ官方] 连接 Gateway [${env}]`, gw.url);

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        this.ws = ws;
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(new Error(`WebSocket 握手失败: ${describeQqOfficialNetworkError(err)}`));
        };
        const onEarlyClose = (code: number, reason: Buffer): void => {
          cleanup();
          reject(new Error(`WebSocket 握手期被关闭: ${describeQqWsClose(code, reason.toString())}`));
        };
        const cleanup = (): void => {
          ws.off('open', onOpen);
          ws.off('error', onError);
          ws.off('close', onEarlyClose);
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        ws.once('close', onEarlyClose);
      });

      this.ws!.on('message', (raw) => this.handleMessage(raw.toString()));
      this.ws!.on('close', (code: number, reason: Buffer) => {
        this.handleClose(code, reason?.toString?.() ?? '');
      });
      this.ws!.on('error', (err) => {
        this.log('warn', '[QQ官方] WebSocket 错误', describeQqOfficialNetworkError(err));
      });
      this.reconnectAttempts = 0;
      this.invalidSessions = 0;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, conn.sandbox);
      this.log('error', '[QQ官方] 连接失败', msg);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async ensureAccessToken(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    if (!conn.appId || !conn.appSecret) {
      throw new Error('QQ 官方连接缺少 AppID / AppSecret，无法获取 AccessToken');
    }
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) return;

    const res = await fetchQqOfficialAccessToken(
      conn.appId,
      conn.appSecret,
      (m) => this.logNetRetry(m),
    );
    this.accessToken = res.access_token;
    this.tokenExpiresAt = now + res.expires_in * 1000;
  }

  private handleMessage(raw: string): void {
    let payload: QqGatewayPayload;
    try {
      payload = JSON.parse(raw) as QqGatewayPayload;
    } catch {
      this.log('warn', '[QQ官方] 无法解析 Gateway 消息');
      return;
    }

    if (payload.s != null) this.lastSeq = payload.s;

    switch (payload.op) {
      case 10: { // Hello
        const hello = (payload.d ?? {}) as { heartbeat_interval?: number };
        const interval = Number(hello?.heartbeat_interval);
        this.heartbeatIntervalMs = Number.isFinite(interval) && interval > 0 ? interval : 45000;
        this.clearIdentifyTimer();
        void this.sendIdentify();
        this.startHeartbeat();
        break;
      }
      case 11: // Heartbeat ACK
        this.lastAckAt = Date.now();
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t, payload.d);
        break;
      case 7: // Reconnect：服务端要求立刻重连
        this.log('warn', '[QQ官方] 服务端要求重连');
        this.reconnect();
        break;
      case 9: { // Invalid Session：清会话；等 1~5s 再 Identify，连错多次就直接重建
        this.invalidSessions += 1;
        this.sessionId = null;
        this.lastSeq = null;
        if (this.invalidSessions >= INVALID_SESSION_RECONNECT_AFTER) {
          this.log('warn', `[QQ官方] 连续 ${this.invalidSessions} 次会话无效，改为重建连接`);
          this.reconnect();
          break;
        }
        this.log('warn', `[QQ官方] 会话无效（第 ${this.invalidSessions} 次），${INVALID_SESSION_IDENTIFY_DELAY_MS}ms 后重新 Identify`);
        this.scheduleIdentify(INVALID_SESSION_IDENTIFY_DELAY_MS);
        break;
      }
      default:
        break;
    }
  }

  private async sendIdentify(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn) || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!conn.appId || !conn.appSecret) {
      this.log('error', '[QQ官方] 缺少 AppID / AppSecret，无法 Identify');
      return;
    }
    await this.ensureAccessToken();

    const intents = this.resolveIntents();
    // Resume 不会刷新 intents；若需订阅新 Intent（如 GROUP_MEMBER），必须走 Identify
    const canResume = !!this.sessionId;
    if (canResume) {
      this.send({
        op: 6,
        d: {
          token: `QQBot ${this.accessToken}`,
          session_id: this.sessionId,
          seq: this.lastSeq ?? null,
        },
      });
      this.log('info', `[QQ官方] Resume session intents=${describeQqOfficialIntents(intents)}`);
      return;
    }

    const d: Record<string, unknown> = {
      token: `QQBot ${this.accessToken}`,
      intents,
      shard: [0, this.shardCount],
      properties: {
        $os: process.platform,
        $browser: 'kakake',
        $device: 'kakake',
      },
    };
    this.log(
      'info',
      `[QQ官方] Identify intents=${describeQqOfficialIntents(intents)} shard=[0,${this.shardCount}]`
      + (this.fallbackLevel > 0 ? '（默认组合被拒后已自动降级）' : ''),
    );
    this.send({ op: 2, d });
  }

  /** 显式配置优先；未配置时按降级阶梯取当前档位（0＝默认组合，逐级下退到最小集合） */
  private resolveIntents(): number {
    const configured = Number(this.options.connection.intents);
    if (Number.isFinite(configured) && configured > 0) return configured >>> 0;
    const ladder = QQ_OFFICIAL_INTENTS_FALLBACK_LADDER;
    const idx = Math.min(this.fallbackLevel, ladder.length - 1);
    return ladder[idx] >>> 0;
  }

  /** 用户显式配过 intents 就尊重配置；否则允许沿阶梯继续下退 */
  private mayDowngradeIntents(): boolean {
    const configured = Number(this.options.connection.intents);
    if (Number.isFinite(configured) && configured > 0) return false;
    return this.fallbackLevel < QQ_OFFICIAL_INTENTS_FALLBACK_LADDER.length - 1;
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    if (!eventType) return;

    if (eventType === 'READY') {
      const ready = data as { session_id?: string };
      this.sessionId = ready.session_id ?? null;
      this.invalidSessions = 0;
      this.ready = true;
      this.log('info', '[QQ官方] Gateway READY');
      void this.refreshBotProfile().then(() => {
        this.options.onProfileUpdated?.();
      });
      this.options.onReady?.();
      return;
    }

    const event = (typeof data === 'object' && data) ? { ...data as object, t: eventType } : { t: eventType, d: data };
    const formatted = formatQqOfficialEvent(eventType, event);
    logQqOfficialEvent(
      `[官方:${this.name}]`,
      formatted.message,
      { detail: formatted.detail, raw: formatted.raw, level: eventType === 'READY' ? 'debug' : 'info' },
    );

    void eventBus.emit('qq_official/event', {
      connectionId: this.id,
      eventType,
      event,
    });
  }

  private send(payload: QqGatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this.lastAckAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.abandoned) return;
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      const silentMs = Date.now() - this.lastAckAt;
      // 收不到 ACK：TCP 可能还没断，但事件已经不会再到达（半开连接），必须主动重建
      if (silentMs > this.heartbeatIntervalMs * HEARTBEAT_ACK_GRACE_FACTOR) {
        this.log(
          'warn',
          `[QQ官方] ${Math.round(silentMs / 1000)}s 未收到心跳 ACK（心跳间隔 ${Math.round(this.heartbeatIntervalMs / 1000)}s），判定连接已失效，主动重连`,
        );
        this.reconnect();
        return;
      }
      this.send({ op: 1, d: this.lastSeq ?? null });
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleIdentify(delayMs: number): void {
    this.clearIdentifyTimer();
    this.identifyTimer = setTimeout(() => {
      this.identifyTimer = null;
      if (this.closed || this.abandoned) return;
      void this.sendIdentify();
      // 重新 Identify 后重置 ACK 计时，避免旧计时把新会话误判为掉线
      this.startHeartbeat();
    }, Math.max(0, delayMs));
  }

  private clearIdentifyTimer(): void {
    if (this.identifyTimer) {
      clearTimeout(this.identifyTimer);
      this.identifyTimer = null;
    }
  }

  /**
   * 统一清理：注销监听 → 关 socket → 清心跳/待发 Identify。
   * 只有 notifyDisconnect=true 且此前确实处于 READY 时才回调 onDisconnect，
   * 避免 stop() / op7 重连 / 对端断开 三条路径重复或漏掉回调。
   */
  private teardown(notifyDisconnect: boolean): void {
    this.clearHeartbeat();
    this.clearIdentifyTimer();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      try {
        ws.close();
      } catch {
        /* socket 已断开时 close 可能抛错，忽略 */
      }
    }
    const wasReady = this.ready;
    this.ready = false;
    if (notifyDisconnect && wasReady) this.options.onDisconnect?.();
  }

  private handleClose(code?: number, reason?: string): void {
    const wasReady = this.ready;
    this.teardown(true);
    if (typeof code === 'number') {
      this.log('warn', '[QQ官方] Gateway 连接断开', describeQqWsClose(code, reason ?? ''));
    } else if (wasReady) {
      this.log('warn', '[QQ官方] Gateway 连接断开');
    }
    if (this.closed) return;

    if (typeof code === 'number' && QQ_TERMINAL_CLOSE_CODES.has(code)) {
      this.abandoned = true;
      this.log(
        'error',
        `[QQ官方] 关闭码 ${code} 属于终态（机器人已下架/封禁），停止自动重连；`
        + '请到开放平台处理，或把该连接切到沙箱环境',
      );
      return;
    }

    if (code === 4014 && this.mayDowngradeIntents()) {
      this.fallbackLevel += 1;
      // 必须清掉会话：否则下次连上会走 Resume（op6 不会改 intents），降级永远不生效
      this.sessionId = null;
      this.lastSeq = null;
      const next = this.resolveIntents();
      this.log(
        'warn',
        `[QQ官方] 平台以 4014（intents 未获授权）断开，已自动降级为 ${describeQqOfficialIntents(next)} 重试；`
        + '需要频道或互动（按钮回调）等事件时，请到开放平台开通对应权限，或在连接设置里显式填写 intents',
      );
    }

    this.scheduleReconnect();
  }

  private reconnect(): void {
    if (this.closed || this.abandoned) return;
    this.teardown(true);
    void this.connect();
  }

  private resolveIntervalMs(): number {
    const ms = Number(this.options.connection.reconnectIntervalMs);
    return Number.isFinite(ms) && ms >= 500 ? Math.floor(ms) : 5000;
  }

  private resolveMaxAttempts(): number {
    const n = Number(this.options.connection.reconnectMaxAttempts);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 15;
  }

  private scheduleReconnect(): void {
    if (this.closed || this.abandoned || this.reconnectTimer) return;
    const conn = this.options.connection;
    if (!conn.enable) return;
    const interval = Math.max(500, this.resolveIntervalMs());
    const max = this.resolveMaxAttempts();
    if (max > 0 && this.reconnectAttempts >= max) {
      this.abandoned = true;
      this.log('error', `[QQ官方] 已达最大重连次数 ${max}，停止自动重连（可点“重连”或调整重连设置）`);
      return;
    }
    this.reconnectAttempts += 1;
    const label = max > 0 ? `${this.reconnectAttempts}/${max}` : String(this.reconnectAttempts);
    this.log('info', `[QQ官方] ${interval}ms 后尝试重连（第 ${label} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.abandoned) return;
      void this.connect();
    }, interval);
  }
}
