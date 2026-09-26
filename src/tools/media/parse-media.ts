/**
 * 统一媒体解析：检测平台 → 调用对应 parse → 归一化结果。
 * 无缓存、不落盘；每次请求独立执行。
 */
import { parse as parseBlbl } from './blbl.js';
import { createCookieRef } from './media-proxy-download.js';
import { parse as parseDy } from './dy.js';
import { parse as parseXhs } from './xhs.js';
import { parse as parseKs } from './ks.js';
import { parse as parseTg } from './tg.js';
import { parse as parseTt } from './tt.js';
import { parse as parseYt } from './yt.js';
import { parse as parseX } from './x.js';

export type MediaPlatform = 'blbl' | 'dy' | 'xhs' | 'ks' | 'tt' | 'yt' | 'x' | 'tg';
export type MediaType = 'video' | 'image' | 'live' | 'animated' | 'unknown';

export type MediaStats = {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  coins?: number;
  danmaku?: number;
};

export type NormalizedMediaResult = {
  ok: boolean;
  platform: MediaPlatform | null;
  type: MediaType;
  title: string;
  author?: string;
  duration?: number | null;
  /** 发布时间（已格式化文案，如 2024-05-01 12:00:00） */
  publishTime?: string;
  /** 视频体积（人类可读，如 12.34MB） */
  sizeText?: string;
  description: string;
  tags: string[];
  stats: MediaStats;
  cover: string;
  videoUrl: string | null;
  images: string[];
  liveItems: { image: string; video: string }[];
  /** TikTok CDN 常校验 tt_chain_token 等 Cookie，下载时需带上 */
  cookie?: string;
  message?: string;
};

function emptyResult(
  partial: Partial<NormalizedMediaResult> & { ok: boolean; message?: string },
): NormalizedMediaResult {
  return {
    platform: null,
    type: 'unknown',
    title: '',
    description: '',
    tags: [],
    stats: {},
    cover: '',
    videoUrl: null,
    images: [],
    liveItems: [],
    ...partial,
  };
}

/** 失败结果：供调用方（如限速拒绝）构造结构完整的响应，避免手写半个对象 */
export function failedResult(
  message: string,
  platform: MediaPlatform | null = null,
): NormalizedMediaResult {
  return emptyResult({ ok: false, platform, message });
}

export function detectPlatform(text: string): MediaPlatform | null {
  const s = String(text || '');
  if (
    /https?:\/\/b23\.tv\/[a-zA-Z0-9]+/i.test(s)
    || /https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[a-zA-Z0-9]{10}/i.test(s)
    || /\bBV[a-zA-Z0-9]{10}\b/i.test(s)
    // av 号与番剧（bangumi）此前完全不识别，只粘一个 av 号会报「未能识别平台」
    || /^\s*av\d{1,12}\s*$/i.test(s)
    || /^\s*(?:ep|ss)\d{1,10}\s*$/i.test(s)
    || /https?:\/\/[^\s]*bilibili\.com\/(?:video|bangumi)\/[^\s]*/i.test(s)
  ) {
    return 'blbl';
  }
  if (
    /https?:\/\/v\.douyin\.com\/[\w-]+/i.test(s)
    || /https?:\/\/(?:www\.)?douyin\.com\//i.test(s)
  ) {
    return 'dy';
  }
  if (
    /https?:\/\/xhslink\.com\/[^\s\]]+/i.test(s)
    || /https?:\/\/(?:www\.)?xiaohongshu\.com\/[^\s\]]+/i.test(s)
  ) {
    return 'xhs';
  }
  if (
    /https?:\/\/v\.kuaishou\.com\/[\w-]+/i.test(s)
    || /https?:\/\/(?:www\.)?kuaishou\.com\//i.test(s)
  ) {
    return 'ks';
  }
  if (
    /https?:\/\/(?:www\.|m\.)?tiktok\.com\//i.test(s)
    || /https?:\/\/(?:vm|vt|t)\.tiktok\.com\/[\w-]+/i.test(s)
  ) {
    return 'tt';
  }
  if (
    /https?:\/\/youtu\.be\/[\w-]+/i.test(s)
    || /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\//i.test(s)
  ) {
    return 'yt';
  }
  // Telegram 公开帖：t.me/<频道>/<帖号>（telegram.me / telegram.dog 是旧别名）。
  // 通常粘贴时没有协议头，所以这里不要求 https://；t.me/s/<频道>/<帖号> 也算。
  // 放在 X 之前：t.me 与 t.co 不是一回事，但两者都是「t.」开头的短域名，
  // 先判 Telegram 可以避免以后新增规则时互相误吃。
  if (
    /(?:https?:\/\/)?(?:www\.|m\.)?(?:t\.me|telegram\.me|telegram\.dog)\//i.test(s)
  ) {
    return 'tg';
  }
  // X（Twitter）放在最后：t.co 短链也归它，避免误吃其他平台的链接
  if (
    /https?:\/\/(?:[\w-]+\.)*(?:x\.com|twitter\.com|fxtwitter\.com|fixupx\.com|vxtwitter\.com)\//i.test(s)
    || /https?:\/\/t\.co\/[\w]+/i.test(s)
  ) {
    return 'x';
  }
  return null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asStr(x)).filter(Boolean);
}

/**
 * 实况图 / 动图列表的安全映射。
 * 上游把字段换成字符串数组或塞进 null 时，直接取 x.image 会抛 TypeError，
 * 最终被外层 catch 成一句「解析失败：Cannot read properties of ...」，
 * 对排查毫无帮助。这里逐项判类型，坏数据直接跳过。
 */
function asLiveItems(
  v: unknown,
  imageKey: string,
  videoKey: string,
): { image: string; video: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { image: string; video: string }[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const image = asStr(o[imageKey]);
    const video = asStr(o[videoKey]);
    if (image || video) out.push({ image, video });
  }
  return out;
}

/** 作者字段：有的平台给字符串，有的给对象，两种都要能读 */
function asAuthor(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (v && typeof v === 'object') return asStr((v as Record<string, unknown>).name);
  return '';
}

function asNum(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** 简介与标题相同时不重复展示简介 */
function distinctDesc(title: string, desc: string): string {
  const t = title.trim();
  const d = desc.trim();
  if (!d || d === t || d === '无描述') return '';
  return d;
}

/** Unix 时间戳 → 本地时间文案；秒/毫秒自动判别（快手等平台两种都出现过） */
function formatUnixTime(value: unknown): string | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return undefined;
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 把 http:// 的媒体地址统一升成 https://。
 *
 * 面板可能通过 HTTPS 访问（反代 / 绑定域名），这时浏览器会直接拦掉明文图片
 * 和视频（混合内容），表现为封面或图集整块空白。上游接口本来就常返回 http
 * 地址（B站 的 pic 字段就是 http://i1.hdslb.com/...），所以在这里集中升一次，
 * 比在各平台解析器里各写一遍可靠。只动协议，其余部分（含签名参数）保持原样。
 */
function toHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice('http://'.length)}` : url;
}

function upgradeMediaSchemes(r: NormalizedMediaResult): NormalizedMediaResult {
  if (!r.ok) return r;
  return {
    ...r,
    cover: toHttps(r.cover),
    videoUrl: r.videoUrl ? toHttps(r.videoUrl) : r.videoUrl,
    images: r.images.map(toHttps),
    liveItems: r.liveItems.map((it) => ({
      image: toHttps(it.image),
      video: toHttps(it.video),
    })),
  };
}

/** 统一入口：归一化结果之上再补一道协议规范化 */
export async function parseMedia(text: string): Promise<NormalizedMediaResult> {
  return upgradeMediaSchemes(await parseMediaInner(text));
}

async function parseMediaInner(text: string): Promise<NormalizedMediaResult> {
  const input = String(text || '').trim();
  if (!input) {
    return emptyResult({ ok: false, message: '请输入链接或含链接的文本' });
  }

  const platform = detectPlatform(input);
  if (!platform) {
    return emptyResult({
      ok: false,
      message: '未能识别平台（支持 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram）',
    });
  }

  try {
    if (platform === 'blbl') {
      const r = await parseBlbl(input);
      if (r.状态码 !== 200 || !r.数据) {
        return emptyResult({
          ok: false,
          platform,
          message: r.消息 || '解析失败',
        });
      }
      const d = r.数据;
      const title = asStr(d.视频标题);
      return {
        ok: true,
        platform,
        type: 'video',
        title,
        author: asStr(d.UP主信息?.UP主名称),
        duration: asNum(d.视频时长秒) ?? null,
        publishTime: asStr(d.发布时间) || undefined,
        sizeText: asStr(d.视频大小) || undefined,
        description: distinctDesc(title, asStr(d.视频描述)),
        tags: asStrArr(d.标签),
        stats: {
          views: asNum(d.播放次数),
          likes: asNum(d.点赞数量),
          comments: asNum(d.评论数量),
          shares: asNum(d.分享数量),
          favorites: asNum(d.收藏数量),
          coins: asNum(d.投币数量),
          danmaku: asNum(d.弹幕数量),
        },
        cover: asStr(d.视频封面),
        videoUrl: asStr(d.视频链接) || null,
        images: [],
        liveItems: [],
      };
    }

    if (platform === 'dy') {
      const r = await parseDy(input);
      if (r.code !== 200 || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: r.msg || '解析失败',
        });
      }
      const d = r.data;
      const title = asStr(d.title);
      const desc = asStr(d.desc);
      return {
        ok: true,
        platform,
        type: (d.type as MediaType) || 'unknown',
        title,
        author: asAuthor(d.author) || undefined,
        duration: asNum(d.duration) ?? null,
        publishTime: formatUnixTime(d.create_time),
        description: distinctDesc(title, desc),
        tags: asStrArr(d.tags),
        stats: {
          views: asNum(d.stats?.views),
          likes: asNum(d.stats?.likes),
          comments: asNum(d.stats?.comments),
          shares: asNum(d.stats?.shares),
          favorites: asNum(d.stats?.favorites),
        },
        cover: asStr(d.cover),
        videoUrl: d.url ? asStr(d.url) : null,
        images: asStrArr(d.images),
        liveItems: asLiveItems(d.live_photo, 'image', 'video'),
      };
    }

    if (platform === 'xhs') {
      const r = await parseXhs(input);
      if (!r.success || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: ('error' in r ? asStr(r.error) : '') || '解析失败',
        });
      }
      const d = r.data;
      const typeRaw = asStr(d.类型);
      const type: MediaType =
        typeRaw === 'video' || typeRaw === 'image' || typeRaw === 'live'
          ? typeRaw
          : 'unknown';
      const title = asStr(d.标题);
      return {
        ok: true,
        platform,
        type,
        title,
        author: asStr(d.作者?.名称) || undefined,
        description: distinctDesc(title, asStr(d.描述)),
        tags: asStrArr(d.标签),
        stats: {
          views: asNum(d.浏览),
          likes: asNum(d.点赞),
          comments: asNum(d.评论),
          shares: asNum(d.分享),
          favorites: asNum(d.收藏),
        },
        cover: asStr(d.封面),
        videoUrl: d.视频链接 ? asStr(d.视频链接) : null,
        images: asStrArr(d.图片),
        liveItems: asLiveItems(d.实况图, '图片', '视频'),
      };
    }

    if (platform === 'tt') {
      const r = await parseTt(input);
      if (r.code !== 200 || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: r.msg || '解析失败',
        });
      }
      const d = r.data;
      return {
        ok: true,
        platform,
        type: d.type === 'image' ? 'image' : 'video',
        title: asStr(d.title),
        author: asStr(d.author),
        duration: d.duration ?? null,
        description: '',
        tags: [],
        stats: {},
        cover: asStr(d.cover),
        videoUrl: d.type === 'video' ? asStr(d.url) || null : null,
        images: d.type === 'image' ? asStrArr(d.images) : [],
        liveItems: [],
        // 服务端拿到的是 TikTok CDN 的 Cookie，浏览器不需要原文：
        // 换成一次性引用，下载时由服务端自己换回来（见 createCookieRef）
        ...(d.cookie ? { cookie: createCookieRef(String(d.cookie)) } : {}),
      };
    }

    if (platform === 'yt') {
      const r = await parseYt(input);
      if (r.code !== 200 || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: r.msg || '解析失败',
        });
      }
      const d = r.data;
      return {
        ok: true,
        platform,
        type: 'video',
        title: asStr(d.title),
        author: asStr(d.author),
        duration: d.duration ?? null,
        description: '',
        tags: [],
        stats: {},
        cover: asStr(d.cover),
        videoUrl: asStr(d.url) || null,
        images: [],
        liveItems: [],
        // 只有分离流时的提醒（无音轨）由前端展示
        ...(d.message ? { message: asStr(d.message) } : {}),
      };
    }

    if (platform === 'tg') {
      const r = await parseTg(input);
      if (r.code !== 200 || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: r.msg || '解析失败',
        });
      }
      const d = r.data;
      const title = asStr(d.title);
      return {
        ok: true,
        platform,
        type: d.type === 'image' ? 'image' : 'video',
        title,
        author: asStr(d.author) || undefined,
        duration: d.duration ?? null,
        publishTime: asStr(d.publishTime) || undefined,
        sizeText: asStr(d.sizeText) || undefined,
        description: distinctDesc(title, asStr(d.description)),
        tags: [],
        stats: {},
        cover: asStr(d.cover),
        videoUrl: d.type === 'video' ? asStr(d.url) || null : null,
        images: asStrArr(d.images),
        liveItems: [],
        // 视频直链失效、一帖多视频等前提由前端展示
        ...(d.message ? { message: asStr(d.message) } : {}),
      };
    }

    if (platform === 'x') {
      const r = await parseX(input);
      if (r.code !== 200 || !r.data) {
        return emptyResult({
          ok: false,
          platform,
          message: r.msg || '解析失败',
        });
      }
      const d = r.data;
      const title = asStr(d.title);
      const desc = d.retweet_from ? `🔁 转推自 ${d.retweet_from}：${asStr(d.desc)}` : asStr(d.desc);
      return {
        ok: true,
        platform,
        type: d.type,
        title,
        author: asAuthor(d.author) || asStr(d.author?.screen_name),
        duration: d.duration ?? null,
        description: distinctDesc(title, desc),
        tags: asStrArr(d.tags),
        stats: {
          views: asNum(d.stats?.views),
          likes: asNum(d.stats?.likes),
          comments: asNum(d.stats?.comments),
          shares: asNum(d.stats?.shares),
          favorites: asNum(d.stats?.favorites),
        },
        cover: asStr(d.cover),
        videoUrl: d.url ? asStr(d.url) : null,
        images: asStrArr(d.images),
        liveItems: asLiveItems(d.live_photo, 'image', 'video'),
      };
    }

    // ks
    const r = await parseKs(input);
    if (r.code !== 200 || !r.data) {
      return emptyResult({
        ok: false,
        platform,
        message: r.msg || '解析失败',
      });
    }
    const d = r.data;
    const title = asStr(d.title);
    return {
      ok: true,
      platform,
      type: d.type === 'image' ? 'image' : 'video',
      title,
      author: asAuthor(d.author) || undefined,
      publishTime: formatUnixTime(d.time),
      description: '',
      tags: asStrArr(d.tags),
      stats: {
        views: asNum(d.view),
        likes: asNum(d.like),
        comments: asNum(d.comment),
        shares: asNum(d.share),
      },
      cover: asStr(d.cover),
      videoUrl: d.type === 'video' ? asStr(d.url) || null : null,
      images: d.type === 'image' ? (asStrArr(d.images).length ? asStrArr(d.images) : [asStr(d.url)].filter(Boolean)) : asStrArr(d.images),
      liveItems: [],
    };
  } catch (e) {
    return emptyResult({
      ok: false,
      platform,
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
