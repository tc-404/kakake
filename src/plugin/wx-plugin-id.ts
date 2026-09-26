/** 微信机器人插件目录命名前缀，例如 WX-plugin-wxbot */
export const WX_PLUGIN_DIR_PREFIX = 'WX-';

export function isWxPluginDir(dirName: string): boolean {
  return dirName.startsWith(WX_PLUGIN_DIR_PREFIX);
}

export function toWxPluginDirName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${WX_PLUGIN_DIR_PREFIX}plugin-unknown`;
  if (isWxPluginDir(trimmed)) return trimmed;
  if (/^wx-plugin-/i.test(trimmed)) {
    return `${WX_PLUGIN_DIR_PREFIX}${trimmed.slice('wx-'.length)}`;
  }
  if (/^wxbot[-_]?/i.test(trimmed)) {
    return `${WX_PLUGIN_DIR_PREFIX}plugin-wxbot`;
  }
  if (trimmed.startsWith('plugin-')) return `${WX_PLUGIN_DIR_PREFIX}${trimmed}`;
  return `${WX_PLUGIN_DIR_PREFIX}plugin-${trimmed}`;
}

export function resolveWxPluginId(pluginId: string): string {
  return toWxPluginDirName(pluginId);
}
