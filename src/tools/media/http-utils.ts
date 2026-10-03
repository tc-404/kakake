// ---------------------------------------------------------------------------
// 视频解析 API 共用 HTTP 工具（本地 lib/api 模块）
// ---------------------------------------------------------------------------

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';

export const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';

/**
 * 上游请求超时。
 *
 * 解析链路上任何一次请求都不该无限等待：上游半死不活时，没有超时会让
 * 这条 HTTP 请求一直挂到 Node 的 requestTimeout（默认 5 分钟），前端只能
 * 一直转圈，期间还占着一次限速额度。JSON/HTML 这类小响应给 15 秒，
 * 页面级请求给 20 秒。
 */
export const FETCH_TIMEOUT_MS = 15000;
export const PAGE_TIMEOUT_MS = 20000;

/**
 * 带超时的 fetch（总时长上限，含读 body）。
 * 用于 JSON / HTML 这类响应体必然很小的请求。
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!init.signal) return fetch(url, { ...init, signal: timer });

  // 调用方自带 signal 时手工合并，避免依赖 AbortSignal.any（Node 20.3+ 才有）
  const ctrl = new AbortController();
  const forward = () => ctrl.abort();
  init.signal.addEventListener('abort', forward, { once: true });
  timer.addEventListener('abort', forward, { once: true });
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => {
    init.signal?.removeEventListener('abort', forward);
  });
}

/**
 * 只在「拿到响应头」之前计时。
 * 媒体下载必须这样：一条 500MB 的视频正常传输要几分钟，用总时长上限会在
 * 传输中途被掐断；这里只兜住「上游一直不回应」的情况。
 */
export async function fetchWithConnectTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('上游连接超时')), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 一次解析的总时限。
 *
 * 各平台都有「多地址 × 多 UA」的串行重试（TikTok 最多约 20 次请求、
 * 抖音最多约 40 次），上游整体变慢时单次解析可能拖到几分钟。循环里用
 * deadline.expired() 提前收手，让用户尽快拿到失败原因而不是一直等。
 */
export interface Deadline {
  /** 是否已超过总时限 */
  expired(): boolean;
  /** 剩余毫秒（不小于 0） */
  leftMs(): number;
}

export function createDeadline(ms: number): Deadline {
  const end = Date.now() + ms;
  return {
    expired: () => Date.now() >= end,
    leftMs: () => Math.max(0, end - Date.now()),
  };
}

export async function fetchText(
  url: string,
  init: RequestInit = {},
  userAgent = DEFAULT_USER_AGENT,
): Promise<string> {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', userAgent);
  }

  const res = await fetchWithTimeout(url, {
    ...init,
    headers,
    redirect: init.redirect ?? 'follow',
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.text();
}

/**
 * 跟随重定向，返回最终 URL。
 * 传了 isAllowed 就逐跳校验跳转目标（redirect: 'manual' 自己走），
 * 不允许的目标会抛错而不是照单全收——与媒体代理那边同一套口径。
 * 解析器里的短链跳转都该带上它：只校验第一跳等于没校验。
 */
export async function followRedirect(
  url: string,
  userAgent = DEFAULT_USER_AGENT,
  isAllowed?: (target: string) => boolean,
): Promise<string> {
  if (!isAllowed) {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
    });
    return res.url || url;
  }

  const r = await fetchFollowingAllowedRedirects({
    url,
    headers: { 'User-Agent': userAgent },
    isAllowed,
    maxRedirects: 5,
    timeoutMs: PAGE_TIMEOUT_MS,
  });
  if (!r.ok) throw new Error(r.message);
  // 只要最终地址，不读 body，直接丢弃避免占着连接
  r.response.body?.cancel().catch(() => {});
  return r.url;
}

/** 清理 URL 末尾非法字符 */
export function cleanUrlTail(url: string): string {
  return url.replace(/[^\w\-./?=&:#]+$/u, '');
}

/**
 * 域名白名单校验（防 SSRF）。
 *
 * 按 **主机名标签边界** 匹配，而不是拿正则去扫整串链接：
 * 旧实现用 `https?://[^/]*youtube\.com`，`https://evil-youtube.com/` 与
 * `https://evil.com/?u=youtube.com` 都能通过——只要将来有人拿它去决定
 * 「这个 URL 能不能抓」，就是一个真 SSRF。这里解析出 hostname 后按
 * 「相等」或「以 .域名 结尾」判断，子域仍放行（www./i./sns-img-hw. 等）。
 */
export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  const cleaned = cleanUrlTail(String(url || ''));
  if (!cleaned) return false;

  let host: string;
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    host = parsed.hostname.toLowerCase();
  } catch {
    // 不是合法绝对 URL（例如用户只粘了裸域名）→ 一律不通过
    return false;
  }
  if (!host) return false;

  return allowedDomains.some((allowed) => {
    const domain = String(allowed || '').trim().toLowerCase().replace(/^\./, '');
    return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
  });
}

export type AllowedRedirectResult =
  | { ok: true; response: Response; url: string }
  | { ok: false; status: number; message: string };

/**
 * 手工跟随重定向，并且**每一跳都重新过白名单**。
 *
 * `fetch(..., { redirect: 'follow' })` 只在第一跳校验过域名，301/302 之后的
 * 目标（包括内网地址、云厂商 metadata 端点）会照单全收；这里改成
 * redirect: 'manual' 自己走，跳转目标不允许就直接中止。
 */
export async function fetchFollowingAllowedRedirects(opts: {
  url: string;
  headers?: Record<string, string>;
  method?: string;
  isAllowed: (target: string) => boolean;
  maxRedirects?: number;
  timeoutMs?: number;
}): Promise<AllowedRedirectResult> {
  const maxRedirects = opts.maxRedirects ?? 4;
  let current = opts.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!opts.isAllowed(current)) {
      return { ok: false, status: 403, message: `该域名不允许代理下载：${hostnameOf(current)}` };
    }

    let res: Response;
    try {
      res = await fetchWithConnectTimeout(
        current,
        {
          method: opts.method ?? 'GET',
          redirect: 'manual',
          headers: opts.headers ?? {},
        },
        opts.timeoutMs,
      );
    } catch (e) {
      return { ok: false, status: 502, message: e instanceof Error ? e.message : '拉取资源失败' };
    }

    const location = res.headers.get('location');
    const isRedirect = [301, 302, 303, 307, 308].includes(res.status) && Boolean(location);
    if (!isRedirect) return { ok: true, response: res, url: current };

    // 不读跳转响应的 body，直接丢弃，避免占着连接
    res.body?.cancel().catch(() => {});
    let next: string;
    try {
      next = new URL(String(location), current).toString();
    } catch {
      return { ok: false, status: 502, message: '上游返回了无法解析的跳转地址' };
    }
    if (!opts.isAllowed(next)) {
      return {
        ok: false,
        status: 403,
        message: `跳转目标不在白名单：${hostnameOf(next)}`,
      };
    }
    current = next;
  }

  return { ok: false, status: 502, message: '重定向次数过多' };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return String(url).slice(0, 60);
  }
}

/** 从 HTML 中按 marker 后第一个 `{` 起做括号平衡，提取完整 JSON 字符串 */
export function extractBalancedJsonFrom(html: string, marker: string): string | null {
  const startIdx = html.indexOf(marker);
  if (startIdx < 0) return null;

  const eqIdx = html.indexOf('=', startIdx);
  if (eqIdx < 0) return null;

  const braceStart = html.indexOf('{', eqIdx);
  if (braceStart < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let quote = '';

  for (let i = braceStart; i < html.length; i++) {
    const ch = html[i];
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
      if (depth === 0) {
        return html.slice(braceStart, i + 1);
      }
    }
  }
  return null;
}
