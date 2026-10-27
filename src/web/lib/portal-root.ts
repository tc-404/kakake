/**
 * 所有 React Portal 的统一挂载点（#kk-portal-root）。
 * 多个 Portal 直接挂 body 会与 React 宿主容器争抢 insertBefore 参照，导致整屏崩溃。
 * 该容器保持无 position/z-index/transform，不能创建层叠上下文。
 */
let cached: HTMLElement | null = null;

export function getPortalRoot(): HTMLElement {
  if (typeof document === 'undefined') {
    // SSR / 非浏览器环境兜底：理论上不会走到这里（本项目是纯客户端 SPA）
    throw new Error('getPortalRoot: document is not available');
  }
  if (cached && document.body.contains(cached)) return cached;
  const existing = document.getElementById('kk-portal-root');
  if (existing) {
    cached = existing;
    return cached;
  }
  const el = document.createElement('div');
  el.id = 'kk-portal-root';
  document.body.appendChild(el);
  cached = el;
  return el;
}
