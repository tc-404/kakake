// ---------------------------------------------------------------------------
// X（Twitter）解析 —— 参考 FixTweet（FxTwitter）开源实现的取数与归一化结构：
//   路线 A（主，本地直连）：X 官方 syndication 嵌入接口 cdn.syndication.twimg.com/tweet-result
//     （FixTweet SyndicationServer 同款端点与 token 推导算法），免登录、无需任何第三方；
//     twimg 域名国内被墙，经 http-proxy.ts 走本机代理。
//   路线 B（补全/兜底）：FixTweet 公开 API（api.fxtwitter.com，Cloudflare 国内可直连），
//     提供浏览量/收藏(书签)/转推数等 syndication 缺失的统计；A 失败时整条走 B。
//     环境变量 X_FXTWITTER_FALLBACK=off 可关闭该路线。
// 覆盖内容：文案、图片、视频、动图(GIF)、引用推文、转推，作者/昵称/标题，
//           点赞、收藏、浏览、回复、转推数。X 无「实况照片」类型，GIF 按动图处理。
// ---------------------------------------------------------------------------

import { DEFAULT_USER_AGENT, fetchWithTimeout } from './http-utils';
import { proxyConfigured, proxyFetch, proxyFollowRedirect } from './http-proxy';

const UA = DEFAULT_USER_AGENT;

const SYNDICATION_API = 'https://cdn.syndication.twimg.com/tweet-result';
const FXTWITTER_API = 'https://api.fxtwitter.com/status';

/* ==================== 输出结构（对齐 FixTweet 的推文数据模型） ==================== */

export interface XAuthor {
  name: string;
  screen_name: string;
  id: string;
  avatar: string;
  description?: string;
  location?: string;
  website?: string;
  verified?: boolean;
  protected?: boolean;
  followers?: number;
}

export interface XStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  /** 收藏（书签）数 */
  favorites?: number;
}

/** 引用推文（轻量版：原文 + 媒体） */
export interface XQuoteInfo {
  id: string;
  url: string;
  text: string;
  author: XAuthor;
  images: string[];
  videoUrl: string | null;
  cover: string;
  duration: number | null;
}

export interface XMediaData {
  id: string;
  type: 'video' | 'image' | 'animated' | 'unknown';
  title: string;
  desc: string;
  author: XAuthor;
  cover: string;
  /** 视频直链（最高码率 mp4），纯图文为 null */
  url: string | null;
  /** 视频时长（秒） */
  duration: number | null;
  video_backup: string[];
  images: string[];
  /** 动图（GIF）列表：image=封面帧，video=可播放的 mp4 */
  live_photo: { image: string; video: string }[];
  quote: XQuoteInfo | null;
  /** 转推来源作者（@xx），非转推为空 */
  retweet_from: string;
  tags: string[];
  stats: XStats;
  created_at: string;
  sensitive: boolean;
}

export interface XApiResult {
  code: number;
  msg: string;
  data?: XMediaData;
}

function output(code: number, msg: string, data?: XMediaData): XApiResult {
  return { code, msg, ...(data ? { data } : {}) };
}

/* ==================== 链接 / ID 提取 ==================== */

const X_HOST_RE = /https?:\/\/(?:[\w-]+\.)*(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\/[^\s"'<>()\[\]]+/i;
const TCO_RE = /https?:\/\/t\.co\/[\w]+/i;
// 早期推文 ID 可以短到 2 位（例如 @jack 的第一条是 20），此前从 5 位起判，
// 这类链接会被判成「无法提取推文ID」；ID 位数本身不该成为门槛，宽松取即可。
const STATUS_ID_RE = /\/(?:status|statuses)\/(\d{1,25})/i;
const PLAIN_ID_RE = /^(\d{10,25})$/;

function extractStatusId(url: string): string | null {
  const m = url.match(STATUS_ID_RE);
  return m ? m[1] : null;
}

/** 从输入里拿推文 ID；t.co 短链没有 ID，返回 null 由调用方先解析 */
function extractTweetId(input: string): { url: string | null; id: string | null } {
  const plain = input.trim().match(PLAIN_ID_RE);
  if (plain) return { url: null, id: plain[1] };
  const urlMatch = input.match(X_HOST_RE);
  if (urlMatch) {
    const url = urlMatch[0].replace(/[.,!?;：，。！？]+$/, '');
    return { url, id: extractStatusId(url) };
  }
  const tco = input.match(TCO_RE);
  if (tco) return { url: tco[0], id: null };
  return { url: null, id: null };
}

/* ==================== 路线 A：X 官方 syndication 接口 ==================== */

interface SyndVariant {
  content_type?: string;
  bitrate?: number;
  url?: string;
}

interface SyndMedia {
  type?: string;
  media_url_https?: string;
  url?: string;
  expanded_url?: string;
  video_info?: { variants?: SyndVariant[]; duration_millis?: number; aspect_ratio?: number[] };
  original_info?: { width?: number; height?: number };
}

interface SyndUser {
  id?: string | number;
  name?: string;
  screen_name?: string;
  avatar_url?: string;
  profile_image_url_https?: string;
  description?: string;
  location?: string;
  website?: string;
  banner_url?: string;
  followers?: number;
  followers_count?: number;
  protected?: boolean;
  is_blue_verified?: boolean;
  verification?: { verified?: boolean } | null;
  verified?: boolean;
}

/**
 * FixTweet 的 syndication token 算法：由推文 ID 推导出前端校验用的三位 token。
 * 与 FixTweet SyndicationServer / react-tweet 保持一致，失败时退回固定 'a'。
 */
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '').slice(-3);
}

async function fetchBySyndication(id: string): Promise<Record<string, unknown> | null> {
  if (!proxyConfigured()) return null;
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  for (const token of [syndicationToken(id), 'a']) {
    const url = `${SYNDICATION_API}?id=${id}&lang=zh-cn&token=${encodeURIComponent(token)}`;
    try {
      const res = await proxyFetch(url, { headers, timeoutMs: 15000 });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown>;
      if (json && typeof json === 'object' && (json.text || json.mediaDetails || json.user)) return json;
    } catch {
      // 换下一个 token
    }
  }
  return null;
}

/* ==================== 路线 B：FixTweet 公开 API（兜底/统计补全） ==================== */

function fxFallbackEnabled(): boolean {
  const v = process.env.X_FXTWITTER_FALLBACK;
  return !v || !/^(off|false|0|no)$/i.test(v.trim());
}

async function fetchByFxtwitter(id: string): Promise<Record<string, unknown> | null> {
  if (!fxFallbackEnabled()) return null;
  try {
    const res = await fetchWithTimeout(`${FXTWITTER_API}/${id}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { code?: number; tweet?: Record<string, unknown> };
    return json && typeof json === 'object' ? (json.tweet ?? null) : null;
  } catch {
    return null;
  }
}

/* ==================== 文本 / 标签 清洗 ==================== */

interface TextUrlEntity {
  url?: string;
  expanded_url?: string;
}

/** syndication 的文本是 HTML 转义过的（&amp; 等），需要还原 */
function decodeHtmlEntities(s: string): string {
  return String(s || '').replace(
    /&(amp|lt|gt|quot|apos|nbsp);|&#(\d+);/g,
    (m, name: string, num: string) => {
      if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[name] ?? m;
      const code = Number(num);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    },
  );
}

/** 把文案里的 t.co 短链还原成真实链接；媒体自带的 t.co 直接去掉（FixTweet 同款处理） */
function cleanText(text: string, urlEntities: TextUrlEntity[], dropUrls: Set<string>): string {
  let out = text;
  const map = new Map<string, string>();
  for (const e of urlEntities || []) {
    if (!e.url) continue;
    const expanded = e.expanded_url && !dropUrls.has(e.url) ? e.expanded_url : '';
    map.set(e.url, expanded);
  }
  for (const [short, real] of map) {
    out = out.replaceAll(short, real);
  }
  for (const short of dropUrls) {
    out = out.replaceAll(short, '');
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function collectTags(text: string, hashtags: unknown): string[] {
  const tags: string[] = [];
  const push = (t: unknown) => {
    const s = String(t || '').trim();
    if (s && !tags.includes(s)) tags.push(s);
  };
  if (Array.isArray(hashtags)) {
    for (const h of hashtags) push((h as { text?: string })?.text);
  }
  for (const m of text.matchAll(/(?:^|[\s(（>])#([^\s#.,!?：:，。！？（）()]{1,40})/g)) push(m[1]);
  return tags.slice(0, 20);
}

function firstLineTitle(text: string): string {
  const line = String(text || '').split('\n').map((s) => s.trim()).find(Boolean) || '';
  return line.slice(0, 80);
}

/** pbs.twimg.com 图片提清：name=small/medium/900x900 → name=large */
function upgradeImageUrl(url: string): string {
  const u = String(url || '');
  if (!u) return '';
  if (/name=\w+/.test(u)) return u.replace(/name=\w+/, 'name=large');
  if (/pbs\.twimg\.com\/media\//.test(u) && !u.includes('format=')) return `${u}?format=jpg&name=large`;
  return u;
}

function mapSyndicationUser(u: SyndUser | undefined): XAuthor {
  return {
    name: String(u?.name || ''),
    screen_name: String(u?.screen_name || ''),
    id: String(u?.id ?? ''),
    avatar: String(u?.avatar_url || u?.profile_image_url_https || '').replace(/_normal/, '_400x400'),
    description: u?.description || undefined,
    location: u?.location || undefined,
    website: u?.website || undefined,
    verified: Boolean(u?.is_blue_verified ?? u?.verification?.verified ?? u?.verified),
    protected: Boolean(u?.protected),
    followers: Number(u?.followers ?? u?.followers_count) || undefined,
  };
}

/** 视频变体排序：码率优先，无码率按分辨率面积（路径形如 /vid/avc1/1350x1080/） */
function rankVariant(v: SyndVariant): number {
  if (Number(v.bitrate) > 0) return Number(v.bitrate);
  const m = String(v.url || '').match(/\/(\d{2,5})x(\d{2,5})\//);
  if (m) return Number(m[1]) * Number(m[2]);
  return 0;
}

function pickMp4(variants: SyndVariant[] | undefined): { best: string; backup: string[] } {
  const mp4s = (variants || []).filter((v) => v.url && /video\/mp4/i.test(String(v.content_type)));
  const sorted = [...mp4s].sort((a, b) => rankVariant(b) - rankVariant(a));
  const urls = sorted.map((v) => String(v.url)).filter(Boolean);
  return { best: urls[0] || '', backup: urls.slice(1) };
}

/** syndication 推文节点 → XMediaData（quote 递归一层） */
export function mapSyndicationTweet(t: Record<string, unknown>, id: string): XMediaData {
  const media = (t.mediaDetails as SyndMedia[] | undefined) || [];
  const photos = (t.photos as Array<{ url?: string; width?: number; height?: number }> | undefined) || [];
  const videoObj = (t.video ?? t.videoInfo) as
    | { variants?: Array<{ type?: string; src?: string }>; poster?: string; durationMs?: number; viewCount?: number }
    | undefined;
  const entities = (t.entities as { urls?: TextUrlEntity[]; hashtags?: unknown[] } | undefined) || {};

  const dropUrls = new Set<string>();
  const photoImages: string[] = [];
  const livePhoto: { image: string; video: string }[] = [];
  let videoUrl: string | null = null;
  let videoBackup: string[] = [];
  let cover = '';
  let duration: number | null = null;
  let hasVideo = false;
  let hasGif = false;

  for (const m of media) {
    const kind = String(m.type || '');
    const thumb = upgradeImageUrl(String(m.media_url_https || ''));
    if (!cover && thumb) cover = thumb;

    if (kind === 'photo') {
      if (thumb && !photoImages.includes(thumb)) photoImages.push(thumb);
      continue;
    }

    const variants = m.video_info?.variants;
    const { best, backup } = pickMp4(variants);
    if (!best) continue;

    if (kind === 'animated_gif') {
      hasGif = true;
      livePhoto.push({ image: thumb || best, video: best });
    } else if (kind === 'video' && !videoUrl) {
      hasVideo = true;
      videoUrl = best;
      videoBackup = backup;
      // syndication 给毫秒，统一输出秒（工具页按秒格式化）
      duration = Number(m.video_info?.duration_millis) > 0
        ? Math.round(Number(m.video_info?.duration_millis) / 1000)
        : duration;
      if (!cover && thumb) cover = thumb;
    }
  }

  // video 对象兜底（variants 只有 type/src，无码率，按分辨率面积排序）
  if (!videoUrl && videoObj && Array.isArray(videoObj.variants)) {
    const mp4s = videoObj.variants
      .filter((v) => v.src && /video\/mp4/i.test(String(v.type)))
      .map((v) => String(v.src))
      .filter(Boolean);
    if (mp4s.length) {
      const areaOf = (u: string) => {
        const m = u.match(/\/(\d{2,5})x(\d{2,5})\//);
        return m ? Number(m[1]) * Number(m[2]) : 0;
      };
      mp4s.sort((a, b) => areaOf(b) - areaOf(a));
      videoUrl = mp4s[0];
      videoBackup = mp4s.slice(1);
      hasVideo = true;
      duration = Number(videoObj.durationMs) > 0
        ? Math.round(Number(videoObj.durationMs) / 1000)
        : duration;
    }
  }
  if (!cover && videoObj?.poster) cover = String(videoObj.poster);

  // photos[] 顶层兜底（纯图推 mediaDetails 缺失时）
  if (!photoImages.length) {
    for (const p of photos) {
      const u = upgradeImageUrl(String(p.url || ''));
      if (u && !photoImages.includes(u)) photoImages.push(u);
      if (!cover && u) cover = u;
    }
  }

  // 媒体 t.co 短链从文案里剔除
  for (const m of media) {
    if (m.url) dropUrls.add(String(m.url));
  }
  const desc = decodeHtmlEntities(cleanText(String(t.text || ''), entities.urls || [], dropUrls));

  const type: XMediaData['type'] = hasVideo ? 'video' : hasGif ? 'animated' : photoImages.length ? 'image' : 'unknown';

  const rawQuote = t.quoted_tweet as Record<string, unknown> | undefined;
  let quote: XQuoteInfo | null = null;
  if (rawQuote && rawQuote.id_str) {
    const q = mapSyndicationTweet(rawQuote, String(rawQuote.id_str));
    quote = {
      id: String(rawQuote.id_str),
      url: `https://x.com/${q.author.screen_name}/status/${String(rawQuote.id_str)}`,
      text: q.desc || q.title,
      author: q.author,
      images: q.images,
      videoUrl: q.url || q.live_photo[0]?.video || null,
      cover: q.cover || q.images[0] || '',
      duration: q.duration,
    };
  }

  return {
    id: String(t.id_str || id),
    type,
    title: firstLineTitle(desc) || `X 推文 ${String(t.id_str || id)}`,
    desc,
    author: mapSyndicationUser(t.user as SyndUser | undefined),
    cover,
    url: videoUrl,
    duration,
    video_backup: videoBackup,
    images: photoImages,
    live_photo: livePhoto,
    quote,
    retweet_from: '',
    tags: collectTags(desc, entities.hashtags),
    stats: {
      likes: Number(t.favorite_count) || undefined,
      comments: Number(t.conversation_count) || undefined,
      views: Number(videoObj?.viewCount) > 0 ? Number(videoObj?.viewCount) : undefined,
    },
    created_at: String(t.created_at || ''),
    sensitive: Boolean(t.possibly_sensitive),
  };
}

/* ==================== 路线 B：FixTweet API → 同一数据模型 ==================== */

function mapFxAuthor(a: Record<string, unknown> | undefined): XAuthor {
  const verification = a?.verification as { verified?: boolean } | undefined;
  return {
    name: String(a?.name || ''),
    screen_name: String(a?.screen_name || ''),
    id: String(a?.id || ''),
    avatar: String(a?.avatar_url || '').replace(/_normal/, '_400x400'),
    description: (a?.description as string) || undefined,
    location: (a?.location as string) || undefined,
    website: (a?.website as { url?: string } | undefined)?.url || undefined,
    verified: Boolean(verification?.verified),
    protected: Boolean(a?.protected),
    followers: Number(a?.followers) || undefined,
  };
}

/** FixTweet API 推文节点 → XMediaData */
export function mapFxTweet(tweet: Record<string, unknown>): XMediaData {
  const author = mapFxAuthor(tweet.author as Record<string, unknown> | undefined);
  const media = (tweet.media as { all?: Array<Record<string, unknown>>; photos?: Array<Record<string, unknown>>; videos?: Array<Record<string, unknown>> } | undefined);
  const all = media?.all || [];

  const images: string[] = [];
  const livePhoto: { image: string; video: string }[] = [];
  let videoUrl: string | null = null;
  let videoBackup: string[] = [];
  let cover = '';
  let duration: number | null = null;
  let hasVideo = false;
  let hasGif = false;

  for (const m of all) {
    const kind = String(m.type || '');
    if (kind === 'photo') {
      const u = upgradeImageUrl(String(m.url || ''));
      if (u && !images.includes(u)) images.push(u);
      if (!cover && u) cover = u;
      continue;
    }
    const thumb = upgradeImageUrl(String(m.thumbnail_url || ''));
    if (!cover && thumb) cover = thumb;
    const mp4 = String(m.url || '');
    if (!mp4) continue;
    if (kind === 'gif') {
      hasGif = true;
      livePhoto.push({ image: thumb || mp4, video: mp4 });
    } else {
      if (!hasVideo) {
        hasVideo = true;
        videoUrl = mp4;
      } else if (!videoBackup.includes(mp4) && mp4 !== videoUrl) {
        videoBackup.push(mp4);
      }
      // FixTweet API 的 duration 为毫秒，统一输出秒
      duration = Number(m.duration) > 0 ? Math.round(Number(m.duration) / 1000) : duration;
    }
  }

  const text = decodeHtmlEntities(String(tweet.text || ''));
  const rawQuote = tweet.quote as Record<string, unknown> | undefined;
  let quote: XQuoteInfo | null = null;
  if (rawQuote && rawQuote.id) {
    const q = mapFxTweet(rawQuote);
    quote = {
      id: String(rawQuote.id),
      url: String(rawQuote.url || `https://x.com/${q.author.screen_name}/status/${String(rawQuote.id)}`),
      text: q.desc || q.title,
      author: q.author,
      images: q.images,
      videoUrl: q.url || q.live_photo[0]?.video || null,
      cover: q.cover || q.images[0] || '',
      duration: q.duration,
    };
  }

  const statsRaw = (tweet.stats as Record<string, unknown> | undefined) || {};
  // FixTweet API 的统计在 tweet 顶层（views/likes/replies/retweets/bookmarks），stats 子对象可能不存在
  const count = (...vals: unknown[]): number | undefined => {
    for (const v of vals) {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  };

  const type: XMediaData['type'] = hasVideo ? 'video' : hasGif ? 'animated' : images.length ? 'image' : 'unknown';

  return {
    id: String(tweet.id || ''),
    type,
    title: firstLineTitle(text) || `X 推文 ${String(tweet.id || '')}`,
    desc: text,
    author,
    cover,
    url: videoUrl,
    duration,
    video_backup: videoBackup,
    images,
    live_photo: livePhoto,
    quote,
    retweet_from: '',
    tags: Array.isArray(tweet.hashtags) ? (tweet.hashtags as Array<{ text?: string }>).map((h) => String(h?.text || '')).filter(Boolean) : collectTags(text, []),
    stats: {
      views: count(tweet.views, statsRaw.views),
      likes: count(tweet.likes, statsRaw.likes),
      comments: count(tweet.replies, statsRaw.replies),
      shares: count(tweet.retweets, statsRaw.retweets),
      favorites: count(tweet.bookmarks, statsRaw.bookmarks),
    },
    created_at: String(tweet.created_at || tweet.created_timestamp || ''),
    sensitive: Boolean(tweet.sensitive),
  };
}

/* ==================== 合并与兜底处理 ==================== */

/**
 * 用 FixTweet API 补全 syndication 缺失的部分：
 * 浏览/收藏/转推等统计、粉丝数、引用推文（syndication 部分推文不带 quoted_tweet）。
 */
async function mergeFxExtras(data: XMediaData, id: string): Promise<void> {
  const fx = await fetchByFxtwitter(id);
  if (!fx) return;
  const mapped = mapFxTweet(fx);
  for (const key of ['views', 'likes', 'comments', 'shares', 'favorites'] as const) {
    if (data.stats[key] == null && mapped.stats[key] != null) data.stats[key] = mapped.stats[key];
  }
  if (data.author.followers == null) data.author.followers = mapped.author.followers;
  if (!data.quote && mapped.quote) data.quote = mapped.quote;
  if (!data.retweet_from && mapped.retweet_from) data.retweet_from = mapped.retweet_from;
}

/** FixTweet API 结果 → 数据（处理转推/转发标记） */
function applyFxTweet(fx: Record<string, unknown>): XMediaData {
  const data = mapFxTweet(fx);
  // 转推：内容取被转推的原推，标注转推者
  const inner = fx.retweet as Record<string, unknown> | undefined;
  if (inner) {
    const innerData = mapFxTweet(inner);
    innerData.retweet_from = data.author.screen_name ? `@${data.author.screen_name}` : '';
    return innerData;
  }
  // 转发标记（reposted_by）：内容本身就是原推，标注转发者
  const repostedBy = fx.reposted_by as { screen_name?: string } | undefined;
  if (repostedBy?.screen_name) data.retweet_from = `@${repostedBy.screen_name}`;
  return data;
}

/** 纯文案推引用了媒体时：把引用推的媒体提升为主媒体（用户贴这种链接多半要引用里的内容） */
function promoteQuoteIfBare(data: XMediaData): void {
  if (data.type !== 'unknown' || !data.quote) return;
  const q = data.quote;
  if (q.videoUrl) {
    data.url = q.videoUrl;
    data.type = 'video';
    if (data.duration == null) data.duration = q.duration;
  } else if (q.images.length) {
    data.images = q.images;
    data.type = 'image';
  } else {
    return;
  }
  if (!data.cover) data.cover = q.cover || q.images[0] || '';
}

/** 在文案末尾标注引用来源，保证引用内容不丢失 */
function annotateQuote(data: XMediaData): void {
  if (!data.quote) return;
  const q = data.quote;
  const label = q.author.screen_name ? `@${q.author.screen_name}` : q.author.name || '未知用户';
  const qText = String(q.text || '').slice(0, 120);
  data.desc = `${data.desc ? `${data.desc}\n` : ''}↘ 引用 ${label}：${qText}`.trim();
  if (!data.title) data.title = firstLineTitle(data.desc) || `X 推文 ${data.id}`;
}

/* ==================== 主流程 ==================== */

/**
 * 解析 X/Twitter 链接（支持 x.com / twitter.com / fxtwitter / fixupx / vxtwitter / t.co / 纯ID）
 */
export async function parse(urlInput: string): Promise<XApiResult> {
  const raw = String(urlInput || '').trim();
  if (!raw) return output(400, '请输入 X/Twitter 链接');

  let { url, id } = extractTweetId(raw);

  // t.co 短链：跟随重定向拿真实推文链接
  if (!id && url && TCO_RE.test(url)) {
    try {
      if (proxyConfigured()) {
        url = await proxyFollowRedirect(url);
      } else {
        const res = await fetchWithTimeout(url, { redirect: 'follow', headers: { 'User-Agent': UA } });
        url = res.url || url;
      }
      id = url ? extractStatusId(url) : null;
    } catch {
      return output(400, 't.co 短链解析失败（需要本机代理可用，当前代理：' + (proxyConfigured() ? '已配置' : '未配置') + '）');
    }
  }

  if (!id) return output(400, `无法从输入提取推文ID：${raw.slice(0, 80)}`);

  try {
    let data: XMediaData | null = null;

    // 路线 A：本地直连 X 官方 syndication 接口（媒体/文案/作者主来源）
    const synd = await fetchBySyndication(id).catch(() => null);
    if (synd) {
      data = mapSyndicationTweet(synd, id);
      // syndication 缺浏览/收藏/转推统计，FixTweet API 补全（直连，失败不影响主结果）
      await mergeFxExtras(data, id).catch(() => {});
    } else {
      // 路线 B：FixTweet API 兜底（含转推结构）
      const fx = await fetchByFxtwitter(id);
      if (fx) data = applyFxTweet(fx);
    }

    if (!data) {
      return output(404, '解析失败：官方嵌入接口与 FixTweet API 均未取到数据（推文可能已删除或受保护）');
    }

    promoteQuoteIfBare(data);
    annotateQuote(data);
    return output(200, '解析成功', data);
  } catch (e) {
    return output(500, e instanceof Error ? e.message : '解析失败');
  }
}

export default { parse };
