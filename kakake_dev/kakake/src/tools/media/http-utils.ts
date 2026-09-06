// ---------------------------------------------------------------------------
// 视频解析 API 共用 HTTP 工具（本地 lib/api 模块）
// ---------------------------------------------------------------------------

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36';

export const EDGE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';

export async function fetchText(
  url: string,
  init: RequestInit = {},
  userAgent = DEFAULT_USER_AGENT,
): Promise<string> {
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', userAgent);
  }

  const res = await fetch(url, {
    ...init,
    headers,
    redirect: init.redirect ?? 'follow',
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  return res.text();
}

/** 跟随重定向，返回最终 URL */
export async function followRedirect(
  url: string,
  userAgent = DEFAULT_USER_AGENT,
): Promise<string> {
  const res = await fetch(url, {
    method: 'GET',
    redirect: 'follow',
    headers: { 'User-Agent': userAgent },
  });
  return res.url || url;
}

/** 清理 URL 末尾非法字符 */
export function cleanUrlTail(url: string): string {
  return url.replace(/[^\w\-./?=&:#]+$/u, '');
}

/** 域名白名单校验（防 SSRF） */
export function isAllowedDomain(url: string, allowedDomains: string[]): boolean {
  const cleaned = cleanUrlTail(url);
  return allowedDomains.some((allowed) =>
    new RegExp(`https?://[^/]*${allowed.replace(/\./g, '\\.')}`, 'i').test(cleaned),
  );
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
