import type { Request, Response } from 'express';

/** 运行时实例键：账号 + 插件 */
export function pluginRuntimeKey(accountKey: string, pluginId: string): string {
  return `${accountKey}::${pluginId}`;
}

export function parsePluginRuntimeKey(key: string): { accountKey: string; pluginId: string } | null {
  const i = key.indexOf('::');
  if (i <= 0) return null;
  return { accountKey: key.slice(0, i), pluginId: key.slice(i + 2) };
}

/** Cookie：记录最近打开的插件后台所属账号（兼容旧 /plugin/:id/api） */
export function pluginAccountCookieName(pluginId: string): string {
  const safe = String(pluginId || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `kk_pa_${safe}`;
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  const parts = raw.split(';');
  for (const p of parts) {
    const idx = p.indexOf('=');
    if (idx < 0) continue;
    const k = p.slice(0, idx).trim();
    if (k !== name) continue;
    return decodeURIComponent(p.slice(idx + 1).trim());
  }
  return undefined;
}

export function setPluginAccountCookie(res: Response, pluginId: string, accountKey: string): void {
  const name = pluginAccountCookieName(pluginId);
  const value = encodeURIComponent(accountKey);
  res.append('Set-Cookie', `${name}=${value}; Path=/; SameSite=Lax; Max-Age=2592000`);
}

/** 从 pathname 提取 /plugin|/plugins/:id/a/:account 或 /api/Plugin/ext/:id/a/:account */
function accountKeyFromPathname(pathname: string, pluginId: string): string | null {
  const id = escapeRegExp(pluginId);
  const patterns = [
    // 宿主 SPA：/plugins/:id/a/:account/pages/...
    new RegExp(`^/plugins/${id}/a/([^/]+)(?:/|$)`, 'i'),
    // 旧 HTML / 资源：/plugin/:id/a/:account/...
    new RegExp(`^/plugin/${id}/a/([^/]+)(?:/|$)`, 'i'),
    // 扩展 API：/api/Plugin/ext/:id/a/:account/...
    new RegExp(`^/api/Plugin/ext/${id}/a/([^/]+)(?:/|$)`, 'i'),
  ];
  for (const re of patterns) {
    const m = pathname.match(re);
    if (m?.[1]) return decodeURIComponent(m[1]);
  }
  return null;
}

export type AccountKeyExtract = {
  accountKey: string | null;
  source: 'path' | 'referer' | 'cookie' | 'query' | 'none';
  path?: string;
  refererPath?: string;
  cookieName?: string;
  cookieValue?: string | null;
};

/** 解析账号并标注来源（供排查 Cookie 抢账号） */
export function extractAccountKeyFromRequestDetailed(
  req: Request,
  pluginId: string,
): AccountKeyExtract {
  const path = req.path || '';
  const fromPath = accountKeyFromPathname(path, pluginId);
  if (fromPath) {
    return { accountKey: fromPath, source: 'path', path };
  }

  let refererPath = '';
  const referer = String(req.headers.referer || '');
  if (referer) {
    try {
      const u = new URL(referer);
      refererPath = u.pathname;
      const fromReferer = accountKeyFromPathname(u.pathname, pluginId);
      if (fromReferer) {
        return { accountKey: fromReferer, source: 'referer', path, refererPath };
      }
    } catch { /* ignore */ }
  }

  const cookieName = pluginAccountCookieName(pluginId);
  const fromCookie = readCookie(req, cookieName) || null;
  if (fromCookie) {
    return {
      accountKey: fromCookie,
      source: 'cookie',
      path,
      refererPath,
      cookieName,
      cookieValue: fromCookie,
    };
  }

  const q = req.query?.account ?? req.query?.accountKey;
  if (typeof q === 'string' && q.trim()) {
    return { accountKey: q.trim(), source: 'query', path, refererPath };
  }

  return {
    accountKey: null,
    source: 'none',
    path,
    refererPath,
    cookieName,
    cookieValue: null,
  };
}

/**
 * 从 URL / Referer / Cookie 解析账号。
 * 优先级：当前请求路径上的显式账号 > Referer 里的显式账号 > Cookie > query。
 * （Cookie 不能压过地址栏/宿主页账号，否则换账号打开后台会仍用旧 kk_pa_*）
 */
export function extractAccountKeyFromRequest(req: Request, pluginId: string): string | null {
  return extractAccountKeyFromRequestDetailed(req, pluginId).accountKey;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 插件后台规范 URL（按账号隔离） */
export function pluginPageUrl(pluginId: string, accountKey: string, pagePath: string): string {
  const page = String(pagePath || 'admin').replace(/^\//, '');
  return `/plugin/${encodeURIComponent(pluginId)}/a/${encodeURIComponent(accountKey)}/page/${page}`;
}
