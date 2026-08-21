/** 控制台内嵌插件后台（方案 B）路径 */

export function pluginHostConsolePath(
  pluginId: string,
  pagePath: string,
  accountKey?: string,
): string {
  const page = String(pagePath || 'admin').replace(/^\/+/, '');
  const id = encodeURIComponent(pluginId);
  if (accountKey) {
    return `/plugins/${id}/a/${encodeURIComponent(accountKey)}/pages/${page}`;
  }
  return `/plugins/${id}/pages/${page}`;
}

export function pluginLegacyHtmlUrl(
  pluginId: string,
  pagePath: string,
  accountKey?: string,
): string {
  const page = String(pagePath || 'admin').replace(/^\/+/, '');
  const id = encodeURIComponent(pluginId);
  if (accountKey) {
    return `/plugin/${id}/a/${encodeURIComponent(accountKey)}/page/${page}`;
  }
  return `/plugin/${id}/page/${page}`;
}

export function pluginModuleAssetUrl(
  pluginId: string,
  moduleRel: string,
  accountKey?: string,
): string {
  const rel = String(moduleRel || '').replace(/^\/+/, '');
  const id = encodeURIComponent(pluginId);
  if (accountKey) {
    return `/plugin/${id}/a/${encodeURIComponent(accountKey)}/module/${rel}`;
  }
  return `/plugin/${id}/module/${rel}`;
}

export function pluginExtApiBase(pluginId: string, accountKey?: string): string {
  const id = encodeURIComponent(pluginId);
  if (accountKey) {
    return `/api/Plugin/ext/${id}/a/${encodeURIComponent(accountKey)}`;
  }
  return `/api/Plugin/ext/${id}`;
}
