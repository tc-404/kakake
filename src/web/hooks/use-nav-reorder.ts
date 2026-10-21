import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 侧边栏导航「拖拽排序」手势（仅在编辑模式下启用）。
 *
 * 两档表现，跟着设备档位走：
 * - **完整特效**：被拖的那一枚跟手位移 + 抬起来（放大 / 加深投影 / 微微倾斜），
 *   其余项用 FLIP 动画平滑让位——顺序是实时预览的，手指到哪它们就挪到哪，
 *   松手即定稿。
 * - **低配**：不做实时重排（每帧重排 + 动画在小机上会掉帧），只在目标落点画一条
 *   插入线，松手时才真正换位。
 *
 * 位置只写 DOM、不进 React state：这个 hook 挂在 ConsoleShell 上，每一次 setState
 * 都会把整页（含当前界面内容）重渲染一遍，拖动必然掉帧。只有「拖到第几项」这种
 * 低频变化才走 state。
 */

/** 进入拖动前允许的位移（px）：低于它算点击，不算拖 */
const MOVE_TOLERANCE = 5;

type DragState = {
  href: string;
  pointerId: number;
  startX: number;
  startY: number;
  /** 按下点在被拖项内部的纵向偏移，保证拖动时不会「跳」到指针位置 */
  grabOffset: number;
  /** 当前写进 transform 的位移，用来反推元素未变换时的布局位置 */
  translate: number;
  active: boolean;
  raf: number | null;
  pointerY: number;
  /** 低配档已经画出来的那条插入线所在槽位，避免重复 setState */
  insertMark?: number;
};

export function useNavReorder(opts: {
  /** 仅编辑模式下启用 */
  enabled: boolean;
  /** 当前可见项的路径顺序 */
  items: string[];
  /** 完整特效档：实时重排 + FLIP 让位；低配档只画插入线 */
  fullEffects: boolean;
  /** 顺序变化（完整档实时预览 / 低配档松手落定） */
  onReorder: (next: string[]) => void;
}): {
  /** 正在被拖的路径 */
  dragHref: string | null;
  /** 低配档的插入落点（0..n），null = 没在拖 */
  dropIndex: number | null;
  bindItem: (href: string, el: HTMLElement | null) => void;
  /** 挂在每一项的 onPointerDown 上 */
  startDrag: (href: string, e: React.PointerEvent) => void;
} {
  const { enabled, items, fullEffects, onReorder } = opts;

  const [dragHref, setDragHref] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const refs = useRef(new Map<string, HTMLElement>());
  const drag = useRef<DragState | null>(null);
  // 每次渲染同步，避免把 hook 的回调做成 effect 依赖导致反复解绑/重绑
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;
  const fullRef = useRef(fullEffects);
  fullRef.current = fullEffects;
  /** FLIP 用：上一次布局里每一项的纵向位置（offsetTop，不受 transform 影响） */
  const tops = useRef(new Map<string, number>());

  const bindItem = useCallback((href: string, el: HTMLElement | null) => {
    if (el) refs.current.set(href, el);
    else refs.current.delete(href);
  }, []);

  /** 指针 y 落在第几个槽位（按「去掉被拖项后」的数法） */
  const insertIndexAt = useCallback((pointerY: number, dragging: string): number => {
    let insert = 0;
    for (const href of itemsRef.current) {
      if (href === dragging) continue;
      const el = refs.current.get(href);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (pointerY > r.top + r.height / 2) insert += 1;
    }
    return insert;
  }, []);

  /** 把被拖项从当前顺序里取出，插到 insert 处 */
  const moved = useCallback((list: string[], href: string, insert: number): string[] => {
    const rest = list.filter((h) => h !== href);
    const at = Math.max(0, Math.min(rest.length, insert));
    return [...rest.slice(0, at), href, ...rest.slice(at)];
  }, []);

  const finish = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    if (d.raf !== null) cancelAnimationFrame(d.raf);
    const el = refs.current.get(d.href);
    if (el) {
      el.style.transform = '';
      el.style.zIndex = '';
      el.style.transition = '';
    }
    drag.current = null;
    setDragHref(null);
    setDropIndex(null);
  }, []);

  const startDrag = useCallback((href: string, e: React.PointerEvent) => {
    if (!enabled) return;
    if (e.button !== undefined && e.button !== 0) return;
    const el = refs.current.get(href);
    if (!el) return;
    const r = el.getBoundingClientRect();
    drag.current = {
      href,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabOffset: e.clientY - r.top,
      translate: 0,
      active: false,
      raf: null,
      pointerY: e.clientY,
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      d.pointerY = e.clientY;

      if (!d.active) {
        const far = Math.abs(e.clientY - d.startY) > MOVE_TOLERANCE
          || Math.abs(e.clientX - d.startX) > MOVE_TOLERANCE;
        if (!far) return;
        d.active = true;
        setDragHref(d.href);
        // 拖起来：抬升 + 轻微放大，读起来像被拎出列表
        const el = refs.current.get(d.href);
        if (el) {
          el.style.zIndex = '30';
          el.style.transition = 'box-shadow 160ms ease, transform 0ms';
        }
      }

      // 移动端按住拖动时别让侧栏跟着滚
      if (e.cancelable) e.preventDefault();

      if (d.raf === null) {
        d.raf = requestAnimationFrame(() => {
          d.raf = null;
          const cur = drag.current;
          if (!cur) return;
          const el = refs.current.get(cur.href);
          if (!el) return;
          // 未变换时的布局位置 = 当前视觉位置 - 上次写进去的位移
          const layoutTop = el.getBoundingClientRect().top - cur.translate;
          const next = cur.pointerY - cur.grabOffset - layoutTop;
          cur.translate = next;
          el.style.transform = `translate3d(0, ${next}px, 0) scale(1.03)`;

          const insert = insertIndexAt(cur.pointerY, cur.href);
          const list = itemsRef.current;
          const from = list.indexOf(cur.href);
          if (fullRef.current) {
            // 完整档：实时预览重排，其余项靠 FLIP 平滑让位
            const nextList = moved(list, cur.href, insert);
            if (nextList.join('|') !== list.join('|')) onReorderRef.current(nextList);
          } else if (insert !== cur.insertMark) {
            // 低配档：只挪那条插入线
            cur.insertMark = insert;
            setDropIndex(insert);
          }
        });
      }
    };

    const onUp = (e: PointerEvent) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.pointerId) return;
      if (!d.active) {
        drag.current = null;
        return;
      }
      const insert = insertIndexAt(d.pointerY, d.href);
      const list = itemsRef.current;
      const nextList = moved(list, d.href, insert);
      const changed = nextList.join('|') !== list.join('|');
      finish();
      if (changed) onReorderRef.current(nextList);
    };

    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      finish();
    };
  }, [enabled, finish, insertIndexAt, moved]);

  /**
   * FLIP：顺序变化后让其余项从「上一次的位置」滑到新位置。
   * 用 offsetTop（不受 transform 影响）而不是 getBoundingClientRect，
   * 否则读到的是动画中间态，连续拖拽会越抖越厉害。
   */
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    for (const [href, el] of refs.current) {
      next.set(href, el.offsetTop);
    }
    if (fullEffects) {
      for (const [href, el] of refs.current) {
        if (href === dragHref) continue;
        const before = tops.current.get(href);
        const now = next.get(href) ?? 0;
        if (before === undefined || Math.abs(before - now) < 1) continue;
        el.animate(
          [{ transform: `translateY(${before - now}px)` }, { transform: 'translateY(0)' }],
          { duration: 200, easing: 'cubic-bezier(0.32,0.72,0,1)' },
        );
      }
    }
    tops.current = next;
  }, [items.join('|'), dragHref, fullEffects]);

  return { dragHref, dropIndex, bindItem, startDrag };
}
