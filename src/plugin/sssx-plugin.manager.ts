import type { Logger } from '../core/logger.js';
import type { ActionCaller } from '../connection/onebot.types.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { configService } from '../core/config.service.js';
import { isQqOfficialConnection, type ConnectionConfig } from '../core/types.js';
import { pluginAccountService } from './plugin-account.service.js';
import { isSssxPluginDir, resolveSssxPluginId } from './sssx-plugin-id.js';
import { AccountPluginManagerBase } from './account-plugin.manager.base.js';
import type { AccountRuntime } from './plugin-manager-shared.js';
import type { NapCatPluginContext, KakakeProtocol } from './plugin.types.js';

const ADAPTER_NAME = 'sssx_plugin_manager';

/** 连接类型 → 事件里注入的平台标记键（双生插件靠它认这次事件是哪条协议来的） */
const FLAG_BY_CONN_TYPE: Record<string, string> = {
  onebot: 'onebot',
  qq_official: 'qq_official',
};

/** 连接类型 → 下发给插件的协议标识 */
const PROTOCOL_BY_CONN_TYPE: Record<string, KakakeProtocol> = {
  onebot: 'onebot',
  qq_official: 'qq_official',
};

/** 连接类型 → frameworkEnv.ob11Mode */
function ob11ModeFor(connType: string, mode?: string): string {
  if (connType === 'qq_official') {
    return mode === 'https' ? 'qq-official-https' : 'qq-official-ws';
  }
  return 'ws-server';
}

/** 模拟派发的假返回值：官方接口走 /v2/... 路径，OneBot 走 send_*_msg 这类动作名 */
function twinSimulatedResult(action: string): unknown {
  const a = String(action || '').toLowerCase();
  if (a.includes('/messages') || (a.includes('message') && !a.startsWith('get'))) {
    return { id: `SIM${Date.now()}`, message_id: Math.floor(Math.random() * 2_000_000_000) };
  }
  if (a === 'get_login_info') return { user_id: 0, nickname: '模拟账号' };
  return {};
}

/**
 * 双生插件的会话键：同一会话内的消息必须按到达顺序处理。
 * 官方被动回复依赖 msg_id / msg_seq 的时序，并发处理同一会话的连发消息会答非所问；
 * OneBot 侧同理（连发消息要按序回）。不同会话之间仍然并发，避免慢插件拖住全站。
 */
function twinConversationKey(event: Record<string, unknown>): string | null {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const group = text(event.group_openid) || text(event.group_id);
  if (group) return `group:${group}`;
  const channel = text(event.channel_id);
  if (channel) return `channel:${channel}`;
  const author = event.author && typeof event.author === 'object'
    ? event.author as Record<string, unknown>
    : null;
  const user = text(event.openid)
    || text(event.user_id)
    || text(author?.user_openid)
    || text(author?.member_openid)
    || text(author?.id);
  if (user) return `user:${user}`;
  const guild = text(event.guild_id);
  if (guild) return `guild:${guild}`;
  return null;
}

/**
 * 只把「真·消息事件」派给 plugin_onmessage。
 * 双生插件同时收两条协议的回执（onebot/action_result + qq_official/action_result），
 * 不挡的话插件的 plugin_onmessage 会被动作回执刷到。
 */
function isMessageEvent(event: Record<string, unknown>): boolean {
  const t = String(event?.t ?? '').trim();
  if (t) return t.includes('MESSAGE') || t.includes('MSG_RECEIVE');
  return String(event?.post_type ?? '') === 'message';
}

/**
 * 双生插件管理器（按账号多实例，一条实例只服务一个协议账号）。
 *
 * 框架**只负责双路由**：同一个 sssx-plugin-* 目录既能装在 OneBot 连接上，
 * 也能装在 QQ 官方机器人连接上，两个账号各自独立 plugin_init / 路由 / dataPath。
 * 至于插件内部怎么区分协议、怎么把两套事件/发送接口抹平——那是插件自己的事。
 *
 * - 安装源：plugins/（按 sssx-plugin- 前缀区分）
 * - 运行副本：plugins_two/<QQ 号 或 AppID>/
 */
export class SssxPluginManager extends AccountPluginManagerBase {
  constructor(
    logger: Logger,
    connectionManager: ConnectionManager,
    adminHost: string,
    adminPort: number,
    adminAuthRequired = false,
  ) {
    super(logger, connectionManager, adminHost, adminPort, adminAuthRequired, {
      adapterName: ADAPTER_NAME,
      logLabel: 'SssxPluginManager',
      managerNoun: '双生插件管理器',
      pluginNoun: '双生插件',
      statusPath: PATHS.sssxPluginsStatus,
      // 主协议 OneBot，第二条协议 QQ 官方机器人
      connType: 'onebot',
      extraConnTypes: ['qq_official'],
      extraChannels: [
        { eventName: 'qq_official/event', actionResultName: 'qq_official/action_result' },
      ],
      pluginKind: 'sssx',
      eventName: 'onebot/event',
      actionResultName: 'onebot/action_result',
      enrichFlagKey: 'onebot',
      enrichFlagKeyByConnType: (connType) => FLAG_BY_CONN_TYPE[connType] ?? 'onebot',
      ob11Mode: 'ws-server',
      protocol: 'onebot',
      accountNotReadyError: '账号未就绪：请先启用连接，等机器人身份上报（OneBot 的 QQ 号 / 官方的 AppID）后再启用双生插件',
      dirFilter: isSssxPluginDir,
      resolveId: resolveSssxPluginId,
      // 两条协议通用：解析出账号键就建运行目录（只认 OneBot / QQ 官方两种连接）
      ensureAccount: (connectionId) => {
        const conn = configService.getConnection(connectionId);
        if (!conn) return false;
        const connType = conn.type ?? 'onebot';
        if (connType !== 'onebot' && connType !== 'qq_official') return false;
        const key = pluginAccountService.resolveAccountKey(conn);
        if (!key) return false;
        pluginAccountService.ensureAccountRuntimeRoot(key);
        return true;
      },
      // OneBot 的 self_id 是连上之后才从事件里带出来的，补登记账号
      captureAccountFromEvent: (event, connectionId) => {
        const selfId = event.self_id;
        if (selfId === undefined || selfId === null || !String(selfId).trim()) return false;
        // 内部会校验连接类型，官方连接上直接返回 false
        return pluginAccountService.lockOnebotAccount(connectionId, selfId as string | number);
      },
      // 箭头函数延迟到调用时再取 this.connectionManager（super 调用期间字段尚未赋值）
      createActionCaller: (adapterName: string, connId?: string) => {
        const conn = connId ? configService.getConnection(connId) : undefined;
        const caller = isQqOfficialConnection(conn as ConnectionConfig)
          ? connectionManager.createQqOfficialActionCaller(adapterName, connId)
          : connectionManager.createActionCaller(adapterName, connId);
        return caller as ActionCaller;
      },
      loggerCategory: 'plugin',
      conversationKey: twinConversationKey,
      messageEventFilter: isMessageEvent,
      resolveOb11Mode: (connectionId) => {
        const conn = configService.getConnection(connectionId);
        return ob11ModeFor(conn?.type ?? 'onebot', conn?.mode);
      },
      resolveProtocol: (connectionId) => {
        const conn = configService.getConnection(connectionId);
        return PROTOCOL_BY_CONN_TYPE[conn?.type ?? 'onebot'] ?? 'onebot';
      },
      resolveConnectionForAccount: (accountKey) => this.resolveAccountConnection(accountKey),
    });
  }

  /**
   * 模拟派发：把一条事件发给该账号已加载的双生插件，用捕获版 actions.call 拦截输出，
   * 不触发真实 API 调用。供「模拟消息」功能调用。
   */
  async dispatchSimulated(
    accountKey: string,
    event: Record<string, unknown>,
    capture: (call: { pluginId: string; action: string; params: Record<string, unknown> }) => void,
  ): Promise<{ dispatched: number }> {
    const key = String(accountKey || '').trim();
    if (!key) return { dispatched: 0 };

    const targets: AccountRuntime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.accountKey !== key) continue;
      if (!this.loader.isMasterEnabled(rt.pluginId)) continue;
      targets.push(rt);
    }
    if (targets.length === 0) return { dispatched: 0 };

    await Promise.allSettled(targets.map((rt) => this.callSimulatedHandler(rt, event, capture)));
    return { dispatched: targets.length };
  }

  private async callSimulatedHandler(
    rt: AccountRuntime,
    event: Record<string, unknown>,
    capture: (call: { pluginId: string; action: string; params: Record<string, unknown> }) => void,
  ): Promise<void> {
    const { entry } = rt;
    if (entry.runtime.status !== 'loaded' || !entry.runtime.module || !entry.runtime.context) return;

    const { module, context: baseContext } = entry.runtime;
    const simConnId = `sim:${rt.accountKey}`;
    const base = this.createEventContext(baseContext, simConnId, entry.id, rt.accountKey);
    // 模拟没有真实连接，协议只能按事件形态认：官方事件带 t，OneBot 事件不带
    const protocol: KakakeProtocol = String(event?.t ?? '').trim() ? 'qq_official' : 'onebot';
    const context: NapCatPluginContext = {
      ...base,
      frameworkEnv: base.frameworkEnv ? { ...base.frameworkEnv, protocol } : undefined,
      actions: {
        call: async (action: string, params?: Record<string, unknown>) => {
          const p = (params ?? {}) as Record<string, unknown>;
          try { capture({ pluginId: rt.pluginId, action, params: p }); } catch { /* ignore */ }
          return twinSimulatedResult(action);
        },
      },
    };

    const wantMessage = isMessageEvent(event);
    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (wantMessage && typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(`[SssxPluginManager] 模拟派发插件错误 ${entry.id}@${rt.accountKey}:`, error);
    }
  }

  /**
   * 该账号对应的连接信息。两条协议都可能命中，取第一条已启用且账号键一致的。
   * ob11Mode / protocol 必须按连接真实类型给，写死会让插件拿到错误的环境标识。
   */
  private resolveAccountConnection(accountKey: string): { id?: string; ob11Mode: string } {
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable) continue;
      const connType = conn.type ?? 'onebot';
      if (connType !== 'onebot' && connType !== 'qq_official') continue;
      if (pluginAccountService.resolveAccountKey(conn) !== accountKey) continue;
      return { id: conn.id, ob11Mode: ob11ModeFor(connType, conn.mode) };
    }
    return { ob11Mode: 'ws-server' };
  }
}
