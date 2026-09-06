/** 与后端 plugin-host-paths 对齐的前端路径工具（避免 web 依赖后端 ts 路径） */

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
