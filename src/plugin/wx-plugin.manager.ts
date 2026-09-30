import type { Logger } from '../core/logger.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { pluginAccountService } from './plugin-account.service.js';
import { isWxPluginDir, resolveWxPluginId } from './wx-plugin-id.js';
import { AccountPluginManagerBase } from './account-plugin.manager.base.js';

/**
 * 微信机器人插件管理器（按账号多实例）
 * - 安装源：plugins/（按 WX- 前缀区分）
 * - 运行副本：plugins_two/<微信账号>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 *
 * 平台无关的核心逻辑全部在 AccountPluginManagerBase，本类只注入微信平台参数。
 */
export class WxPluginManager extends AccountPluginManagerBase {
  constructor(
    logger: Logger,
    connectionManager: ConnectionManager,
    adminHost: string,
    adminPort: number,
    adminAuthRequired = false,
  ) {
    super(logger, connectionManager, adminHost, adminPort, adminAuthRequired, {
      adapterName: 'wx_plugin_manager',
      logLabel: 'WxPluginManager',
      managerNoun: '微信插件管理器',
      pluginNoun: '微信插件',
      statusPath: PATHS.wxPluginsStatus,
      connType: 'weixin_bot',
      pluginKind: 'wx',
      eventName: 'weixin_bot/event',
      actionResultName: 'weixin_bot/action_result',
      enrichFlagKey: 'weixin_bot',
      ob11Mode: 'weixin-ilink',
      accountNotReadyError: '微信账号未配置，请先扫码登录',
      dirFilter: isWxPluginDir,
      resolveId: resolveWxPluginId,
      ensureAccount: (connectionId) => pluginAccountService.ensureWeixinAccount(connectionId),
      createActionCaller: (adapterName, connId) =>
        connectionManager.createWeixinBotActionCaller(adapterName, connId),
    });
  }
}
