/** 复制到剪贴板：兼容 HTTP / 无 clipboard API 的环境 */
export async function copyToClipboard(text: string): Promise<boolean> {
  const value = String(text ?? '');
  if (!value) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through */
  }

  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (ok) return true;
  } catch {
    /* fall through */
  }

  // 最后兜底：弹出可选中文本，便于手动 Ctrl+C（HTTP 非安全上下文常见）
  try {
    window.prompt('复制失败，请手动全选并复制：', value);
    return true;
  } catch {
    return false;
  }
}
