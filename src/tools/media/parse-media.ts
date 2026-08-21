/**
 * 统一媒体解析：检测平台 → 调用对应 parse → 归一化结果。
 * 无缓存、不落盘；每次请求独立执行。
 */
import { parse as parseBlbl } from './blbl.js';
import { parse as parseDy } from './dy.js';
import { parse as parseXhs } from './xhs.js';
import { parse as parseKs } from './ks.js';

export type MediaPlatform = 'blbl' | 'dy' | 'xhs' | 'ks';
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
  description: string;
  tags: string[];
  stats: MediaStats;
  cover: string;
  videoUrl: string | null;
  images: string[];
  liveItems: { image: string; video: string }[];
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

export function detectPlatform(text: string): MediaPlatform | null {
  const s = String(text || '');
  if (
    /https?:\/\/b23\.tv\/[a-zA-Z0-9]+/i.test(s)
    || /https?:\/\/(?:www\.)?bilibili\.com\/video\/BV[a-zA-Z0-9]{10}/i.test(s)
    || /\bBV[a-zA-Z0-9]{10}\b/i.test(s)
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
  return null;
}

function asStr(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => asStr(x)).filter(Boolean);
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

export async function parseMedia(text: string): Promise<NormalizedMediaResult> {
  const input = String(text || '').trim();
  if (!input) {
    return emptyResult({ ok: false, message: '请输入链接或含链接的文本' });
  }

  const platform = detectPlatform(input);
  if (!platform) {
    return emptyResult({
      ok: false,
      message: '未能识别平台（支持 B站 / 抖音 / 小红书 / 快手）',
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
        liveItems: Array.isArray(d.live_photo)
          ? d.live_photo.map((x) => ({ image: asStr(x.image), video: asStr(x.video) })).filter((x) => x.image || x.video)
          : [],
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
        liveItems: Array.isArray(d.实况图)
          ? d.实况图.map((x) => ({ image: asStr(x.图片), video: asStr(x.视频) })).filter((x) => x.image || x.video)
          : [],
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
