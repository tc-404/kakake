import type { Application, Request, Response, NextFunction } from 'express';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { PluginRouterRegistryImpl } from './router-registry.js';
import { isRequestAuthed } from '../admin/auth.middleware.js';
import { resolvePluginHttpIds } from './plugin-id.js';
import { resolveGfPluginId } from './gf-plugin-id.js';
import { resolveWxPluginId } from './wx-plugin-id.js';
import { resolveSsPluginId } from './ss-plugin-id.js';
import { kakakeApp } from '../kakake-app.js';
import type { PluginEntry } from './plugin.types.js';
import { PATHS } from '../paths.js';
import {
  extractAccountKeyFromRequest,
  pluginPageUrl,
  setPluginAccountCookie,
} from './plugin-account-http.js';
import { pluginHostConsolePath } from './plugin-host-paths.js';

/** 插件 HTTP 解析：同时覆盖 OneBot / GF / 微信 / KOOK 四套管理器 */
export interface PluginHttpHost {
  getPluginRouter(pluginId: string, accountKey?: string): PluginRouterRegistryImpl | undefined;
  getPluginInfo(pluginId: string): PluginEntry | undefined;
  getLoadedAccountKeys?(pluginId: string): string[];
  getRuntimeEntry?(pluginId: string, accountKey: string): PluginEntry | undefined;
  isLoadedForAccount?(pluginId: string, accountKey: string): boolean;
}

function findPluginEntryLoose(pluginId: string): PluginEntry | undefined {
  const trimmed = String(pluginId || '').trim();
  if (!trimmed) return undefined;
  const managers = [
    kakakeApp.pluginManager,
    kakakeApp.gfPluginManager,
    kakakeApp.wxPluginManager,
    kakakeApp.ssPluginManager,
  ].filter(Boolean);
  for (const pm of managers) {
    const hit = pm.getPluginInfo(trimmed);
    if (hit) return hit;
  }
  const lower = trimmed.toLowerCase();
  const gfAlias = resolveGfPluginId(trimmed).toLowerCase();
  const wxAlias = resolveWxPluginId(trimmed).toLowerCase();
  const ssAlias = resolveSsPluginId(trimmed).toLowerCase();
  for (const pm of managers) {
    for (const p of pm.getAllPlugins()) {
      if (
        p.id.toLowerCase() === lower
        || p.id.toLowerCase() === gfAlias
        || p.id.toLowerCase() === wxAlias
        || p.id.toLowerCase() === ssAlias
      ) return p;
      if (String(p.fileId || '').toLowerCase() === lower) return p;
      if (String(p.fileId || '').toLowerCase() === gfAlias) return p;
      if (String(p.fileId || '').toLowerCase() === wxAlias) return p;
      if (String(p.fileId || '').toLowerCase() === ssAlias) return p;
      const pkg = p.packageJson;
      if (String(pkg?.name || '').toLowerCase() === lower) return p;
      if (String(pkg?.plugin || '').toLowerCase() === lower) return p;
    }
  }
  return undefined;
}

function listLoadedAccounts(pluginId: string): string[] {
  const id = findPluginEntryLoose(pluginId)?.id || pluginId;
  const a = kakakeApp.pluginManager?.getLoadedAccountKeys?.(id) ?? [];
  const b = kakakeApp.gfPluginManager?.getLoadedAccountKeys?.(id) ?? [];
  const c = kakakeApp.wxPluginManager?.getLoadedAccountKeys?.(id) ?? [];
  const d = kakakeApp.ssPluginManager?.getLoadedAccountKeys?.(id) ?? [];
  return [...new Set([...a, ...b, ...c, ...d])];
}

function resolveWebuiHtmlFile(pluginDir: string, preferred?: string): string | undefined {
  const candidates = [
    preferred,
    'webui/admin.html',
    'webui/index.html',
    'admin.html',
  ].filter(Boolean) as string[];
  for (const rel of candidates) {
    const abs = path.join(pluginDir, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return rel.replace(/\\/g, '/');
  }
  return undefined;
}

export function createDefaultPluginHttpHost(): PluginHttpHost {
  return {
    getPluginRouter(pluginId: string, accountKey?: string) {
      const entry = findPluginEntryLoose(pluginId);
      const id = entry?.id ?? pluginId;
      return (
        kakakeApp.pluginManager?.getPluginRouter(id, accountKey)
        ?? kakakeApp.gfPluginManager?.getPluginRouter(id, accountKey)
        ?? kakakeApp.wxPluginManager?.getPluginRouter(id, accountKey)
        ?? kakakeApp.ssPluginManager?.getPluginRouter(id, accountKey)
        ?? kakakeApp.pluginManager?.getPluginRouter(pluginId, accountKey)
        ?? kakakeApp.gfPluginManager?.getPluginRouter(pluginId, accountKey)
        ?? kakakeApp.wxPluginManager?.getPluginRouter(pluginId, accountKey)
        ?? kakakeApp.ssPluginManager?.getPluginRouter(pluginId, accountKey)
      );
    },
    getPluginInfo(pluginId: string) {
      return findPluginEntryLoose(pluginId);
    },
    getLoadedAccountKeys(pluginId: string) {
      return listLoadedAccounts(pluginId);
    },
    getRuntimeEntry(pluginId: string, accountKey: string) {
      const entry = findPluginEntryLoose(pluginId);
      const id = entry?.id ?? pluginId;
      return (
        kakakeApp.pluginManager?.getRuntimeEntry?.(id, accountKey)
        ?? kakakeApp.gfPluginManager?.getRuntimeEntry?.(id, accountKey)
        ?? kakakeApp.wxPluginManager?.getRuntimeEntry?.(id, accountKey)
        ?? kakakeApp.ssPluginManager?.getRuntimeEntry?.(id, accountKey)
      );
    },
    isLoadedForAccount(pluginId: string, accountKey: string) {
      const entry = findPluginEntryLoose(pluginId);
      const id = entry?.id ?? pluginId;
      return !!(
        kakakeApp.pluginManager?.isLoadedForAccount?.(id, accountKey)
        || kakakeApp.gfPluginManager?.isLoadedForAccount?.(id, accountKey)
        || kakakeApp.wxPluginManager?.isLoadedForAccount?.(id, accountKey)
        || kakakeApp.ssPluginManager?.isLoadedForAccount?.(id, accountKey)
      );
    },
  };
}

function requestQuery(req: Request): string {
  const u = req.originalUrl || req.url;
  const i = u.indexOf('?');
  return i >= 0 ? u.slice(i) : '';
}

function pluginSubUrl(pathPart: string, req: Request): string {
  const pathOnly = (pathPart.startsWith('/') ? pathPart : `/${pathPart}`).split('?')[0]!;
  return pathOnly + requestQuery(req);
}

function resolveHttpPluginIds(pluginId: string): string[] {
  const ids = new Set<string>(resolvePluginHttpIds(pluginId));
  const trimmed = String(pluginId || '').trim();
  if (trimmed) {
    ids.add(resolveGfPluginId(trimmed));
    ids.add(trimmed);
  }
  return [...ids];
}

function resolveAccountForPlugin(
  req: Request,
  pluginId: string,
  explicitAccount?: string,
): { accountKey: string } | { error: string; accounts: string[] } {
  const accounts = listLoadedAccounts(pluginId);
  if (accounts.length === 0) {
    return { error: '插件未加载，无法访问后台（请开启总开关，并在至少一个连接打开子开关）', accounts: [] };
  }

  const hinted = explicitAccount
    || extractAccountKeyFromRequest(req, pluginId)
    || extractAccountKeyFromRequest(req, findPluginEntryLoose(pluginId)?.id || pluginId);

  if (hinted && accounts.includes(hinted)) {
    return { accountKey: hinted };
  }
  if (hinted && !accounts.includes(hinted)) {
    return {
      error: `账号 ${hinted} 未加载此插件。已加载：${accounts.join(', ')}`,
      accounts,
    };
  }
  if (accounts.length === 1) {
    return { accountKey: accounts[0]! };
  }
  return {
    error: '多账号已加载同一插件，请从连接面板打开对应账号后台，或使用 /plugin/<插件>/a/<账号>/page/...',
    accounts,
  };
}

function getRegistry(
  host: PluginHttpHost,
  pluginId: string,
  accountKey?: string,
): PluginRouterRegistryImpl | undefined {
  for (const id of resolveHttpPluginIds(pluginId)) {
    const registry = host.getPluginRouter(id, accountKey);
    if (registry) return registry;
  }
  return undefined;
}

function assertPluginHttpAccessible(
  pluginId: string,
  accountKey?: string,
):
  | { ok: true; entry: PluginEntry; accountKey: string }
  | { ok: false; status: number; message: string; accounts?: string[] } {
  const entry = findPluginEntryLoose(pluginId);
  if (!entry) {
    return { ok: false, status: 404, message: `Plugin '${pluginId}' not found` };
  }

  const kakakeHit = kakakeApp.pluginManager?.getPluginInfo(entry.id);
  const gfHit = kakakeApp.gfPluginManager?.getPluginInfo(entry.id);
  const masterOn = kakakeHit
    ? kakakeApp.pluginManager.isMasterEnabled(entry.id)
    : gfHit
      ? kakakeApp.gfPluginManager.isMasterEnabled(entry.id)
      : kakakeApp.wxPluginManager?.isMasterEnabled(entry.id) ?? false;

  if (!masterOn) {
    return { ok: false, status: 403, message: '插件总开关已关闭，无法访问后台' };
  }

  const accounts = listLoadedAccounts(entry.id);
  if (accounts.length === 0) {
    return {
      ok: false,
      status: 403,
      message: '插件未加载，无法访问后台（请开启总开关，并在至少一个连接打开子开关）',
    };
  }

  if (accountKey) {
    if (!accounts.includes(accountKey)) {
      return {
        ok: false,
        status: 403,
        message: `账号 ${accountKey} 未加载此插件`,
        accounts,
      };
    }
    return { ok: true, entry, accountKey };
  }

  if (accounts.length === 1) {
    return { ok: true, entry, accountKey: accounts[0]! };
  }

  return {
    ok: false,
    status: 409,
    message: '多账号已加载，请指定账号路径 /plugin/<插件>/a/<账号>/page/...',
    accounts,
  };
}

function denyPluginHttp(
  res: Response,
  gate: { ok: false; status: number; message: string; accounts?: string[] },
): void {
  res.status(gate.status).json({
    code: -1,
    message: gate.message,
    accounts: gate.accounts,
  });
}

/**
 * 插件 HTTP 登录门禁。
 *
 * 背景：`/plugin/*` 整段在鉴权白名单里（登录页之外的静态资源要能被同源页面直接引用，
 * 且插件资源无法挂在 Nest 路由下），所以登录校验必须由本处理器自己完成——
 * 否则插件后台 HTML、静态资源、以及走 `/plugin/:id/files/*` 兜底的插件 API
 * 会对公网匿名开放（「插件是否已加载」是状态门禁，不是身份鉴权）。
 *
 * 豁免范围（刻意收窄，且都是插件**显式声明**的）：
 * - 插件注册的 no-auth 路由：`/plugin/:id/api/*`（见 withAccountApi 的 'noauth' 分支）
 * - 扩展 API 下的静态 shim：`static/plugin-info.js`（isPublicPluginAsset）
 */
function pluginAuthBlocked(req: Request, res: Response): boolean {
  if (isRequestAuthed(req)) return false;
  if ((req.path || '').startsWith('/api/')) {
    res.status(401).json({ code: -1, message: 'Unauthorized' });
    return true;
  }
  res.redirect(302, '/login');
  return true;
}

/** HTML 转义：账号选择页要把插件 id / 链接插进属性与正文，必须转义 */
function escapeHtmlAttr(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

function sendAccountPicker(res: Response, pluginId: string, pagePath: string, accounts: string[]): void {
  const links = accounts.map((a) => {
    const href = pluginPageUrl(pluginId, a, pagePath);
    return `<li style="margin:8px 0"><a href="${escapeHtmlAttr(href)}">账号 ${escapeHtmlAttr(a)}</a></li>`;
  }).join('');
  res.type('html').status(200).send(`<!doctype html><html><head><meta charset="utf-8"><title>选择账号</title></head>
<body style="font-family:system-ui;padding:2rem">
<h1>选择要打开的账号后台</h1>
<p>插件 <code>${escapeHtmlAttr(pluginId)}</code> 已在多个账号上启用：</p>
<ul>${links}</ul>
</body></html>`);
}

function findPage(registry: PluginRouterRegistryImpl, pagePath: string) {
  const pages = registry.getPages();
  return pages.find(p => p.path === pagePath || p.path === `/${pagePath}`);
}

function computePageBaseHref(pluginId: string, staticRoutes: Array<{ urlPath: string }>): string {
  if (!staticRoutes[0]) return `/plugin/${pluginId}/files/`;
  const urlPath = staticRoutes[0].urlPath.startsWith('/')
    ? staticRoutes[0].urlPath
    : `/${staticRoutes[0].urlPath}`;
  const basePath = urlPath.replace(/\/static\/?$/, '') || urlPath;
  return `/plugin/${pluginId}/files${basePath}/`;
}

function getApiRoutePrefix(staticRoutes: Array<{ urlPath: string }>): string {
  const route = staticRoutes.find((r) => /\/static\/?$/i.test(r.urlPath));
  if (route) {
    const prefix = route.urlPath.replace(/\/static\/?$/i, '');
    if (prefix) return prefix.startsWith('/') ? prefix : `/${prefix}`;
  }
  if (staticRoutes[0]) {
    const urlPath = staticRoutes[0].urlPath.startsWith('/')
      ? staticRoutes[0].urlPath
      : `/${staticRoutes[0].urlPath}`;
    const idx = urlPath.lastIndexOf('/');
    if (idx > 0) return urlPath.slice(0, idx);
  }
  return '/mkbot';
}

/**
 * 插件页面 HTML 模板缓存：只缓存「注入前」的原始文本，按 mtime + size 指纹失效——
 * 插件更新 / 重载重写文件后 mtime 变化即自动重读，无需手动清缓存。
 * 账号标记、base href 等与请求相关的注入每次现场做（纯内存字符串操作，微秒级），
 * 绝不缓存注入后的成品，避免把 A 账号的标记发给 B 账号。
 */
const htmlTemplateCache = new Map<string, { mtimeMs: number; size: number; html: string }>();
const HTML_TEMPLATE_CACHE_MAX = 64;

function readPluginHtmlCached(htmlPath: string): string {
  // 与原实现一致：调用方已 existsSync 预检，stat/read 失败照常向上抛
  const st = fs.statSync(htmlPath);
  const hit = htmlTemplateCache.get(htmlPath);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.html;
  const html = fs.readFileSync(htmlPath, 'utf-8');
  if (htmlTemplateCache.size >= HTML_TEMPLATE_CACHE_MAX) {
    // FIFO 淘汰，防止长期运行内存无界
    const oldest = htmlTemplateCache.keys().next().value;
    if (oldest !== undefined) htmlTemplateCache.delete(oldest);
  }
  htmlTemplateCache.set(htmlPath, { mtimeMs: st.mtimeMs, size: st.size, html });
  return html;
}

/** 手动失效缓存（按路径前缀过滤）；不带参数时全清。插件卸载 / 重载场景可用。 */
export function invalidatePluginHtmlCache(pathPrefix?: string): void {
  if (!pathPrefix) {
    htmlTemplateCache.clear();
    return;
  }
  for (const key of [...htmlTemplateCache.keys()]) {
    if (key.startsWith(pathPrefix)) htmlTemplateCache.delete(key);
  }
}

function sendPluginHtml(
  res: Response,
  pluginId: string,
  accountKey: string,
  htmlPath: string,
  baseHref: string,
  staticRoutes: Array<{ urlPath: string }>,
): void {
  let html = readPluginHtmlCached(htmlPath);

  const apiPrefix = getApiRoutePrefix(staticRoutes);
  html = html.replace(
    /(<script\s+src=")static\/plugin-info\.js(")/i,
    `$1/api/Plugin/ext/${pluginId}${apiPrefix}/static/plugin-info.js$2`,
  );

  const href = baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
  if (!html.includes('<base ')) {
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${href}">`);
  }

  // 注入账号标记，便于旧插件绝对路径 API 通过 Cookie/全局变量定位
  const inject = `<script>window.__KAKAKE_PLUGIN_ACCOUNT__=${JSON.stringify(accountKey)};window.__KAKAKE_PLUGIN_ID__=${JSON.stringify(pluginId)};</script>`;
  if (html.includes('</head>')) {
    html = html.replace('</head>', `${inject}</head>`);
  } else {
    html = inject + html;
  }

  setPluginAccountCookie(res, pluginId, accountKey);
  res.type('html').send(html);
}

function dispatchPluginApi(
  registry: PluginRouterRegistryImpl,
  subPath: string,
  req: Request,
  res: Response,
  next: NextFunction,
  onMiss: () => void,
): void {
  const savedUrl = req.url;
  req.url = pluginSubUrl(subPath, req);
  registry.buildApiRouter()(req, res, (err?: unknown) => {
    req.url = savedUrl;
    if (err) {
      next(err as Error);
      return;
    }
    if (!res.headersSent) onMiss();
  });
}

function tryApiStaticFallback(
  subPath: string,
  req: Request,
  res: Response,
  next: NextFunction,
  registry: PluginRouterRegistryImpl | undefined,
  onMiss: () => void,
): void {
  if (!registry?.hasApiRoutes() || req.method !== 'GET') {
    onMiss();
    return;
  }
  // 静态未命中时的 API 兜底会把请求派发到插件**需鉴权**路由（buildApiRouter），
  // 所以必须与 /api/Plugin/ext/* 同口径先校验登录，否则
  // `/plugin/<插件>/files/xxx` 就是绕过登录直达受保护 API 的旁路。
  if (!isRequestAuthed(req)) {
    res.status(401).json({ code: -1, message: 'Unauthorized' });
    return;
  }
  dispatchPluginApi(registry, subPath, req, res, next, onMiss);
}

function handlePage(
  req: Request,
  res: Response,
  host: PluginHttpHost,
  pluginId: string,
  pagePath: string,
  explicitAccount?: string,
): boolean {
  const resolved = resolveAccountForPlugin(req, pluginId, explicitAccount);
  if ('error' in resolved) {
    if (resolved.accounts.length > 1 && req.method === 'GET' && !explicitAccount) {
      const entry = findPluginEntryLoose(pluginId);
      sendAccountPicker(res, entry?.id || pluginId, pagePath, resolved.accounts);
      return true;
    }
    res.status(resolved.accounts.length ? 409 : 403).json({
      code: -1,
      message: resolved.error,
      accounts: resolved.accounts,
    });
    return true;
  }

  const gate = assertPluginHttpAccessible(pluginId, resolved.accountKey);
  if (!gate.ok) {
    denyPluginHttp(res, gate);
    return true;
  }

  const { entry, accountKey } = gate;
  const runtimeEntry = host.getRuntimeEntry?.(entry.id, accountKey) ?? entry;
  const registry = getRegistry(host, entry.id, accountKey) ?? getRegistry(host, pluginId, accountKey);

  let page = registry ? findPage(registry, pagePath) : undefined;
  let htmlFile = page?.htmlFile;
  const moduleRel = page?.module || entry.packageJson?.webuiModule;

  if (!htmlFile && registry) {
    const pages = registry.getPages();
    if (pages.length === 1) htmlFile = pages[0]!.htmlFile;
    else {
      const adminLike = pages.find((p) =>
        p.path === 'admin' || p.path === 'gfmk-dashboard' || p.path === 'mkbot-dashboard'
      );
      if (adminLike) htmlFile = adminLike.htmlFile;
    }
  }

  const diskDir = runtimeEntry.pluginPath || registry?.getPluginPath();
  if (!htmlFile && diskDir) {
    htmlFile = resolveWebuiHtmlFile(diskDir, entry.packageJson?.webui);
  }

  // 仅有 ESM 模块、无 HTML：跳转到控制台宿主路由
  if (!htmlFile && moduleRel) {
    const dest = pluginHostConsolePath(entry.id || pluginId, pagePath, accountKey);
    res.redirect(302, dest);
    return true;
  }

  if (!htmlFile || !diskDir) {
    res.status(404).json({
      code: -1,
      message: `Page '${pagePath}' not found`,
      hint: `pluginId=${pluginId}; account=${accountKey}`,
    });
    return true;
  }

  const htmlPath = path.join(diskDir, htmlFile);
  if (!fs.existsSync(htmlPath)) {
    res.status(404).json({ code: -1, message: `HTML not found: ${htmlFile}` });
    return true;
  }

  const publicId = entry.id || path.basename(diskDir);
  const staticRoutes = registry?.getStaticRoutes() ?? [];
  const baseHref = computePageBaseHref(publicId, staticRoutes);
  sendPluginHtml(res, publicId, accountKey, htmlPath, baseHref, staticRoutes);
  return true;
}

const MODULE_ASSET_EXT = new Set(['.js', '.mjs', '.cjs', '.css', '.map', '.json', '.wasm']);

function moduleContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.wasm') return 'application/wasm';
  if (ext === '.map') return 'application/json; charset=utf-8';
  return 'text/javascript; charset=utf-8';
}

/** 按插件根目录提供 ESM 模块及相对资源（方案 B） */
function handleModuleAsset(
  req: Request,
  res: Response,
  host: PluginHttpHost,
  pluginId: string,
  relPath: string,
  explicitAccount?: string,
): void {
  const resolved = resolveAccountForPlugin(req, pluginId, explicitAccount);
  if ('error' in resolved) {
    res.status(resolved.accounts.length ? 409 : 403).json({
      code: -1,
      message: resolved.error,
      accounts: resolved.accounts,
    });
    return;
  }

  const gate = assertPluginHttpAccessible(pluginId, resolved.accountKey);
  if (!gate.ok) {
    denyPluginHttp(res, gate);
    return;
  }

  const runtimeEntry = host.getRuntimeEntry?.(gate.entry.id, gate.accountKey) ?? gate.entry;
  const diskDir = runtimeEntry.pluginPath;
  if (!diskDir) {
    res.status(404).json({ code: -1, message: 'Plugin path missing' });
    return;
  }

  const cleaned = String(relPath || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!cleaned || cleaned.includes('..')) {
    res.status(400).json({ code: -1, message: 'Invalid module path' });
    return;
  }

  const abs = path.resolve(diskDir, cleaned);
  const root = path.resolve(diskDir);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    res.status(400).json({ code: -1, message: 'Path escapes plugin root' });
    return;
  }

  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    res.status(404).json({ code: -1, message: `Module not found: ${cleaned}` });
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  if (!MODULE_ASSET_EXT.has(ext)) {
    res.status(403).json({ code: -1, message: `Extension not allowed: ${ext}` });
    return;
  }

  setPluginAccountCookie(res, gate.entry.id, gate.accountKey);
  res.setHeader('Content-Type', moduleContentType(abs));
  res.setHeader('Cache-Control', 'no-cache');
  // 便于动态 import；同源即可，显式声明 MIME
  res.sendFile(abs);
}

function handleStaticFiles(
  subPath: string,
  req: Request,
  res: Response,
  next: NextFunction,
  host: PluginHttpHost,
  pluginId: string,
  explicitAccount?: string,
): void {
  const resolved = resolveAccountForPlugin(req, pluginId, explicitAccount);
  if ('error' in resolved) {
    res.status(resolved.accounts.length ? 409 : 403).json({
      code: -1,
      message: resolved.error,
      accounts: resolved.accounts,
    });
    return;
  }

  const gate = assertPluginHttpAccessible(pluginId, resolved.accountKey);
  if (!gate.ok) {
    denyPluginHttp(res, gate);
    return;
  }

  const registry = getRegistry(host, gate.entry.id, gate.accountKey)
    ?? getRegistry(host, pluginId, gate.accountKey);
  const routes = registry?.getStaticRoutes() ?? [];

  const finish404 = (): void => {
    tryApiStaticFallback(subPath, req, res, next, registry, () => {
      if (!res.headersSent) {
        res.status(404).json({ code: -1, message: 'Static resource not found' });
      }
    });
  };

  if (!routes.length) {
    finish404();
    return;
  }

  const tryRoute = (index: number): void => {
    if (index >= routes.length) {
      finish404();
      return;
    }

    const { urlPath, localPath } = routes[index]!;
    const prefix = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
    if (!subPath.startsWith(prefix) && subPath !== prefix.slice(0, -1)) {
      tryRoute(index + 1);
      return;
    }

    if (!fs.existsSync(localPath)) {
      tryRoute(index + 1);
      return;
    }

    const originalUrl = req.url;
    req.url = `/${subPath.substring(prefix.length).replace(/^\//, '') || ''}`;
    express.static(localPath, { maxAge: '1d' })(req, res, (err?: unknown) => {
      req.url = originalUrl;
      if (res.headersSent) return;
      if (err) {
        next(err as Error);
        return;
      }
      tryRoute(index + 1);
    });
  };

  tryRoute(0);
}

function isPublicPluginAsset(subPath: string): boolean {
  return /\/static\/plugin-info\.js$/i.test(subPath);
}

function withAccountApi(
  req: Request,
  res: Response,
  next: NextFunction,
  host: PluginHttpHost,
  pluginId: string,
  subPath: string,
  mode: 'auth' | 'noauth',
  explicitAccount?: string,
): void {
  const resolved = resolveAccountForPlugin(req, pluginId, explicitAccount);
  if ('error' in resolved) {
    res.status(resolved.accounts.length ? 409 : 403).json({
      code: -1,
      message: resolved.error,
      accounts: resolved.accounts,
    });
    return;
  }

  const gate = assertPluginHttpAccessible(pluginId, resolved.accountKey);
  if (!gate.ok) {
    denyPluginHttp(res, gate);
    return;
  }

  setPluginAccountCookie(res, gate.entry.id, gate.accountKey);
  const registry = getRegistry(host, gate.entry.id, gate.accountKey)
    ?? getRegistry(host, pluginId, gate.accountKey);

  if (mode === 'auth') {
    if (!registry?.hasApiRoutes()) {
      res.status(404).json({ code: -1, message: `Plugin '${pluginId}' has no API routes` });
      return;
    }
    const savedUrl = req.url;
    req.url = pluginSubUrl(subPath, req);
    registry.buildApiRouter()(req, res, (err?: unknown) => {
      req.url = savedUrl;
      if (err) {
        next(err as Error);
        return;
      }
      if (!res.headersSent) {
        res.status(404).json({ code: -1, message: `Plugin API not found: ${subPath}` });
      }
    });
    return;
  }

  if (!registry?.hasApiNoAuthRoutes()) {
    res.status(404).json({ code: -1, message: 'No no-auth API routes' });
    return;
  }
  req.url = pluginSubUrl(subPath, req);
  registry.buildApiNoAuthRouter()(req, res, next);
}

/** 插件 HTTP 处理器（须在 Nest 路由之前挂载） */
export function createPluginHttpMiddleware(getHost: () => PluginHttpHost = createDefaultPluginHttpHost) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const host = getHost();
    const url = req.path;

    // 带账号：/api/Plugin/ext/:id/a/:account/...
    const extAcct = url.match(/^\/api\/Plugin\/ext\/([^/]+)\/a\/([^/]+)(\/.*)?$/i);
    if (extAcct) {
      const pluginId = extAcct[1]!;
      const accountKey = decodeURIComponent(extAcct[2]!);
      const subPath = extAcct[3] || '/';
      const subPathOnly = subPath.split('?')[0]!;
      const publicAsset = isPublicPluginAsset(subPathOnly);
      if (!publicAsset && !isRequestAuthed(req)) {
        res.status(401).json({ code: -1, message: 'Unauthorized' });
        return;
      }
      withAccountApi(req, res, next, host, pluginId, subPathOnly, 'auth', accountKey);
      return;
    }

    const extMatch = url.match(/^\/api\/Plugin\/ext\/([^/]+)(\/.*)?$/i);
    if (extMatch) {
      const subPath = extMatch[2] || '/';
      const subPathOnly = subPath.split('?')[0]!;
      const publicAsset = isPublicPluginAsset(subPathOnly);
      if (!publicAsset && !isRequestAuthed(req)) {
        res.status(401).json({ code: -1, message: 'Unauthorized' });
        return;
      }
      withAccountApi(req, res, next, host, extMatch[1]!, subPathOnly, 'auth');
      return;
    }

    const apiPageAcct = url.match(/^\/api\/Plugin\/page\/([^/]+)\/a\/([^/]+)\/([^/]+)$/i);
    if (apiPageAcct && req.method === 'GET') {
      if (pluginAuthBlocked(req, res)) return;
      handlePage(req, res, host, apiPageAcct[1]!, apiPageAcct[3]!, decodeURIComponent(apiPageAcct[2]!));
      return;
    }

    const apiPageMatch = url.match(/^\/api\/Plugin\/page\/([^/]+)\/([^/]+)$/i);
    if (apiPageMatch && req.method === 'GET') {
      if (pluginAuthBlocked(req, res)) return;
      handlePage(req, res, host, apiPageMatch[1]!, apiPageMatch[2]!);
      return;
    }

    // /plugin/:id/a/:account/page/...
    const pageAcct = url.match(/^\/plugin\/([^/]+)\/a\/([^/]+)\/page\/(.+)$/);
    if (pageAcct && req.method === 'GET') {
      if (pluginAuthBlocked(req, res)) return;
      handlePage(req, res, host, pageAcct[1]!, pageAcct[3]!, decodeURIComponent(pageAcct[2]!));
      return;
    }

    const pageMatch = url.match(/^\/plugin\/([^/]+)\/page\/(.+)$/);
    if (pageMatch && req.method === 'GET') {
      if (pluginAuthBlocked(req, res)) return;
      handlePage(req, res, host, pageMatch[1]!, pageMatch[2]!);
      return;
    }

    const moduleAcct = url.match(/^\/plugin\/([^/]+)\/a\/([^/]+)\/module\/(.+)$/);
    if (moduleAcct && (req.method === 'GET' || req.method === 'HEAD')) {
      if (pluginAuthBlocked(req, res)) return;
      handleModuleAsset(
        req, res, host,
        moduleAcct[1]!,
        moduleAcct[3]!,
        decodeURIComponent(moduleAcct[2]!),
      );
      return;
    }

    const moduleMatch = url.match(/^\/plugin\/([^/]+)\/module\/(.+)$/);
    if (moduleMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      if (pluginAuthBlocked(req, res)) return;
      handleModuleAsset(req, res, host, moduleMatch[1]!, moduleMatch[2]!);
      return;
    }

    const filesAcct = url.match(/^\/plugin\/([^/]+)\/a\/([^/]+)\/files(\/.*)?$/);
    if (filesAcct) {
      if (pluginAuthBlocked(req, res)) return;
      handleStaticFiles(
        filesAcct[3] || '/',
        req, res, next, host,
        filesAcct[1]!,
        decodeURIComponent(filesAcct[2]!),
      );
      return;
    }

    const filesMatch = url.match(/^\/plugin\/([^/]+)\/files(\/.*)?$/);
    if (filesMatch) {
      if (pluginAuthBlocked(req, res)) return;
      handleStaticFiles(filesMatch[2] || '/', req, res, next, host, filesMatch[1]!);
      return;
    }

    const apiAcct = url.match(/^\/plugin\/([^/]+)\/a\/([^/]+)\/api(\/.*)?$/);
    if (apiAcct) {
      withAccountApi(
        req, res, next, host,
        apiAcct[1]!,
        apiAcct[3] || '/',
        'noauth',
        decodeURIComponent(apiAcct[2]!),
      );
      return;
    }

    const apiMatch = url.match(/^\/plugin\/([^/]+)\/api(\/.*)?$/);
    if (apiMatch) {
      withAccountApi(req, res, next, host, apiMatch[1]!, apiMatch[2] || '/', 'noauth');
      return;
    }

    const memAcct = url.match(/^\/plugin\/([^/]+)\/a\/([^/]+)\/mem(\/.*)?$/);
    if (memAcct) {
      if (pluginAuthBlocked(req, res)) return;
      const pluginId = memAcct[1]!;
      const accountKey = decodeURIComponent(memAcct[2]!);
      const gate = assertPluginHttpAccessible(pluginId, accountKey);
      if (!gate.ok) {
        denyPluginHttp(res, gate);
        return;
      }
      const registry = getRegistry(host, gate.entry.id, accountKey);
      const subPath = memAcct[3] || '/';
      for (const { urlPath, files } of registry?.getMemoryStaticRoutes() ?? []) {
        const prefix = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
        if (!subPath.startsWith(prefix)) continue;
        const filePath = `/${subPath.substring(prefix.length).replace(/^\//, '') || ''}`;
        const memFile = files.find(f => `/${f.path.replace(/^\//, '')}` === filePath);
        if (!memFile) continue;
        void (async () => {
          try {
            const content = typeof memFile.content === 'function' ? await memFile.content() : memFile.content;
            res.setHeader('Content-Type', memFile.contentType || 'application/octet-stream');
            res.send(content);
          } catch (e) {
            res.status(500).json({ code: -1, message: String(e) });
          }
        })();
        return;
      }
      res.status(404).json({ code: -1, message: 'Memory file not found' });
      return;
    }

    const memMatch = url.match(/^\/plugin\/([^/]+)\/mem(\/.*)?$/);
    if (memMatch) {
      if (pluginAuthBlocked(req, res)) return;
      const pluginId = memMatch[1]!;
      const resolved = resolveAccountForPlugin(req, pluginId);
      if ('error' in resolved) {
        res.status(resolved.accounts.length ? 409 : 403).json({
          code: -1,
          message: resolved.error,
          accounts: resolved.accounts,
        });
        return;
      }
      const gate = assertPluginHttpAccessible(pluginId, resolved.accountKey);
      if (!gate.ok) {
        denyPluginHttp(res, gate);
        return;
      }
      const registry = getRegistry(host, gate.entry.id, gate.accountKey);
      const subPath = memMatch[2] || '/';
      for (const { urlPath, files } of registry?.getMemoryStaticRoutes() ?? []) {
        const prefix = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
        if (!subPath.startsWith(prefix)) continue;
        const filePath = `/${subPath.substring(prefix.length).replace(/^\//, '') || ''}`;
        const memFile = files.find(f => `/${f.path.replace(/^\//, '')}` === filePath);
        if (!memFile) continue;
        void (async () => {
          try {
            const content = typeof memFile.content === 'function' ? await memFile.content() : memFile.content;
            res.setHeader('Content-Type', memFile.contentType || 'application/octet-stream');
            res.send(content);
          } catch (e) {
            res.status(500).json({ code: -1, message: String(e) });
          }
        })();
        return;
      }
      res.status(404).json({ code: -1, message: 'Memory file not found' });
      return;
    }

    // 宿主 SPA：/plugins/:id/a/:account/... 同步 Cookie，避免 iframe/API 无 /a/ 时仍用旧 kk_pa_*
    const spaHost = url.match(/^\/plugins\/([^/]+)\/a\/([^/]+)(?:\/|$)/i);
    if (spaHost && (req.method === 'GET' || req.method === 'HEAD')) {
      const pid = decodeURIComponent(spaHost[1]!);
      const ak = decodeURIComponent(spaHost[2]!);
      if (pid && ak) {
        setPluginAccountCookie(res, pid, ak);
        const entry = findPluginEntryLoose(pid);
        if (entry?.id && entry.id !== pid) {
          setPluginAccountCookie(res, entry.id, ak);
        }
      }
    }

    void PATHS;
    next();
  };
}

export function mountPluginHttp(app: Application, getHost: () => PluginHttpHost = createDefaultPluginHttpHost): void {
  app.use(createPluginHttpMiddleware(getHost));
}
