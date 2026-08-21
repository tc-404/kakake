import fs from 'node:fs';
import path from 'node:path';
import type { PluginManager } from './plugin.manager.js';
import type { GfPluginManager } from './gf-plugin.manager.js';
import type { WxPluginManager } from './wx-plugin.manager.js';
import type { PluginConfigSchema, PluginEntry } from './plugin.types.js';

export interface PluginConfigView {
  id: string;
  name: string;
  schema: PluginConfigSchema;
  config: Record<string, unknown>;
  supportReactive: boolean;
  hasConfig: boolean;
}

type PluginKind = 'ob' | 'gf' | 'wx';

type ResolvedPlugin = {
  entry: PluginEntry;
  kind: PluginKind;
};

export class PluginConfigService {
  constructor(
    private readonly pluginManager: PluginManager,
    private readonly gfPluginManager?: GfPluginManager,
    private readonly wxPluginManager?: WxPluginManager,
  ) {}

  private resolvePlugin(pluginId: string): ResolvedPlugin | null {
    const ob = this.pluginManager.getPluginInfo(pluginId);
    if (ob) return { entry: ob, kind: 'ob' };
    const gf = this.gfPluginManager?.getPluginInfo(pluginId);
    if (gf) return { entry: gf, kind: 'gf' };
    const wx = this.wxPluginManager?.getPluginInfo(pluginId);
    if (wx) return { entry: wx, kind: 'wx' };
    return null;
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
    await this.pluginManager.reloadPlugin(pluginId);
  }

  getConfigView(pluginId: string): PluginConfigView | null {
    const resolved = this.resolvePlugin(pluginId);
    if (!resolved) return null;

    const { entry } = resolved;
    const module = entry.runtime.module;
    const schema = this.resolveSchema(entry);
    const config = this.readConfig(pluginId, entry);
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

  private readConfig(pluginId: string, entry: PluginEntry): Record<string, unknown> {
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

    const configPath = ctx?.configPath || this.pluginManager.getPluginConfigPath(pluginId);
    if (fs.existsSync(configPath)) {
      try {
        return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      } catch { /* ignore */ }
    }

    return {};
  }

  async readConfigAsync(pluginId: string): Promise<Record<string, unknown>> {
    const resolved = this.resolvePlugin(pluginId);
    if (!resolved) return {};

    const { entry } = resolved;
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

    return this.readConfig(pluginId, entry);
  }

  async saveConfig(pluginId: string, config: Record<string, unknown>): Promise<void> {
    const resolved = this.resolvePlugin(pluginId);
    if (!resolved) throw new Error('插件不存在');

    const { entry, kind } = resolved;
    const ctx = entry.runtime.context;
    const mod = entry.runtime.module;

    if (mod?.plugin_set_config && ctx) {
      await mod.plugin_set_config(ctx, config);
      return;
    }

    const configPath = ctx?.configPath || this.pluginManager.getPluginConfigPath(pluginId);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
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
