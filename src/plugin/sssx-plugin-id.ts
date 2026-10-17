/**
 * 双生插件目录命名前缀，例如 sssx-plugin-hello。
 *
 * 「双生」= 同一份插件代码同时挂在两条协议上：OneBot（kakake- 那条路）
 * 与 QQ 官方机器人（GF- 那条路）。框架只负责把它**同时**装载到两类连接上，
 * 事件怎么区分、消息怎么发，由插件自己处理。
 *
 * ⚠️ 前缀判定要早于 ss-plugin-：`sssx-plugin-foo` 不以 `ss-plugin-` 开头，
 *    但反过来的宽松别名正则会误吞，所以调用方必须先判 sssx 再判 ss。
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
