/** 其他类型插件目录命名前缀，例如 ss-plugin-foo */
export const SS_PLUGIN_DIR_PREFIX = 'ss-plugin-';

export function isSsPluginDir(dirName: string): boolean {
  return dirName.startsWith(SS_PLUGIN_DIR_PREFIX);
}

export function toSsPluginDirName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${SS_PLUGIN_DIR_PREFIX}unknown`;
  if (isSsPluginDir(trimmed)) return trimmed;
  // ss_plugin-foo / ssplugin-foo / SSPlugin-foo → ss-plugin-foo
  const stripped = trimmed.replace(/^ss[-_]?plugin[-_]?/i, '');
  if (stripped !== trimmed) {
    return stripped ? `ss-plugin-${stripped}` : `${SS_PLUGIN_DIR_PREFIX}unknown`;
  }
  if (trimmed.startsWith('plugin-')) return `${SS_PLUGIN_DIR_PREFIX}${trimmed.slice('plugin-'.length)}`;
  return `${SS_PLUGIN_DIR_PREFIX}${trimmed}`;
}

export function resolveSsPluginId(pluginId: string): string {
  return toSsPluginDirName(pluginId);
}
