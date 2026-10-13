/**
 * 侧边栏开合时，主内容区「被推挤 / 被撞到」的物理感。
 *
 * 分两层看，两者叠加才成立：
 *
 * 1. 主体位移：桌面端侧栏是占位式的（static + width 过渡），主内容靠 flex 被挤开，
 *    位移量天然等于侧栏宽度变化量，且由同一条 width 过渡驱动——这层已经严格同步，
 *    不是本模块的事。
 * 2. 惯性冲量（本模块）：在主体位移之上叠加一段短促的 translateX 过冲再收敛，
 *    让「被撞了一下」的手感出来。只用 transform，不参与布局，因此不会重排、
 *    不会抖滚动条、不会让文字重排跳动。
 *
 * 为什么不用「整体 translateX(侧栏宽度)」的一刀切做法：
 * 主内容区里包含顶栏，整体右移会把顶栏右侧的操作按钮和 GitHub 入口推出视口。
 * 想让内容完整可见，内容区宽度就必须真的缩小——那正是第 1 层在做的挤压。
 * 所以这里只做克制的冲量，不做整体搬运。
 *
 * 明确不做的事：任何 translateY（上下弹动）、任何 scale（会连带改变字号视觉大小）、
 * 任何 font-size / font-weight 相关变化。
 */

const DESKTOP_QUERY = '(min-width: 768px)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/* —— 可调参数 —— */

/** 惯性冲量位移（px）：主内容被推/被拉时冲过头的距离 */
const PUSH_PX = 10;
/** 收敛回弹幅度，相对冲量的比例（反向），越小越克制 */
const REBOUND_RATIO = 0.28;
/** 冲量到达峰值的时刻 */
const PEAK_AT = 0.42;
/** 反向回弹的时刻 */
const REBOUND_AT = 0.72;
/** 取不到侧栏实际过渡参数时的兜底时长（ms），与 SIDEBAR_MOTION 的 duration-300 对齐 */
const FALLBACK_DURATION = 300;
const FALLBACK_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

const PUSH_ID = 'kk-content-push';

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/**
 * 取逗号分隔列表的第一项。
 *
 * 必须按「顶层逗号」切：缓动函数是 `cubic-bezier(0.32, 0.72, 0, 1)`，
 * 函数内部也有逗号，直接 `split(',')[0]` 会切成 `cubic-bezier(0.32`——
 * 喂给 el.animate() 会抛 TypeError，进而打断 React 渲染。
 */
function firstOfList(value: string): string {
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) return value.slice(0, i).trim();
  }
  return value.trim();
}

/** 兜底校验：只接受 Web Animations 认的缓动写法，拿不准就别喂给 animate */
function isValidEasing(value: string): boolean {
  return /^(linear|ease|ease-in|ease-out|ease-in-out|cubic-bezier\([^()]*\)|steps\([^()]*\))$/.test(value);
}

/**
 * 直接读侧栏的真实过渡参数，保证「时长 / 缓动曲线与侧栏严格匹配」。
 * 侧栏改了 duration 或 easing，这里自动跟随，不用两处同步改数字。
 */
function readSidebarMotion(): { duration: number; easing: string } {
  let duration = FALLBACK_DURATION;
  let easing = FALLBACK_EASING;
  const aside = document.querySelector<HTMLElement>('.kk-sidebar');
  if (!aside) return { duration, easing };

  const style = getComputedStyle(aside);
  // transition 写了多个属性时这里会是逗号分隔的列表，取第一个即可（三者同值）
  const rawDuration = firstOfList(style.transitionDuration);
  if (rawDuration) {
    const n = Number.parseFloat(rawDuration);
    if (Number.isFinite(n) && n > 0) {
      duration = clamp(rawDuration.endsWith('ms') ? n : n * 1000, 80, 1200);
    }
  }
  const rawEasing = firstOfList(style.transitionTimingFunction);
  if (rawEasing && isValidEasing(rawEasing)) easing = rawEasing;
  return { duration, easing };
}

/**
 * 让主内容区弹一下（水平方向，带克制回弹）。
 *
 * @param el    主内容区容器（.kk-ambient-main）
 * @param opening true = 侧栏展开（被推向右），false = 侧栏收起（被拉向左）
 *
 * 窄屏、系统开启「减少动态效果」、或拿不到元素时静默跳过，调用方无需前置判断。
 */
export function pushContent(el: HTMLElement | null | undefined, opening: boolean): void {
  if (!el || typeof window === 'undefined') return;

  // 窄屏（移动端抽屉是覆盖层，主内容尺寸压根不变）不做——降级为完全不动
  if (!window.matchMedia(DESKTOP_QUERY).matches) return;
  if (window.matchMedia(REDUCED_MOTION_QUERY).matches) return;

  // 展开：被侧栏推向右侧；收起：跟着侧栏回到左侧。方向相反，量级相同
  const push = opening ? PUSH_PX : -PUSH_PX;
  const rebound = -push * REBOUND_RATIO;
  const { duration, easing } = readSidebarMotion();

  const keyframes: Keyframe[] = [
    { transform: 'translateX(0px)' },
    { transform: `translateX(${push}px)`, offset: PEAK_AT },
    { transform: `translateX(${rebound}px)`, offset: REBOUND_AT },
    { transform: 'translateX(0px)' },
  ];

  // 连点开合时先取消上一次没跑完的冲量，否则两个 transform 会打架抽搐
  for (const running of el.getAnimations()) {
    if (running.id === PUSH_ID) running.cancel();
  }

  try {
    const anim = el.animate(keyframes, {
      duration,
      easing,
      // 不保留终态：跑完自动回到元素原本的样式，不留残留
      fill: 'none',
    });
    anim.id = PUSH_ID;
  } catch {
    // 动画只是锦上添花：万一某个浏览器不认这组参数，也不能让它打断侧栏开合
  }
}
