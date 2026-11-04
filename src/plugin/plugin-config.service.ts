import type { PluginManager } from './plugin.manager.js';
import type { GfPluginManager } from './gf-plugin.manager.js';
import type { WxPluginManager } from './wx-plugin.manager.js';
import type { SsPluginManager } from './ss-plugin.manager.js';
import type { SssxPluginManager } from './sssx-plugin.manager.js';
import type { KzPluginManager } from './kz-plugin.manager.js';
import type { PluginConfigSchema, PluginEntry } from './plugin.types.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

export interface PluginConfigView {
  id: string;
  name: string;
  schema: PluginConfigSchema;
  config: Record<string, unknown>;
  supportReactive: boolean;
  hasConfig: boolean;
}

type PluginKind = 'ob' | 'gf' | 'wx' | 'ss' | 'sssx' | 'kz';

type ResolvedPlugin = {
  entry: PluginEntry;
  kind: PluginKind;
};

/** 配置视图只需要管理器的这两项能力，避免为六套类型写六个分支 */
type ConfigRuntimeHost = {
  getRuntimeEntry?(pluginId: string, accountKey: string): PluginEntry | undefined;
  getPluginConfigPath?(pluginId: string, accountKey?: string | null): string;
};

export class PluginConfigService {
  constructor(
    private readonly pluginManager: PluginManager,
    private readonly gfPluginManager?: GfPluginManager,
    private readonly wxPluginManager?: WxPluginManager,
    private readonly ssPluginManager?: SsPluginManager,
    private readonly sssxPluginManager?: SssxPluginManager,
    private readonly kzPluginManager?: KzPluginManager,
  ) {}

  private resolvePlugin(pluginId: string): ResolvedPlugin | null {
    // 扩展插件前缀与其它几套不重叠，先判
    const kz = this.kzPluginManager?.getPluginInfo(pluginId);
    if (kz) return { entry: kz, kind: 'kz' };
    const ob = this.pluginManager.getPluginInfo(pluginId);
    if (ob) return { entry: ob, kind: 'ob' };
    const gf = this.gfPluginManager?.getPluginInfo(pluginId);
    if (gf) return { entry: gf, kind: 'gf' };
    const wx = this.wxPluginManager?.getPluginInfo(pluginId);
    if (wx) return { entry: wx, kind: 'wx' };
    // sssx 必须早于 ss：sssx-plugin-* 的字面量不会命中 ss，但别名兜底顺序别反
    const sssx = this.sssxPluginManager?.getPluginInfo(pluginId);
    if (sssx) return { entry: sssx, kind: 'sssx' };
    const ss = this.ssPluginManager?.getPluginInfo(pluginId);
    if (ss) return { entry: ss, kind: 'ss' };
    return null;
  }

  private managerFor(kind: PluginKind): ConfigRuntimeHost | undefined {
    const manager = kind === 'gf'
      ? this.gfPluginManager
      : kind === 'wx'
        ? this.wxPluginManager
        : kind === 'sssx'
          ? this.sssxPluginManager
          : kind === 'ss'
            ? this.ssPluginManager
            : kind === 'kz'
              ? this.kzPluginManager
              : this.pluginManager;
    return manager as unknown as ConfigRuntimeHost | undefined;
  }

  /**
   * 配置本来就在 `data/<账号>/<插件>/config.json`，所以指定账号时必须用**该账号的运行实例**
   * 取 schema / 读写。不指定账号时退回目录条目——它的 runtime 指向首个已加载实例，
   * 与旧行为一致（单账号时两者等价）。
   */
  private resolveRuntime(pluginId: string, accountKey?: string | null): ResolvedPlugin | null {
    const base = this.resolvePlugin(pluginId);
    if (!base) return null;
    const key = String(accountKey || '').trim();
    if (!key) return base;
    const runtimeEntry = this.managerFor(base.kind)?.getRuntimeEntry?.(base.entry.id, key);
    return runtimeEntry ? { entry: runtimeEntry, kind: base.kind } : base;
  }

  private async reloadByKind(kind: PluginKind, pluginId: string): Promise<void> {
    if (kind === 'gf') {
      await this.gfPluginManager?.reloadPlugin(pluginId);
      return;
    }
    if (kind === 'wx') {
      await this.wxPluginManager?.reloadPlugin(pluginId);
      return;
    }
    if (kind === 'sssx') {
      await this.sssxPluginManager?.reloadPlugin(pluginId);
      return;
    }
    if (kind === 'ss') {
      await this.ssPluginManager?.reloadPlugin(pluginId);
      return;
    }
    if (kind === 'kz') {
      await this.kzPluginManager?.reloadPlugin(pluginId);
      return;
    }
    await this.pluginManager.reloadPlugin(pluginId);
  }

  getConfigView(pluginId: string, accountKey?: string | null): PluginConfigView | null {
    const resolved = this.resolveRuntime(pluginId, accountKey);
    if (!resolved) return null;

    const { entry, kind } = resolved;
    const module = entry.runtime.module;
    const schema = this.resolveSchema(entry);
    const config = this.readConfig(pluginId, entry, kind, accountKey);
    const hasConfig = schema.length > 0
      || !!module?.plugin_get_config
      || !!module?.plugin_set_config
      || !!module?.plugin_config_controller;

    return {
      id: pluginId,
      name: entry.packageJson?.plugin || entry.name || pluginId,
      schema,
      config,
      supportReactive: !!(module?.plugin_config_controller || module?.plugin_on_config_change),
      hasConfig,
    };
  }

  private resolveSchema(entry: PluginEntry): PluginConfigSchema {
    const mod = entry.runtime.module;
    if (mod?.plugin_config_ui?.length) return mod.plugin_config_ui;
    if (mod?.plugin_config_schema?.length) return mod.plugin_config_schema;

    const exported = mod as Record<string, unknown> | undefined;
    if (Array.isArray(exported?.plugin_config_ui) && exported.plugin_config_ui.length) {
      return exported.plugin_config_ui as PluginConfigSchema;
    }

    return [];
  }

  private readConfig(
    pluginId: string,
    entry: PluginEntry,
    kind: PluginKind,
    accountKey?: string | null,
  ): Record<string, unknown> {
    const ctx = entry.runtime.context;
    const mod = entry.runtime.module;

    if (mod?.plugin_get_config && ctx) {
      try {
        const result = mod.plugin_get_config(ctx);
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          // sync fallback — async 走 readConfigAsync
        } else if (result && typeof result === 'object') {
          return result as Record<string, unknown>;
        }
      } catch { /* fall through */ }
    }

    // 未加载时没有 ctx：按插件类型回落到各自的配置路径（扩展插件是 data/<id>/config.json）
    const configPath = ctx?.configPath
      || this.managerFor(kind)?.getPluginConfigPath?.(pluginId, accountKey)
      || this.pluginManager.getPluginConfigPath(pluginId);
    return readJsonSafe<Record<string, unknown>>(configPath, {}, { label: `${pluginId}/config.json` });
  }

  async readConfigAsync(pluginId: string, accountKey?: string | null): Promise<Record<string, unknown>> {
    const resolved = this.resolveRuntime(pluginId, accountKey);
    if (!resolved) return {};

    const { entry, kind } = resolved;
    const ctx = entry.runtime.context;
    const mod = entry.runtime.module;

    if (mod?.plugin_get_config && ctx) {
      try {
        const result = await mod.plugin_get_config(ctx);
        if (result && typeof result === 'object') {
          return result as Record<string, unknown>;
        }
      } catch { /* fall through */ }
    }

    return this.readConfig(pluginId, entry, kind, accountKey);
  }

  async saveConfig(
    pluginId: string,
    config: Record<string, unknown>,
    accountKey?: string | null,
  ): Promise<void> {
    const resolved = this.resolveRuntime(pluginId, accountKey);
    if (!resolved) throw new Error('插件不存在');

    const { entry, kind } = resolved;
    const ctx = entry.runtime.context;
    const mod = entry.runtime.module;

    if (mod?.plugin_set_config && ctx) {
      await mod.plugin_set_config(ctx, config);
      return;
    }

    const configPath = ctx?.configPath
      || this.managerFor(kind)?.getPluginConfigPath?.(pluginId, accountKey)
      || this.pluginManager.getPluginConfigPath(pluginId);
    writeJsonAtomic(configPath, config);
    await this.reloadByKind(kind, pluginId);
  }

  /** 从 schema 合并默认值 */
  mergeDefaults(schema: PluginConfigSchema, config: Record<string, unknown>): Record<string, unknown> {
    const merged = { ...config };
    for (const item of schema) {
      if (item.key.startsWith('_') || item.hidden) continue;
      if (merged[item.key] === undefined && item.default !== undefined) {
        merged[item.key] = item.default;
      }
    }
    return merged;
  }

  /** 将表单 POST 数据转为配置对象 */
  parseFormBody(schema: PluginConfigSchema, body: Record<string, string | string[]>): Record<string, unknown> {
    const config: Record<string, unknown> = {};

    for (const item of schema) {
      if (item.key.startsWith('_') || item.type === 'html' || item.type === 'text') continue;

      const raw = body[item.key];
      if (raw === undefined) {
        if (item.type === 'boolean') config[item.key] = false;
        continue;
      }

      switch (item.type) {
        case 'boolean':
          config[item.key] = raw === 'true' || raw === 'on' || raw === '1';
          break;
        case 'number':
          config[item.key] = Number(raw);
          break;
        case 'multi-select':
          config[item.key] = Array.isArray(raw) ? raw : [raw];
          break;
        default:
          config[item.key] = raw;
      }
    }

    return config;
  }
}
