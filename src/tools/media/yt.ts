// ---------------------------------------------------------------------------
// YouTube 解析（InnerTube ANDROID 客户端 · 音视频合一 progressive 直链）
// ---------------------------------------------------------------------------

import { cleanUrlTail, fetchWithTimeout, isAllowedDomain } from './http-utils';

const ALLOWED_DOMAINS = [
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
  'googlevideo.com',
  'ytimg.com',
];

const USER_AGENT =
  'com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip';

const INNERTUBE_CLIENT = {
  clientName: 'ANDROID',
  clientVersion: '20.10.38',
  androidSdkVersion: 34,
  hl: 'en',
  gl: 'US',
};

export interface YtMediaData {
  type: 'video';
  title: string;
  author: string;
  cover: string;
  url: string;
  duration: number | null;
  video_id: string;
  /** 成功但有需要告知用户的前提（例如只有分离流、画面无声） */
  message?: string;
}

export interface YtApiResult {
  code: number;
  msg: string;
  data?: YtMediaData;
}

function output(code: number, msg: string, data?: YtMediaData): YtApiResult {
  return data ? { code, msg, data } : { code, msg };
}

function extractYoutubeUrl(text: string): string {
  const shorts = text.match(
    /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/shorts\/[\w-]+(?:\?[^\s]*)?/i,
  );
  if (shorts) return cleanUrlTail(shorts[0]);

  const watch = text.match(
    /https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/watch\?[^\s]*/i,
  );
  if (watch) return cleanUrlTail(watch[0]);

  const embed = text.match(
    /https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/(?:embed|live)\/[\w-]+(?:\?[^\s]*)?/i,
  );
  if (embed) return cleanUrlTail(embed[0]);

  const short = text.match(/https?:\/\/youtu\.be\/[\w-]+(?:\?[^\s]*)?/i);
  if (short) return cleanUrlTail(short[0]);

  const any = text.match(/https?:\/\/[^\s]*youtu(?:\.be|be\.com)[^\s]*/i);
  if (any) return cleanUrlTail(any[0]);

  return cleanUrlTail(text.trim());
}

function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();

    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return id && /^[\w-]{6,}$/.test(id) ? id : null;
    }

    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{6,}$/.test(v)) return v;

      const parts = u.pathname.split('/').filter(Boolean);
      const kind = parts[0]?.toLowerCase();
      if (['shorts', 'embed', 'live', 'v'].includes(kind) && parts[1] && /^[\w-]{6,}$/.test(parts[1])) {
        return parts[1];
      }
    }
  } catch {
    // fall through
  }

  const m =
    url.match(/[?&]v=([\w-]{6,})/i) ||
    url.match(/\/(?:shorts|embed|live|v)\/([\w-]{6,})/i) ||
    url.match(/youtu\.be\/([\w-]{6,})/i);
  return m?.[1] ?? null;
}

function pickCover(details: Record<string, unknown> | undefined): string {
  const thumbs = (details?.thumbnail as { thumbnails?: Array<{ url?: string; width?: number }> })
    ?.thumbnails;
  if (!Array.isArray(thumbs) || !thumbs.length) {
    const id = String(details?.videoId || '');
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
  }
  const sorted = [...thumbs].sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0));
  return String(sorted[0]?.url || '');
}

type YtFormat = {
  itag?: number;
  url?: string;
  mimeType?: string;
  bitrate?: number;
  width?: number;
  height?: number;
  contentLength?: string;
  audioQuality?: string;
};

/** 只要带直链、音视频合一的 progressive（formats），不要无声 adaptive */
function pickProgressiveUrl(streamingData: Record<string, unknown> | undefined): string {
  const formats = Array.isArray(streamingData?.formats)
    ? (streamingData!.formats as YtFormat[])
    : [];
  const candidates = formats.filter((f) => {
    if (!f?.url || typeof f.url !== 'string') return false;
    const mime = String(f.mimeType || '');
    // progressive mp4/webm 通常同时含 video + audio codecs
    return /video\/(mp4|webm)/i.test(mime) && /avc1|vp9|av01|mp4a|opus/i.test(mime);
  });
  if (!candidates.length) return '';
  return pickBest(candidates, 1);
}

/**
 * 兜底：只有分离流时取最高画质的「纯画面」轨（无声）。
 * 新版 YouTube 对不少视频已不再下发音视频合一格式，此前这种情况直接报
 * 「未找到可用的音视频合一直链」，用户什么都拿不到。
 */
function pickAdaptiveVideoUrl(streamingData: Record<string, unknown> | undefined): string {
  const formats = Array.isArray(streamingData?.adaptiveFormats)
    ? (streamingData!.adaptiveFormats as YtFormat[])
    : [];
  const videoOnly = formats.filter((f) => {
    if (!f?.url || typeof f.url !== 'string') return false;
    const mime = String(f.mimeType || '');
    return /video\//i.test(mime) && !/mp4a|opus/i.test(mime);
  });
  if (!videoOnly.length) return '';
  return pickBest(videoOnly, 0);
}

/** 合并流按「高度 > 码率」、纯画面轨额外优先 h264（浏览器兼容） */
function pickBest(candidates: YtFormat[], combined: number): string {
  const codecRank = (f: YtFormat) => {
    const mime = String(f.mimeType || '');
    if (/avc1/i.test(mime)) return 2;
    if (/vp9|vp09/i.test(mime)) return 1;
    return 0;
  };
  const sorted = [...candidates].sort((a, b) => {
    if (combined === 0 && codecRank(a) !== codecRank(b)) return codecRank(b) - codecRank(a);
    const ha = Number(a.height) || 0;
    const hb = Number(b.height) || 0;
    if (hb !== ha) return hb - ha;
    return (Number(b.bitrate) || 0) - (Number(a.bitrate) || 0);
  });
  return sorted[0]?.url || '';
}

async function fetchPlayer(videoId: string): Promise<Record<string, unknown>> {
  const body = {
    videoId,
    context: { client: { ...INNERTUBE_CLIENT } },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetchWithTimeout('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
      'X-YouTube-Client-Name': '3',
      'X-YouTube-Client-Version': INNERTUBE_CLIENT.clientVersion,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`InnerTube HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/**
 * 解析 YouTube / Shorts / youtu.be 链接
 */
export async function parse(urlInput: string): Promise<YtApiResult> {
  const url = extractYoutubeUrl(urlInput);
  if (!url) return output(400, '请输入 YouTube 链接');

  if (!isAllowedDomain(url, ALLOWED_DOMAINS)) {
    return output(400, '非 YouTube 域名链接');
  }

  const videoId = extractVideoId(url);
  if (!videoId) return output(400, '无法提取视频 ID');

  try {
    const player = await fetchPlayer(videoId);
    const status = (player.playabilityStatus as { status?: string; reason?: string } | undefined)
      ?.status;
    if (status && status !== 'OK') {
      const reason =
        (player.playabilityStatus as { reason?: string } | undefined)?.reason || status;
      return output(403, `无法播放：${reason}`);
    }

    const details = player.videoDetails as Record<string, unknown> | undefined;
    const streamingData = player.streamingData as Record<string, unknown> | undefined;
    let streamUrl = pickProgressiveUrl(streamingData);
    let warning = '';
    if (!streamUrl) {
      streamUrl = pickAdaptiveVideoUrl(streamingData);
      if (streamUrl) {
        warning = '该视频只有分离的音视频流，已给出最高画质的画面轨：可正常观看与下载，但没有声音。';
      }
    }
    if (!streamUrl) {
      return output(404, '未找到可用的视频直链（视频可能受地区、年龄或会员限制）');
    }

    const title = String(details?.title || '');
    const author = String(details?.author || '');
    const durationRaw = Number(details?.lengthSeconds);
    const cover = pickCover(details);

    return output(200, '解析成功', {
      type: 'video',
      title,
      author,
      cover,
      url: streamUrl,
      duration: Number.isFinite(durationRaw) ? durationRaw : null,
      video_id: String(details?.videoId || videoId),
      ...(warning ? { message: warning } : {}),
    });
  } catch (e) {
    return output(500, e instanceof Error ? e.message : '解析失败');
  }
}

export default { parse };
