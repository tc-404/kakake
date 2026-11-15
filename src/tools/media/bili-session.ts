// ---------------------------------------------------------------------------
// B站 请求会话：自动获取设备指纹 Cookie + wbi 签名（不需要用户配置任何东西）
//
// 背景：blbl.ts 原先只带 UA + Referer 直连 api.bilibili.com。家宽 / 住宅 IP
// 上 B站 会放过这种「裸请求」，但机房、云服务器、境外 IP 会被风控直接回
// HTTP 412 —— 同一个视频本地能解析、部署到服务器就 412，就是这么来的。
//
// B站 的风控分主要看三样：出口 IP 信誉、设备指纹 Cookie（buvid3/buvid4）、
// wbi 签名（w_rid + wts）。IP 我们改不了，后两样可以自己补齐：
//   · finger/spi 接口免登录发放 buvid3 / buvid4，拿到后按 Cookie 带上；
//   · nav 接口（未登录也返回）给出当日 wbi 密钥，本地 md5 算签名。
// 两者都做了，机房 IP 上的 412 大多能过。
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  fetchText,
  fetchFollowingAllowedRedirects,
  PAGE_TIMEOUT_MS,
} from './http-utils';

/**
 * B站 动态接口按 UA 做风控：Chrome/103、Edg/122 一律 -352，
 * Chrome/120、131 正常。所以 B站 相关请求统一用较新的 Chrome UA。
 */
export const BILI_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const API = 'https://api.bilibili.com';
const HOME = 'https://www.bilibili.com/';

/** 指纹 Cookie 有效期：B站 自己给的 buvid 是长期有效的，6 小时换一次足够 */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;
/** 取指纹失败时的重试间隔（不能一失败就 6 小时不试） */
const SESSION_FAIL_TTL_MS = 60 * 1000;
/** wbi 密钥每天轮换，20 分钟刷一次即可 */
const WBI_KEY_TTL_MS = 20 * 60 * 1000;

/** wbi 密钥打乱表（B站 前端硬编码的那 64 个下标） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
  11, 26, 54, 1, 34, 21, 52, 30, 60, 20, 51, 17, 25, 44, 6, 57, 4, 36, 22,
  59, 0, 61, 56, 31, 62, 63,
];

interface BiliSession {
  cookie: string;
  /** 本次 Cookie 是否真的拿到了 buvid（失败也要记时间，避免频繁重试） */
  ok: boolean;
  fetchedAt: number;
}

let session: BiliSession | null = null;
let sessionPending: Promise<BiliSession> | null = null;

let wbiKeys: { imgKey: string; subKey: string; fetchedAt: number } | null = null;
let wbiPending: Promise<{ imgKey: string; subKey: string } | null> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 浏览器会带、而裸 fetch 不会带的那批头。
 * 机房 IP 上「只有 UA + Referer」的请求指纹残缺得很明显，补齐能显著降低风控分。
 */
function browserHeaders(cookie: string): Record<string, string> {
  const headers: Record<string, string> = {
    'User-Agent': BILI_USER_AGENT,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    Referer: HOME,
    Origin: 'https://www.bilibili.com',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-site',
  };
  if (cookie) headers.Cookie = cookie;
  return headers;
}

/**
 * 自动领取设备指纹。
 *
 * finger/spi 是 B站 官方免登录接口，返回 b_3 / b_4（即 buvid3 / buvid4）。
 * 失败不抛错，退化成不带 Cookie —— 家宽 IP 上照样能用，只是机房 IP 更容易 412。
 */
async function loadSession(): Promise<BiliSession> {
  const now = Date.now();
  if (session) {
    const ttl = session.ok ? SESSION_TTL_MS : SESSION_FAIL_TTL_MS;
    if (now - session.fetchedAt < ttl) return session;
  }
  if (sessionPending) return sessionPending;

  sessionPending = (async (): Promise<BiliSession> => {
    // 高级用法：手动配了 BILI_COOKIE（例如登录态 SESSDATA，能解 1080P / 番剧）就直接用
    const override = (process.env.BILI_COOKIE || '').trim();
    if (override) {
      return { cookie: override, ok: true, fetchedAt: now };
    }

    try {
      const raw = await fetchText(
        `${API}/x/frontend/finger/spi`,
        { headers: browserHeaders('') },
        BILI_USER_AGENT,
      );
      const json = JSON.parse(raw) as { code?: number; data?: { b_3?: string; b_4?: string } };
      const b3 = String(json.data?.b_3 ?? '').trim();
      const b4 = String(json.data?.b_4 ?? '').trim();
      if (!b3 && !b4) return { cookie: '', ok: false, fetchedAt: Date.now() };

      const parts = [`b_nut=${Math.floor(Date.now() / 1000)}`];
      if (b3) parts.push(`buvid3=${b3}`);
      if (b4) parts.push(`buvid4=${b4}`);
      return { cookie: parts.join('; '), ok: true, fetchedAt: Date.now() };
    } catch {
      return { cookie: '', ok: false, fetchedAt: Date.now() };
    }
  })().finally(() => {
    sessionPending = null;
  });

  session = await sessionPending;
  return session;
}

function fileKey(url: string): string {
  return String(url || '').split('/').pop()?.split('.')[0] ?? '';
}

/** 取当日 wbi 密钥。未登录时 nav 返回 code -101，但 wbi_img 照样带，所以不能按 code 判断 */
async function loadWbiKeys(): Promise<{ imgKey: string; subKey: string } | null> {
  const now = Date.now();
  if (wbiKeys && now - wbiKeys.fetchedAt < WBI_KEY_TTL_MS) return wbiKeys;
  if (wbiPending) return wbiPending;

  wbiPending = (async () => {
    try {
      const s = await loadSession();
      const raw = await fetchText(
        `${API}/x/web-interface/nav`,
        { headers: browserHeaders(s.cookie) },
        BILI_USER_AGENT,
      );
      const json = JSON.parse(raw) as {
        data?: { wbi_img?: { img_url?: string; sub_url?: string } };
      };
      const imgKey = fileKey(json.data?.wbi_img?.img_url ?? '');
      const subKey = fileKey(json.data?.wbi_img?.sub_url ?? '');
      if (!imgKey || !subKey) return null;
      wbiKeys = { imgKey, subKey, fetchedAt: Date.now() };
      return { imgKey, subKey };
    } catch {
      return null;
    }
  })().finally(() => {
    wbiPending = null;
  });

  return wbiPending;
}

function mixinKey(orig: string): string {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n] ?? '').join('').slice(0, 32);
}

/**
 * 给 wbi 接口加签名：参数按 key 排序 → 拼查询串 → md5(查询串 + mixinKey)。
 * 值里的 !'()* 必须按 B站 的口径先剔除，否则算出来的 w_rid 对不上。
 */
function signWbi(url: string, imgKey: string, subKey: string): string {
  const u = new URL(url);
  const params: Array<[string, string]> = [...u.searchParams.entries()];
  params.push(['wts', String(Math.floor(Date.now() / 1000))]);
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v.replace(/[!'()*]/g, ''))}`)
    .join('&');
  const wRid = createHash('md5')
    .update(query + mixinKey(imgKey + subKey))
    .digest('hex');
  return `${u.origin}${u.pathname}?${query}&w_rid=${wRid}`;
}

/** 412 / 429 = 风控拦截，换一套指纹重试有意义；其它错误没必要重试 */
function isRiskBlocked(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /HTTP (412|429)/.test(msg);
}

/** 作废当前指纹与密钥，下次请求重新领取 */
export function resetBiliSession(): void {
  session = null;
  wbiKeys = null;
}

/**
 * 请求 B站 并返回文本。
 * 带设备指纹 + 完整浏览器头；URL 里含 `/wbi/` 的自动签名，调用方不用操心。
 * 碰到 412 会作废指纹重来一次——风控经常是「这套指纹被盯上了」而不是永久封。
 */
export async function biliFetchText(url: string, opts: { sign?: boolean } = {}): Promise<string> {
  const wantSign = opts.sign !== false;

  const run = async (): Promise<string> => {
    const s = await loadSession();
    let target = url;
    if (wantSign && url.includes('/wbi/')) {
      const keys = await loadWbiKeys();
      if (keys) target = signWbi(url, keys.imgKey, keys.subKey);
    }
    return fetchText(target, { headers: browserHeaders(s.cookie) }, BILI_USER_AGENT);
  };

  try {
    return await run();
  } catch (e) {
    if (!isRiskBlocked(e)) throw e;
    resetBiliSession();
    await sleep(400);
    return await run();
  }
}

/** -352 = 风控校验失败（签名 / 指纹不认），-412 = 请求被拦截 */
function isRiskCode(code: unknown): boolean {
  return code === -352 || code === -412;
}

/**
 * 请求 B站 并解析 JSON。
 *
 * 三级降级，保证这条改造只会让成功率高、不会让成功率变低：
 *   ① 带指纹 + 签名请求；
 *   ② code -352（风控校验失败）→ 换一套指纹与密钥重来；
 *   ③ 仍是 -352 → 退回「不带签名」的老请求方式，也就是改造前的行为。
 * 签名算法一旦因为 B站 改版而失效，走 ③ 就自动回到旧状态，不会比原来更糟。
 */
export async function biliGetJson<T extends { code?: number }>(url: string): Promise<T> {
  const parse = (text: string) => JSON.parse(text) as T;

  const first = parse(await biliFetchText(url));
  if (!isRiskCode(first.code)) return first;

  resetBiliSession();
  await sleep(600);
  const second = parse(await biliFetchText(url));
  if (!isRiskCode(second.code) || !url.includes('/wbi/')) return second;

  const third = parse(await biliFetchText(url, { sign: false }));
  return third;
}

/**
 * 跟随 b23.tv 短链跳转（逐跳过白名单）。短链服务和 API 是同一套风控，
 * 所以同样带上指纹；412 也重试一次。
 */
export async function biliFollowRedirect(
  url: string,
  isAllowed: (target: string) => boolean,
): Promise<string> {
  const run = async (): Promise<string> => {
    const s = await loadSession();
    const r = await fetchFollowingAllowedRedirects({
      url,
      headers: browserHeaders(s.cookie),
      isAllowed,
      maxRedirects: 5,
      timeoutMs: PAGE_TIMEOUT_MS,
    });
    if (!r.ok) throw new Error(r.message);
    const status = r.response.status;
    r.response.body?.cancel().catch(() => {});
    // 412 时自身不是跳转，手工跟随的循环会把拦截页当成终点返回
    if (status >= 400) throw new Error(`HTTP ${status}`);
    return r.url;
  };

  try {
    return await run();
  } catch (e) {
    if (!isRiskBlocked(e)) throw e;
    resetBiliSession();
    await sleep(400);
    return await run();
  }
}
