import fs from 'node:fs';
import type { ConnectionPluginsConfig, ConnectionType } from '../core/types.js';
import { configService } from '../core/config.service.js';
import {
  isKookConnection,
  isOnebotConnection,
  isQqOfficialConnection,
  isWeixinBotConnection,
} from '../core/types.js';
import { resolveKakakePluginId } from './plugin-id.js';
import { resolveGfPluginId, isGfPluginDir } from './gf-plugin-id.js';
import { resolveWxPluginId, isWxPluginDir } from './wx-plugin-id.js';
import { resolveSsPluginId, isSsPluginDir } from './ss-plugin-id.js';
import { PATHS } from '../paths.js';

export type PluginKind = 'kakake' | 'gf' | 'wx' | 'ss';

function resolvePluginKind(pluginId: string): PluginKind {
  if (isWxPluginDir(pluginId) || pluginId.startsWith('WX-') || /^wx-plugin-/i.test(pluginId)) {
    return 'wx';
  }
  if (isGfPluginDir(pluginId) || pluginId.startsWith('GF-')) {
    return 'gf';
  }
  if (isSsPluginDir(pluginId) || /^ss[-_]?plugin/i.test(pluginId)) {
    return 'ss';
  }
  return 'kakake';
}

function connectionTypeForKind(kind: PluginKind): ConnectionType {
  if (kind === 'gf') return 'qq_official';
  if (kind === 'wx') return 'weixin_bot';
  if (kind === 'ss') return 'kook';
  return 'onebot';
}

class ConnectionPluginService {
  load(): ConnectionPluginsConfig {
    return configService.storageService.readJson<ConnectionPluginsConfig>(PATHS.connectionPlugins, {});
  }

  save(config: ConnectionPluginsConfig): void {
    configService.storageService.writeJson(PATHS.connectionPlugins, config);
  }

  private resolvePluginId(pluginId: string, kind?: PluginKind): string {
    const k = kind ?? resolvePluginKind(pluginId);
    if (k === 'gf') return resolveGfPluginId(pluginId);
    if (k === 'wx') return resolveWxPluginId(pluginId);
    if (k === 'ss') return resolveSsPluginId(pluginId);
    return resolveKakakePluginId(pluginId);
  }

  private pluginKeyMatches(plugins: Record<string, boolean>, pluginId: string, resolved: string): boolean {
    if (plugins[resolved] === true || plugins[pluginId] === true) return true;
    const lower = pluginId.toLowerCase();
    for (const [key, on] of Object.entries(plugins)) {
      if (!on) continue;
      if (key.toLowerCase() === lower || key.toLowerCase() === resolved.toLowerCase()) return true;
      if (key === `GF-plugin-${pluginId}` || key === `GF-plugin-${resolved}`) return true;
      if (key === `WX-plugin-${pluginId}` || key === `WX-plugin-${resolved}`) return true;
    }
    return false;
  }

  isEnabled(connectionId: string, pluginId: string, kind?: PluginKind): boolean {
    const resolved = this.resolvePluginId(pluginId, kind);
    const plugins = this.load()[connectionId];
    if (!plugins) return false;
    return this.pluginKeyMatches(plugins, pluginId, resolved);
  }

  isEnabledOnAnyConnection(pluginId: string, kind?: PluginKind): boolean {
    const resolved = this.resolvePluginId(pluginId, kind);
    const config = this.load();
    for (const plugins of Object.values(config)) {
      if (this.pluginKeyMatches(plugins, pluginId, resolved)) return true;
    }
    return false;
  }

  /** 插件是否在任意「已启用」且类型匹配的连接上开启 */
  isEnabledOnAnyActiveConnection(pluginId: string, kind?: PluginKind): boolean {
    const k = kind ?? resolvePluginKind(pluginId);
    const resolved = this.resolvePluginId(pluginId, k);
    const wantType = connectionTypeForKind(k);
    const config = this.load();
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable) continue;
      const connType = conn.type ?? 'onebot';
      if (connType !== wantType) continue;
      const plugins = config[conn.id];
      if (plugins && this.pluginKeyMatches(plugins, pluginId, resolved)) return true;
    }
    return false;
  }

  setEnabled(connectionId: string, pluginId: string, enable: boolean, kind?: PluginKind): void {
    const conn = configService.getConnection(connectionId);
    if (!conn) return;
    const k = kind ?? resolvePluginKind(pluginId);
    if (k === 'gf' && !isQqOfficialConnection(conn)) return;
    if (k === 'wx' && !isWeixinBotConnection(conn)) return;
    if (k === 'ss' && !isKookConnection(conn)) return;
    if (k === 'kakake' && !isOnebotConnection(conn)) return;

    const resolved = this.resolvePluginId(pluginId, k);
    const config = this.load();
    if (!config[connectionId]) config[connectionId] = {};
    const bucket = config[connectionId];
    for (const key of Object.keys(bucket)) {
      if (
        key === pluginId
        || key === resolved
        || key === `GF-plugin-${pluginId}`
        || key === `GF-plugin-gf-plugin-mk`
        || key === `WX-plugin-${pluginId}`
        || key.toLowerCase() === pluginId.toLowerCase()
        || key.toLowerCase() === resolved.toLowerCase()
      ) {
        delete bucket[key];
      }
    }
    if (enable) {
      bucket[resolved] = true;
    } else {
      bucket[resolved] = false;
    }
    this.save(config);
  }

  removeConnection(connectionId: string): void {
    const config = this.load();
    if (!config[connectionId]) return;
    delete config[connectionId];
    this.save(config);
  }

  /** 卸载插件时清掉各连接上的子开关记录（含历史别名键） */
  removePluginEverywhere(pluginId: string, kind?: PluginKind): void {
    const resolved = this.resolvePluginId(pluginId, kind);
    const config = this.load();
    let changed = false;
    for (const bucket of Object.values(config)) {
      for (const key of Object.keys(bucket)) {
        if (
          key === pluginId
          || key === resolved
          || key === `GF-plugin-${pluginId}`
          || key === `GF-plugin-gf-plugin-mk`
          || key === `WX-plugin-${pluginId}`
          || key.toLowerCase() === pluginId.toLowerCase()
          || key.toLowerCase() === resolved.toLowerCase()
        ) {
          delete bucket[key];
          changed = true;
        }
      }
    }
    if (changed) this.save(config);
  }

  /**
   * 仅在「从未写过 connection-plugins.json」时，把旧版全局 plugins.json 启停迁到各连接。
   */
  migrateFromGlobalIfNeeded(): void {
    if (fs.existsSync(PATHS.connectionPlugins)) return;

    const global = configService.getPluginStatus();
    const enabledIds = Object.entries(global).filter(([, v]) => v).map(([id]) => id);
    const { connections } = configService.getConnections();

    const migrated: ConnectionPluginsConfig = {};
    if (enabledIds.length > 0 && connections.length > 0) {
      for (const conn of connections) {
        if (!isOnebotConnection(conn)) continue;
        migrated[conn.id] = {};
        for (const pluginId of enabledIds) {
          migrated[conn.id][pluginId] = true;
        }
      }
    }
    this.save(migrated);
  }
}

export const connectionPluginService = new ConnectionPluginService();
