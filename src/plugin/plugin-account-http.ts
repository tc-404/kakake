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
  // URL 里的插件 ID 常是 encodeURIComponent 形态（中文插件名），而调用方传进来的
  // 多是 decodeURIComponent 之后的真实 ID；两种形态都要认，否则多账号插件的
  // Referer 解析会落回 Cookie，甚至被当成「未携带账号」拒绝。
  const ids = [...new Set([pluginId, encodeURIComponent(pluginId)])].map(escapeRegExp);
  const id = `(?:${ids.join('|')})`;
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
  const page = String(pagePath || 'admin')
    .replace(/^\//, '')
    // 逐段编码：page 段来自 URL 路径，之前原样拼接，配合调用方直接插进 href 会构成反射型 XSS。
    // 分段编码保留多级页面路径（admin/sub）的斜杠语义。
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/plugin/${encodeURIComponent(pluginId)}/a/${encodeURIComponent(accountKey)}/page/${page}`;
}

export type PluginAccountResolution =
  | { accountKey: string }
  | { error: string; accounts: string[] };

/**
 * 决定一次插件 HTTP 请求该落到哪个账号实例。
 *
 * `kk_pa_<插件ID>` 是浏览器级单例 Cookie（名字里没有账号、也没有标签页维度），
 * 同时打开 A / B 两个连接的后台时，最后一次写入的账号会决定所有「不带账号」
 * 请求的归属；旧实现对此静默放行，于是 A 页面的保存会写进 B 的插件实例。
 * 因此多账号插件只接受显式账号（URL /a/、Referer、query、调用方指定），
 * 仅靠 Cookie 猜测时直接报错；单账号插件不受影响，且忽略残留的旧 Cookie。
 */
export function selectPluginAccount(opts: {
  accounts: string[];
  explicitAccount?: string;
  /** 同一个请求按插件 ID / 规范 ID 解析出的账号来源，显式来源优先 */
  sources: AccountKeyExtract[];
}): PluginAccountResolution {
  const { accounts, explicitAccount, sources } = opts;
  if (accounts.length === 0) {
    return {
      error: '插件未加载，无法访问后台（请开启总开关，并在至少一个连接打开子开关）',
      accounts,
    };
  }

  if (explicitAccount) {
    if (accounts.includes(explicitAccount)) return { accountKey: explicitAccount };
    return {
      error: `账号 ${explicitAccount} 未加载此插件。已加载：${accounts.join(', ')}`,
      accounts,
    };
  }

  // 只有一个账号时无需猜测：忽略可能残留的旧 kk_pa_*（换连接后不该把请求打挂）
  if (accounts.length === 1) return { accountKey: accounts[0]! };

  const explicitHit = sources.find(
    (s) => s.accountKey && s.source !== 'cookie' && s.source !== 'none',
  );
  const cookieHit = sources.find((s) => s.accountKey && s.source === 'cookie');

  if (explicitHit?.accountKey) {
    if (accounts.includes(explicitHit.accountKey)) return { accountKey: explicitHit.accountKey };
    return {
      error: `账号 ${explicitHit.accountKey} 未加载此插件。已加载：${accounts.join(', ')}`,
      accounts,
    };
  }

  if (cookieHit?.accountKey) {
    return {
      error: `多账号插件的该请求未携带账号，请从连接面板打开带 /a/<账号>/ 的后台地址（当前 Cookie 指向 ${cookieHit.accountKey}）`,
      accounts,
    };
  }

  return {
    error: '多账号已加载同一插件，请从连接面板打开对应账号后台，或使用 /plugin/<插件>/a/<账号>/page/...',
    accounts,
  };
}
