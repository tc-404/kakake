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
    ta.style.left = '0';
    ta.style.top = '0';
    ta.style.width = '1px';
    ta.style.height = '1px';
    ta.style.padding = '0';
    ta.style.border = '0';
    ta.style.opacity = '0';
    ta.style.pointerEvents = 'none';
    // Radix Dialog（modal）带焦点陷阱：把 textarea 直接插到 body 时，focus 会被
    // 立即抢回弹窗，execCommand 复制到空选区，表现为「点了没反应」。这里把它插到
    // 当前焦点所在的弹窗容器内（非弹窗场景退回 body），textarea 就始终在可聚焦范围内。
    const active = document.activeElement;
    const host = active instanceof HTMLElement
      ? active.closest('[role="dialog"], [data-radix-dialog-content]')
      : null;
    (host ?? document.body).appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    ta.remove();
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
