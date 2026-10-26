/**
 * 所有 React Portal 的统一挂载容器。
 *
 * 为什么要有它、而不是直接 portal 到 document.body？
 *
 * `#root` 是 React 的「宿主容器」（createRoot 的目标）。原本 AppToaster（toast）、
 * 准星光标、各弹窗遮罩都各自 `createPortal(children, document.body)`。于是同一个
 * React root 既要在 #root 里提交，又要把多个 Portal 子树插进 **同一个 document.body**
 * （#root 本身也是 body 的子节点）。
 *
 * 这种「多个 Portal 同时指向与宿主容器同级的 body」写法，会让 React 在提交阶段
 * 计算 insertBefore 的参照节点时彼此干扰：一次 Portal 子树插入/移除后，另一次
 * Portal 用的 beforeChild 参照就不再是 body 的直接子节点了，于是抛出
 * 「NotFoundError: Failed to execute 'insertBefore' on 'Node': The node before which
 * the new node is to be inserted is not a child of this node」，进而整屏白屏
 * （PageErrorBoundary 捕获到的 “This page failed to load”）。
 *
 * 解决办法：把所有 Portal 收敛到这一个「纯净容器」——它既不是 React 宿主、也绝不会被
 * React 之外的逻辑改动。body 下只剩 #root 与 #kk-portal-root 两个子节点，而
 * #kk-portal-root 内部的所有 Portal 子树由 React 自洽管理，彻底消除这类协调崩溃。
 *
 * 该 div 故意保持「纯静态」：不设 position/z-index/opacity/transform/isolation，
 * 因此它自身不创建 stacking context，内部 `position: fixed` 的弹窗仍相对视口定位，
 * 层级表现与原来直接挂 body 完全一致。
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
