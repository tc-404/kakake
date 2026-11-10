import type { GfPluginManager } from './plugin/gf-plugin.manager.js';
import type { WxPluginManager } from './plugin/wx-plugin.manager.js';
import type { SsPluginManager } from './plugin/ss-plugin.manager.js';
import type { SssxPluginManager } from './plugin/sssx-plugin.manager.js';
import type { KzPluginManager } from './plugin/kz-plugin.manager.js';
import type { TgPluginManager } from './plugin/tg-plugin.manager.js';
import type { ConnectionManager } from './connection/connection.manager.js';
import type { PluginManager } from './plugin/plugin.manager.js';
import type { PluginConfigService } from './plugin/plugin-config.service.js';
import type { PluginImporter } from './plugin/plugin.importer.js';

class KakakeApp {
  connectionManager!: ConnectionManager;
  pluginManager!: PluginManager;
  gfPluginManager!: GfPluginManager;
  wxPluginManager!: WxPluginManager;
  ssPluginManager!: SsPluginManager;
  /** 双生插件（sssx-plugin-*，OneBot + QQ 官方双路由） */
  sssxPluginManager!: SssxPluginManager;
  /** 扩展插件（kz-plugin-*，不绑任何连接） */
  kzPluginManager!: KzPluginManager;
  /** Telegram Bot 插件（TG-plugin-*，按 bot id 账号隔离） */
  tgPluginManager!: TgPluginManager;
  pluginConfigService!: PluginConfigService;
  /** Telegram 插件配置视图：与统一 PluginConfigService 同源，便于按协议取用 */
  tgPluginConfigService!: PluginConfigService;
  pluginImporter!: PluginImporter;
  expressApp!: import('express').Application;
}

export const kakakeApp = new KakakeApp();
