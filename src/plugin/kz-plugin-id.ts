import { assertSafePluginDirName } from './plugin-dir-safety.js';

/**
 * 「扩展」插件目录前缀 kz-plugin-*。
 *
 * 扩展插件不绑定任何连接：不接事件、不收上报、没有连接级子开关，
 * 只由插件列表的总开关启停；数据目录直接落在 data/<pluginId>。
 * 前缀与其它几套（kakake- / GF- / WX- / ss-plugin- / sssx-plugin-）互不重叠，
 * 所以判定顺序不敏感，但归一化必须早于 toKakakePluginDirName 的兜底分支。
 */
export const KZ_PLUGIN_DIR_PREFIX = 'kz-plugin-';

/** 是否为扩展插件目录名 */
export function isKzPluginDir(dirName: string): boolean {
  return String(dirName || '').startsWith(KZ_PLUGIN_DIR_PREFIX);
}

/** 将任意插件名规范为 kz-plugin-* 目录名 */
export function toKzPluginDirName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return `${KZ_PLUGIN_DIR_PREFIX}unknown`;
  assertSafePluginDirName(trimmed);
  if (isKzPluginDir(trimmed)) return trimmed;

  // KZ-Plugin-foo / kz_plugin-foo / kzplugin-foo → kz-plugin-foo
  const stripped = trimmed.replace(/^kz[-_]?plugin[-_]?/i, '');
  if (stripped !== trimmed) {
    return stripped ? `${KZ_PLUGIN_DIR_PREFIX}${stripped}` : `${KZ_PLUGIN_DIR_PREFIX}unknown`;
  }

  if (trimmed.startsWith('plugin-')) {
    return `${KZ_PLUGIN_DIR_PREFIX}${trimmed.slice('plugin-'.length)}`;
  }
  return `${KZ_PLUGIN_DIR_PREFIX}${trimmed}`;
}

/** 解析扩展插件 ID */
export function resolveKzPluginId(pluginId: string): string {
  return toKzPluginDirName(pluginId);
}
