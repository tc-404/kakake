/**
 * 媒体资源代理下载：绕过浏览器端防盗链 / CORS，供工具页「下载视频」「下载封面」使用。
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

const ALLOWED_HOST_SUFFIXES = [
  'douyinvod.com',
  'douyin.com',
  'iesdouyin.com',
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
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export type MediaDownloadKind = 'video' | 'cover';

function hostAllowed(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return ALLOWED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
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

function extFromUrl(url: URL, kind: MediaDownloadKind): string | null {
  const path = url.pathname.toLowerCase();
  const m = path.match(/\.(mp4|webm|mov|m4v|jpg|jpeg|png|webp|gif)(?:$|\?)/i);
  if (m) return m[1]!.toLowerCase() === 'jpeg' ? 'jpg' : m[1]!.toLowerCase();
  return kind === 'cover' ? null : null;
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

/**
 * 拉取远端媒体。调用方负责把 body 管道写给客户端。
 */
export async function fetchMediaForDownload(opts: {
  url: string;
  kind: MediaDownloadKind;
  platform?: string | null;
}): Promise<MediaProxyDownloadResult> {
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
    return { ok: false, status: 403, message: '该域名不允许代理下载' };
  }

  const referer = refererFor(target, opts.platform);
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Origin: referer.replace(/\/$/, ''),
        Accept: opts.kind === 'cover' ? 'image/avif,image/webp,image/*,*/*;q=0.8' : '*/*',
      },
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      message: e instanceof Error ? e.message : '拉取资源失败',
    };
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
  const ext = extFromUrl(target, opts.kind) || extFromContentType(contentType, opts.kind);
  const filename = buildFilename(opts.kind, ext);

  return {
    ok: true,
    response: upstream,
    filename,
    contentType,
  };
}

/** 将 fetch Response body 接到 Node/Express 可 pipe 的 Readable */
export function upstreamBodyToNodeStream(body: ReadableStream<Uint8Array>): Readable {
  return Readable.fromWeb(body as unknown as NodeReadableStream);
}
