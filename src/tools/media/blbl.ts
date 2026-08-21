// ---------------------------------------------------------------------------
// 哔哩哔哩视频解析（由 blbl.php 迁移）
// ---------------------------------------------------------------------------

import { DEFAULT_USER_AGENT, fetchText, followRedirect } from './http-utils';

export interface BlblUpInfo {
  UP主ID: number | string;
  UP主名称: string;
  UP主头像: string;
}

export interface BlblVideoData {
  视频标题: string;
  视频封面: string;
  发布时间: string;
  视频描述: string;
  视频链接: string;
  视频时长: string;
  视频大小: string;
  播放次数: number;
  弹幕数量: number;
  点赞数量: number;
  投币数量: number;
  收藏数量: number;
  分享数量: number;
  评论数量: number;
  标签: string[];
  UP主信息?: BlblUpInfo;
}

export interface BlblParseResult {
  状态码: number;
  消息: string;
  数据: BlblVideoData | null;
}

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

function formatPubDate(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 解析哔哩哔哩链接
 * @param lq 原始链接或 BV 号所在文本
 */
export async function parse(lq: string): Promise<BlblParseResult> {
  const 原始链接 = lq.trim();

  if (!原始链接) {
    return { 状态码: 403, 消息: '参数lq为空', 数据: null };
  }

  const 短链接匹配 = 原始链接.match(/https?:\/\/b23\.tv\/[a-zA-Z0-9]{7}/i);
  const BV号匹配 = 原始链接.match(/BV[a-zA-Z0-9]{10}/i);

  let BV号: string | null = null;

  if (短链接匹配) {
    const 跳转后链接 = await followRedirect(短链接匹配[0], DEFAULT_USER_AGENT);
    const 跳转BV号匹配 = 跳转后链接.match(/BV[a-zA-Z0-9]{10}/i);
    BV号 = 跳转BV号匹配?.[0] ?? BV号匹配?.[0] ?? null;
  } else {
    BV号 = BV号匹配?.[0] ?? null;
  }

  if (!BV号) {
    return { 状态码: 403, 消息: '未找到b23.tv短链接或BV号', 数据: null };
  }

  const 视频信息Raw = await fetchText(
    `https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV号}`,
    {},
    DEFAULT_USER_AGENT,
  );
  const 视频信息 = JSON.parse(视频信息Raw) as {
    code: number;
    data?: {
      title?: string;
      pic?: string;
      pubdate?: number;
      desc?: string;
      cid?: number;
      tname?: string;
      tname_v2?: string;
      stat?: Record<string, number>;
      owner?: { mid?: number; name?: string; face?: string };
    };
  };

  if (视频信息.code !== 0 || !视频信息.data) {
    return { 状态码: 403, 消息: '获取视频信息失败', 数据: null };
  }

  const cid = 视频信息.data.cid;
  const 播放信息Raw = await fetchText(
    `https://api.bilibili.com/x/player/wbi/playurl?gaia_source=view-card&fnval=4048&platform=html5&bvid=${BV号}&cid=${cid}`,
    {},
    DEFAULT_USER_AGENT,
  );
  const 播放信息 = JSON.parse(播放信息Raw) as {
    code: number;
    data?: { durl?: Array<{ url?: string; length?: number; size?: number }> };
  };

  if (播放信息.code !== 0 || !播放信息.data?.durl?.[0]?.url) {
    return { 状态码: 403, 消息: '获取播放地址失败', 数据: null };
  }

  const durl = 播放信息.data.durl[0];
  let 视频时长 = 0;
  let 视频大小 = 0;

  if (durl.length != null) {
    视频时长 = Math.round(durl.length / 1000);
  }
  if (durl.size != null) {
    视频大小 = Math.round((durl.size / (1024 * 1024)) * 100) / 100;
  }

  const stat = 视频信息.data.stat ?? {};
  const tags: string[] = [];
  const tname = 视频信息.data.tname_v2 || 视频信息.data.tname;
  if (tname) tags.push(tname);
  const desc = 视频信息.data.desc ?? '';
  for (const m of desc.matchAll(/#([^\s#]+)/g)) {
    const t = m[1]?.trim();
    if (t && !tags.includes(t)) tags.push(t);
  }

  const 数据: BlblVideoData = {
    视频标题: 视频信息.data.title ?? '',
    视频封面: 视频信息.data.pic ?? '',
    发布时间: 视频信息.data.pubdate ? formatPubDate(视频信息.data.pubdate) : '未知',
    视频描述: desc || '无描述',
    视频链接: (durl.url ?? '').replace(/\\/g, ''),
    视频时长: formatDuration(视频时长),
    视频大小: `${视频大小}MB`,
    播放次数: stat.view ?? 0,
    弹幕数量: stat.danmaku ?? 0,
    点赞数量: stat.like ?? 0,
    投币数量: stat.coin ?? 0,
    收藏数量: stat.favorite ?? 0,
    分享数量: stat.share ?? 0,
    评论数量: stat.reply ?? 0,
    标签: tags,
  };

  if (视频信息.data.owner?.mid != null) {
    数据.UP主信息 = {
      UP主ID: 视频信息.data.owner.mid,
      UP主名称: 视频信息.data.owner.name ?? '',
      UP主头像: 视频信息.data.owner.face ?? '',
    };
  }

  return { 状态码: 200, 消息: '获取成功', 数据 };
}

export default { parse };
