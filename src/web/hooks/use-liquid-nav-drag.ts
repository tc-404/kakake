import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * 侧边栏「长按拖动切换」手势。
 *
 * 交互：按住某一项不动约 0.33s → 进入拖动态，液态指示条被「拎起来」跟着手指/鼠标
 * 上下滑，松手时落在哪一项就切到哪一项。进入拖动后位移会读指针速度算出挤压量
 * （竖向拉伸 + 横向收窄 + 圆角变鼓），并在跨项时溅出小水花，做出「拖一坨水」的观感。
 *
 * 两个刻意的实现选择：
 * 1. **60fps 的位置只改 DOM，不进 React state**。这个 hook 挂在 ConsoleShell 上，
 *    setState 会把整页（含当前页面内容）重渲染一遍，拖动必然掉帧。所以位置/挤压量
 *    都放在 ref 里、在 rAF 里直接写 style；只有「是否在拖」「悬停到第几项」这种
 *    低频变化才走 state。
 * 2. **拖动前先看有没有位移**。长按判定期间只要指针动了超过 MOVE_TOLERANCE 就取消——
 *    否则侧栏滚不动、普通点击也会被吃掉。
 */

export type NavFxKind = 'splash' | 'wet';
export type NavFx = { id: number; y: number; dir: -1 | 1; kind: NavFxKind };

type Rect = { top: number; left: number; width: number; height: number };

/** 停止态的位置（React 按当前激活项算出来的那份，每次渲染同步进来） */
export type NavRestBox = { top: number; left: number; width: number; height: number; ready: boolean };

/** 长按判定时长（ms） */
const LONG_PRESS_MS = 330;
/** 进入拖动前允许的位移（px）：超过就当成滚动 / 滑动，取消长按 */
const MOVE_TOLERANCE = 9;
/**
 * 弹簧参数：刚度调得比「点一下就滑过去」软一档，拖动时才有被水拖着的迟滞感。
 * 太小会变成拖不动。0.16 大约是一帧走一成半距离，让玻璃跟指针慢半拍、更有水感。
 */
const SPRING_K = 0.16;
const SPRING_DAMP = 0.66;
/** 拖尾（水花尾巴）用更软的弹簧，跟得慢半拍才像水 */
const TAIL_K = 0.12;
const TAIL_DAMP = 0.74;
/** 速度 → 挤压量的换算与上限 */
const SQUASH_PER_V = 0.013;
const SQUASH_MAX = 0.34;
/** 速度 → 内部水流位移的换算（每帧累加，做出「水在管子里流」的观感） */
const FLOW_PER_V = 2.4;
/** 松手后的回弹时长（ms）：要盖住 CSS 里那段 settle 过渡 */
const SETTLE_MS = 380;
/** 拖动中最多同时存在几个特效节点 */
const MAX_FX = 5;
/** 重力水滴：逐帧向下加速度，模拟被重力拉扯 */
const DRIP_GRAVITY = 0.34;
/** 重力水滴回拽到液体底部的弹簧 */
const DRIP_SPRING = 0.07;
/** 重力水滴速度阻尼 */
const DRIP_DAMP = 0.84;
/** 引力：液体中心朝指针 X 方向轻斜的最大偏移（px） */
const ATTRACT_MAX = 9;

export function useLiquidNavDrag(opts: {
  navRef: RefObject<HTMLElement | null>;
  /** 液态指示条本体 */
  liquidRef: RefObject<HTMLElement | null>;
  /** 拖尾水影（可选） */
  tailRef?: RefObject<HTMLElement | null>;
  /** 条内的「水流」层（可选）：拖动时按速度滚动，做出液体在流动的观感 */
  flowRef?: RefObject<HTMLElement | null>;
  /** 重力水滴（可选）：挂在液体底部，受重力下坠，经 gooey 与液体融合成水珠 */
  dripRef?: RefObject<HTMLElement | null>;
  /** 完整特效档：关闭时跳过重力水滴等装饰计算，配合低配档降级 */
  fullEffects?: boolean;
  /**
   * 停止态位置（可选）。**必须传**：松手动画结束后要把内联样式交还给 React，
   * 而 transform / width / height 是 React 在管的属性——直接清空的话 React 不会
   * 因为「值没变」而重新写回，指示条就失去定位与尺寸、整个消失，只有等下一次
   * 点击切换界面（box 变了）才会重新出现。所以这里按当前 resting 值写回去。
   */
  restBoxRef?: RefObject<NavRestBox>;
  itemCount: number;
  /**
   * 总开关。导航编辑模式下要关掉：那个模式下「按住拖动」是排序，
   * 两个手势抢同一个 pointerdown 会互相打断（拖到一半界面被切走）。
   */
  enabled?: boolean;
  /** 松手落在第 index 项时调用 */
  onCommit: (index: number) => void;
}): {
  dragging: boolean;
  hoverIndex: number | null;
  fx: NavFx[];
  bindItem: (index: number, el: HTMLElement | null) => void;
} {
  const { navRef, liquidRef, tailRef, flowRef, dripRef, restBoxRef, itemCount, fullEffects, onCommit, enabled = true } = opts;

  const [dragging, setDragging] = useState(false);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [fx, setFx] = useState<NavFx[]>([]);

  const itemsRef = useRef<(HTMLElement | null)[]>([]);
  const rectsRef = useRef<Rect[]>([]);
  const pressRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const settleRef = useRef<number | null>(null);
  const activeRef = useRef(false);
  const suppressClickRef = useRef(false);
  const rippleIdRef = useRef(0);
  /** 上一次推进模拟的时间：指针事件发现 rAF 迟迟没跑（帧被节流）时自己补一帧 */
  const lastTickRef = useRef(0);
  /** onCommit 每次渲染都会换身份，放 ref 里避免反复解绑/重绑监听 */
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  /** rAF 里读写的可变状态：位置 / 速度 / 挤压量 / 拖尾 / 内部水流 / 引力 / 重力水滴 */
  const sim = useRef({
    y: 0, vy: 0, tailY: 0, tailVy: 0, squash: 0, hover: -1,
    x: 0, w: 0, h: 0, max: 0, target: 0, flow: 0,
    pointerX: 0, attractX: 0, dripY: 0, dripVy: 0, dripS: 0,
  });

  const bindItem = useCallback((index: number, el: HTMLElement | null) => {
    itemsRef.current[index] = el;
    if (itemsRef.current.length < itemCount) itemsRef.current.length = itemCount;
  }, [itemCount]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || !enabled) return;

    const clearTimer = () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    /** 清掉移动端长按拖拽时可能残留的文字选中高亮（user-select:none 只能防新选中，清不掉已有的） */
    const clearSelection = () => {
      try {
        const sel = window.getSelection?.() ?? document.getSelection?.();
        if (sel && sel.rangeCount > 0) sel.removeAllRanges();
      } catch {
        /* 某些环境无 getSelection，忽略 */
      }
    };

    /** 采集各项（以及可拖动范围）在 nav 内容坐标系里的位置 */
    const measure = () => {
      const nr = nav.getBoundingClientRect();
      const rects: Rect[] = [];
      for (let i = 0; i < itemCount; i++) {
        const el = itemsRef.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        rects[i] = {
          top: r.top - nr.top + nav.scrollTop,
          left: r.left - nr.left + nav.scrollLeft,
          width: r.width,
          height: r.height,
        };
      }
      rectsRef.current = rects;
      const first = rects[0];
      const last = rects[rects.length - 1];
      sim.current.max = first && last ? last.top + last.height - first.height : 0;
    };

    const pushFx = (kind: NavFxKind, y: number, dir: -1 | 1, life: number) => {
      const id = ++rippleIdRef.current;
      setFx((prev) => [...prev.slice(-(MAX_FX - 1)), { id, y, dir, kind }]);
      // 动画结束就摘掉，避免节点堆积
      window.setTimeout(() => setFx((prev) => prev.filter((f) => f.id !== id)), life);
    };

    const paint = () => {
      const el = liquidRef.current;
      if (!el) return;
      const s = sim.current;
      const sq = s.squash;
      // 挤压：竖向拉伸、横向收窄（近似体积守恒），圆角跟着变鼓；
      // attractX 让液体中心朝指针 X 方向轻斜，做出「被吸引」的引力感
      el.style.transform = `translate3d(${s.x + s.attractX}px, ${s.y}px, 0) scale(${1 - sq * 0.34}, ${1 + sq})`;
      el.style.borderRadius = `${15 + sq * 14}px`;
      // 内部水流：按速度滚动条纹，做出「液体在被带动」的观感
      const flow = flowRef?.current;
      if (flow) flow.style.transform = `translate3d(0, ${s.flow}px, 0)`;
      const tail = tailRef?.current;
      if (tail) {
        tail.style.transform = `translate3d(${s.x + s.attractX * 0.6 + s.w * 0.12}px, ${s.tailY}px, 0) scale(${1 - sq * 0.2}, ${1 + sq * 0.9})`;
        tail.style.opacity = String(Math.min(0.55, 0.16 + sq * 0.9));
      }
      // 重力水滴：挂在液体底部，随向下速度被拉大，经 gooey 与液体融成一颗将滴未滴的水珠
      const drip = dripRef?.current;
      if (drip) {
        if (!fullEffects) {
          drip.style.opacity = '0';
        } else {
          const size = Math.max(0, s.dripS) * s.h * 0.5;
          const cx = s.x + s.attractX + s.w / 2;
          drip.style.opacity = String(Math.min(0.95, s.dripS));
          drip.style.transform = `translate3d(${cx - size / 2}px, ${s.dripY - size / 2}px, 0)`;
          drip.style.width = `${size}px`;
          drip.style.height = `${size}px`;
        }
      }
    };

    /** 指针位置 → 中心离它最近的那一项 */
    const hoverAt = (centerY: number) => {
      const rects = rectsRef.current;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (!r) continue;
        const d = Math.abs(r.top + r.height / 2 - centerY);
        if (d < bestD) { bestD = d; best = i; }
      }
      return best;
    };

    /** 推进一帧模拟并落笔。rAF 与 pointermove 都会调它 */
    const step = () => {
      const s = sim.current;
      // 主液体：弹簧跟随
      s.vy = s.vy * SPRING_DAMP + (s.target - s.y) * SPRING_K;
      s.y += s.vy;
      // 拖尾：更软的弹簧
      s.tailVy = s.tailVy * TAIL_DAMP + (s.y - s.tailY) * TAIL_K;
      s.tailY += s.tailVy;
      // 内部水流：按速度累加位移（条纹周期会自然循环，不需要取模）
      s.flow += s.vy * FLOW_PER_V;
      // 速度 → 挤压量（带一点平滑，免得抖）
      const want = Math.min(SQUASH_MAX, Math.abs(s.vy) * SQUASH_PER_V);
      s.squash += (want - s.squash) * 0.34;
      // 引力：液体中心朝指针 X 方向轻斜（被吸引，幅度收敛在 ATTRACT_MAX 内）
      const targetAttract = Math.max(-ATTRACT_MAX, Math.min(ATTRACT_MAX, (s.pointerX - (s.x + s.w / 2)) * 0.4));
      s.attractX += (targetAttract - s.attractX) * 0.1;
      // 重力水滴：受重力下坠、被弹簧拽回液体底部，向下速度越大拉得越长
      if (fullEffects) {
        const liquidBottom = s.y + s.h;
        s.dripVy = s.dripVy * DRIP_DAMP + DRIP_GRAVITY + (liquidBottom - s.dripY) * DRIP_SPRING;
        s.dripY += s.dripVy;
        const wantDrip = Math.min(1, 0.35 + Math.max(0, s.vy) * 0.05);
        s.dripS += (wantDrip - s.dripS) * 0.18;
      }
      paint();
      // 悬停项按**指针目标位置**算，不看平滑后的 y —— 松手落点才跟手
      const best = hoverAt(s.target + s.h / 2);
      if (best >= 0 && best !== s.hover) {
        const down = best > s.hover;
        const rect = rectsRef.current[best];
        // 水花：朝行进方向从液体边缘溅出去
        pushFx('splash', s.y + s.h / 2, down ? 1 : -1, 700);
        // 湿痕：刚经过的那一项留一道会「干」掉的痕迹
        pushFx('wet', rect ? rect.top + rect.height / 2 : best * 48, down ? 1 : -1, 1000);
        s.hover = best;
        setHoverIndex(best);
      }
      lastTickRef.current = performance.now();
    };

    const loop = () => {
      step();
      rafRef.current = requestAnimationFrame(loop);
    };

    const startDrag = (pointerId: number) => {
      clearSelection();
      measure();
      const s = sim.current;
      const rects = rectsRef.current;
      const cur = rects[0];
      if (!cur) return;
      s.h = cur.height;
      s.w = cur.width;
      s.x = cur.left;
      // 从指针当前位置起步，不要从上一项「飞」过来
      const nr = nav.getBoundingClientRect();
      const startY = (pressRef.current?.y ?? nr.top) - nr.top + nav.scrollTop - s.h / 2;
      s.y = startY;
      s.tailY = startY;
      s.vy = 0;
      s.tailVy = 0;
      s.squash = 0;
      s.flow = 0;
      s.attractX = 0;
      s.pointerX = s.x + s.w / 2;
      s.dripY = startY + s.h;
      s.dripVy = 0;
      s.dripS = 0.4;
      s.target = Math.max(0, Math.min(s.max, startY));
      s.y = s.target;
      s.tailY = s.target;
      // 落点从一开始就按指针位置定：长按后原地松手 = 切到按住的那一项
      s.hover = hoverAt(s.target + s.h / 2);
      activeRef.current = true;
      suppressClickRef.current = true;
      // 拖动期间关掉 CSS 过渡，位置完全由 rAF 接管
      const el = liquidRef.current;
      if (el) el.style.transition = 'none';
      const tail = tailRef?.current;
      if (tail) {
        tail.style.transition = 'none';
        tail.style.width = `${s.w * 0.66}px`;
        tail.style.height = `${s.h}px`;
      }
      paint();
      setDragging(true);
      setHoverIndex(null);
      // 触感（支持的设备才有）
      try { navigator.vibrate?.(12); } catch { /* 忽略 */ }
      rafRef.current = requestAnimationFrame(loop);
      // 指针捕获：手指划出侧栏也继续跟
      try { nav.setPointerCapture(pointerId); } catch { /* 忽略 */ }
    };

    const endDrag = (commit: boolean) => {
      if (!activeRef.current) return;
      activeRef.current = false;
      clearSelection();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      const s = sim.current;
      const rects = rectsRef.current;
      const idx = commit ? s.hover : -1;
      const rest = restBoxRef?.current;
      // 落点：提交就用松手时那一项，取消就回到当前激活项
      const drop = rects[idx] ?? (rest?.ready ? { top: rest.top, left: rest.left, width: rest.width, height: rest.height } : undefined);
      const el = liquidRef.current;
      const tail = tailRef?.current;
      if (el && drop) {
        // 松手：把挤压量揉回去、落到该项上，走一段带回弹的过渡
        el.style.transition = `transform calc(${SETTLE_MS}ms * var(--kk-motion)) cubic-bezier(0.34, 1.46, 0.64, 1), border-radius calc(${SETTLE_MS}ms * var(--kk-motion)) ease-out`;
        el.style.transform = `translate3d(${drop.left}px, ${drop.top}px, 0) scale(1, 1)`;
        el.style.borderRadius = '15px';
        if (tail) {
          tail.style.transition = `transform calc(${SETTLE_MS}ms * var(--kk-motion)) ease-out, opacity calc(${SETTLE_MS}ms * var(--kk-motion)) ease-out`;
          tail.style.transform = `translate3d(${drop.left + drop.width * 0.12}px, ${drop.top}px, 0) scale(1, 1)`;
          tail.style.opacity = '0';
        }
        // 重力水滴：松手后坠落一段并淡出，做出「水滴挣脱滴落」的收尾
        const dripNode = dripRef?.current;
        if (dripNode && fullEffects) {
          const size = Math.max(0, s.dripS) * s.h * 0.5;
          const cx = s.x + s.w / 2;
          dripNode.style.transition = `transform calc(${SETTLE_MS}ms * var(--kk-motion)) cubic-bezier(0.3, 0.7, 0.35, 1), opacity calc(${SETTLE_MS}ms * var(--kk-motion)) ease-in`;
          dripNode.style.transform = `translate3d(${cx - size / 2}px, ${s.dripY - size / 2 + s.h * 1.05}px, 0) scale(0.55)`;
          dripNode.style.opacity = '0';
        }
        if (idx >= 0) {
          pushFx('splash', drop.top + drop.height / 2, 1, 700);
          pushFx('wet', drop.top + drop.height / 2, 1, 1000);
        }
      }
      setDragging(false);
      setHoverIndex(null);
      /*
       * 过渡跑完把内联样式交还给 React。
       *
       * transform / width / height 是 React 在管的属性，**不能直接清空**：
       * React 只在「属性值变了」时才写 DOM，清空后它不会重新写回，
       * 指示条就失去定位与尺寸、整个消失——表现为「拖动切换后玻璃不见了，
       * 必须手动点一次别的项（box 变了）才回来」。
       * 所以这里按当前 resting 值写回去，与 React 的预期完全一致。
       */
      if (settleRef.current !== null) clearTimeout(settleRef.current);
      settleRef.current = window.setTimeout(() => {
        settleRef.current = null;
        // 重新读一次：这段时间里界面已经切过去了，resting 值是新的
        const restNow = restBoxRef?.current;
        const liquid = liquidRef.current;
        if (liquid) {
          liquid.style.transition = '';
          liquid.style.borderRadius = '';
          if (restNow?.ready) {
            liquid.style.transform = `translate3d(${restNow.left}px, ${restNow.top}px, 0)`;
            liquid.style.width = `${restNow.width}px`;
            liquid.style.height = `${restNow.height}px`;
          }
        }
        // 拖尾的 transform / 尺寸本来就不归 React 管，直接清掉即可
        const tailNode = tailRef?.current;
        if (tailNode) {
          tailNode.style.transition = '';
          tailNode.style.transform = '';
          tailNode.style.opacity = '';
          tailNode.style.width = '';
          tailNode.style.height = '';
        }
        const flowNode = flowRef?.current;
        if (flowNode) flowNode.style.transform = '';
        // 水滴的 transform / 尺寸 / 透明度本来就不归 React 管，直接清掉即可
        const dripNode2 = dripRef?.current;
        if (dripNode2) {
          dripNode2.style.transition = '';
          dripNode2.style.transform = '';
          dripNode2.style.opacity = '';
          dripNode2.style.width = '';
          dripNode2.style.height = '';
        }
      }, SETTLE_MS + 80);
      // 之后的这一次 click 是「松手」产生的，不该再当成点击导航
      window.setTimeout(() => { suppressClickRef.current = false; }, 320);
      if (idx >= 0) commitRef.current(idx);
      try { navigator.vibrate?.(8); } catch { /* 忽略 */ }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (activeRef.current || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (!target?.closest('[data-nav-index]')) return;
      pressRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        startDrag(pressRef.current?.pointerId ?? e.pointerId);
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      const press = pressRef.current;
      if (!activeRef.current) {
        // 还没进拖动：位移超阈值就撤销长按（这一下是滚动或普通滑动）
        if (!press) return;
        if (Math.abs(e.clientX - press.x) > MOVE_TOLERANCE || Math.abs(e.clientY - press.y) > MOVE_TOLERANCE) {
          clearTimer();
          pressRef.current = null;
        }
        return;
      }
      const s = sim.current;
      const nr = nav.getBoundingClientRect();
      const y = e.clientY - nr.top + nav.scrollTop - s.h / 2;
      s.target = Math.max(0, Math.min(s.max, y));
      s.pointerX = e.clientX - nr.left + nav.scrollLeft;
      // 正常情况下位置由 rAF 逐帧推进；帧被节流时（后台标签、无头环境）rAF 可能一直不触发，
      // 这里自己补一帧，保证拖动手势在任何环境下都还成立。
      if (performance.now() - lastTickRef.current > 40) step();
    };

    const onPointerUp = (e: PointerEvent) => {
      clearTimer();
      pressRef.current = null;
      if (!activeRef.current) return;
      e.preventDefault();
      /*
       * 松手前按**最终指针位置**再推一帧。
       *
       * 指针事件和 rAF 不同步：最后一次 pointermove 可能因为节流没推进模拟
       * （补帧的那个 40ms 判断也可能刚好不满足），这时 s.hover 还停在上一格，
       * 直接读它就会「差一项」。这里强制重算一次，落点永远等于松手位置。
       */
      const s = sim.current;
      const nr = nav.getBoundingClientRect();
      s.target = Math.max(0, Math.min(s.max, e.clientY - nr.top + nav.scrollTop - s.h / 2));
      step();
      try { nav.releasePointerCapture(e.pointerId); } catch { /* 忽略 */ }
      endDrag(true);
    };

    const onPointerCancel = () => {
      clearTimer();
      pressRef.current = null;
      suppressClickRef.current = false;
      endDrag(false);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (activeRef.current) {
        suppressClickRef.current = false;
        endDrag(false);
      } else {
        clearTimer();
        pressRef.current = null;
      }
    };

    /** 拖动中要吃掉松手那一下产生的 click，否则会跳两次 */
    const onClickCapture = (e: MouseEvent) => {
      if (!suppressClickRef.current) return;
      e.preventDefault();
      e.stopPropagation();
    };

    /** 触摸：进拖动后禁止页面跟着滚（touch-action 是手势开始时定的，改不动，只能这么挡） */
    const onTouchMove = (e: TouchEvent) => {
      if (!activeRef.current) return;
      if (e.cancelable) e.preventDefault();
    };

    /** 长按在移动端会弹上下文菜单 / 选中文字 */
    const onContextMenu = (e: Event) => {
      if (!activeRef.current && timerRef.current === null) return;
      e.preventDefault();
    };

    nav.addEventListener('pointerdown', onPointerDown);
    // pointermove 挂 window 而不是 nav：长按判定期间指针滑出侧栏也要能判定「这是滑动」
    window.addEventListener('pointermove', onPointerMove);
    nav.addEventListener('pointerup', onPointerUp);
    nav.addEventListener('pointercancel', onPointerCancel);
    nav.addEventListener('click', onClickCapture, true);
    nav.addEventListener('touchmove', onTouchMove, { passive: false });
    nav.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerup', onPointerUp);

    return () => {
      clearTimer();
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (settleRef.current !== null) clearTimeout(settleRef.current);
      nav.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      nav.removeEventListener('pointerup', onPointerUp);
      nav.removeEventListener('pointercancel', onPointerCancel);
      nav.removeEventListener('click', onClickCapture, true);
      nav.removeEventListener('touchmove', onTouchMove);
      nav.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [navRef, liquidRef, tailRef, flowRef, dripRef, restBoxRef, itemCount, fullEffects, enabled]);

  return { dragging, hoverIndex, fx, bindItem };
}
