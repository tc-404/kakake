import fs from 'node:fs';
import path from 'node:path';
import type { PluginEntry, PluginPackageJson, KakakePluginManifest } from './plugin.types.js';
import { isKakakePluginDir } from './plugin-id.js';
import { isGfPluginDir } from './gf-plugin-id.js';
import { PATHS } from '../paths.js';

import { DEFAULT_PLUGIN_ICON, DEFAULT_PLUGIN_ICON_DATA_URI } from './default-plugin-icon.js';

export { DEFAULT_PLUGIN_ICON, DEFAULT_PLUGIN_ICON_DATA_URI };
export function readPluginManifest(pluginDir: string): KakakePluginManifest | undefined {
  const manifestPath = path.join(pluginDir, 'plugin.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as KakakePluginManifest;
  } catch {
    return undefined;
  }
}

export function resolvePluginDisplayName(entry: PluginEntry): string {
  return entry.pluginJson?.displayName
    || entry.packageJson?.plugin
    || entry.name
    || entry.pluginJson?.name
    || entry.packageJson?.name
    || entry.id;
}

export function resolvePluginAuthor(entry: PluginEntry): string {
  return entry.pluginJson?.author || entry.packageJson?.author || entry.author || '';
}

export function resolvePluginVersion(entry: PluginEntry): string {
  return entry.pluginJson?.version || entry.packageJson?.version || entry.version || '0.0.0';
}

export function resolvePluginIconPath(entry: PluginEntry): string | undefined {
  const rel = entry.pluginJson?.icon;
  if (!rel) return undefined;
  const abs = path.join(entry.pluginPath, rel);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return undefined;
  return rel.replace(/\\/g, '/');
}

export function resolvePluginIconUrl(entry: PluginEntry): string {
  const rel = resolvePluginIconPath(entry);
  if (rel) {
    return `/api/Plugin/Asset?id=${encodeURIComponent(entry.id)}&file=${encodeURIComponent(rel)}`;
  }
  return DEFAULT_PLUGIN_ICON;
}

/** 插件安装目录内的说明文档文件名 */
export const PLUGIN_DOCS_FILENAME = '插件文档.md';

export function resolvePluginDocsPath(pluginDir: string): string | null {
  const abs = path.join(pluginDir, PLUGIN_DOCS_FILENAME);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
  return abs;
}

export function pluginDirHasDocs(pluginDir: string): boolean {
  return !!resolvePluginDocsPath(pluginDir);
}

/** 优先读 plugins/<id>/插件文档.md，其次任意候选目录 */
export function resolveInstalledPluginDocs(
  pluginId: string,
  extraDirs: string[] = [],
): string | null {
  const dirs = [path.join(PATHS.plugins, pluginId), ...extraDirs];
  for (const dir of dirs) {
    if (!dir) continue;
    const found = resolvePluginDocsPath(dir);
    if (found) return found;
  }
  return null;
}

/** Web 插件列表状态（全局：总开关 + 运行态） */
export function mapPluginListStatus(
  entry: PluginEntry,
  masterEnabled = true,
): 'active' | 'stopped' | 'disabled' | 'error' {
  if (!masterEnabled) return 'disabled';
  if (entry.enable && entry.loaded) return 'active';
  if (entry.enable && entry.runtime.status === 'error') return 'error';
  if (entry.enable) return 'stopped';
  if (entry.runtime.status === 'error') return 'error';
  return 'disabled';
}

/** 连接作用域下的插件状态（子开关；总关时也显示 disabled） */
export function mapConnectionPluginListStatus(
  entry: PluginEntry,
  connectionEnabled: boolean,
  masterEnabled = true,
): 'active' | 'stopped' | 'disabled' | 'error' {
  if (!masterEnabled || !connectionEnabled) return 'disabled';
  if (entry.runtime.status === 'error') return 'error';
  if (entry.loaded) return 'active';
  return 'stopped';
}

export function buildPluginListItem(
  entry: PluginEntry,
  opts: { hasPages: boolean; connectionEnabled?: boolean; masterEnabled?: boolean },
) {
  const masterEnabled = opts.masterEnabled ?? true;
  const status = opts.connectionEnabled !== undefined
    ? mapConnectionPluginListStatus(entry, opts.connectionEnabled, masterEnabled)
    : mapPluginListStatus(entry, masterEnabled);
  const installDocs = path.join(PATHS.plugins, entry.id);
  const hasDocs = pluginDirHasDocs(installDocs) || pluginDirHasDocs(entry.pluginPath);
  return {
    name: resolvePluginDisplayName(entry),
    id: entry.id,
    version: resolvePluginVersion(entry),
    description: entry.packageJson?.description || '',
    author: resolvePluginAuthor(entry),
    iconUrl: resolvePluginIconUrl(entry),
    status,
    connectionEnabled: opts.connectionEnabled,
    masterEnabled,
    errorMessage: entry.runtime.error || '',
    hasConfig: !!(entry.runtime.module?.plugin_config_ui || entry.runtime.module?.plugin_get_config),
    hasPages: opts.hasPages,
    hasDocs,
    homepage: entry.packageJson?.homepage,
  };
}

export function mergePluginMetadata(
  dirname: string,
  pluginDir: string,
  packageJson?: PluginPackageJson,
  pluginJson?: KakakePluginManifest,
): Pick<PluginEntry, 'id' | 'name' | 'version' | 'author' | 'description'> {
  const manifestId = packageJson?.name || pluginJson?.name;
  // 目录名即稳定 ID（kakake-* / GF-*），勿用 package.json name（如 gf-plugin-mk）覆盖
  const id = isKakakePluginDir(dirname) || isGfPluginDir(dirname)
    ? dirname
    : (manifestId || dirname);
  return {
    id,
    name: pluginJson?.displayName || packageJson?.plugin || packageJson?.name || pluginJson?.name,
    version: pluginJson?.version || packageJson?.version,
    author: pluginJson?.author || packageJson?.author,
    description: packageJson?.description,
  };
}
