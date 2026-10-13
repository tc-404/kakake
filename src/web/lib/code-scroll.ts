/** 代码块滚动穿透：内层滚到顶 / 底后，把滚轮交还给页面，避免滚动被"卡"在代码块里 */
function resolvePageScrollEl(from: HTMLElement): HTMLElement {
  const marked = from.closest('[data-kk-page-scroll]');
  if (marked instanceof HTMLElement) return marked;
  const doc = document.scrollingElement;
  if (doc instanceof HTMLElement) return doc;
  return document.documentElement;
}

/**
 * 绑定滚动穿透，返回解绑函数。
 * 用法：useEffect(() => bindCodeScrollPassthrough(el), [])
 */
export function bindCodeScrollPassthrough(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent) => {
    const dy = e.deltaY;
    if (dy === 0) return;

    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

    // 未到顶 / 底：交给代码块自己滚
    if ((dy < 0 && !atTop) || (dy > 0 && !atBottom)) return;

    // 到顶继续上滚 / 到底继续下滚：带动页面
    const page = resolvePageScrollEl(el);
    page.scrollTop += dy;
    e.preventDefault();
  };

  el.addEventListener('wheel', onWheel, { passive: false });
  return () => el.removeEventListener('wheel', onWheel);
}
