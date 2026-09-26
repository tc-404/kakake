// ---------------------------------------------------------------------------
// 哔哩哔哩视频解析（由 blbl.php 迁移）
// 覆盖：BV 号 / av 号 / b23.tv 短链 / 番剧（ep、ss）
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
  /** 视频时长（秒），供归一化层直接使用，免去反解 HH:MM:SS */
  视频时长秒: number;
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

/** 调 B站 接口一律带 Referer：番剧播放地址与部分接口会校验来源 */
const BILI_HEADERS = { Referer: 'https://www.bilibili.com/' };

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

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function stripHtml(s: string): string {
  return String(s || '').replace(/<[^>]*>/g, '').trim();
}

/** 从文本里取 BV 号 */
function findBv(text: string): string | null {
  return text.match(/BV[a-zA-Z0-9]{10}/i)?.[0] ?? null;
}

/** 取 av 号（av123456）。b23.tv 短链已先被剔除，避免把短链编码当 av 号 */
function findAv(text: string): string | null {
  return text.match(/(?:^|[^\w])av(\d{1,12})(?!\d)/i)?.[1] ?? null;
}

/** 取番剧 ep / ss 号 */
function findEp(text: string): string | null {
  return text.match(/(?:^|[^\w])ep(\d{1,10})(?!\d)/i)?.[1] ?? null;
}

function findSs(text: string): string | null {
  return text.match(/(?:^|[^\w])ss(\d{1,10})(?!\d)/i)?.[1] ?? null;
}

function isBiliUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'b23.tv' || host === 'bilibili.com' || host.endsWith('.bilibili.com');
  } catch {
    return false;
  }
}

/**
 * 短视频直链。
 * 普通投稿走 x/player/wbi/playurl，番剧走 pgc/player/web/playurl；
 * 两者都带 platform=html5，让接口回 durl（mp4 直链）而不是 dash 分段。
 */
async function fetchPlayUrl(
  bvid: string,
  cid: string | number,
  pgc: boolean,
): Promise<{ url: string; length?: number; size?: number } | null> {
  const attempts = pgc
    ? ['bvid=%s&cid=%s&qn=80&fnval=0&fourk=1&platform=html5', 'bvid=%s&cid=%s&platform=html5']
    : ['gaia_source=view-card&fnval=4048&platform=html5&bvid=%s&cid=%s'];
  const base = pgc
    ? 'https://api.bilibili.com/pgc/player/web/playurl'
    : 'https://api.bilibili.com/x/player/wbi/playurl';

  for (const tpl of attempts) {
    const query = tpl.replace('%s', bvid).replace('%s', String(cid));
    try {
      const raw = await fetchText(`${base}?${query}`, { headers: BILI_HEADERS }, DEFAULT_USER_AGENT);
      const json = JSON.parse(raw) as {
        code?: number;
        message?: string;
        data?: { durl?: Array<{ url?: string; length?: number; size?: number }> };
        result?: { durl?: Array<{ url?: string; length?: number; size?: number }> };
      };
      const durl = (json.data ?? json.result)?.durl?.[0];
      if (durl?.url) return { url: durl.url, length: durl.length, size: durl.size };
    } catch {
      // 换下一种参数
    }
  }
  return null;
}

/** av 号 → BV 号（av 链接此前完全不被识别） */
async function lookupAv(aid: string): Promise<string | null> {
  const raw = await fetchText(
    `https://api.bilibili.com/x/web-interface/view?aid=${encodeURIComponent(aid)}`,
    { headers: BILI_HEADERS },
    DEFAULT_USER_AGENT,
  );
  const json = JSON.parse(raw) as { code?: number; data?: { bvid?: string } };
  return json.code === 0 && json.data?.bvid ? json.data.bvid : null;
}

/** 番剧 / 剧集：走 pgc season 接口取剧集信息与播放地址 */
async function parsePgc(ep: string | null, ss: string | null): Promise<BlblParseResult> {
  const query = ep ? `ep_id=${encodeURIComponent(ep)}` : `season_id=${encodeURIComponent(String(ss))}`;
  const raw = await fetchText(
    `https://api.bilibili.com/pgc/view/web/season?${query}`,
    { headers: BILI_HEADERS },
    DEFAULT_USER_AGENT,
  );
  const json = JSON.parse(raw) as {
    code?: number;
    message?: string;
    result?: {
      title?: string;
      cover?: string;
      evaluate?: string;
      pubdate?: number;
      type_name?: string;
      styles?: Array<{ name?: string }>;
      stat?: Record<string, number>;
      episodes?: Array<{
        id?: number;
        bvid?: string;
        cid?: number;
        title?: string;
        long_title?: string;
        cover?: string;
        duration?: number;
        pub_time?: number;
      }>;
    };
  };
  const result = json.result;
  if (json.code !== 0 || !result?.episodes?.length) {
    return { 状态码: 403, 消息: json.message || '番剧信息获取失败（可能需要大会员或地区受限）', 数据: null };
  }

  const episode = (ep ? result.episodes.find((e) => String(e.id) === ep) : undefined) ?? result.episodes[0]!;
  if (!episode.bvid || !episode.cid) {
    return { 状态码: 403, 消息: '该剧集没有可用的播放信息（可能需要大会员）', 数据: null };
  }

  const play = await fetchPlayUrl(episode.bvid, episode.cid, true);
  if (!play) {
    return { 状态码: 403, 消息: '获取播放地址失败（该剧集可能需要大会员或已下架）', 数据: null };
  }

  const 时长秒 = episode.duration ? Math.round(episode.duration / 1000) : 0;
  const 大小 = play.size != null ? Math.round((play.size / (1024 * 1024)) * 100) / 100 : 0;
  const 标题 = [result.title, episode.title, episode.long_title].filter(Boolean).join(' · ');
  const stat = result.stat ?? {};
  const tags = [result.type_name, ...(result.styles ?? []).map((s) => s.name)]
    .map((t) => String(t || '').trim())
    .filter(Boolean);

  return {
    状态码: 200,
    消息: '获取成功',
    数据: {
      视频标题: 标题,
      视频封面: episode.cover || result.cover || '',
      发布时间: episode.pub_time ? formatPubDate(episode.pub_time) : (result.pubdate ? formatPubDate(result.pubdate) : '未知'),
      视频描述: stripHtml(result.evaluate ?? '') || '无描述',
      视频链接: play.url.replace(/\\/g, ''),
      视频时长: formatDuration(时长秒),
      视频时长秒: 时长秒,
      视频大小: `${大小}MB`,
      播放次数: num(stat.views),
      弹幕数量: num(stat.danmaku),
      点赞数量: num(stat.likes),
      投币数量: num(stat.coins),
      收藏数量: num(stat.favorite),
      分享数量: num(stat.share),
      评论数量: num(stat.reply),
      标签: [...new Set(tags)],
    },
  };
}

/**
 * 解析哔哩哔哩链接
 * @param lq 原始链接或 BV / av 号所在文本
 */
export async function parse(lq: string): Promise<BlblParseResult> {
  const 原始链接 = lq.trim();

  if (!原始链接) {
    return { 状态码: 403, 消息: '参数lq为空', 数据: null };
  }

  try {
    // 1) b23.tv 短链：跟随跳转，把跳转结果与原文合并后再找 ID。
    //    短链编码长度不固定，早先正则写死 7 位会把长编码截断。
    let 链接 = 原始链接;
    const 短链 = 原始链接.match(/https?:\/\/b23\.tv\/[a-zA-Z0-9]+/i);
    if (短链) {
      const 跳转后链接 = await followRedirect(短链[0], DEFAULT_USER_AGENT, isBiliUrl).catch(() => '');
      if (跳转后链接 && !isBiliUrl(跳转后链接)) {
        return { 状态码: 403, 消息: `短链跳转到了非 B站 域名：${跳转后链接.slice(0, 80)}`, 数据: null };
      }
      if (跳转后链接) 链接 = `${原始链接} ${跳转后链接}`;
    }

    // 2) 先认 BV / av 号：正文里带「EP1」之类字样的普通视频链接不该被当成番剧
    const 无短链文本 = 链接.replace(/https?:\/\/b23\.tv\/[a-zA-Z0-9]+/gi, ' ');
    let BV号 = findBv(链接);
    if (!BV号) {
      const av号 = findAv(无短链文本);
      if (av号) {
        BV号 = await lookupAv(av号).catch(() => null);
        if (!BV号) return { 状态码: 403, 消息: `av${av号} 转换 BV 号失败（视频可能已删除或仅会员可见）`, 数据: null };
      }
    }

    // 3) 没有 BV/av 时再按番剧链接处理（ep / ss）
    if (!BV号) {
      const ep = findEp(无短链文本);
      const ss = findSs(无短链文本);
      if (ep || ss) return await parsePgc(ep, ss);
      if (/\/bangumi\/play\//i.test(链接)) {
        return { 状态码: 403, 消息: '番剧链接里没有找到 ep / ss 号', 数据: null };
      }
      return { 状态码: 403, 消息: '未找到 BV 号 / av 号 / 番剧 ep 号（支持 BV、av、b23.tv 短链与 bangumi 链接）', 数据: null };
    }

    const 视频信息Raw = await fetchText(
      `https://api.bilibili.com/x/web-interface/wbi/view?bvid=${BV号}`,
      { headers: BILI_HEADERS },
      DEFAULT_USER_AGENT,
    );
    const 视频信息 = JSON.parse(视频信息Raw) as {
      code: number;
      message?: string;
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
      return { 状态码: 403, 消息: 视频信息.message || '获取视频信息失败', 数据: null };
    }

    const cid = 视频信息.data.cid;
    if (!cid) return { 状态码: 403, 消息: '视频信息里没有 cid，无法取播放地址', 数据: null };
    const play = await fetchPlayUrl(BV号, cid, false);
    if (!play) {
      return { 状态码: 403, 消息: '获取播放地址失败（视频可能已下架或仅会员可见）', 数据: null };
    }

    const 时长秒 = play.length != null ? Math.round(play.length / 1000) : 0;
    const 大小 = play.size != null ? Math.round((play.size / (1024 * 1024)) * 100) / 100 : 0;

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
      // B 站未填简介时返回空字符串，?? 兜不住，需按空白判断
      视频描述: String(视频信息.data.desc ?? '').trim() || '无描述',
      视频链接: play.url.replace(/\\/g, ''),
      视频时长: formatDuration(时长秒),
      视频时长秒: 时长秒,
      视频大小: `${大小}MB`,
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
  } catch (e) {
    return {
      状态码: 500,
      消息: `解析失败：${e instanceof Error ? e.message : String(e)}`,
      数据: null,
    };
  }
}

export default { parse };
