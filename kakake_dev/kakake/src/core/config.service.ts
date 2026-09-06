import type { KakakeConfig, ConnectionConfig, ConnectionsFile, PluginStatusConfig, StoredConnectionsFile } from '../core/types.js';
import {
  DEFAULT_CONFIG,
  DEFAULT_CONNECTIONS,
  normalizeApiTimeoutMs,
  normalizeConnection,
} from '../core/types.js';
import { PATHS } from '../paths.js';
import { FileStorage } from '../storage/file-storage.js';

export class ConfigService {
  private readonly storage = new FileStorage(PATHS.data);

  getConfig(): KakakeConfig {
    const raw = this.storage.readJson<Partial<KakakeConfig>>(PATHS.config, DEFAULT_CONFIG);
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      apiTimeoutMs: normalizeApiTimeoutMs(raw.apiTimeoutMs),
    };
  }

  saveConfig(config: KakakeConfig): void {
    this.storage.writeJson(PATHS.config, config);
  }

  getConnections(): ConnectionsFile {
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
  }

  getConnection(id: string): ConnectionConfig | undefined {
    return this.getConnections().connections.find(c => c.id === id);
  }

  getPluginStatus(): PluginStatusConfig {
    return this.storage.readJson<PluginStatusConfig>(PATHS.pluginsStatus, {});
  }

  savePluginStatus(status: PluginStatusConfig): void {
    this.storage.writeJson(PATHS.pluginsStatus, status);
  }

  get storageService(): FileStorage {
    return this.storage;
  }
}

export const configService = new ConfigService();
