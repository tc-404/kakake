import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';

export type LiquidBox = {
  top: number;
  left: number;
  width: number;
  height: number;
  ready: boolean;
};

/** 测量激活项相对导航容器的位置，驱动液态指示条滑动 */
export function useLiquidIndicator(
  activeIndex: number,
  itemCount: number,
  /** 额外依赖：计数角标变化等导致项宽变化时强制重测 */
  layoutKey?: string | number,
): {
  navRef: RefObject<HTMLElement | null>;
  setItemRef: (index: number, el: HTMLElement | null) => void;
  box: LiquidBox;
} {
  const navRef = useRef<HTMLElement | null>(null);
  const itemsRef = useRef<(HTMLElement | null)[]>([]);
  const [box, setBox] = useState<LiquidBox>({
    top: 0,
    left: 0,
    width: 0,
    height: 0,
    ready: false,
  });

  const setItemRef = useCallback((index: number, el: HTMLElement | null) => {
    itemsRef.current[index] = el;
  }, []);

  const update = useCallback(() => {
    const nav = navRef.current;
    const el = itemsRef.current[activeIndex];
    if (!nav || !el) return;

    const nr = nav.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    setBox({
      top: er.top - nr.top + nav.scrollTop,
      left: er.left - nr.left + nav.scrollLeft,
      width: er.width,
      height: er.height,
      ready: true,
    });
  }, [activeIndex]);

  useLayoutEffect(() => {
    if (itemsRef.current.length < itemCount) {
      itemsRef.current.length = itemCount;
    }
    update();
  }, [update, itemCount, activeIndex, layoutKey]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const ro = new ResizeObserver(() => update());
    ro.observe(nav);
    for (const el of itemsRef.current) {
      if (el) ro.observe(el);
    }

    window.addEventListener('resize', update);
    nav.addEventListener('scroll', update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
      nav.removeEventListener('scroll', update);
    };
  }, [update, itemCount, layoutKey]);

  return { navRef, setItemRef, box };
}
