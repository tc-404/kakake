// ---------------------------------------------------------------------------
// TikTok 解析（内置 Cobalt 同款网页路径：短链 → @i/video/{id} → itemStruct）
// 进程内完成，不开端口、不依赖独立 Cobalt
// ---------------------------------------------------------------------------

import { cleanUrlTail, createDeadline, fetchWithTimeout, isAllowedDomain, PAGE_TIMEOUT_MS } from './http-utils';

const ALLOWED_DOMAINS = ['tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'musical.ly'];

/** 机房 IP 上带 Mozilla 的 UA 更容易被 TikTok 轻量页/挑战；Cobalt 社区用非 Mozilla UA 更稳 */
const UA_COBALT_LIKE = 'kakake/0.4.15 (+tiktok-webapp)';
const UA_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const UA_ANDROID =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';
const UA_DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
/** 短链解析用：去掉 Chrome/… 后缀，贴近 Cobalt 对 vt.tiktok.com 的 UA */
const UA_SHORT_LINK = UA_DESKTOP.split(' Chrome/')[0];

const FETCH_UA_LIST = [UA_COBALT_LIKE, UA_IPHONE, UA_ANDROID, UA_DESKTOP];

export interface TtMediaData {
  type: 'video' | 'image';
  title: string;
  author: string;
  cover: string;
  url: string;
  duration: number | null;
  video_id: string;
  images?: string[];
  music?: { title?: string; author?: string; url?: string };
  /** CDN 常需页面 Cookie（tt_chain_token 等），下载时一并带上 */
  cookie?: string;
}

export interface TtApiResult {
  code: number;
  msg: string;
  data?: TtMediaData;
}

function output(code: number, msg: string, data?: TtMediaData): TtApiResult {
  return data ? { code, msg, data } : { code, msg };
}

function extractTikTokUrl(text: string): string {
  const pathShort = text.match(/https?:\/\/(?:www\.)?tiktok\.com\/t\/[\w-]+\/?(?:\?[^\s]*)?/i);
  if (pathShort) return cleanUrlTail(pathShort[0]);

  const vm = text.match(/https?:\/\/(?:vm|vt|t)\.tiktok\.com\/[\w-]+\/?(?:\?[^\s]*)?/i);
  if (vm) return cleanUrlTail(vm[0]);

  const video = text.match(
    /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/\s]+\/video\/\d+(?:\?[^\s]*)?/i,
  );
  if (video) return cleanUrlTail(video[0]);

  const photo = text.match(
    /https?:\/\/(?:www\.|m\.)?tiktok\.com\/@[^/\s]+\/photo\/\d+(?:\?[^\s]*)?/i,
  );
  if (photo) return cleanUrlTail(photo[0]);

  const any = text.match(/https?:\/\/[^\s]*tiktok\.com\/[^\s]*/i);
  if (any) return cleanUrlTail(any[0]);

  return cleanUrlTail(text.trim());
}

function mergeCookies(...parts: string[]): string {
  const map = new Map<string, string>();
  for (const part of parts) {
    for (const piece of String(part || '').split(';')) {
      const s = piece.trim();
      if (!s || !s.includes('=')) continue;
      const eq = s.indexOf('=');
      const k = s.slice(0, eq).trim();
      const v = s.slice(eq + 1).trim();
      if (k) map.set(k, v);
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function pickCookieHeader(res: Response): string {
  const list =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
  if (list.length) {
    return list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  }
  const single = res.headers.get('set-cookie');
  if (!single) return '';
  return single
    .split(',')
    .map((p) => p.split(';')[0].trim())
    .filter((s) => s.includes('='))
    .join('; ');
}

function extractVideoId(url: string): string | null {
  const m =
    String(url || '').match(/\/video\/(\d+)/i) ||
    String(url || '').match(/\/photo\/(\d+)/i) ||
    String(url || '').match(/\/v\/(\d+)/i) ||
    String(url || '').match(/[?&]item_id=(\d+)/i) ||
    String(url || '').match(/[?&]aweme_id=(\d+)/i);
  return m?.[1] ?? null;
}

function extractShortLinkCode(url: string): string | null {
  const m =
    String(url || '').match(/(?:vm|vt|t)\.tiktok\.com\/([\w-]+)/i) ||
    String(url || '').match(/tiktok\.com\/t\/([\w-]+)/i);
  return m?.[1] ?? null;
}

/**
 * Cobalt 同款：vt.tiktok.com 短链 redirect:manual，从 <a href="..."> 抠正式 URL / postId
 */
async function resolveShortLinkPostId(shortCode: string): Promise<{ postId: string; finalUrl: string } | null> {
  try {
    const res = await fetchWithTimeout(`https://vt.tiktok.com/${shortCode}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': UA_SHORT_LINK },
    });
    const loc = res.headers.get('location') || '';
    if (loc) {
      const postId = extractVideoId(loc);
      if (postId) return { postId, finalUrl: loc };
    }
    const html = await res.text();
    if (html.startsWith('<a href="https://')) {
      const href = html.split('<a href="')[1]?.split('?')[0] || '';
      const postId = extractVideoId(href);
      if (postId) return { postId, finalUrl: href };
    }
    // 部分环境仍 follow 了；再从正文里找
    const fromHtml =
      html.match(/https?:\/\/(?:www\.)?tiktok\.com\/@[^/\s"']+\/(?:video|photo)\/\d+/i)?.[0] || '';
    const postId = extractVideoId(fromHtml) || extractVideoId(html);
    if (postId) return { postId, finalUrl: fromHtml || `https://www.tiktok.com/@i/video/${postId}` };
  } catch {
    // fall through
  }
  return null;
}

function extractBalancedObject(src: string, fromIdx: number): string | null {
  const braceStart = src.indexOf('{', fromIdx);
  if (braceStart < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let quote = '';
  for (let i = braceStart; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(braceStart, i + 1);
    }
  }
  return null;
}

function extractUniversalJson(html: string): Record<string, unknown> | null {
  // Cobalt：按 script id 切片；再兼容属性顺序 / 平衡括号
  const marker = 'id="__UNIVERSAL_DATA_FOR_REHYDRATION__"';
  const alt = "id='__UNIVERSAL_DATA_FOR_REHYDRATION__'";
  let idx = html.indexOf(marker);
  if (idx < 0) idx = html.indexOf(alt);
  if (idx >= 0) {
    const gt = html.indexOf('>', idx);
    const end = html.indexOf('</script>', gt);
    if (gt >= 0 && end > gt) {
      const raw = html.slice(gt + 1, end).trim();
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }

  const re = /<script\b[^>]*\bid=["']__UNIVERSAL_DATA_FOR_REHYDRATION__["'][^>]*>\s*([\s\S]*?)\s*<\/script>/i;
  const m = html.match(re);
  if (m?.[1]) {
    try {
      return JSON.parse(m[1]) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  const start = html.indexOf('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  if (start >= 0) {
    const raw = extractBalancedObject(html, start);
    if (raw) {
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // fall through
      }
    }
  }
  return null;
}

function pickItemStruct(root: Record<string, unknown>): Record<string, unknown> | null {
  const scope = (root.__DEFAULT_SCOPE__ || {}) as Record<string, unknown>;
  const candidates = [
    scope['webapp.video-detail'],
    scope['webapp.reflow.video.detail'],
  ];
  for (const block of candidates) {
    const item = (block as { itemInfo?: { itemStruct?: Record<string, unknown> } } | undefined)
      ?.itemInfo?.itemStruct;
    if (item && typeof item === 'object') return item;
  }
  return null;
}

/** 页面无完整 UNIVERSAL 时，尝试从 HTML 里抠 itemStruct */
function extractItemStructFromHtml(html: string): Record<string, unknown> | null {
  const uni = extractUniversalJson(html);
  if (uni) {
    const item = pickItemStruct(uni);
    if (item) return item;
  }

  const key = '"itemStruct"';
  let from = 0;
  while (from < html.length) {
    const idx = html.indexOf(key, from);
    if (idx < 0) break;
    const colon = html.indexOf(':', idx + key.length);
    if (colon < 0) break;
    const raw = extractBalancedObject(html, colon);
    if (raw) {
      try {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        if (obj && (obj.video || obj.id || obj.desc)) return obj;
      } catch {
        // continue
      }
    }
    from = idx + key.length;
  }
  return null;
}

function firstUrl(value: unknown): string {
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  if (Array.isArray(value)) {
    for (const x of value) {
      const u = firstUrl(x);
      if (u) return u;
    }
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const k of ['urlList', 'UrlList', 'url', 'Url']) {
      const u = firstUrl(o[k]);
      if (u) return u;
    }
  }
  return '';
}

function pickVideoUrl(video: Record<string, unknown> | undefined, preferH265 = false): string {
  if (!video) return '';
  // 默认挑 h264：浏览器普遍放不了 HEVC，选 h265 会「解析成功但播不动」，
  // 用户看到的是播放失败，容易被误判成防盗链。h265 只在 h264 缺失时兜底。
  if (preferH265) {
    const bitrate = video.bitrateInfo;
    if (Array.isArray(bitrate)) {
      for (const b of bitrate) {
        const codec = String((b as { CodecType?: string; codecType?: string })?.CodecType
          ?? (b as { codecType?: string })?.codecType
          ?? '');
        if (/h265|hevc/i.test(codec)) {
          const u = firstUrl(
            (b as { PlayAddr?: unknown })?.PlayAddr ?? (b as { playAddr?: unknown })?.playAddr,
          );
          if (u) return u;
        }
      }
    }
  }
  const play = firstUrl(video.playAddr);
  if (play) return play;
  const download = firstUrl(video.downloadAddr);
  if (download) return download;
  const bitrate = video.bitrateInfo;
  if (Array.isArray(bitrate)) {
    for (const b of bitrate) {
      const u = firstUrl(
        (b as { PlayAddr?: unknown; playAddr?: unknown })?.PlayAddr
          ?? (b as { playAddr?: unknown })?.playAddr,
      );
      if (u) return u;
    }
  }
  return '';
}

function pickImageList(item: Record<string, unknown>): string[] {
  const images: string[] = [];
  const push = (u: string) => {
    if (u && !images.includes(u)) images.push(u);
  };

  const imagePost = item.imagePost as
    | { images?: Array<{ imageURL?: unknown; urlList?: unknown }> }
    | undefined;
  if (Array.isArray(imagePost?.images)) {
    for (const img of imagePost.images) {
      // Cobalt 优先 .jpeg?
      const list = firstUrl(img?.imageURL) || firstUrl(img?.urlList) || firstUrl(img);
      if (list) {
        const jpegPrefer =
          (Array.isArray((img as { imageURL?: { urlList?: string[] } })?.imageURL?.urlList)
            ? (img as { imageURL: { urlList: string[] } }).imageURL.urlList.find((p) =>
                String(p).includes('.jpeg?'),
              )
            : '') || list;
        push(String(jpegPrefer));
      }
    }
  }

  const slideshow = item.image_post_info || item.imagePostInfo;
  if (slideshow && typeof slideshow === 'object') {
    const arr = (slideshow as { images?: unknown }).images;
    if (Array.isArray(arr)) {
      for (const img of arr) push(firstUrl(img));
    }
  }

  return images.filter(Boolean);
}

function pickMusic(item: Record<string, unknown>): { title?: string; author?: string; url?: string } | undefined {
  const music = item.music as
    | { title?: string; authorName?: string; author?: string; playUrl?: unknown }
    | undefined;
  if (!music) return undefined;
  const url = firstUrl(music.playUrl);
  if (!url) return undefined;
  return {
    title: music.title ? String(music.title) : undefined,
    author: String(music.authorName || music.author || '') || undefined,
    url,
  };
}

async function fetchPage(
  url: string,
  ua: string,
  cookie = '',
): Promise<{ ok: boolean; status: number; finalUrl: string; html: string; cookie: string }> {
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  }, PAGE_TIMEOUT_MS);
  const nextCookie = mergeCookies(cookie, pickCookieHeader(res));
  const html = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    finalUrl: res.url || url,
    html,
    cookie: nextCookie,
  };
}

function formatFromItem(item: Record<string, unknown>, cookie: string): TtApiResult {
  const video = item.video as Record<string, unknown> | undefined;
  const images = pickImageList(item);
  const streamUrl = pickVideoUrl(video);
  const authorObj = (item.author as { nickname?: string; uniqueId?: string } | undefined) || {};
  const author = String(authorObj.nickname || authorObj.uniqueId || '');
  const title = String(item.desc || '');
  const cover =
    firstUrl(video?.cover) ||
    firstUrl(video?.originCover) ||
    images[0] ||
    '';
  const durationRaw = Number(video?.duration);
  const videoId = String(item.id || video?.id || '');
  const music = pickMusic(item);

  if (images.length && !streamUrl) {
    return output(200, '解析成功', {
      type: 'image',
      title,
      author,
      cover,
      url: '',
      duration: null,
      video_id: videoId,
      images,
      ...(music ? { music } : {}),
      ...(cookie ? { cookie } : {}),
    });
  }

  if (!streamUrl) return output(404, '未找到视频直链');

  return output(200, '解析成功', {
    type: 'video',
    title,
    author,
    cover,
    url: streamUrl,
    duration: Number.isFinite(durationRaw) ? durationRaw : null,
    video_id: videoId,
    ...(music ? { music } : {}),
    ...(cookie ? { cookie } : {}),
  });
}

/**
 * 解析 TikTok 链接（含 www.tiktok.com/t/ 短链）
 */
export async function parse(urlInput: string): Promise<TtApiResult> {
  const url = extractTikTokUrl(urlInput);
  if (!url) return output(400, '请输入 TikTok 链接');

  if (!isAllowedDomain(url, ALLOWED_DOMAINS)) {
    return output(400, '非 TikTok 域名链接');
  }

  // 多地址 × 多 UA 的串行重试最多会打二十来次上游请求，整体变慢时必须收手，
  // 否则用户只能一直等（这里限制总时长，单次请求自身另有 15/20 秒超时）
  const deadline = createDeadline(25 * 1000);

  try {
    let cookie = '';
    let finalUrl = url;
    let item: Record<string, unknown> | null = null;
    let lastStatus = 0;
    let tried = 0;
    let postId = extractVideoId(url);
    const routes: string[] = [];

    // 1) Cobalt 同款短链：vt.tiktok.com + redirect:manual
    if (!postId) {
      const shortCode = extractShortLinkCode(url);
      if (shortCode) {
        routes.push('短链跳转');
        const resolved = await resolveShortLinkPostId(shortCode);
        if (resolved) {
          postId = resolved.postId;
          finalUrl = resolved.finalUrl || finalUrl;
        }
      }
    }

    // 2) 主路径：https://www.tiktok.com/@i/video/{postId}（Cobalt 固定用 /video/，图集也一样）
    if (postId && !deadline.expired()) {
      routes.push('详情页');
      const detailUrls = [
        `https://www.tiktok.com/@i/video/${postId}`,
        `https://www.tiktok.com/@/video/${postId}`,
        `https://m.tiktok.com/v/${postId}`,
      ];
      for (const detailUrl of detailUrls) {
        for (const ua of FETCH_UA_LIST) {
          if (deadline.expired()) break;
          tried += 1;
          const page = await fetchPage(detailUrl, ua, cookie);
          cookie = page.cookie;
          finalUrl = page.finalUrl || finalUrl;
          lastStatus = page.status;
          item = extractItemStructFromHtml(page.html);
          if (item) break;
        }
        if (item || deadline.expired()) break;
      }
    }

    // 3) 兜底：直接拉原链 / follow 后的页（多 UA）
    if (!item && !deadline.expired()) {
      routes.push('原始链接');
      for (const ua of FETCH_UA_LIST) {
        if (deadline.expired()) break;
        tried += 1;
        const page = await fetchPage(url, ua, cookie);
        cookie = page.cookie;
        finalUrl = page.finalUrl || finalUrl;
        lastStatus = page.status;
        if (!page.ok && page.status >= 400) continue;
        item = extractItemStructFromHtml(page.html);
        if (item) break;
      }
    }

    // 4) 仍无 postId 时，从 follow 后的 finalUrl 再试 @i/video
    if (!item && !deadline.expired()) {
      const id2 = extractVideoId(finalUrl) || postId;
      if (id2 && id2 !== postId) {
        routes.push('跳转后详情页');
        for (const ua of FETCH_UA_LIST) {
          if (deadline.expired()) break;
          tried += 1;
          const page = await fetchPage(`https://www.tiktok.com/@i/video/${id2}`, ua, cookie);
          cookie = page.cookie;
          lastStatus = page.status;
          item = extractItemStructFromHtml(page.html);
          if (item) break;
        }
      }
    }

    if (!item) {
      const detail = `已尝试 ${routes.length ? routes.join(' → ') : '无可用路线'}，共 ${tried} 次请求`
        + (lastStatus ? `，最后状态 HTTP ${lastStatus}` : '');
      if (deadline.expired()) {
        return output(504, `解析失败：TikTok 响应太慢，已到总时限（${detail}）`);
      }
      if (!postId) {
        return output(400, `解析失败：没能从链接里定位到作品 ID（${detail}）`);
      }
      return output(404, `解析失败：页面里没有内嵌作品数据（${detail}，通常是被风控或页面结构已变更）`);
    }

    return formatFromItem(item, cookie);
  } catch (e) {
    return output(500, e instanceof Error ? e.message : '解析失败');
  }
}

export default { parse };
