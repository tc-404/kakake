import fs from 'node:fs';
import type { ConnectionPluginsConfig, ConnectionType } from '../core/types.js';
import { configService } from '../core/config.service.js';
import {
  isOnebotConnection,
} from '../core/types.js';
import { resolveKakakePluginId } from './plugin-id.js';
import { resolveGfPluginId, isGfPluginDir } from './gf-plugin-id.js';
import { resolveWxPluginId, isWxPluginDir } from './wx-plugin-id.js';
import { resolveSsPluginId, isSsPluginDir } from './ss-plugin-id.js';
import { resolveSssxPluginId, isSssxPluginDir } from './sssx-plugin-id.js';
import { PATHS } from '../paths.js';

/** 'sssx' = 双生插件：同一份代码同时可挂在 OneBot 与 QQ 官方机器人两条协议上 */
export type PluginKind = 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx';

function resolvePluginKind(pluginId: string): PluginKind {
  // sssx 必须早于 ss：sssx-plugin-foo 的宽松别名正则会被 ss 的规则误吞
  if (isSssxPluginDir(pluginId) || /^sssx[-_]?plugin/i.test(pluginId)) {
    return 'sssx';
  }
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

/**
 * 该种类插件能挂在哪些连接类型上。
 * 双生插件（sssx）返回两种——这正是「双路由」的唯一真相来源。
 */
function connectionTypesForKind(kind: PluginKind): ConnectionType[] {
  if (kind === 'sssx') return ['onebot', 'qq_official'];
  if (kind === 'gf') return ['qq_official'];
  if (kind === 'wx') return ['weixin_bot'];
  if (kind === 'ss') return ['kook'];
  return ['onebot'];
}

class ConnectionPluginService {
  load(): ConnectionPluginsConfig {
    // 走 ConfigService 的 mtime 缓存：热路径（每条消息 × 每个插件实例）不再重复读盘
    return configService.getConnectionPlugins();
  }

  save(config: ConnectionPluginsConfig): void {
    configService.saveConnectionPlugins(config);
  }

  private resolvePluginId(pluginId: string, kind?: PluginKind): string {
    const k = kind ?? resolvePluginKind(pluginId);
    if (k === 'sssx') return resolveSssxPluginId(pluginId);
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
    const wantTypes = connectionTypesForKind(k);
    const config = this.load();
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable) continue;
      const connType = conn.type ?? 'onebot';
      if (!wantTypes.includes(connType)) continue;
      const plugins = config[conn.id];
      if (plugins && this.pluginKeyMatches(plugins, pluginId, resolved)) return true;
    }
    return false;
  }

  setEnabled(connectionId: string, pluginId: string, enable: boolean, kind?: PluginKind): void {
    const conn = configService.getConnection(connectionId);
    if (!conn) return;
    const k = kind ?? resolvePluginKind(pluginId);
    const wantTypes = connectionTypesForKind(k);
    // 双生插件允许落在 OneBot 或 QQ 官方连接上；其余种类必须与连接类型严格一致
    if (!wantTypes.includes(conn.type ?? 'onebot')) return;

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
