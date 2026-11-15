import type { Logger } from '../core/logger.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { pluginAccountService } from './plugin-account.service.js';
import { isTgPluginDir, resolveTgPluginId } from './tg-plugin-id.js';
import { AccountPluginManagerBase } from './account-plugin.manager.base.js';

/**
 * Telegram Bot 插件管理器（按账号多实例）
 * - 安装源：plugins/（按 TG-plugin- 前缀区分，大小写不敏感）
 * - 运行副本：plugins_two/<Telegram Bot 账号>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 *
 * 平台无关的核心逻辑全部在 AccountPluginManagerBase，本类只注入 Telegram 平台参数。
 */
export class TgPluginManager extends AccountPluginManagerBase {
  constructor(
    logger: Logger,
    connectionManager: ConnectionManager,
    adminHost: string,
    adminPort: number,
    adminAuthRequired = false,
  ) {
    super(logger, connectionManager, adminHost, adminPort, adminAuthRequired, {
      adapterName: 'tg_plugin_manager',
      logLabel: 'TgPluginManager',
      managerNoun: 'Telegram 插件管理器',
      pluginNoun: 'Telegram 插件',
      statusPath: PATHS.tgPluginsStatus,
      connType: 'telegram',
      pluginKind: 'tg',
      eventName: 'telegram/event',
      actionResultName: 'telegram/action_result',
      enrichFlagKey: 'telegram',
      ob11Mode: 'telegram-bot-api',
      protocol: 'telegram',
      accountNotReadyError: 'Telegram Bot 账号未就绪：请先启用连接，调用 getMe 获取机器人身份后再启用插件',
      dirFilter: isTgPluginDir,
      resolveId: resolveTgPluginId,
      ensureAccount: (connectionId) => pluginAccountService.ensureTelegramAccount(connectionId),
      createActionCaller: (adapterName, connId) =>
        connectionManager.createTelegramBotActionCaller(adapterName, connId),
    });
  }
}
