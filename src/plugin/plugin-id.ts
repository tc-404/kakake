import { isSsPluginDir } from './ss-plugin-id.js';

/** 咔咔珂插件目录命名前缀，例如 kakake-plugin-mkbot */
export const KAKAKE_PLUGIN_DIR_PREFIX = 'kakake-';

/** 旧版插件目录前缀（导入时自动转换为 kakake-） */
export const LEGACY_NAPCAT_PLUGIN_DIR_PREFIX = 'napcat-plugin-';

/** 内置插件默认 ID */
export const KAKAKE_BUILTIN_PLUGIN_ID = 'kakake-plugin-builtin';

/** 是否为有效的咔咔珂插件目录名 */
export function isKakakePluginDir(dirName: string): boolean {
  return dirName.startsWith(KAKAKE_PLUGIN_DIR_PREFIX);
}

/** 将任意插件名规范为 kakake- 目录名 */
export function toKakakePluginDirName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return `${KAKAKE_PLUGIN_DIR_PREFIX}plugin-unknown`;

  if (isKakakePluginDir(trimmed)) return trimmed;

  // 其他类型（ss-plugin-*）已是规范目录名，原样保留
  if (isSsPluginDir(trimmed)) return trimmed;

  if (trimmed.startsWith(LEGACY_NAPCAT_PLUGIN_DIR_PREFIX)) {
    // 旧前缀插件目录 → kakake-plugin-*（须保留 plugin- 段，不能变成 kakake-mkbot）
    return `${KAKAKE_PLUGIN_DIR_PREFIX}plugin-${trimmed.slice(LEGACY_NAPCAT_PLUGIN_DIR_PREFIX.length)}`;
  }

  if (trimmed.startsWith('plugin-')) {
    return `${KAKAKE_PLUGIN_DIR_PREFIX}${trimmed}`;
  }

  return `${KAKAKE_PLUGIN_DIR_PREFIX}plugin-${trimmed}`;
}

/** 解析插件 ID（兼容旧版命名） */
export function resolveKakakePluginId(pluginId: string): string {
  return toKakakePluginDirName(pluginId);
}

/** kakake-plugin-foo → 旧前缀别名（HTTP 路由 legacy 兼容） */
export function legacyNapcatPluginId(kakakePluginId: string): string | null {
  if (!kakakePluginId.startsWith(KAKAKE_PLUGIN_DIR_PREFIX)) return null;
  const rest = kakakePluginId.slice(KAKAKE_PLUGIN_DIR_PREFIX.length);
  if (rest.startsWith('plugin-')) {
    return `${LEGACY_NAPCAT_PLUGIN_DIR_PREFIX}${rest.slice('plugin-'.length)}`;
  }
  return `${LEGACY_NAPCAT_PLUGIN_DIR_PREFIX}${rest}`;
}

/** 解析 HTTP 路由可能使用的插件 ID 变体（去重） */
export function resolvePluginHttpIds(pluginId: string): string[] {
  const ids = new Set<string>();
  const trimmed = pluginId.trim();
  if (trimmed) ids.add(trimmed);
  const kakakeId = resolveKakakePluginId(trimmed);
  ids.add(kakakeId);
  const legacyId = legacyNapcatPluginId(kakakeId);
  if (legacyId) ids.add(legacyId);
  return [...ids];
}
