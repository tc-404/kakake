import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot } from '@/lib/portal-root';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Compass,
  Lightbulb,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { closeConnDialog, closeSimConfig, suppressTourEscape } from './product-tour-dom';
import { STEPS } from './product-tour-steps';
import { isEditableElement, setTourActive } from '@/lib/tour-state';

/* ------------------------------------------------------------------ *
 *  产品导览（Product Tour）
 *  - 首次设置密码后进入控制台强制弹出（刷新不消失，直到「跳过」或「完成」）
 *  - 逐步高亮目标、说明内容并显示进度，允许自动跳转页面
 *  - 同一套步骤兼容手机端与电脑端 UI（按 data-tour 选中当前可见的元素）
 * ------------------------------------------------------------------ */

/**
 * 看过标记。
 * 内容有较大更新时往上推一版，好让看过旧版的人也能看到新的。
 * v5：补设置页后半段七步（水印 / 背景预设 / 资源官网 / GitHub Token / 语言 / 登录防护 / 图片引擎）、
 *     高亮框在步骤激活期间持续贴合目标（弹窗动画 / 列表加载后不再错位）。
 */
const TOUR_KEY = 'kk-product-tour-v5';
/** 手动触发（设置页「重新查看」）用的自定义事件名 */
export const PRODUCT_TOUR_EVENT = 'kk:start-product-tour';

/** 是否看过（跳过或完成都算） */
export function isProductTourSeen(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return !!localStorage.getItem(TOUR_KEY);
  } catch {
    return false;
  }
}

function markProductTourSeen(value: 'done' | 'skipped'): void {
  try {
    localStorage.setItem(TOUR_KEY, value);
  } catch {
    /* 隐私模式写不进就算了，下次还会弹 */
  }
}

/** 从任意位置手动开启导览（设置页调用） */
export function startProductTour(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(PRODUCT_TOUR_EVENT));
}

type Phase = 'idle' | 'welcome' | 'running';
type Rect = { top: number; left: number; width: number; height: number };

/* —— 侧边栏：默认收起，导览要按目标所在区域自动开合 —— */
const sidebarToggle = () => document.querySelector<HTMLElement>('[data-tour="nav-toggle"]');
const sidebarIsOpen = () => sidebarToggle()?.getAttribute('aria-expanded') === 'true';
/** 最近一次开合的时间戳：宽度过渡约 300ms，期间元素还在动，等高亮框定位稳定了再取 */
let sidebarTouchedAt = 0;
/** 展开侧边栏（导航项、版本号徽标都在侧栏里，收起时它们只是被裁掉、并非不存在） */
function openSidebar(): void {
  if (sidebarIsOpen()) return;
  sidebarToggle()?.click();
  sidebarTouchedAt = Date.now();
}
/** 桌面断点：与 console-shell / globals.css 的 768px 保持同一根线 */
const DESKTOP_QUERY = '(min-width: 768px)';
const isDesktopNow = () =>
  typeof window !== 'undefined' && window.matchMedia(DESKTOP_QUERY).matches;

/** 收起侧边栏：手机端侧栏是带遮罩的抽屉，展开会盖住内容区与顶栏 */
function closeSidebar(): void {
  if (typeof document === 'undefined') return;
  if (!sidebarIsOpen()) return;
  sidebarToggle()?.click();
  sidebarTouchedAt = Date.now();
}

/**
 * 导览开始时侧栏的原始状态。
 * 导览为了高亮导航项会去开合侧栏，那属于「导览自己借用的状态」，用完必须还回去。
 */
let sidebarOpenAtStart = false;

function rememberSidebarState(): void {
  sidebarOpenAtStart = sidebarIsOpen();
}

/**
 * 导览结束时还原侧栏。
 *
 * 以前这里无条件收起，于是电脑端用户本来展开着侧栏、点「跳过教程」后侧栏就被关掉；
 * 更糟的是 console-shell 会把开合状态写进 localStorage，重启也回不来——
 * 等于一次导览把用户的布局偏好改没了。
 *
 * 手机端例外：侧栏是覆盖式抽屉，留在展开态会盖住内容区，一律收起。
 */
function restoreSidebar(): void {
  if (isDesktopNow() && sidebarOpenAtStart) openSidebar();
  else closeSidebar();
}

/** 导览自己的浮层：命中测试必须排掉，否则整屏最上层都是它 */
const TOUR_ROOT = '.kk-tour-root';

/** 焦点兜底的命中计数：同一元素短时间被反复聚焦就不再硬顶（见组件内注释） */
const focusGuardHits = new WeakMap<HTMLElement, { at: number; n: number }>();

/** 视觉上真的看得见吗：排除被 overflow 裁掉、被 transform 移出屏幕、被上层盖住的元素 */
function isReallyVisible(el: HTMLElement, r: DOMRect): boolean {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  if (cx < 1 || cy < 1 || cx > window.innerWidth - 1 || cy > window.innerHeight - 1) return false;
  for (const node of document.elementsFromPoint(cx, cy)) {
    if (!(node instanceof HTMLElement)) continue;
    if (node.closest(TOUR_ROOT)) continue;
    return el === node || el.contains(node) || node.contains(el);
  }
  return false;
}

function findVisibleTarget(selector: string): HTMLElement | null {
  const nodes = Array.from(document.querySelectorAll<HTMLElement>(selector));
  // 宽松判定（只看宽高与 visibility）留作兜底：宁可高亮一个位置不完美的元素，
  // 也不要把整步说明退化成居中浮层。有严格命中的时候优先用它。
  let loose: HTMLElement | null = null;
  for (const el of nodes) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (!loose) loose = el;
    // 侧栏收起时里面的元素依然有宽高（只是被裁掉 / 被移出屏幕），必须靠命中测试排除，
    // 否则「侧栏里一个、顶栏里一个」的同名锚点会选到看不见的那个。
    if (isReallyVisible(el, r)) return el;
  }
  return loose;
}

/**
 * 目标所在的最近一个可滚动祖先。
 *
 * 以前只认 `[data-kk-page-scroll]`（外壳那一层）。页面内部自己开了滚动区时
 * （AI 页的编辑表单就是），目标其实在里面那层里——却去滚外层，外层压根没溢出，
 * 于是「该滚的没滚」，高亮框直接框在用户看不见的位置上。
 * 从内往外找第一个真的能滚的，才对得上用户眼睛看到的那块区域。
 */
function findScrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const cs = getComputedStyle(node);
    const canScroll = /(auto|scroll|overlay)/.test(cs.overflowY) || /(auto|scroll|overlay)/.test(cs.overflowX);
    if (canScroll && node.scrollHeight > node.clientHeight + 4) return node;
    node = node.parentElement;
  }
  /*
   * 兜底：设置页这类布局里，内容是从好几层「漫出去」的（页面根是 h-full，
   * 中间层被 flex-1 + min-h-0 封顶在视口高度），从内往外逐层问下来，
   * 每一层的 scrollHeight 都未必大于 clientHeight——只有最外面那一层真的能滚。
   * 没兜底时这里返回 null，导览就误判「不需要滚动」，高亮框留在屏幕外。
   */
  const shell = el.closest<HTMLElement>('[data-kk-page-scroll]');
  if (shell && shell.scrollHeight > shell.clientHeight + 4) return shell;
  return null;
}

/**
 * 把高亮框裁进视口。
 *
 * 目标是「一个比屏幕还高的容器」时（AI 模型编辑表单、整段日志区），
 * 直接按它的 rect 画框会画到屏幕外：上面看不见、下面也看不见，
 * 用户只看到一条贴边的边线。裁进视口后至少框住「这一屏里属于它的那部分」。
 */
function clampToViewport(r: Rect): Rect {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
  const EDGE = 8;
  const top = Math.max(r.top, EDGE);
  const left = Math.max(r.left, EDGE);
  const bottom = Math.min(r.top + r.height, vh - EDGE);
  const right = Math.min(r.left + r.width, vw - EDGE);
  return {
    top,
    left,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** 从 from 起、沿 dir 方向找到第一个不被跳过的步骤下标；越界返回 -1 */
function resolveStep(from: number, dir: 1 | -1): number {
  let i = from;
  while (i >= 0 && i < STEPS.length) {
    if (!STEPS[i].skipIf?.()) return i;
    i += dir;
  }
  return -1;
}

/** **文字** → 高亮 */
function renderRich(text: string, keyBase: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part, i) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return (
        <strong key={`${keyBase}-${i}`} className="font-semibold text-teal-700">
          {part.slice(2, -2)}
        </strong>
      );
    }
    return <span key={`${keyBase}-${i}`}>{part}</span>;
  });
}

const CARD_WIDTH_MAX = 372;
const MARGIN = 12;
const GAP = 14;

export function ProductTour() {
  const navigate = useNavigate();
  const location = useLocation();
  const t = useT();

  const [phase, setPhase] = useState<Phase>('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  /** 卡片是否可见：高亮框移动到位后才淡入，避免一闪而过 */
  const [cardVisible, setCardVisible] = useState(false);
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1024 : window.innerWidth));

  const targetElRef = useRef<HTMLElement | null>(null);
  const rectRef = useRef<Rect | null>(null);
  /**
   * 最后一次「真的量到」的高亮框位置。
   * 高亮框靠 CSS 过渡从一个目标滑到下一个目标——前提是它**一直挂着**。
   * 以前只要某一步没找到目标就 setRect(null)，框直接卸载，下一步再挂上时
   * 没有起点可过渡，于是每次都是「闪现」到新位置而不是滑过去。
   * 现在框常驻挂载，找不到目标时停在原地淡出，重新找到目标时从那里滑过去。
   */
  const lastGoodRectRef = useRef<Rect | null>(null);
  if (rect) lastGoodRectRef.current = rect;
  /** 正在跟随平滑滚动：此时高亮框逐帧贴合、不走 CSS 过渡 */
  const trackingRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardPos, setCardPos] = useState<{ top: number; left: number } | null>(null);

  rectRef.current = rect;

  /** 高亮框移动动画时长（与下方 CSS transition 保持一致） */
  const MOVE_MS = 340;

  const step = STEPS[stepIndex];
  const total = STEPS.length;
  /** 当前步骤的高度上限：remeasure 的监听只依赖 phase，靠 ref 读到最新值 */
  const maxHeightRef = useRef<number | undefined>(undefined);
  maxHeightRef.current = step?.maxHeight;

  /**
   * 量目标位置；设了 maxHeight 的步骤只从顶部往下框这么多，不跟着容器一起撑大。
   *
   * 但「撑大」有两种，不能一刀切：
   * - 容器被内容塞满（日志刷屏、列表很长）：它自己就是滚动容器，scrollHeight 明显
   *   大于 clientHeight。这时整块都是内容，就该框整块——按 maxHeight 砍成半屏，
   *   反而框不住用户正在看的那些行。
   * - 容器只是 flex-1 撑开、里面其实没多少内容：才是当初加 maxHeight 要对付的情况，
   *   按内容真实高度（scrollHeight）收一下，免得框住一大片空白。
   */
  const measureRect = useCallback((el: HTMLElement): Rect => {
    const r = el.getBoundingClientRect();
    const cap = maxHeightRef.current;
    let height = r.height;
    if (cap && r.height > cap) {
      const overflowing = el.scrollHeight > el.clientHeight + 4;
      height = overflowing ? r.height : Math.min(cap, Math.max(el.scrollHeight, cap / 3));
    }
    return clampToViewport({ top: r.top, left: r.left, width: r.width, height });
  }, []);

  /* —— 首次自动弹出（未看过时）—— */
  useEffect(() => {
    if (isProductTourSeen()) return;
    const t = window.setTimeout(() => {
      setPhase((p) => (p === 'idle' ? 'welcome' : p));
      // 记的时候机：欢迎页上直接点跳过也要能还原，不能在 beginTour 才记
      rememberSidebarState();
    }, 650);
    return () => window.clearTimeout(t);
  }, []);

  /* —— 手动触发（设置页）—— */
  useEffect(() => {
    const onStart = () => {
      rememberSidebarState();
      setStepIndex(0);
      setPhase('welcome');
    };
    window.addEventListener(PRODUCT_TOUR_EVENT, onStart);
    return () => window.removeEventListener(PRODUCT_TOUR_EVENT, onStart);
  }, []);

  const closeTour = useCallback(() => {
    closeConnDialog();
    closeSimConfig();
    // 还原到导览开始时的状态：导览期间为高亮导航项把它展开过，用完还回去
    restoreSidebar();
    setPhase('idle');
    setRect(null);
    setCardVisible(false);
    targetElRef.current = null;
    trackingRef.current = false;
    setCardPos(null);
  }, []);

  const finish = useCallback(
    (result: 'done' | 'skipped') => {
      markProductTourSeen(result);
      closeTour();
    },
    [closeTour],
  );

  const beginTour = useCallback(() => {
    setStepIndex(0);
    setPhase('running');
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((i) => {
      const next = resolveStep(i + 1, 1);
      if (next < 0) {
        markProductTourSeen('done');
        closeConnDialog();
        closeSimConfig();
        restoreSidebar();
        setPhase('idle');
        setRect(null);
        setCardVisible(false);
        targetElRef.current = null;
        trackingRef.current = false;
        setCardPos(null);
        return i;
      }
      return next;
    });
  }, []);

  const goPrev = useCallback(() => {
    setStepIndex((i) => {
      const prev = resolveStep(i - 1, -1);
      return prev < 0 ? i : prev;
    });
  }, []);

  const hasNext = resolveStep(stepIndex + 1, 1) >= 0;
  const hasPrev = resolveStep(stepIndex - 1, -1) >= 0;

  /* —— 定位当前步骤目标（含自动跳转 + 平滑滚动跟随 + 轮询等待元素）—— */
  useEffect(() => {
    if (phase !== 'running' || !step) return;

    if (step.route && location.pathname !== step.route) {
      navigate(step.route);
      return;
    }

    // 进入副作用（如打开/关闭连接管理弹窗），需幂等
    step.enter?.();
    if (step.sidebar === 'open') openSidebar();
    else closeSidebar();

    // 清掉上一步的目标：新目标就位前，别让逐帧贴合循环把高亮框拽回上一个元素
    targetElRef.current = null;

    let cancelled = false;
    const timers: number[] = [];
    let raf = 0;
    // 切换步骤：先把卡片淡出，等高亮框移动到位再淡入
    setCardVisible(false);

    const revealAfter = (ms: number) => {
      timers.push(window.setTimeout(() => {
        if (!cancelled) setCardVisible(true);
      }, ms));
    };

    const setRectFrom = (el: HTMLElement) => {
      const rect0 = measureRect(el);
      setRect(rect0);
      return el.getBoundingClientRect();
    };

    if (step.center || !step.target) {
      targetElRef.current = null;
      trackingRef.current = false;
      setRect(null);
      revealAfter(120);
      return () => {
        cancelled = true;
        timers.forEach((t) => window.clearTimeout(t));
      };
    }

    /*
     * 目标迟迟不出现（页面还在拉数据、顶栏在重排）时，别让用户对着空白干等：
     * 先按居中把说明卡片显示出来，等目标出现后高亮框再从这里滑过去。
     * 以前只有「定位成功」或「彻底放弃」两种时机才显示卡片，中间这段就是那 3 秒空白。
     */
    revealAfter(560);

    let tries = 0;
    const tick = () => {
      if (cancelled) return;
      // 每轮都重跑一次进入副作用：确保「打开弹窗/面板」的事件即使早于目标页监听注册也能生效（幂等）
      step.enter?.();
      if (step.sidebar === 'open') openSidebar();
      else closeSidebar();
      // 侧栏刚开合过：等宽度过渡收尾再定位，否则高亮框会贴在过渡中途的位置上
      if (Date.now() - sidebarTouchedAt < 340) {
        timers.push(window.setTimeout(tick, 16));
        return;
      }
      const el = findVisibleTarget(step.target as string);
      if (!el) {
        tries += 1;
        // 300 × 16ms ≈ 4.8s：商城这类要先拉完列表、顶栏才把操作按钮渲染出来的界面，
        // 原来的 1.9s 不够，正好卡在「按钮刚出现、导览已经放弃了」的缝里
        if (tries > 300) {
          // 找不到（数据未加载 / 该端无此入口 / 锚点被包装组件吞了）→ 居中浮层，仍展示说明
          // 打一条警告：这类问题在界面上只表现为「没高亮」，不看控制台根本查不出是哪一步
          console.warn(
            `[tour] 步骤「${step.id}」找不到可高亮的目标：${step.target}`
            + '（锚点是否真的渲染进了 DOM？包一层自定义组件却没透传 props 是最常见的坑）',
          );
          targetElRef.current = null;
          trackingRef.current = false;
          setRect(null);
          revealAfter(120);
          return;
        }
        timers.push(window.setTimeout(tick, 16));
        return;
      }

      targetElRef.current = el;
      const r0 = el.getBoundingClientRect();
      const hadRect = rectRef.current != null;
      // 只在目标所在的滚动容器内滚动（见 findScrollParent）。用 scrollIntoView 会向上冒泡去滚
      // 窗口/根滚动，把 background-attachment:fixed 的氛围底和固定背景层整体推走，
      // 停下后又缓慢弹回——这正是导览期间「背景上移再慢慢下降」的来源。
      const scroller = findScrollParent(el);
      const view = scroller?.getBoundingClientRect() ?? null;
      // 判定放宽到「视口」：目标可能已经伸出屏幕（比屏幕还高的容器更是必然），
      // 只要它有一截没露出来就先滚，别把高亮框钉在用户看不见的地方。
      const offTop = r0.top < (view ? view.top : 0) + 72;
      const offBottom = r0.bottom > (view ? view.bottom : window.innerHeight) - 72;
      /** 目标在滚动容器里真正露出来的高度 */
      const shown = view ? Math.min(r0.bottom, view.bottom) - Math.max(r0.top, view.top) : r0.height;
      // 光看上下越界还不够：目标是「贴着容器边缘只露一条」时上下判定都不过线，
      // 用户却只看到一条边。至少要露出 72px（目标本身没这么高就按它自己的高度算）。
      const tooLittle = shown < Math.min(r0.height, 72);
      const needScroll = !!scroller && !!view && (offTop || offBottom || tooLittle);

      if (needScroll && scroller && view) {
        // 平滑滚动，并逐帧让高亮框贴住目标，直到滚动停稳
        trackingRef.current = true;
        setRect(measureRect(el));

        const scrollOnce = () => {
          const r = el.getBoundingClientRect();
          const v = scroller.getBoundingClientRect();
          // 比容器还高的目标（AI 编辑表单、设置页的外观卡片这类）别去居中——居中等于把它的
          // 开头顶出屏幕，直接对齐到容器顶部更容易看懂「框的是从哪儿开始的一大块」
          const toTop = scroller.scrollTop + (r.top - v.top) - 72;
          const centered = scroller.scrollTop + (r.top - v.top) - (v.height / 2 - r.height / 2);
          const desired = r.height > v.height - 16 ? toTop : centered;
          const maxTop = scroller.scrollHeight - scroller.clientHeight;
          const next = Math.max(0, Math.min(maxTop, desired));
          /*
           * 跨屏滚动（设置页从顶部跳到「界面外观」就是）用平滑动画要跑一秒以上，
           * 比下面跟随循环的耐心（1.5s）还长：循环先判定「已经停稳」并定格，
           * 滚动却还在半路——高亮框钉在中途，看着就像「压根没滚」。
           * 距离超过一屏就直接跳到位，短距离才平滑。
           */
          const far = Math.abs(next - scroller.scrollTop) > v.height * 1.1;
          scroller.scrollTo({ top: next, behavior: far ? 'auto' : 'smooth' });
          return far;
        };

        let lastTop = Number.NaN;
        let stable = 0;
        let round = 0;
        let startAt = performance.now();
        const loop = () => {
          if (cancelled) return;
          const r = setRectFrom(el);
          const cur = Math.round(r.top);
          if (cur === lastTop) stable += 1;
          else { stable = 0; lastTop = cur; }
          if (stable >= 4 || performance.now() - startAt > 1500) {
            /*
             * 停稳后再验一次：目标真的露出来了吗？
             * 容器的可滚动高度有时会在滚动过程中变（图片/卡片加载完变高、
             * 吸顶工具栏改变布局），第一轮的落点就偏了。只补一轮，别陷入来回滚。
             */
            const v = scroller.getBoundingClientRect();
            const visible = Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top);
            if (visible < Math.min(r.height, 72) && round < 1) {
              round += 1;
              lastTop = Number.NaN;
              stable = 0;
              startAt = performance.now();
              scrollOnce();
              raf = requestAnimationFrame(loop);
              return;
            }
            trackingRef.current = false;
            setRectFrom(el); // 恢复过渡后再定格一次
            revealAfter(70);
            return;
          }
          raf = requestAnimationFrame(loop);
        };
        scrollOnce();
        raf = requestAnimationFrame(loop);
      } else {
        // 无需滚动：靠 CSS 过渡把高亮框平移过去
        trackingRef.current = false;
        setRect(measureRect(el));
        revealAfter(hadRect ? MOVE_MS : 90);
      }
    };
    tick();

    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [phase, stepIndex, step, location.pathname, navigate, measureRect]);

  /* —— 视口变化时重新测量（滚动的贴合由下面的逐帧循环负责）—— */
  useEffect(() => {
    if (phase !== 'running') return;
    const onResize = () => {
      setVw(window.innerWidth);
      const el = targetElRef.current;
      if (el && document.contains(el)) setRect(measureRect(el));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase, measureRect]);

  /*
   * 步骤激活期间逐帧贴合目标。
   * 以前定位成功一次就收工——之后目标因拾色面板弹出动画、列表加载、字体加载再挪动时，
   * 高亮框停在旧位置，就是「高亮区域对不上」。每帧只量一次、有变化才 setState。
   */
  useEffect(() => {
    if (phase !== 'running') return;
    let raf = 0;
    let lastKey = '';
    const poll = () => {
      const el = targetElRef.current;
      if (el && document.contains(el) && !trackingRef.current) {
        const r = measureRect(el);
        const key = `${r.top}|${r.left}|${r.width}|${r.height}`;
        if (key !== lastKey) {
          lastKey = key;
          setRect(r);
        }
      }
      raf = requestAnimationFrame(poll);
    };
    raf = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(raf);
  }, [phase, measureRect]);

  /* —— 导览期间：把「导览在跑」广播出去，弹窗据此收起自动聚焦 —— */
  useEffect(() => {
    setTourActive(phase !== 'idle');
  }, [phase]);
  // 组件卸载才收：换步骤时不要先关后开，中间那一瞬会被弹窗当成「导览已结束」
  useEffect(() => () => setTourActive(false), []);

  /*
   * 导览期间不让底层输入框拿到焦点。
   *
   * 导览为了演示会主动打开连接表单 / 模型表单这类弹窗，Radix 一开弹窗就把焦点
   * 塞给里面第一个可聚焦元素，恰好大多是输入框：电脑端只是多了个光标，
   * 手机端会直接顶起软键盘、把说明卡片挤到屏幕外——用户什么也看不成。
   *
   * 弹窗层面已经在 onOpenAutoFocus 里拦了一道（见 ui/dialog），这里是兜底：
   * 无论焦点从哪来（autoFocus、程序化 focus()、焦点陷阱回捞），一律还回去。
   */
  useEffect(() => {
    if (phase === 'idle') return;
    // 进入导览那一刻焦点可能已经落在输入框上（上一步刚开的弹窗），先还回去
    const cur = document.activeElement;
    if (cur instanceof HTMLElement && isEditableElement(cur) && !cur.closest(TOUR_ROOT)) cur.blur();

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (!isEditableElement(el)) return;
      if (el?.closest(TOUR_ROOT)) return; // 导览自己的输入区（目前没有，留个口子）
      /*
       * 有些组件（Radix 的焦点陷阱、受控表单）会在 blur 后立刻把焦点塞回同一个
       * 输入框，硬顶下去就成了「聚焦—失焦」的死循环，界面一直在抖。
       * 同一元素短时间内被反复抓超过 3 次就放手，宁可让它弹一次键盘。
       */
      const now = Date.now();
      const rec = focusGuardHits.get(el as HTMLElement);
      if (rec && now - rec.at < 600) {
        rec.n += 1;
        rec.at = now;
        if (rec.n > 3) return;
      } else {
        focusGuardHits.set(el as HTMLElement, { at: now, n: 1 });
      }
      el?.blur();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, [phase]);

  /* —— 键盘：Esc 跳过、← → / Enter 翻页 —— */
  useEffect(() => {
    if (phase !== 'running') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (suppressTourEscape) return;
        e.preventDefault();
        finish('skipped');
      } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goPrev();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, finish, goNext, goPrev]);

  const cardWidth = Math.min(CARD_WIDTH_MAX, vw - MARGIN * 2);

  /* —— 计算说明卡片位置（相对高亮框，自动上/下/居中）—— */
  useLayoutEffect(() => {
    if (phase !== 'running') return;
    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth || cardWidth;
    const ch = card.offsetHeight || 220;
    const winW = window.innerWidth;
    const winH = window.innerHeight;

    if (!rect) {
      setCardPos({ left: (winW - cw) / 2, top: Math.max(MARGIN, (winH - ch) / 2) });
      return;
    }

    const pad = step?.padding ?? 8;
    const boxTop = rect.top - pad;
    const boxBottom = rect.top + rect.height + pad;

    let top: number;
    if (boxBottom + GAP + ch <= winH - MARGIN) {
      top = boxBottom + GAP;
    } else if (boxTop - GAP - ch >= MARGIN) {
      top = boxTop - GAP - ch;
    } else {
      top = rect.top > winH / 2 ? MARGIN : winH - ch - MARGIN;
    }
    top = Math.max(MARGIN, Math.min(top, winH - ch - MARGIN));

    const centerX = rect.left + rect.width / 2 - cw / 2;
    const left = Math.max(MARGIN, Math.min(winW - cw - MARGIN, centerX));
    setCardPos({ top, left });
  }, [phase, rect, stepIndex, step, cardWidth]);

  if (phase === 'idle') return null;

  /* —— 欢迎弹窗（强制，两个按钮）—— */
  if (phase === 'welcome') {
    return createPortal(
      <div className="kk-tour-root fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" style={{ pointerEvents: 'auto' }}>
        {/* 阴影改读 --glass-shadow-hover：原来写死的 0_20px_60px 是 utilities 层，
            直接盖掉 kk-glass-2 的玻璃阴影，「阴影透明度」滑块对导览弹窗完全无效 */}
        <div className="kk-pop kk-glass-2 w-full max-w-sm overflow-hidden rounded-[1.35rem] p-6 shadow-[var(--glass2-shadow)]">
          <div className="flex flex-col items-center text-center">
            <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-teal-500/15 text-teal-600">
              <Compass className="h-7 w-7" />
            </span>
            <h2 className="text-xl font-bold tracking-tight text-slate-800">{t('tour.welcomeTitle')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {t('tour.welcomeP1')}
              <span className="font-semibold text-teal-700">{t('tour.welcomeTour')}</span>
              {t('tour.welcomeP2')}
              <span className="font-semibold text-teal-700">{t('tour.welcomeOrder')}</span>
              {t('tour.welcomeP3')}
            </p>
          </div>
          <div className="mt-6 flex gap-3">
            {/* kk-field：outline 变体的 bg-white/35 + border-white/55 + backdrop-blur-md
                全是写死值，导览按钮因此既不受外观控制、也没有阴影 */}
            <Button
              variant="outline"
              className="kk-field flex-1 text-slate-600 hover:text-slate-800"
              onClick={() => finish('skipped')}
            >
              {t('tour.skipBtn')}
            </Button>
            <Button className="flex-1" onClick={beginTour}>
              {t('tour.startBtn')}
            </Button>
          </div>
        </div>
      </div>,
      getPortalRoot(),
    );
  }

  /* —— 运行中：遮罩 + 高亮 + 说明卡片 —— */
  const pad = step?.padding ?? 8;
  /** 高亮框实际画在哪：有目标就用目标，没目标就停在最后一次的位置淡出 */
  const boxRect = rect ?? lastGoodRectRef.current;
  const boxTransition = trackingRef.current
    ? 'none'
    : 'top .34s cubic-bezier(0.22,1,0.36,1), left .34s cubic-bezier(0.22,1,0.36,1), width .34s cubic-bezier(0.22,1,0.36,1), height .34s cubic-bezier(0.22,1,0.36,1), opacity .2s ease';
  const hole = boxRect
    ? {
        top: boxRect.top - pad,
        left: boxRect.left - pad,
        width: boxRect.width + pad * 2,
        height: boxRect.height + pad * 2,
      }
    : null;
  const darkBg = 'rgba(15,23,42,0.55)';
  /** 洞的四角补块半径：目标太小时按洞的一半收，避免补块盖进洞里 */
  const cornerR = hole ? Math.min(16, hole.width / 2, hole.height / 2) : 16;
  /** 四角补块：贴洞的内角用 radial-gradient 留出四分之一圆透明，暗场由此凸进洞里拼出内圆角 */
  const cornerPatches = hole
    ? [
        { left: hole.left, top: hole.top, cx: '100%', cy: '100%' },
        { left: hole.left + hole.width - cornerR, top: hole.top, cx: '0%', cy: '100%' },
        { left: hole.left, top: hole.top + hole.height - cornerR, cx: '100%', cy: '0%' },
        { left: hole.left + hole.width - cornerR, top: hole.top + hole.height - cornerR, cx: '0%', cy: '0%' },
      ]
    : [];
  /** 高亮框实际画在哪：有目标就用目标，没目标就停在最后一次的位置淡出 */
  const progress = Math.round(((stepIndex + 1) / total) * 100);

  return createPortal(
    <div
      className="kk-tour-root fixed inset-0 z-[80]"
      style={{ pointerEvents: 'auto' }}
      aria-live="polite"
      // 阻止指针事件冒泡到 document：否则 Radix 弹窗会把「点击导览按钮」当成点击窗外而自动关闭
      onPointerDown={(e) => e.stopPropagation()}
    >
      {/* 捕获层：屏蔽底层交互，导览只能用卡片按钮推进 */}
      <div
        className="absolute inset-0"
        style={{ background: rect ? 'transparent' : 'rgba(15,23,42,0.55)' }}
        onClick={(e) => e.stopPropagation()}
      />

      {/*
        暗场 = 四条直边带 + 洞的四角各补一小块「radial-gradient 缺口方块」：
        方块在贴洞的内角留出四分之一圆的透明，暗场便凸进洞里，拼出内圆角高亮洞。
        （不能用条带自己的 border-radius——那是从暗场里抠掉一块，圆弧方向正好反了。）
        常驻挂载：找不到目标时停在原地淡出，下一步从那里滑过去而不是闪现。
      */}
      {hole ? (
        <>
          <div aria-hidden className="pointer-events-none absolute" style={{ left: 0, right: 0, top: 0, height: Math.max(0, hole.top), background: darkBg, opacity: rect ? 1 : 0, transition: boxTransition }} />
          <div aria-hidden className="pointer-events-none absolute" style={{ left: 0, right: 0, top: hole.top + hole.height, bottom: 0, background: darkBg, opacity: rect ? 1 : 0, transition: boxTransition }} />
          <div aria-hidden className="pointer-events-none absolute" style={{ left: 0, width: Math.max(0, hole.left), top: hole.top, height: hole.height, background: darkBg, opacity: rect ? 1 : 0, transition: boxTransition }} />
          <div aria-hidden className="pointer-events-none absolute" style={{ left: hole.left + hole.width, right: 0, top: hole.top, height: hole.height, background: darkBg, opacity: rect ? 1 : 0, transition: boxTransition }} />
          {cornerPatches.map((c, i) => (
            <div
              key={i}
              aria-hidden
              className="pointer-events-none absolute"
              style={{
                left: c.left,
                top: c.top,
                width: cornerR,
                height: cornerR,
                background: `radial-gradient(circle at ${c.cx} ${c.cy}, transparent ${Math.max(0, cornerR - 1)}px, ${darkBg} ${cornerR}px)`,
                opacity: rect ? 1 : 0,
                transition: boxTransition,
              }}
            />
          ))}
        </>
      ) : null}

      {/* 说明卡片：常驻挂载，高亮框移动到位后淡入 */}
      {phase === 'running' ? (
        <div
          ref={cardRef}
          className="kk-glass-2 absolute flex flex-col overflow-y-auto no-scrollbar rounded-[1.25rem] p-4 shadow-[var(--glass2-shadow)] sm:p-5"
          /*
           * 按住卡片时不让焦点跟着走：焦点一变，开着弹窗的那一步里 Radix 的焦点陷阱
           * 就会把焦点往弹窗里捞（第一个往往正是输入框），手机端随即顶起软键盘。
           * 只取消默认行为、不阻止事件，按钮的 click 照常触发、键盘导航也照常生效。
           */
          onMouseDown={(e) => e.preventDefault()}
          style={{
            width: cardWidth,
            maxHeight: 'calc(100dvh - 24px)',
            top: cardPos?.top ?? -9999,
            left: cardPos?.left ?? -9999,
            opacity: cardVisible && cardPos ? 1 : 0,
            transform: cardVisible && cardPos ? 'translateY(0)' : 'translateY(6px)',
            pointerEvents: cardVisible && cardPos ? 'auto' : 'none',
            transition:
              'opacity .22s ease, transform .22s cubic-bezier(0.22,1,0.36,1)',
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-teal-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-teal-700">
              {t('tour.stepLabel', { n: stepIndex + 1, total })}
            </span>
            <button
              type="button"
              onClick={() => finish('skipped')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-rose-500/10 hover:text-rose-600"
              aria-label={t('tour.closeTourAria')}
              title={t('tour.skipBtn')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <h3 className="text-base font-bold tracking-tight text-slate-800">{step ? t(step.title) : ''}</h3>
          <div className="mt-1.5 space-y-1.5">
            {step?.body.map((line, i) => (
              <p key={i} className="text-[13px] leading-relaxed text-slate-600">
                {renderRich(t(line), `l${i}`)}
              </p>
            ))}
          </div>

          {step?.callout ? (
            <div
              className={cn(
                'mt-3 flex items-start gap-2 rounded-xl px-3 py-2 text-[12.5px] leading-relaxed ring-1',
                step.callout.tone === 'warn'
                  ? 'bg-amber-400/15 text-amber-800 ring-amber-400/30'
                  : 'bg-teal-500/15 text-teal-800 ring-teal-500/25',
              )}
            >
              {step.callout.tone === 'warn' ? (
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              ) : (
                <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
              )}
              <span>{renderRich(t(step.callout.text), 'co')}</span>
            </div>
          ) : null}

          {/* 进度条 */}
          <div className="mt-3.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-300/40">
            <div
              className="h-full rounded-full bg-teal-500 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-3.5 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => finish('skipped')}
              className="kk-field text-slate-500 hover:text-rose-600"
            >
              {t('tour.skipBtn')}
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="kk-field" onClick={goPrev} disabled={!hasPrev}>
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('tour.prevBtn')}
              </Button>
              <Button size="sm" onClick={goNext}>
                {hasNext ? (
                  <>
                    {t('tour.nextBtn')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    {t('tour.doneBtn')}
                    <Check className="h-3.5 w-3.5" />
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>,
    getPortalRoot(),
  );
}
