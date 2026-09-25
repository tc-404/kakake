import type { GfPluginManager } from './plugin/gf-plugin.manager.js';
import type { WxPluginManager } from './plugin/wx-plugin.manager.js';
import type { SsPluginManager } from './plugin/ss-plugin.manager.js';
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
  pluginConfigService!: PluginConfigService;
  pluginImporter!: PluginImporter;
  expressApp!: import('express').Application;
}

export const kakakeApp = new KakakeApp();
