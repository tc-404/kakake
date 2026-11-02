/**
 * 外链协议白名单（XSS 防线）：只放行 http/https/mailto/tel 与 # 锚点，
 * 其它协议（javascript:/data:/vbscript:/file: 等）返回 null。
 * 调用方拿不到 href 时渲染纯文本，不要因此隐藏整块内容。
 */

const SAFE_SCHEME_RE = /^(https?|mailto|tel):/i;

/** 归一化后再判：去掉首尾空白与控制字符，防止 `java\tscript:` 之类绕过 */
function normalize(url: string): string {
  return url.replace(/[\u0000-\u0020]/g, '').trim();
}

/**
 * 判断一个 URL 是否可以安全地放进 `href`。
 * @returns 可安全使用的 URL；不可用时返回 null
 */
export function safeHref(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = normalize(raw);
  if (!url) return null;

  // 站内锚点、相对路径与协议相对 URL：不涉及显式协议，原样放行
  // （协议相对 URL 由浏览器继承当前页协议，内网 http 部署也不会被强行跳 https）
  if (
    url.startsWith('#')
    || url.startsWith('/')
    || url.startsWith('./')
    || url.startsWith('../')
  ) {
    return raw.trim();
  }

  if (SAFE_SCHEME_RE.test(url)) return raw.trim();

  return null;
}
