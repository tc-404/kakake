import type { Logger } from '../core/logger.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { pluginAccountService } from './plugin-account.service.js';
import { isSsPluginDir, resolveSsPluginId } from './ss-plugin-id.js';
import { AccountPluginManagerBase } from './account-plugin.manager.base.js';

/**
 * KOOK 机器人插件管理器（其他类型）（按账号多实例）
 * - 安装源：plugins/（按 ss-plugin- 前缀区分）
 * - 运行副本：plugins_two/<KOOK 账号>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 *
 * 平台无关的核心逻辑全部在 AccountPluginManagerBase，本类只注入 KOOK 平台参数。
 */
export class SsPluginManager extends AccountPluginManagerBase {
  constructor(
    logger: Logger,
    connectionManager: ConnectionManager,
    adminHost: string,
    adminPort: number,
    adminAuthRequired = false,
  ) {
    super(logger, connectionManager, adminHost, adminPort, adminAuthRequired, {
      adapterName: 'ss_plugin_manager',
      logLabel: 'SsPluginManager',
      managerNoun: '其他插件管理器',
      pluginNoun: '其他插件',
      statusPath: PATHS.ssPluginsStatus,
      connType: 'kook',
      pluginKind: 'ss',
      eventName: 'kook/event',
      actionResultName: 'kook/action_result',
      enrichFlagKey: 'kook',
      ob11Mode: 'kook-gateway',
      accountNotReadyError: 'KOOK 账号未就绪：请先启用连接，连上网关获取机器人身份后再启用插件',
      dirFilter: isSsPluginDir,
      resolveId: resolveSsPluginId,
      ensureAccount: (connectionId) => pluginAccountService.ensureKookAccount(connectionId),
      createActionCaller: (adapterName, connId) =>
        connectionManager.createKookBotActionCaller(adapterName, connId),
    });
  }
}
