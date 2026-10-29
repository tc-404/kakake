/** GF 官方机器人插件目录命名前缀，例如 GF-plugin-foo */
export const GF_PLUGIN_DIR_PREFIX = 'GF-';

export function isGfPluginDir(dirName: string): boolean {
  return dirName.startsWith(GF_PLUGIN_DIR_PREFIX);
}

export function toGfPluginDirName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${GF_PLUGIN_DIR_PREFIX}plugin-unknown`;
  if (isGfPluginDir(trimmed)) return trimmed;
  // gf-plugin-mk → GF-plugin-mk（避免变成 GF-plugin-gf-plugin-mk）
  if (/^gf-plugin-/i.test(trimmed)) {
    return `${GF_PLUGIN_DIR_PREFIX}${trimmed.slice('gf-'.length)}`;
  }
  if (trimmed.startsWith('plugin-')) return `${GF_PLUGIN_DIR_PREFIX}${trimmed}`;
  return `${GF_PLUGIN_DIR_PREFIX}plugin-${trimmed}`;
}

export function resolveGfPluginId(pluginId: string): string {
  return toGfPluginDirName(pluginId);
}
