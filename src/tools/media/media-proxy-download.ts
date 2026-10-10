/**
 * 媒体资源代理下载：绕过浏览器端防盗链 / CORS，供工具页「下载视频」「下载封面」使用。
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { fetchFollowingAllowedRedirects, FETCH_TIMEOUT_MS } from './http-utils';
import { proxyConfigured, proxyFetch } from './http-proxy';

const ALLOWED_HOST_SUFFIXES = [
  'douyinvod.com',
  'douyin.com',
  'iesdouyin.com',
  // 抖音封面与原图走 douyinpic / douyincdn，缺了这两个 suffix 会导致
  // 「下载封面」「长按下载图片」被自己的白名单拒掉（403）
  'douyinpic.com',
  'douyincdn.com',
  'byteimg.com',
  'snssdk.com',
  'amemv.com',
  'bilivideo.com',
  'bilivideo.cn',
  'hdslb.com',
  'bilibili.com',
  'xhscdn.com',
  'xiaohongshu.com',
  'xhslink.com',
  'kwimgs.com',
  'yximgs.com',
  'kuaishou.com',
  'gifshow.com',
  'ksapisrv.com',
  'tiktok.com',
  'tiktokv.com',
  'tiktokcdn.com',
  'tiktokcdn-us.com',
  'ibyteimg.com',
  'googlevideo.com',
  'ytimg.com',
  'youtube.com',
  'twimg.com',
  'twimg.co',
  // Telegram 的媒体 CDN（cdn1~cdn5.telesco.pe），视频与图片都在这
  'telesco.pe',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type MediaDownloadKind = 'video' | 'cover';

export function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function urlAllowed(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return hostAllowed(u.hostname);
  } catch {
    return false;
  }
}

/**
 * 只放行媒体类型。
 *
 * 预览接口和后台面板同源，如果原样透传上游的 `text/html`，浏览器会把这页
 * 当成后台同源页面渲染、并执行对方站点 CDN 上的脚本——登录令牌就存在
 * localStorage 里，等于后台直接失守。这里连 `text/plain` 一起挡掉：
 * 媒体 CDN 不会用这些类型返回图片或视频，挡掉不会有误伤。
 */
export function isMediaContentType(contentType: string | null | undefined): boolean {
  const c = String(contentType || '').toLowerCase().split(';')[0]!.trim();
  if (!c) return false;
  if (/^(image|video|audio)\//.test(c)) return true;
  if (c === 'application/octet-stream' || c === 'binary/octet-stream') return true;
  if (c === 'application/x-mpegurl' || c === 'application/vnd.apple.mpegurl') return true;
  return false;
}

/* ---------------------------------------------------------------------------
 * TikTok CDN Cookie 引用表
 *
 * TikTok 的 CDN 会校验 tt_chain_token 等 Cookie，解析时服务端顺手拿到了它。
 * 之前直接把 Cookie 原文回给浏览器、下载时再传回来——浏览器里根本不需要它，
 * 反而多了一次暴露。这里改成发一个一次性引用，服务端自己存原文：
 * 短时效、有上限、只在内存，重启即失效。
 * ------------------------------------------------------------------------- */
const COOKIE_TTL_MS = 10 * 60 * 1000;
const COOKIE_MAX_ENTRIES = 256;
const cookieRefs = new Map<string, { cookie: string; expire: number }>();

export function createCookieRef(cookie: string): string {
  const value = String(cookie || '').trim();
  if (!value) return '';
  const now = Date.now();
  for (const [k, v] of cookieRefs) {
    if (v.expire <= now) cookieRefs.delete(k);
  }
  while (cookieRefs.size >= COOKIE_MAX_ENTRIES) {
    const oldest = cookieRefs.keys().next().value;
    if (oldest == null) break;
    cookieRefs.delete(oldest);
  }
  const ref = randomUUID();
  cookieRefs.set(ref, { cookie: value, expire: now + COOKIE_TTL_MS });
  return ref;
}

/** 引用 → Cookie 原文；查不到（过期/伪造/直接传了原文）时返回空串 */
export function resolveCookieRef(ref: string | null | undefined): string {
  const key = String(ref || '').trim();
  if (!key) return '';
  const hit = cookieRefs.get(key);
  if (!hit) return '';
  if (hit.expire <= Date.now()) {
    cookieRefs.delete(key);
    return '';
  }
  return hit.cookie;
}

function refererFor(url: URL, platform?: string | null): string {
  const p = String(platform || '').toLowerCase();
  if (p === 'dy' || /douyin|iesdouyin|byteimg|snssdk|amemv/i.test(url.hostname)) {
    return 'https://www.douyin.com/';
  }
  if (p === 'blbl' || /bili|hdslb/i.test(url.hostname)) {
    return 'https://www.bilibili.com/';
  }
  if (p === 'xhs' || /xiaohongshu|xhscdn|xhs/i.test(url.hostname)) {
    return 'https://www.xiaohongshu.com/';
  }
  if (p === 'ks' || /kuaishou|kwimgs|yximgs|gifshow/i.test(url.hostname)) {
    return 'https://www.kuaishou.com/';
  }
  if (p === 'tt' || /tiktok|ibyteimg/i.test(url.hostname)) {
    return 'https://www.tiktok.com/';
  }
  if (p === 'yt' || /youtube|ytimg|googlevideo/i.test(url.hostname)) {
    return 'https://www.youtube.com/';
  }
  if (p === 'x' || /twimg|x\.com/i.test(url.hostname)) {
    return 'https://x.com/';
  }
  if (p === 'tg' || /telesco\.pe|telegram\.org/i.test(url.hostname)) {
    return 'https://t.me/';
  }
  return `${url.protocol}//${url.host}/`;
}

function extFromContentType(ct: string, kind: MediaDownloadKind): string {
  const c = ct.toLowerCase();
  if (c.includes('mp4')) return 'mp4';
  if (c.includes('webm')) return 'webm';
  if (c.includes('jpeg') || c.includes('jpg')) return 'jpg';
  if (c.includes('png')) return 'png';
  if (c.includes('webp')) return 'webp';
  if (c.includes('gif')) return 'gif';
  if (c.includes('image/')) return 'jpg';
  if (c.includes('video/')) return 'mp4';
  return kind === 'cover' ? 'jpg' : 'mp4';
}

/** 从 URL 路径猜扩展名；猜不到返回 null，由 Content-Type 兜底 */
function extFromUrl(url: URL): string | null {
  const path = url.pathname.toLowerCase();
  const m = path.match(/\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp|gif)(?:$|\?)/i);
  return m ? (m[1]!.toLowerCase() === 'jpeg' ? 'jpg' : m[1]!.toLowerCase()) : null;
}

function buildFilename(kind: MediaDownloadKind, ext: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return kind === 'cover' ? `cover-${stamp}.${ext}` : `video-${stamp}.${ext}`;
}

export type MediaProxyDownloadResult =
  | {
      ok: true;
      response: Response;
      filename: string;
      contentType: string;
    }
  | { ok: false; status: number; message: string };

export type MediaViewResult =
  | {
      ok: true;
      /** 上游状态码（Range 请求时为 206，需原样回给浏览器） */
      status: number;
      contentType: string;
      contentLength: string | null;
      contentRange: string | null;
      /** 上游是否声明支持 Range；没声明就不该对浏览器声称 Accept-Ranges: bytes */
      acceptRanges: string | null;
      response: Response;
    }
  | { ok: false; status: number; message: string };

/**
 * 拉取远端媒体（下载/预览共用）。
 * twimg（X 的媒体 CDN）与 telesco.pe（Telegram 的媒体 CDN）国内无法直连，
 * 这两个域名先走代理，失败再退回直连。
 * 两条路都逐跳校验白名单。
 */
async function fetchUpstreamMedia(opts: {
  url: string;
  kind: MediaDownloadKind;
  platform?: string | null;
  cookie?: string | null;
  range?: string | null;
}): Promise<
  | { ok: true; response: Response; contentType: string }
  | { ok: false; status: number; message: string }
> {
  const raw = String(opts.url || '').trim();
  if (!raw) return { ok: false, status: 400, message: '缺少下载地址' };

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return { ok: false, status: 400, message: '下载地址无效' };
  }

  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return { ok: false, status: 400, message: '仅支持 http/https' };
  }
  if (!hostAllowed(target.hostname)) {
    // 带上主机名：新增 CDN 时能直接从报错里看出该补哪条白名单
    return { ok: false, status: 403, message: `该域名不允许代理下载：${target.hostname}` };
  }

  const referer = refererFor(target, opts.platform);
  const accept = opts.kind === 'cover' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : '*/*';
  // Cookie 只服务于 TikTok（CDN 会校验 tt_chain_token 等），其余平台一律不带，
  // 避免把请求方传来的任意 Cookie 转投给白名单内的其他站点。
  // 传进来的是引用（见 createCookieRef），原文只存在服务端内存里。
  const tiktokTarget = opts.platform === 'tt'
    || /(^|\.)(tiktok\.com|tiktokv\.com|tiktokcdn\.com|tiktokcdn-us\.com)$/i.test(target.hostname);
  const cookie = tiktokTarget ? resolveCookieRef(opts.cookie) : '';
  const headers: Record<string, string> = {
    'User-Agent': UA,
    Referer: referer,
    Origin: referer.replace(/\/$/, ''),
    Accept: accept,
    ...(cookie ? { Cookie: cookie } : {}),
  };
  if (opts.range) headers.Range = String(opts.range);

  // twimg（X 的媒体 CDN）与 telesco.pe（Telegram 的媒体 CDN）在国内都无法直连，
  // 这两个域名必须先走代理，失败再退回直连。
  const needsProxy = (
    /(^|\.)twimg\.com$/i.test(target.hostname)
    || /(^|\.)telesco\.pe$/i.test(target.hostname)
  ) && proxyConfigured();
  let upstream: Response;
  if (needsProxy) {
    try {
      upstream = await proxyFetch(target.toString(), {
        headers,
        timeoutMs: 60000,
        maxRedirects: 3,
        isAllowedRedirect: urlAllowed,
      });
    } catch {
      // 代理挂了就直连兜底（同样逐跳校验）
      const direct = await fetchFollowingAllowedRedirects({
        url: target.toString(),
        headers,
        isAllowed: urlAllowed,
        timeoutMs: FETCH_TIMEOUT_MS,
      });
      if (!direct.ok) return direct;
      upstream = direct.response;
    }
  } else {
    const direct = await fetchFollowingAllowedRedirects({
      url: target.toString(),
      headers,
      isAllowed: urlAllowed,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    if (!direct.ok) return direct;
    upstream = direct.response;
  }

  if (!upstream.ok || !upstream.body) {
    return {
      ok: false,
      status: 502,
      message: `远端返回 ${upstream.status}，无法下载（可能已失效或防盗链）`,
    };
  }

  const contentType = upstream.headers.get('content-type') || (
    opts.kind === 'cover' ? 'image/jpeg' : 'video/mp4'
  );
  if (!isMediaContentType(contentType)) {
    upstream.body?.cancel().catch(() => {});
    return {
      ok: false,
      status: 415,
      message: `上游返回的不是媒体文件（${contentType.split(';')[0]}），可能是链接指到了网页`,
    };
  }
  return { ok: true, response: upstream, contentType };
}

/**
 * 拉取远端媒体。调用方负责把 body 管道写给客户端。
 */
export async function fetchMediaForDownload(opts: {
  url: string;
  kind: MediaDownloadKind;
  platform?: string | null;
  cookie?: string | null;
}): Promise<MediaProxyDownloadResult> {
  const fetched = await fetchUpstreamMedia(opts);
  if (!fetched.ok) return fetched;

  const target = new URL(String(opts.url));
  const contentType = fetched.contentType;
  const ext = extFromUrl(target) || extFromContentType(contentType, opts.kind);
  const filename = buildFilename(opts.kind, ext);

  return {
    ok: true,
    response: fetched.response,
    filename,
    contentType,
  };
}

/**
 * 拉取远端媒体用于页面内展示（inline）。
 * 与下载的区别：原样返回上游状态码与 Range 头，供 <video> 拖动进度条。
 * 不接受 Cookie —— 展示走的是浏览器侧地址，无需凭据，也不该由请求方指定。
 */
export async function fetchMediaForView(opts: {
  url: string;
  kind: MediaDownloadKind;
  platform?: string | null;
  range?: string | null;
}): Promise<MediaViewResult> {
  const fetched = await fetchUpstreamMedia(opts);
  if (!fetched.ok) return fetched;

  return {
    ok: true,
    status: fetched.response.status,
    contentType: fetched.contentType,
    contentLength: fetched.response.headers.get('content-length'),
    contentRange: fetched.response.headers.get('content-range'),
    acceptRanges: fetched.response.headers.get('accept-ranges'),
    response: fetched.response,
  };
}

/** 将 fetch Response body 接到 Node/Express 可 pipe 的 Readable */
export function upstreamBodyToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as NodeReadableStream);
}
