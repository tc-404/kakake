/**
 * 外链协议白名单（前端侧 XSS 防线）。
 *
 * 背景：模拟消息里的卡片链接（`jump_url` / `url` / `qqdocurl` / `#METAURL#`）与
 * NativeMarkdown 的 `[文本](链接)` 都是**协议端/插件可控的字符串**。若直接塞进
 * `href`，`javascript:` 之类的协议会被浏览器执行——而同源执行意味着能读到会话
 * Cookie、以管理台身份调任意 `/api`。
 *
 * 这里与 `components/markdown-content.tsx` 的 `MarkdownLink` 保持同一套口径，
 * 只是抽出来给模拟消息的几处卡片复用（此前那几处各自 `<a href={...}>`，
 * 没有这一步校验）。
 *
 * 白名单口径（宁少勿多）：
 *   - `http:` / `https:`  → 可点，新窗口打开
 *   - `mailto:` / `tel:`  → 可点，同窗口
 *   - `#...`              → 站内锚点，可点
 *   - 其它一切协议        → 不可点（`javascript:` / `data:` / `vbscript:` / `file:` …）
 *
 * 注意「返回 null 表示不可点」这个约定：调用方应退化为渲染纯文本或不可点的
 * 容器，**不要**因为拿不到 href 就把整块内容藏掉——那会让正常卡片因为一个
 * 奇怪链接而消失，属于用可用性换安全性，反而不利于发现异常数据。
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
