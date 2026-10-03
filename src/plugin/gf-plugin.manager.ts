import type { Logger } from '../core/logger.js';
import type { ActionCaller } from '../connection/onebot.types.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { configService } from '../core/config.service.js';
import { pluginAccountService } from './plugin-account.service.js';
import { isGfPluginDir, resolveGfPluginId } from './gf-plugin-id.js';
import type { NapCatPluginContext } from './plugin.types.js';
import { AccountPluginManagerBase } from './account-plugin.manager.base.js';
import type { AccountRuntime } from './plugin-manager-shared.js';

const ADAPTER_NAME = 'gf_plugin_manager';

/** 模拟模式下给官方插件的假 API 返回值，尽量贴近真实结构，避免插件 await 后读字段崩溃 */
function officialSimulatedResult(action: string, params: Record<string, unknown>): unknown {
  const a = String(action || '').toLowerCase();
  // 发消息类接口（/v2/groups/.../messages、/v2/users/.../messages、/channels/.../messages）
  if (a.includes('/messages') || (a.includes('message') && !a.startsWith('get'))) {
    return { id: `SIM${Date.now()}`, timestamp: new Date().toISOString(), msg_id: params.msg_id ?? '' };
  }
  return {};
}

/**
 * 取事件的“会话键”：同一会话内的消息必须按到达顺序处理。
 * 官方被动回复依赖 msg_id / msg_seq 的时序，并发处理同一会话的连发消息会答非所问。
 * 不同会话（群 / 私聊 / 频道）之间仍然并发，避免慢插件拖住全站。
 */
function eventConversationKey(event: Record<string, unknown>): string | null {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const group = text(event.group_openid) || text(event.group_id);
  if (group) return `group:${group}`;
  const channel = text(event.channel_id);
  if (channel) return `channel:${channel}`;
  const author = (event.author && typeof event.author === 'object')
    ? event.author as Record<string, unknown>
    : null;
  const user = text(event.openid)
    || text(author?.user_openid)
    || text(author?.member_openid)
    || text(author?.id);
  if (user) return `user:${user}`;
  const guild = text(event.guild_id);
  if (guild) return `guild:${guild}`;
  return null;
}

/**
 * QQ 官方机器人 GF 插件管理器（按账号多实例）。
 *
 * 核心生命周期逻辑全部继承自 AccountPluginManagerBase，本类只注入官方机器人
 * 的平台参数与两块独有行为：按连接 mode 动态解析 ob11Mode、同会话串行派发。
 * - 安装源：plugins/（按 GF- 前缀区分）
 * - 运行副本：plugins_two/<AppID>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 */
export class GfPluginManager extends AccountPluginManagerBase {
  constructor(
    logger: Logger,
    connectionManager: ConnectionManager,
    adminHost: string,
    adminPort: number,
    adminAuthRequired = false,
  ) {
    super(logger, connectionManager, adminHost, adminPort, adminAuthRequired, {
      adapterName: ADAPTER_NAME,
      logLabel: 'GfPluginManager',
      managerNoun: 'GF 插件管理器',
      pluginNoun: 'GF 插件',
      statusPath: PATHS.gfPluginsStatus,
      connType: 'qq_official',
      pluginKind: 'gf',
      eventName: 'qq_official/event',
      actionResultName: 'qq_official/action_result',
      enrichFlagKey: 'qq_official',
      ob11Mode: 'qq-official-ws',
      accountNotReadyError: 'AppID 未配置，无法启用插件',
      dirFilter: isGfPluginDir,
      resolveId: resolveGfPluginId,
      ensureAccount: (connectionId) => pluginAccountService.ensureOfficialAccount(connectionId),
      // 箭头函数延迟到调用时再取 this.connectionManager（super 调用期间字段尚未赋值）
      createActionCaller: (adapterName: string, connId?: string) =>
        connectionManager.createQqOfficialActionCaller(adapterName, connId) as ActionCaller,
      loggerCategory: 'gf_plugin',
      conversationKey: eventConversationKey,
      resolveOb11Mode: (connectionId) => {
        const conn = configService.getConnection(connectionId);
        return conn?.mode === 'https' ? 'qq-official-https' : 'qq-official-ws';
      },
      resolveConnectionForAccount: (accountKey) => this.resolveAccountConnection(accountKey),
    });
  }

  /**
   * 该账号对应的连接信息。
   * ob11Mode 必须按连接真实模式给：官方 HTTPS 连接的事件来自 Webhook，
   * 一律写 'qq-official-ws' 会让插件拿到错误的环境标识。
   */
  private resolveAccountConnection(accountKey: string): { id?: string; ob11Mode: string } {
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'qq_official') continue;
      if (pluginAccountService.resolveAccountKey(conn) !== accountKey) continue;
      return {
        id: conn.id,
        ob11Mode: conn.mode === 'https' ? 'qq-official-https' : 'qq-official-ws',
      };
    }
    return { ob11Mode: 'qq-official-ws' };
  }

  /**
   * 模拟派发：把一条官方事件发给该账号已加载的插件，用捕获版 actions.call 拦截输出，
   * 不触发真实官方 API 调用。供「模拟消息」功能调用。
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

    await Promise.allSettled(
      targets.map((rt) => this.callSimulatedHandler(rt, event, capture)),
    );
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
    const context: NapCatPluginContext = {
      ...base,
      actions: {
        call: async (action: string, params?: Record<string, unknown>) => {
          const p = (params ?? {}) as Record<string, unknown>;
          try { capture({ pluginId: rt.pluginId, action, params: p }); } catch { /* ignore */ }
          return officialSimulatedResult(action, p);
        },
      },
    };

    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(`[GfPluginManager] 模拟派发插件错误 ${entry.id}@${rt.accountKey}:`, error);
    }
  }
}
