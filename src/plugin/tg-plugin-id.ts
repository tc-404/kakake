import { assertSafePluginDirName } from './plugin-dir-safety.js';

/**
 * Telegram Bot 插件目录命名前缀，例如 TG-plugin-foo。
 *
 * 识别大小写不敏感，并兼容历史 / 别名写法：
 *   TG-plugin-foo / tg-plugin-foo / TGPlugin-foo / TG_plugin-foo / tgbot-plugin-foo
 * 规范化输出统一保持 `TG-plugin-`。
 */
export const TG_PLUGIN_DIR_PREFIX = 'TG-plugin-';

/** 目录名是否为 Telegram 插件（大小写不敏感，含 tgbot- 别名） */
const TG_PLUGIN_DIR_ALIAS = /^(?:tg|tgbot)[-_]?plugin[-_]/i;

export function isTgPluginDir(dirName: string): boolean {
  return TG_PLUGIN_DIR_ALIAS.test(String(dirName || ''));
}

/** 将任意插件名规范为 TG-plugin-* 目录名 */
export function toTgPluginDirName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) return `${TG_PLUGIN_DIR_PREFIX}unknown`;
  assertSafePluginDirName(trimmed);
  // 已经是规范前缀，别重复加
  if (trimmed.startsWith(TG_PLUGIN_DIR_PREFIX)) return trimmed;

  // tg-plugin-foo / TGPlugin-foo / TG_plugin-foo / tgbot-plugin-foo → TG-plugin-foo
  const stripped = trimmed.replace(/^(?:tg|tgbot)[-_]?plugin[-_]?/i, '');
  if (stripped !== trimmed) {
    return stripped ? `${TG_PLUGIN_DIR_PREFIX}${stripped}` : `${TG_PLUGIN_DIR_PREFIX}unknown`;
  }
  if (trimmed.startsWith('plugin-')) {
    return `${TG_PLUGIN_DIR_PREFIX}${trimmed.slice('plugin-'.length)}`;
  }
  return `${TG_PLUGIN_DIR_PREFIX}${trimmed}`;
}

export function resolveTgPluginId(pluginId: string): string {
  return toTgPluginDirName(pluginId);
}
