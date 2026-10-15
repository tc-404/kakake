import fs from 'node:fs';
import type { KakakeConfig, ConnectionConfig, ConnectionsFile, PluginStatusConfig, StoredConnectionsFile, ConnectionPluginsConfig } from '../core/types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONNECTIONS,
  normalizeApiTimeoutMs,
  normalizeConnection,
} from '../core/types.js';
import { PATHS } from '../paths.js';
import { FileStorage } from '../storage/file-storage.js';

/**
 * 缓存槽：记录上次读盘时文件的「mtime+size」指纹。
 * 读取路径（消息热路径）上每次只做一次 statSync（约微秒级），
 * 指纹未变直接复用上次解析结果，避免每条消息反复读盘 + JSON.parse。
 * size 参与校验可规避「同毫秒内覆盖写导致 mtime 相同」的极端碰撞。
 * 写入路径（save*）写盘成功后用新值刷新缓存；手动改文件会因指纹变化自动重读。
 */
interface CacheSlot<T> {
  stamp: string;
  value: T;
}

/** 取文件「mtime:size」指纹；文件不存在返回 '-'（同样可作缓存键） */
function statStamp(absFile: string): string {
  try {
    const st = fs.statSync(absFile);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

export class ConfigService {
  private readonly storage = new FileStorage(PATHS.data);
  private configCache: CacheSlot<KakakeConfig> | null = null;
  private connectionsCache: CacheSlot<ConnectionsFile> | null = null;
  private pluginStatusCache: CacheSlot<PluginStatusConfig> | null = null;
  private connectionPluginsCache: CacheSlot<ConnectionPluginsConfig> | null = null;

  getConfig(): KakakeConfig {
    const stamp = statStamp(PATHS.config);
    if (this.configCache && this.configCache.stamp === stamp) return this.configCache.value;
    const raw = this.storage.readJson<Partial<KakakeConfig>>(PATHS.config, DEFAULT_CONFIG);
    const value: KakakeConfig = {
      ...DEFAULT_CONFIG,
      ...raw,
      apiTimeoutMs: normalizeApiTimeoutMs(raw.apiTimeoutMs),
    };
    this.configCache = { stamp, value };
    return value;
  }

  saveConfig(config: KakakeConfig): void {
    this.storage.writeJson(PATHS.config, config);
    this.configCache = { stamp: statStamp(PATHS.config), value: config };
  }

  getConnections(): ConnectionsFile {
    const stamp = statStamp(PATHS.connections);
    if (this.connectionsCache && this.connectionsCache.stamp === stamp) {
      return this.connectionsCache.value;
    }
    const value = this.readConnectionsFromDisk();
    this.connectionsCache = { stamp, value };
    return value;
  }

  private readConnectionsFromDisk(): ConnectionsFile {
    const raw = this.storage.readJson<StoredConnectionsFile>(PATHS.connections, DEFAULT_CONNECTIONS);
    let backfilled = false;
    const baseTs = Date.now() - raw.connections.length * 1000;
    const connections = raw.connections.map((c, i) => {
      const n = normalizeConnection(c);
      if (n.createdAt == null || !Number.isFinite(n.createdAt)) {
        // 无记录时间：按文件中的顺序视为添加先后（越靠前越早）
        n.createdAt = baseTs + i;
        backfilled = true;
      }
      return n;
    });
    const normalized: ConnectionsFile = { connections };
    if (
      backfilled
      || JSON.stringify(raw.connections) !== JSON.stringify(normalized.connections)
    ) {
      this.storage.writeJson(PATHS.connections, normalized);
    }
    return normalized;
  }

  saveConnections(data: ConnectionsFile): void {
    this.storage.writeJson(PATHS.connections, data);
    this.connectionsCache = { stamp: statStamp(PATHS.connections), value: data };
  }

  getConnection(id: string): ConnectionConfig | undefined {
    return this.getConnections().connections.find(c => c.id === id);
  }

  getPluginStatus(): PluginStatusConfig {
    const stamp = statStamp(PATHS.pluginsStatus);
    if (this.pluginStatusCache && this.pluginStatusCache.stamp === stamp) {
      return this.pluginStatusCache.value;
    }
    const value = this.storage.readJson<PluginStatusConfig>(PATHS.pluginsStatus, {});
    this.pluginStatusCache = { stamp, value };
    return value;
  }

  savePluginStatus(status: PluginStatusConfig): void {
    this.storage.writeJson(PATHS.pluginsStatus, status);
    this.pluginStatusCache = { stamp: statStamp(PATHS.pluginsStatus), value: status };
  }

  /** connection-plugins.json（各连接的插件子开关），同样走指纹缓存 */
  getConnectionPlugins(): ConnectionPluginsConfig {
    const stamp = statStamp(PATHS.connectionPlugins);
    if (this.connectionPluginsCache && this.connectionPluginsCache.stamp === stamp) {
      return this.connectionPluginsCache.value;
    }
    const value = this.storage.readJson<ConnectionPluginsConfig>(PATHS.connectionPlugins, {});
    this.connectionPluginsCache = { stamp, value };
    return value;
  }

  saveConnectionPlugins(config: ConnectionPluginsConfig): void {
    this.storage.writeJson(PATHS.connectionPlugins, config);
    this.connectionPluginsCache = { stamp: statStamp(PATHS.connectionPlugins), value: config };
  }

  get storageService(): FileStorage {
    return this.storage;
  }
}

export const configService = new ConfigService();
