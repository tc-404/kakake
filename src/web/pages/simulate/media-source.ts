/** 把 OB11 媒体段的 file/url 解析成浏览器可加载的地址 */

/** data:base64 / http(s) 直接用；base64 裸串补前缀；本地路径 / file:// 走 asset 代理 */
export function resolveMediaSrc(
  raw: unknown,
  fallbackMime = 'image/png',
): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;

  if (s.startsWith('data:')) return s;
  if (s.startsWith('http://') || s.startsWith('https://')) return s;

  // base64:// 前缀（NapCat 常见）
  if (s.startsWith('base64://')) {
    return `data:${fallbackMime};base64,${s.slice('base64://'.length)}`;
  }
  // 裸 base64（较长且只含 base64 字符）
  if (s.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(s)) {
    return `data:${fallbackMime};base64,${s.replace(/\s+/g, '')}`;
  }

  // file:// 或本地绝对/相对路径 → 代理
  let p = s;
  if (p.startsWith('file://')) {
    try { p = new URL(p).pathname; } catch { /* keep */ }
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
  }
  return `/api/simulate/asset?p=${encodeURIComponent(p)}`;
}

/** 归一化 message 字段：string(CQ 码或纯文本) / 段数组 / 单段 → 段数组 */
export interface Seg { type: string; data: Record<string, unknown> }

export function normalizeMessage(message: unknown): Seg[] {
  if (Array.isArray(message)) {
    return message
      .filter((m): m is Seg => !!m && typeof m === 'object' && 'type' in (m as object))
      .map((m) => ({ type: String((m as Seg).type), data: (m as Seg).data ?? {} }));
  }
  if (message && typeof message === 'object' && 'type' in (message as object)) {
    const m = message as Seg;
    return [{ type: String(m.type), data: m.data ?? {} }];
  }
  if (typeof message === 'string') {
    return parseCqString(message);
  }
  return [];
}

/** 解析 CQ 码字符串为段数组（文本 + [CQ:...] 混排） */
export function parseCqString(text: string): Seg[] {
  const segs: Seg[] = [];
  const re = /\[CQ:([a-zA-Z]+)((?:,[^\]]*?)?)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segs.push({ type: 'text', data: { text: unescapeCq(text.slice(last, m.index)) } });
    }
    const type = m[1];
    const data: Record<string, unknown> = {};
    const params = m[2] ? m[2].slice(1).split(',') : [];
    for (const kv of params) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = unescapeCq(kv.slice(i + 1));
    }
    segs.push({ type, data });
    last = re.lastIndex;
  }
  if (last < text.length) {
    segs.push({ type: 'text', data: { text: unescapeCq(text.slice(last)) } });
  }
  return segs.length ? segs : [{ type: 'text', data: { text } }];
}

function unescapeCq(s: string): string {
  return s
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}
