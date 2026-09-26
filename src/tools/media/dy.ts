// ---------------------------------------------------------------------------
// 抖音解析（移植 short_videos DouyinParser.php：视频/图集/实况）
// ---------------------------------------------------------------------------

import {
  cleanUrlTail,
  createDeadline,
  extractBalancedJsonFrom,
  fetchText,
  fetchWithTimeout,
  followRedirect,
  type Deadline,
} from './http-utils';
import { generateABogus, generateFingerprint, generateMsToken } from './dy-abogus';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** iPhone UA：m.douyin.com 分享页更易返回 _ROUTER_DATA，ies 站易触发 waf-js */
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

export interface DyAuthor {
  name: string;
  id: string;
  avatar: string;
}

export interface DyLivePhoto {
  image: string;
  video: string;
}

export interface DyMusic {
  title: string;
  author: string;
  url: string;
  cover: string;
}

export interface DyMediaData {
  type: 'video' | 'image' | 'live' | 'animated' | 'unknown';
  title: string;
  desc: string;
  author: DyAuthor;
  cover: string;
  url: string | null;
  duration: number | null;
  /** 发布时间（Unix 秒），上游未返回时为空 */
  create_time?: number;
  video_backup: string[] | null;
  video_id?: string;
  images: string[];
  live_photo: DyLivePhoto[];
  music: DyMusic;
  tags: string[];
  stats: {
    views: number;
    likes: number;
    comments: number;
    shares: number;
    favorites: number;
  };
}

export interface DyApiResult {
  code: number;
  msg: string;
  data?: DyMediaData;
}

function output(code: number, msg: string, data: DyMediaData | Record<string, never> = {}): DyApiResult {
  return { code, msg, data: data as DyMediaData };
}

function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

function extractDouyinUrl(text: string): string {
  const shortMatch = text.match(/https?:\/\/v\.douyin\.com\/[\w-]+/i);
  if (shortMatch) return shortMatch[0].trim();
  const longMatch = text.match(/https?:\/\/(?:www\.)?douyin\.com\/[^\s]+/i);
  if (longMatch) return longMatch[0].trim().replace(/[^\w\-./?=&:#]+$/i, '');
  const anyMatch = text.match(/https?:\/\/[^\s]*douyin\.com[^\s]*/i);
  if (anyMatch) return anyMatch[0].trim().replace(/[^\w\-./?=&:#]+$/i, '');
  return text.trim();
}

function extractId(url: string): string | null {
  const patterns = [
    /\/share\/note\/(\d+)/,
    /\/share\/video\/(\d+)/,
    /\/share\/slides\/(\d+)/,
    /\/video\/(\d+)/,
    /\/note\/(\d+)/,
    /\/slides\/(\d+)/,
    /modal_id=(\d+)/,
    /[?&]item_ids=(\d+)/,
    /^(\d+)$/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function isNoteUrl(url: string): boolean {
  return /\/note\/|share\/note/i.test(url);
}

function isSlidesUrl(url: string): boolean {
  return /\/slides\/|share\/slides/i.test(url);
}

function buildShareFetchUrls(resolvedUrl: string, id: string): string[] {
  const urls: string[] = [];
  // Windows 家宽下 ies / m.douyin share/video 易被 waf-js；
  // slides/动图在 m.douyin.com/share/note/{id} 当前仍能拿到 _ROUTER_DATA
  if (isNoteUrl(resolvedUrl) || isSlidesUrl(resolvedUrl)) {
    urls.push(`https://m.douyin.com/share/note/${id}`);
    urls.push(`https://m.douyin.com/share/video/${id}`);
    urls.push(`https://m.douyin.com/share/slides/${id}/`);
    urls.push(`https://www.iesdouyin.com/share/note/${id}/`);
    urls.push(`https://www.iesdouyin.com/share/slides/${id}/`);
    urls.push(`https://www.douyin.com/note/${id}`);
  } else {
    urls.push(`https://m.douyin.com/share/video/${id}`);
    urls.push(`https://m.douyin.com/share/note/${id}`);
  }
  // 通用兜底：note 再试一次（图集/动图短链常跳 slides，但 note 页更稳）
  urls.push(`https://m.douyin.com/share/note/${id}`);
  urls.push(`https://m.douyin.com/share/video/${id}`);
  urls.push(`https://www.iesdouyin.com/share/video/${id}/`);
  urls.push(`https://www.douyin.com/video/${id}`);
  urls.push(`https://www.douyin.com/user/self?modal_id=${id}&showTab=like`);
  return [...new Set(urls)];
}

async function getRealUrl(url: string): Promise<string> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': MOBILE_UA },
    });
    const location = res.headers.get('location');
    if (location) {
      const loc = location;
      if (extractId(loc)) return loc;
      return loc;
    }
  } catch {
    // fallback
  }
  return followRedirect(url, MOBILE_UA);
}

function isBlockedHtml(html: string): boolean {
  // iesdouyin 风控页常见 waf-js + 极短 HTML；勿仅凭长度误杀 m.douyin 正常壳页
  if (html.includes('waf-js') && html.length < 10000) return true;
  if (html.length < 800 && !html.includes('_ROUTER_DATA') && !html.includes('RENDER_DATA')) return true;
  return false;
}

async function requestPage(url: string, userAgent = MOBILE_UA): Promise<string | false> {
  try {
    const html = await fetchText(
      url,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          Referer: 'https://www.douyin.com/',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      },
      userAgent,
    );
    if (isBlockedHtml(html)) return false;
    return html;
  } catch {
    return false;
  }
}

async function fetchDetailById(
  resolvedUrl: string,
  id: string,
  deadline: Deadline,
): Promise<Record<string, unknown> | null> {
  const fetchUrls = buildShareFetchUrls(resolvedUrl, id);

  // Windows 家宽 IP 更容易被抖音间歇性风控，失败后再整轮重试一次。
  // 每轮最多约 20 次请求（10 个地址 × 2 个 UA），必须盯着总时限。
  for (let round = 0; round < 2; round++) {
    if (round > 0) {
      await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random() * 400)));
    }
    for (const pageUrl of fetchUrls) {
      if (deadline.expired()) return null;
      const preferMobile = pageUrl.includes('m.douyin.com') || pageUrl.includes('iesdouyin.com');
      const uas = preferMobile ? [MOBILE_UA, USER_AGENT] : [USER_AGENT, MOBILE_UA];
      for (const ua of uas) {
        if (deadline.expired()) return null;
        const html = await requestPage(pageUrl, ua);
        if (!html) continue;
        const detail = extractJsonFromHtml(html);
        if (detail) return detail;
      }
    }
  }
  return null;
}

/* ==================== 签名 web API 路线（a_bogus） ==================== */

/** 签名用 UA 必须与请求头 UA 完全一致，否则 a_bogus 校验不通过 */
const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const DETAIL_API = 'https://www.douyin.com/aweme/v1/web/aweme/detail/';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let ttwidCache: { value: string; expire: number } | null = null;

/** 申请 ttwid（游客身份 cookie），30 分钟内复用 */
async function getTtwid(): Promise<string> {
  if (ttwidCache && ttwidCache.expire > Date.now()) return ttwidCache.value;
  try {
    const res = await fetchWithTimeout('https://ttwid.bytedance.com/ttwid/union/register/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': WEB_UA },
      body: JSON.stringify({
        region: 'cn',
        aid: 1768,
        needFid: false,
        service: 'www.ixigua.com',
        migrate_info: { ticket: '', source: 'node' },
        cbUrlProtocol: 'https',
        union: true,
      }),
    });
    const setCookie = res.headers.get('set-cookie') || '';
    const matched = setCookie.match(/ttwid=([^;]+)/);
    if (matched) {
      ttwidCache = { value: matched[1], expire: Date.now() + 30 * 60 * 1000 };
      return matched[1];
    }
  } catch {
    // 拿不到就空着，抖音对详情接口的 ttwid 校验并非强制
  }
  return '';
}

/** 详情接口 query（顺序需与真实前端一致，签名对参数串敏感） */
function buildDetailParams(id: string, msToken: string): string {
  const params: Array<[string, string]> = [
    ['device_platform', 'webapp'],
    ['aid', '6383'],
    ['channel', 'channel_pc_web'],
    ['aweme_id', id],
    ['pc_client_type', '1'],
    ['version_code', '190500'],
    ['version_name', '19.5.0'],
    ['cookie_enabled', 'true'],
    ['screen_width', '1920'],
    ['screen_height', '1080'],
    ['browser_language', 'zh-CN'],
    ['browser_platform', 'Win32'],
    ['browser_name', 'Chrome'],
    ['browser_version', '126.0.0.0'],
    ['browser_online', 'true'],
    ['engine_name', 'Blink'],
    ['engine_version', '126.0.0.0'],
    ['os_name', 'Windows'],
    ['os_version', '10'],
    ['cpu_core_num', '12'],
    ['device_memory', '8'],
    ['platform', 'PC'],
    ['downlink', '10'],
    ['effective_type', '4g'],
    ['round_trip_time', '50'],
    ['msToken', msToken],
  ];
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

export interface DyApiDetailResult {
  detail?: Record<string, unknown>;
  /** 抖音给出的不可看原因（作品被删/私密等） */
  filterMsg?: string;
}

/**
 * 走签名后的 web 详情接口取 aweme_detail。
 * 分享页自 2024 年改版后已不再内嵌 videoInfoRes，这条路线是当前主路线。
 */
async function fetchDetailByApi(id: string, deadline: Deadline): Promise<DyApiDetailResult> {
  const ttwid = await getTtwid();
  const fingerprint = generateFingerprint();
  let filterMsg = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    if (deadline.expired()) break;
    if (attempt > 0) await sleep(400 + Math.floor(Math.random() * 500));

    const msToken = generateMsToken();
    const params = buildDetailParams(id, msToken);
    const abogus = generateABogus(params, {
      userAgent: WEB_UA,
      fingerprint,
      options: [0, 1, 8],
    });
    const url = `${DETAIL_API}?${params}&a_bogus=${encodeURIComponent(abogus)}`;
    const cookie = [ttwid ? `ttwid=${ttwid}` : '', `msToken=${msToken}`]
      .filter(Boolean)
      .join('; ');

    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          'User-Agent': WEB_UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: `https://www.douyin.com/video/${id}`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      if (!res.ok) continue;
      // 风控时抖音返回 200 + 空 body
      const text = await res.text();
      if (!text.trim()) continue;
      const json = JSON.parse(text) as {
        aweme_detail?: Record<string, unknown>;
        aweme_details?: Record<string, unknown>[];
        filter_detail?: { detail_msg?: string; notice?: string };
      };
      const detail = json.aweme_detail ?? json.aweme_details?.[0];
      if (detail && (detail.video || detail.images)) return { detail };
      // 作品被删/私密：接口正常返回但 aweme_detail 为 null，重试无意义
      const msg = json.filter_detail?.detail_msg || json.filter_detail?.notice || '';
      if (msg) {
        filterMsg = msg;
        break;
      }
    } catch {
      // 换 msToken 重试
    }
  }
  return filterMsg ? { filterMsg } : {};
}

/** 判断某个对象是否是作品详情节点 */
function looksLikeDetail(node: Record<string, unknown>): boolean {
  const hasMedia =
    (node.video && typeof node.video === 'object') ||
    (Array.isArray(node.images) && node.images.length > 0);
  if (!hasMedia) return false;
  return (
    typeof node.desc === 'string' ||
    typeof node.aweme_id === 'string' ||
    typeof node.awemeId === 'string' ||
    node.author !== undefined ||
    node.authorInfo !== undefined
  );
}

/**
 * 深度搜索详情节点。
 * 分享页的 _ROUTER_DATA 结构会随抖音前端改版变化（如 note_layout / note_(id)/page），
 * 写死路径会一改版就失效，这里改成按特征找。
 */
function findDetailNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDetailNode(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  if (looksLikeDetail(obj)) return obj;
  for (const key of Object.keys(obj)) {
    const found = findDetailNode(obj[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function extractJsonFromHtml(html: string): Record<string, unknown> | null {
  const renderStart = '<script id="RENDER_DATA" type="application/json">';
  const posStart = html.indexOf(renderStart);
  if (posStart >= 0) {
    const jsonStr = html.slice(posStart + renderStart.length);
    const posEnd = jsonStr.indexOf('</script>');
    if (posEnd >= 0) {
      try {
        const decoded = decodeURIComponent(jsonStr.slice(0, posEnd));
        const data = JSON.parse(decoded) as { app?: { videoDetail?: Record<string, unknown> } };
        if (data.app?.videoDetail) return data.app.videoDetail;
      } catch {
        // continue fallback
      }
    }
  }

  const routerJson = extractBalancedJsonFrom(html, 'window._ROUTER_DATA');
  if (routerJson) {
    try {
      const json = JSON.parse(routerJson) as { loaderData?: Record<string, unknown> };
      const loaderData = json.loaderData;
      if (loaderData) {
        // 旧结构：loaderData['video_(id)/page'].videoInfoRes.item_list[0]
        for (const key of Object.keys(loaderData)) {
          const page = loaderData[key] as {
            videoInfoRes?: { item_list?: Record<string, unknown>[] };
          };
          if (page?.videoInfoRes?.item_list?.[0]) {
            return page.videoInfoRes.item_list[0];
          }
        }
        // 新结构（note_layout / note_(id)/page 等）：按特征深搜
        const found = findDetailNode(loaderData);
        if (found) return found;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

function pickBestPlayUrl(candidates: string[]): string | null {
  if (!candidates.length) return null;
  let v3Link: string | null = null;
  let v26Link: string | null = null;
  for (const candidate of candidates) {
    if (candidate.includes('v3-web')) return candidate;
    if (candidate.includes('v26-web')) v26Link = candidate;
  }
  if (v26Link) return v26Link.replace(/:\/\/([^/]+)/, '://v26-luna.douyinvod.com');
  return candidates[0];
}

/** 抖音 CDN 动图 / GIF 启发式（实况有独立 video 轨，动图常只有动图 webp） */
function isAnimatedImageUrl(url: string): boolean {
  const u = String(url || '').toLowerCase();
  if (!u) return false;
  if (u.includes('.gif')) return true;
  if (u.includes('awebp') || u.includes('animated')) return true;
  // lqen / livephoto 管线常见于动图与实况封面
  if (u.includes('lqen') || u.includes('livephoto') || u.includes('live_photo')) return true;
  return false;
}

function collectImageUrls(img: Record<string, unknown>): string[] {
  const out: string[] = [];
  const lists = [img.url_list, img.urlList, img.download_url_list, img.downloadUrlList];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const s = String(item || '').trim();
      if (s && !out.includes(s)) out.push(s);
    }
  }
  return out;
}

function pickImageUrl(img: Record<string, unknown>): string {
  const all = collectImageUrls(img);
  if (!all.length) return '';
  const animated = all.find((u) => isAnimatedImageUrl(u));
  return animated || all[0];
}

/* ==================== 去水印 ==================== */

/**
 * 抖音带水印地址的标记：
 * - playwm 路由（老分享接口的水印版）
 * - watermark=1 / watermark=true 参数（aweme/v1/play 路由的水印开关，实况图最常踩这个坑）
 * 另外 download_addr 字段给的是「保存到相册」用的水印版，靠字段来源排序规避，不在这里判断。
 */
function isWatermarkedUrl(url: string): boolean {
  const u = String(url || '');
  if (!u) return false;
  if (/playwm/i.test(u)) return true;
  if (/[?&]watermark=(1|true)(?=[&#]|$)/i.test(u)) return true;
  return false;
}

/** 改写成无水印地址：playwm→play、watermark=1→watermark=0 */
function stripWatermark(url: string): string {
  let u = String(url || '');
  if (!u) return '';
  u = u.replace(/playwm/gi, 'play');
  u = u.replace(/([?&]watermark=)(?:1|true)(?=[&#]|$)/gi, (_m, prefix: string) => `${prefix}0`);
  return u;
}

/** CDN 偏好：v3-web 最稳，v26-web 需要换 luna 域名，其余最后 */
function cdnRank(url: string): number {
  if (url.includes('v3-web')) return 0;
  if (url.includes('v26-web')) return 1;
  return 2;
}

/** 用 video_id 拼无水印播放接口，作为只剩水印地址时的兜底 */
function buildPlayApiUrl(videoInfo: Record<string, unknown>): string | null {
  const fromPlayAddr = (videoInfo.play_addr as { uri?: string } | undefined)?.uri;
  const fromCamel = (videoInfo.playAddr as { uri?: string } | undefined)?.uri;
  const uri = [fromPlayAddr, fromCamel, videoInfo.uri].find((v) => typeof v === 'string' && v);
  if (!uri) return null;
  return `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(String(uri))}&ratio=1080p&line=0`;
}

/** 画面轨候选：weight 越小越优先，download_addr（水印版）排最后 */
interface LiveTrackCandidate {
  url: string;
  weight: number;
}

function extractLiveVideoUrl(videoInfo: Record<string, unknown>): string | null {
  if (!videoInfo || typeof videoInfo !== 'object') return null;
  const candidates: LiveTrackCandidate[] = [];

  const push = (value: unknown, weight: number) => {
    const s = typeof value === 'string' ? value.trim() : '';
    if (s) candidates.push({ url: s, weight });
  };
  const pushList = (list: unknown, weight: number) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (typeof item === 'string') push(item, weight);
      else if (item && typeof item === 'object') push((item as { src?: string }).src, weight);
    }
  };

  // 0 = play_addr 系列（无水印画面轨）
  const playAddr = videoInfo.playAddr as Array<{ src?: string }> | { url_list?: string[] } | undefined;
  if (Array.isArray(playAddr)) {
    for (const addr of playAddr) push(addr?.src, 0);
  } else if (playAddr && typeof playAddr === 'object') {
    pushList((playAddr as { url_list?: string[] }).url_list, 0);
  }
  pushList((videoInfo.play_addr as { url_list?: string[] } | undefined)?.url_list, 0);

  // 1 = 编码分支；2 = 码率列表
  for (const key of ['play_addr_h264', 'play_addr_265', 'play_addr_lowbr']) {
    pushList((videoInfo[key] as { url_list?: string[] } | undefined)?.url_list, 1);
  }
  const bitRates = (videoInfo.bit_rate || videoInfo.bitRateList || videoInfo.bit_rate_list) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(bitRates)) {
    for (const rate of bitRates) {
      pushList((rate.play_addr as { url_list?: string[] } | undefined)?.url_list, 2);
      const pa2 = rate.playAddr as Array<{ src?: string }> | undefined;
      if (Array.isArray(pa2)) for (const a of pa2) push(a?.src, 2);
    }
  }

  // 3 = 播放接口地址；9 = download_addr，抖音给的是水印版，只在别无选择时用
  push(videoInfo.playApi, 3);
  push(videoInfo.play_api, 3);
  if (videoInfo.download_addr && typeof videoInfo.download_addr === 'object') {
    pushList((videoInfo.download_addr as { url_list?: string[] }).url_list, 9);
  }

  // 过滤明显是配乐而非画面轨
  let media = candidates.filter((c) => !/ies-music|\/obj\/ies-music\//i.test(c.url));
  if (!media.length) media = candidates;
  if (!media.length) return null;

  // 排序：先无水印，再按字段来源，最后按 CDN
  const score = (c: LiveTrackCandidate) =>
    (isWatermarkedUrl(c.url) ? 1000 : 0) + c.weight * 10 + cdnRank(c.url);
  media.sort((a, b) => score(a) - score(b));

  const best = media[0];
  let url = stripWatermark(best.url);
  if (url.includes('v26-web')) url = url.replace(/:\/\/([^/]+)/, '://v26-luna.douyinvod.com');

  // 改写后仍带水印，或只剩 download_addr：用 video_id 走无水印播放接口
  if (isWatermarkedUrl(url) || best.weight >= 9) {
    const clean = buildPlayApiUrl(videoInfo);
    if (clean) return clean;
  }
  return url;
}

function extractImageLiveVideo(img: Record<string, unknown>): string | null {
  const nested =
    (img.video as Record<string, unknown> | undefined) ||
    (img.live_photo as Record<string, unknown> | undefined) ||
    (img.livePhoto as Record<string, unknown> | undefined) ||
    (img.clip as Record<string, unknown> | undefined) ||
    {};
  let url = extractLiveVideoUrl(nested);
  if (!url && typeof img.video === 'string') url = img.video;
  if (!url && typeof img.live_video_url === 'string') url = img.live_video_url;
  return url ? stripWatermark(url) : null;
}

function extractHighestQualityVideo(detail: Record<string, unknown>): { url: string | null; backup: string[] } {
  let url: string | null = null;
  const backup: string[] = [];
  const video = detail.video as Record<string, unknown> | undefined;

  const bitRateList = (video?.bitRateList ?? video?.bit_rate ?? video?.bit_rate_list) as
    | Array<Record<string, unknown>>
    | undefined;
  if (Array.isArray(bitRateList) && bitRateList.length) {
    const sorted = [...bitRateList].sort(
      (a, b) =>
        (Number(b.bitRate ?? b.bit_rate) || 0) - (Number(a.bitRate ?? a.bit_rate) || 0),
    );

    for (const rateItem of sorted) {
      const candidates: string[] = [];
      const playAddr = rateItem.playAddr as Array<{ src?: string }> | undefined;
      if (Array.isArray(playAddr)) {
        for (const pa of playAddr) {
          if (pa.src) candidates.push(pa.src);
        }
      } else {
        const playAddrSnake = rateItem.play_addr as { url_list?: string[] } | undefined;
        if (playAddrSnake?.url_list) candidates.push(...playAddrSnake.url_list);
      }
      if (!candidates.length) continue;

      // 水印版排除在外，只有全是水印版时才退而用它
      const cleanOnes = candidates.filter((c) => !isWatermarkedUrl(c));
      const pool = cleanOnes.length ? cleanOnes : candidates;
      const currentBest = pickBestPlayUrl(pool);
      if (!url && currentBest) url = currentBest;

      for (let candidate of pool) {
        if (candidate.includes('v26-web')) {
          candidate = candidate.replace(/:\/\/([^/]+)/, '://v26-luna.douyinvod.com');
        }
        candidate = stripWatermark(candidate);
        if (candidate !== url && !backup.includes(candidate)) backup.push(candidate);
      }

      if (url && backup.length) break;
    }
  }

  if (!url && video) {
    const uri = video.uri as string | undefined;
    const playApi = (video.playApi as string | undefined) ??
      ((video.play_addr as { url_list?: string[] })?.url_list?.[0]);
    if (playApi) {
      url = stripWatermark(playApi);
    } else if (uri) {
      url = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=720p&line=0`;
    }

    const urlList = (video.play_addr as { url_list?: string[] })?.url_list ?? [];
    for (let i = 1; i < urlList.length; i++) {
      backup.push(stripWatermark(urlList[i]));
    }
  }

  if (url) url = stripWatermark(url);
  // 兜底：改写后依然是水印版就用 video_id 走无水印播放接口
  if (url && isWatermarkedUrl(url) && video) {
    const clean = buildPlayApiUrl(video);
    if (clean) url = clean;
  }
  return { url, backup };
}

function extractCover(detail: Record<string, unknown>): string {
  const video = detail.video as Record<string, unknown> | undefined;
  let cover = '';

  const originCover = video?.originCover as { urlList?: string[] } | undefined;
  const originCoverSnake = video?.origin_cover as { url_list?: string[] } | undefined;
  if (originCover?.urlList?.[0]) cover = originCover.urlList[0];
  else if (originCoverSnake?.url_list?.[0]) cover = originCoverSnake.url_list[0];
  else if (typeof video?.originCover === 'string') cover = video.originCover;
  else if (Array.isArray(video?.originCoverUrlList) && video.originCoverUrlList[0]) {
    cover = String(video.originCoverUrlList[0]);
  }

  if (!cover && video) {
    const coverObj = video.cover as { urlList?: string[]; url_list?: string[] } | string | undefined;
    if (typeof coverObj === 'string') cover = coverObj;
    else cover = coverObj?.urlList?.[0] ?? coverObj?.url_list?.[0] ?? '';
  }

  const detailCover = detail.cover as { url_list?: string[] } | undefined;
  if (!cover && detailCover?.url_list?.[0]) cover = detailCover.url_list[0];

  if (!cover && video) {
    const dynamicCover = video.dynamicCover as { urlList?: string[] } | undefined;
    const dynamicCoverSnake = video.dynamic_cover as { url_list?: string[] } | undefined;
    cover = dynamicCover?.urlList?.[0] ?? dynamicCoverSnake?.url_list?.[0] ?? '';
  }

  return cover;
}

function extractDyTags(detail: Record<string, unknown>, desc: string): string[] {
  const tags: string[] = [];
  const push = (t: unknown) => {
    const s = typeof t === 'string' ? t.trim() : '';
    if (s && !tags.includes(s)) tags.push(s);
  };

  const textExtra = detail.text_extra as Array<{ hashtag_name?: string; name?: string }> | undefined;
  if (Array.isArray(textExtra)) {
    for (const item of textExtra) push(item.hashtag_name || item.name);
  }
  const textExtraCamel = detail.textExtra as Array<{ hashtagName?: string; name?: string }> | undefined;
  if (Array.isArray(textExtraCamel)) {
    for (const item of textExtraCamel) push(item.hashtagName || item.name);
  }
  const chaList = detail.cha_list as Array<{ cha_name?: string }> | undefined;
  if (Array.isArray(chaList)) {
    for (const item of chaList) push(item.cha_name);
  }
  const videoTag = detail.video_tag as Array<{ tag_name?: string }> | undefined;
  if (Array.isArray(videoTag)) {
    for (const item of videoTag) push(item.tag_name);
  }
  for (const m of desc.matchAll(/#([^\s#]+)/g)) push(m[1]);
  return tags;
}

function extractDyStats(detail: Record<string, unknown>) {
  const s = (detail.statistics || detail.stats || {}) as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  return {
    views: n(s.play_count ?? s.playCount ?? s.view_count ?? detail.playCount),
    likes: n(s.digg_count ?? s.diggCount ?? s.like_count ?? s.admire_count),
    comments: n(s.comment_count ?? s.commentCount),
    shares: n(s.share_count ?? s.shareCount),
    favorites: n(s.collect_count ?? s.collectCount ?? s.forward_count),
  };
}

function formatData(detail: Record<string, unknown>): DyApiResult {
  const authorInfo = detail.authorInfo as Record<string, unknown> | undefined;
  const author = detail.author as Record<string, unknown> | undefined;
  const music = detail.music as Record<string, unknown> | undefined;
  const video = detail.video as Record<string, unknown> | undefined;
  const desc = (detail.desc as string) ?? '';

  const result: DyMediaData = {
    type: 'unknown',
    title: desc,
    desc,
    author: {
      name:
        (authorInfo?.nickname as string) ??
        (author?.nickname as string) ??
        '',
      id: String(authorInfo?.uid ?? author?.uid ?? ''),
      avatar:
        (authorInfo?.avatarUri as string) ??
        ((author?.avatar_thumb as { url_list?: string[] })?.url_list?.[0] ?? ''),
    },
    cover: extractCover(detail),
    url: null,
    duration: (video?.duration as number | null) ?? null,
    create_time: Number(detail.createTime ?? detail.create_time) || undefined,
    video_backup: null,
    images: [],
    live_photo: [],
    music: {
      title: (music?.musicName as string) ?? (music?.title as string) ?? '',
      author: (music?.ownerNickname as string) ?? (music?.author as string) ?? '',
      url:
        (music?.playUrl as { uri?: string })?.uri ??
        (music?.play_url as { uri?: string })?.uri ??
        '',
      cover:
        (music?.coverThumb as { urlList?: string[] })?.urlList?.[0] ??
        (music?.cover_thumb as { url_list?: string[] })?.url_list?.[0] ??
        '',
    },
    tags: extractDyTags(detail, desc),
    stats: extractDyStats(detail),
  };

  const images = detail.images as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(images) && images.length) {
    result.type = 'image';
    let animatedCount = 0;
    for (const img of images) {
      const imgUrl = pickImageUrl(img);
      if (imgUrl) {
        result.images.push(imgUrl);
        if (isAnimatedImageUrl(imgUrl)) animatedCount++;
      }

      const liveVideoUrl = extractImageLiveVideo(img);
      if (liveVideoUrl) {
        result.live_photo.push({ image: imgUrl || liveVideoUrl, video: liveVideoUrl });
      }
    }

    const descHint = /动图|实况|live\s*photo/i.test(result.desc || result.title || '');
    if (result.live_photo.length) {
      // 有独立视频轨 → 实况图
      result.type = 'live';
    } else if (animatedCount > 0 || descHint) {
      // 无视频轨的动图 webp/gif：升为 animated，发送侧按实况同款合并转发流程发「动图」
      result.type = 'animated';
      result.live_photo = result.images.map((image) => ({ image, video: '' }));
    }

    if (!result.cover && result.images.length) result.cover = result.images[0];
    if (!result.cover && result.live_photo.length) result.cover = result.live_photo[0].image;
  } else {
    result.type = 'video';
    const videoInfo = extractHighestQualityVideo(detail);
    result.url = videoInfo.url;
    result.video_backup = videoInfo.backup.length ? videoInfo.backup : null;
    result.video_id = (video?.uri as string) ?? '';
  }

  return output(200, '解析成功', result);
}

/**
 * 解析抖音链接（视频 / 图集 / 实况）
 */
export async function parse(urlInput: string): Promise<DyApiResult> {
  let url = cleanUrlTail(stripTags(extractDouyinUrl(urlInput)));
  if (!url) return output(400, '请输入抖音链接');

  try {
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      return output(400, '链接格式错误');
    }

    if (host === 'v.douyin.com' || !url.includes('douyin.com') || !extractId(url)) {
      url = await getRealUrl(url);
    }

    const id = extractId(url);
    if (!id) {
      return output(400, `链接格式错误，无法提取ID。处理后的链接: ${url}`);
    }

    const deadline = createDeadline(35 * 1000);
    const api = await fetchDetailByApi(id, deadline);
    const detail = api.detail ?? (await fetchDetailById(url, id, deadline));

    if (!detail) {
      if (api.filterMsg) return output(404, `解析失败：${api.filterMsg}`);
      const routes = '签名接口 与 分享页 两条路线都失败';
      if (deadline.expired()) return output(504, `解析失败：抖音响应太慢，已到总时限（${routes}）`);
      return output(
        404,
        `解析失败：${routes}（接口签名被拒或分享页结构已变更，可稍后重试）`,
      );
    }

    return formatData(detail);
  } catch (e) {
    return output(500, e instanceof Error ? e.message : '解析失败');
  }
}

export default { parse };
