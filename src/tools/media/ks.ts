// ---------------------------------------------------------------------------
// 快手解析（移植 short_videos KuaishouSpider.php）
// ---------------------------------------------------------------------------

import { cleanUrlTail, extractBalancedJsonFrom, fetchText, followRedirect, isAllowedDomain } from './http-utils';

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1 Edg/122.0.0.0';

/**
 * 短链跳转目标白名单。
 * v.kuaishou.com 会跳到 www.kuaishou.com 或 v.m.chenzhongtech.com（快手移动页），
 * 跳出去的一律不跟，避免短链服务将来出现开放跳转时把请求带去内网。
 */
const ALLOWED_DOMAINS = [
  'kuaishou.com',
  'kuaishouapp.com',
  'gifshow.com',
  'chenzhongtech.com',
  'kwimgs.com',
  'yximgs.com',
  'ksapisrv.com',
];

export interface KsMusic {
  name: string;
  artist: string;
  cover: string;
  url: string;
}

export interface KsMediaData {
  type: 'video' | 'image';
  title: string;
  author: string;
  avatar: string;
  cover: string;
  url: string;
  like: number;
  view?: number;
  comment?: number;
  share?: number;
  time: number;
  count?: number;
  images?: string[];
  tags?: string[];
  music?: KsMusic | string;
  api?: number;
}

export interface KsApiResult {
  code: number;
  msg: string;
  data?: KsMediaData;
}

function extractKuaishouUrl(text: string): string {
  const shortMatch = text.match(/https?:\/\/v\.kuaishou\.com\/[\w-]+/i);
  if (shortMatch) return shortMatch[0].trim();
  const anyMatch = text.match(/https?:\/\/[^\s]*kuaishou\.com[^\s]*/i);
  if (anyMatch) return anyMatch[0].trim().replace(/[^\w\-./?=&:#]+$/i, '');
  return text.trim();
}

async function getRedirectedUrl(url: string): Promise<string | null> {
  try {
    return await followRedirect(url, USER_AGENT, (u) => isAllowedDomain(u, ALLOWED_DOMAINS));
  } catch {
    return null;
  }
}

async function curlRequest(url: string): Promise<string | false> {
  try {
    return await fetchText(
      url,
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
          'Upgrade-Insecure-Requests': '1',
        },
      },
      USER_AGENT,
    );
  } catch {
    return false;
  }
}

function extractContentIdAndType(url: string): [string, string] {
  const patterns: Record<string, RegExp> = {
    'short-video': /short-video\/([^?]+)/,
    'long-video': /long-video\/([^?]+)/,
    photo: /photo\/([^?]+)/,
  };
  for (const [type, pattern] of Object.entries(patterns)) {
    const match = url.match(pattern);
    if (match) return [type, match[1]];
  }
  return ['', ''];
}

function extractKsMeta(photo: Record<string, unknown>, title: string) {
  const n = (v: unknown) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : 0;
  };
  const tags: string[] = [];
  for (const m of title.matchAll(/#([^\s#]+)/g)) {
    const t = m[1]?.trim();
    if (t && !tags.includes(t)) tags.push(t);
  }
  return {
    like: n(photo.likeCount ?? photo.like_count),
    view: n(photo.viewCount ?? photo.view_count ?? photo.playCount ?? photo.photoViewCount),
    comment: n(photo.commentCount ?? photo.comment_count),
    share: n(photo.shareCount ?? photo.share_count ?? photo.forwardCount),
    tags,
  };
}

function filterMediaData(data: Record<string, unknown>): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith('tusjoh')) continue;
    const item = value as { fid?: unknown; photo?: unknown };
    if (item.fid !== undefined || item.photo !== undefined) {
      filtered[key] = value;
    }
  }
  return filtered;
}

function buildMusicInfo(photo: Record<string, unknown>): KsMusic {
  const musicSource =
    (photo.music as Record<string, unknown> | undefined) ??
    (photo.soundTrack as Record<string, unknown> | undefined) ??
    {};
  return {
    name: (musicSource.name as string) ?? '',
    artist: (musicSource.artist as string) ?? '',
    cover:
      (musicSource.imageUrls as Array<{ url?: string }> | undefined)?.[0]?.url ??
      (musicSource.avatarUrls as Array<{ url?: string }> | undefined)?.[0]?.url ??
      '',
    url: (musicSource.audioUrls as Array<{ url?: string }> | undefined)?.[0]?.url ?? '',
  };
}

function parseInitState(pageContent: string): KsApiResult | null {
  let jsonString = extractBalancedJsonFrom(pageContent, 'window.INIT_STATE');
  if (!jsonString) return null;

  jsonString = jsonString.replace(/;\s*$/, '');

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonString) as Record<string, unknown>;
  } catch {
    let cleaned = jsonString
      .replace(/\\"/g, '"')
      .replace(
        /"\{"err_msg":"launchApplication:fail"\}"/g,
        '"err_msg","launchApplication:fail"',
      )
      .replace(
        /"\{"err_msg":"system:access_denied"\}"/g,
        '"err_msg","system:access_denied"',
      );
    try {
      data = JSON.parse(cleaned) as Record<string, unknown>;
    } catch (e) {
      return { code: 500, msg: `JSON解析错误: ${e instanceof Error ? e.message : 'unknown'}` };
    }
  }

  const filteredData = filterMediaData(data);
  if (!Object.keys(filteredData).length) return null;

  const firstItem = Object.values(filteredData)[0] as { photo?: Record<string, unknown> };
  const photo = firstItem.photo ?? {};
  const musicInfo = buildMusicInfo(photo);

  const atlas = photo.ext_params as { atlas?: { list?: string[]; music?: string } } | undefined;
  const imageList = atlas?.atlas?.list ?? [];
  if (imageList.length) {
    const title = (photo.caption as string) ?? '';
    const meta = extractKsMeta(photo, title);
    return {
      code: 200,
      msg: 'success',
      data: {
        type: 'image',
        title,
        author: (photo.userName as string) ?? '',
        avatar: (photo.headUrl as string) ?? '',
        count: imageList.length,
        like: meta.like,
        view: meta.view,
        comment: meta.comment,
        share: meta.share,
        tags: meta.tags,
        time: Number(photo.timestamp) || 0,
        music: 'https://txmov2.a.kwimgs.com' + (atlas?.atlas?.music ?? ''),
        // 一律 https：面板通过 HTTPS 访问时，明文地址会被浏览器按混合内容拦掉
        images: imageList.map((path) => `https://tx2.a.yximgs.com/${path}`),
        cover: imageList[0] ? `https://tx2.a.yximgs.com/${imageList[0]}` : '',
        url: imageList[0] ? `https://tx2.a.yximgs.com/${imageList[0]}` : '',
        api: 1,
      },
    };
  }

  if (photo.photoType === 'SINGLE_PICTURE' || photo.singlePicture === true) {
    const coverUrls = photo.coverUrls as Array<{ url?: string }> | undefined;
    const imageUrl = coverUrls?.[0]?.url ?? '';
    if (imageUrl) {
      const title = (photo.caption as string) ?? '';
      const meta = extractKsMeta(photo, title);
      return {
        code: 200,
        msg: '解析成功',
        data: {
          type: 'image',
          author: (photo.userName as string) ?? '',
          avatar: (photo.headUrl as string) ?? '',
          like: meta.like,
          view: meta.view,
          comment: meta.comment,
          share: meta.share,
          tags: meta.tags,
          time: Number(photo.timestamp) || 0,
          title,
          cover: imageUrl,
          url: imageUrl,
          images: [imageUrl],
          music: musicInfo,
        },
      };
    }
  }

  if (photo.mainMvUrls || photo.photoType === 'VIDEO') {
    const mainMvUrls = photo.mainMvUrls as Array<{ url?: string }> | undefined;
    let videoUrl = mainMvUrls?.[0]?.url ?? '';
  const manifest = photo.manifest as {
      adaptationSet?: Array<{ representation?: Array<{ url?: string }> }>;
    } | undefined;
    if (!videoUrl) {
      videoUrl = manifest?.adaptationSet?.[0]?.representation?.[0]?.url ?? '';
    }
    if (videoUrl) {
      const coverUrls = photo.coverUrls as Array<{ url?: string }> | undefined;
      const title = (photo.caption as string) ?? '';
      const meta = extractKsMeta(photo, title);
      return {
        code: 200,
        msg: '解析成功',
        data: {
          type: 'video',
          author: (photo.userName as string) ?? '',
          avatar: (photo.headUrl as string) ?? '',
          like: meta.like,
          view: meta.view,
          comment: meta.comment,
          share: meta.share,
          tags: meta.tags,
          time: Number(photo.timestamp) || 0,
          title,
          cover: coverUrls?.[0]?.url ?? '',
          url: videoUrl,
          music: musicInfo,
        },
      };
    }
  }

  return null;
}

function parseApolloState(
  pageContent: string,
  contentId: string,
  contentType: string,
): KsApiResult | null {
  let raw = extractBalancedJsonFrom(pageContent, 'window.__APOLLO_STATE__');
  if (!raw) return null;

  let cleanedData = raw
    .replace(/function\s*\([^)]*\)\s*{[^}]*}/g, ':')
    .replace(/,\s*(?=}|])/g, '')
    .replace(/;\(:?\(\)\);/g, '');

  let apolloState: Record<string, unknown>;
  try {
    apolloState = JSON.parse(cleanedData) as Record<string, unknown>;
  } catch {
    return null;
  }

  const videoInfo = apolloState.defaultClient as Record<string, unknown> | undefined;
  if (!videoInfo) return null;

  const key = `VisionVideoDetailPhoto:${contentId}`;
  const videoData = videoInfo[key] as Record<string, unknown> | undefined;
  if (!videoData) return null;

  let authorData: Record<string, unknown> | null = null;
  for (const k of Object.keys(videoInfo)) {
    if (k.startsWith('VisionVideoDetailAuthor:')) {
      authorData = videoInfo[k] as Record<string, unknown>;
      break;
    }
  }

  let videoUrl = '';
  if (contentType === 'long-video') {
    const manifestH265 = videoData.manifestH265 as {
      json?: { adaptationSet?: Array<{ representation?: Array<{ backupUrl?: string[] }> }> };
    };
    videoUrl = manifestH265?.json?.adaptationSet?.[0]?.representation?.[0]?.backupUrl?.[0] ?? '';
  } else {
    videoUrl = (videoData.photoUrl as string) ?? '';
  }

  if (!videoUrl) return null;

  const title = (videoData.caption as string) ?? '';
  const meta = extractKsMeta(videoData, title);

  return {
    code: 200,
    msg: '解析成功',
    data: {
      type: contentType === 'photo' ? 'image' : 'video',
      author: (authorData?.name as string) ?? '',
      avatar: (authorData?.headerUrl as string) ?? '',
      title,
      cover: (videoData.coverUrl as string) ?? '',
      url: videoUrl,
      like: meta.like || Number(videoData.likeCount) || 0,
      view: meta.view,
      comment: meta.comment,
      share: meta.share,
      tags: meta.tags,
      time: 0,
    },
  };
}

/**
 * 解析快手链接（视频 / 图集）
 */
export async function parse(urlInput: string): Promise<KsApiResult> {
  const url = cleanUrlTail(extractKuaishouUrl(urlInput));
  if (!url) return { code: 201, msg: 'url为空' };

  try {
    const redirectUrl = await getRedirectedUrl(url);
    if (!redirectUrl) return { code: 400, msg: '解析失败：短链跳转失败（v.kuaishou.com 无响应 / 被拦截，或跳转到了非快手域名）' };

    const pageContent = await curlRequest(redirectUrl);
    if (pageContent === false) return { code: 500, msg: '解析失败：分享页抓取失败（请求失败或超时）' };

    const [contentType, contentId] = extractContentIdAndType(redirectUrl);
    if (!contentId) {
      return { code: 400, msg: `解析失败：无法识别的链接类型（跳转后 ${redirectUrl.slice(0, 80)}）` };
    }

    const result =
      parseInitState(pageContent) ??
      parseApolloState(pageContent, contentId, contentType);

    return result ?? {
      code: 404,
      msg: '解析失败：分享页里没有 INIT_STATE 也没有 Apollo 数据（通常是被风控，或页面结构已变更）',
    };
  } catch (e) {
    return { code: 500, msg: e instanceof Error ? e.message : '解析失败' };
  }
}

export default { parse };
