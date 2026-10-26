/**
 * 双生插件目录前缀 sssx-plugin-*：「双生」= 同一份代码同时挂 OneBot 与 QQ 官方两条协议。
 * ⚠️ 前缀判定必须先于 ss-plugin-：sssx-plugin-foo 不以 ss-plugin- 开头，宽松别名会误吞，须先判 sssx 再判 ss。
 */
export const SSSX_PLUGIN_DIR_PREFIX = 'sssx-plugin-';

/** 是否为双生插件目录名 */
export function isSssxPluginDir(dirName: string): boolean {
  return String(dirName || '').startsWith(SSSX_PLUGIN_DIR_PREFIX);
}

/** 将任意插件名规范为 sssx-plugin-* 目录名 */
export function toSssxPluginDirName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return `${SSSX_PLUGIN_DIR_PREFIX}unknown`;
  if (isSssxPluginDir(trimmed)) return trimmed;

  // sssx_plugin-foo / sssxplugin-foo / SSSXPlugin-foo → sssx-plugin-foo
  const stripped = trimmed.replace(/^sssx[-_]?plugin[-_]?/i, '');
  if (stripped !== trimmed) {
    return stripped ? `sssx-plugin-${stripped}` : `${SSSX_PLUGIN_DIR_PREFIX}unknown`;
  }

  if (trimmed.startsWith('plugin-')) {
    return `${SSSX_PLUGIN_DIR_PREFIX}${trimmed.slice('plugin-'.length)}`;
  }
  return `${SSSX_PLUGIN_DIR_PREFIX}${trimmed}`;
}

/** 解析双生插件 ID */
export function resolveSssxPluginId(pluginId: string): string {
  return toSssxPluginDirName(pluginId);
}
