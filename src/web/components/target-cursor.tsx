import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot } from '@/lib/portal-root';
import './target-cursor.css';

export interface TargetCursorProps {
  targetSelector?: string;
  cursorColor?: string;
  /** 中心点的背景：可传渐变串（括号/标签是描边与文字，仍用 cursorColor 纯色） */
  cursorBg?: string;
  cursorColorOnTarget?: string;
  spinDuration?: number;
  hoverDuration?: number;
  parallaxOn?: boolean;
  hideDefaultCursor?: boolean;
  size?: number;
  cornerSize?: number;
  thickness?: number;
  padding?: number;
  matchRadius?: boolean;
  dotSize?: number;
  blendMode?: CSSProperties['mixBlendMode'];
  showLabel?: boolean;
  clickEffect?: boolean;
  container?: RefObject<HTMLElement | null> | HTMLElement | null;
  /** 粗指针（触屏）下的兼容方式：tap=点按时锁一下再淡出，off=完全不启用 */
  touchMode?: 'tap' | 'off';
  /** 触屏锁定的停留时长（毫秒） */
  touchHold?: number;
  /** 单个锁定目标最多能占视口面积的多少，超过就放弃锁定（避免巨型卡片被整圈框住） */
  maxTargetArea?: number;
  /** 语义选择器都没命中时，退一步认「computed cursor: pointer」的元素（覆盖自绘的可点击块） */
  cursorPointerFallback?: boolean;
}

/**
 * 全局默认命中的「可交互元素」。
 *
 * 原版默认只认 `.cursor-target`，逐个按钮去加类名不现实（本项目按钮成百上千、
 * 还大量来自 Radix 的无障碍组件），所以这里直接铺开到所有语义化的可交互元素：
 * 原生 button / a[href] / summary / 表单控件，以及 Radix 那套 role=tab / switch /
 * checkbox / menuitem / combobox / slider / option ...
 *
 * 刻意**排除**纯文本录入元素（text/textarea/contenteditable）：它们不是「按钮」，
 * 框住一整个输入框既难看又挡视线，而且系统光标要留着 I 型供定位插入点。
 */
export const DEFAULT_TARGET_SELECTOR = [
  '.cursor-target',
  '[data-cursor-target]',
  'button',
  '[role="button"]',
  '[role="link"]',
  'a[href]',
  'summary',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="treeitem"]',
  '[role="combobox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  'input[type="button"]',
  'input[type="submit"]',
  'input[type="reset"]',
  'input[type="checkbox"]',
  'input[type="radio"]',
  'input[type="range"]',
  'input[type="color"]',
  'input[type="file"]',
  'select'
].join(', ');

type Spring = { x: number; v: number };

const CORNER_ANGLES = [0, 90, 180, 270];
const QUARTER = Math.PI / 2;
/** 标签最多显示的字符数，超了截掉 —— 长按钮名不至于糊满屏 */
const LABEL_MAX = 16;

const spring = (state: Spring, goal: number, stiffness: number, damping: number, dt: number) => {
  const steps = 2;
  const h = dt / steps;
  for (let i = 0; i < steps; i++) {
    state.v += (stiffness * (goal - state.x) - damping * state.v) * h;
    state.x += state.v * h;
  }
};

const resolveElement = (value: TargetCursorProps['container']): HTMLElement | null =>
  (value && 'current' in value ? value.current : value) || null;

/** '#rgb' / '#rrggbb' / '#rrggbbaa' / rgb() / rgba() → [r,g,b]；认不出来返回 null */
function parseColor(input: string): [number, number, number] | null {
  const raw = input.trim();
  if (raw.startsWith('#')) {
    const hex = raw.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return [r, g, b];
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      if ([r, g, b].some(Number.isNaN)) return null;
      return [r, g, b];
    }
    return null;
  }
  const matched = raw.match(/^rgba?\(([^)]+)\)$/i);
  if (!matched) return null;
  const parts = matched[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
  return [parts[0], parts[1], parts[2]];
}

/**
 * 自己在 JS 里混色，不用 CSS 的 color-mix(in oklab, ...)。
 * 老一点的内核（部分 Electron / WebView 版本）不认 color-mix 会把它整条声明丢掉，
 * 结果锁定态直接变全透明 —— 这里自己算 rgb() 更稳。
 */
function mixColor(from: string, to: string, t: number): string {
  const a = parseColor(from);
  const b = parseColor(to);
  if (!a || !b) return t > 0.5 ? to : from;
  const k = Math.max(0, Math.min(1, t));
  const ch = (i: number) => Math.round(a[i] + (b[i] - a[i]) * k);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

function trimLabel(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > LABEL_MAX ? `${clean.slice(0, LABEL_MAX)}…` : clean;
}

/**
 * 标签文案：优先 data-cursor-label（显式指定），其次 aria-label / title，
 * 最后退回元素自己的文字。纯图标按钮（没有文字也没有 aria-label）→ 空串，不显示标签。
 */
function resolveLabel(element: Element | null): string {
  if (!element) return '';
  const custom = element.getAttribute('data-cursor-label');
  if (custom !== null) return trimLabel(custom);
  const aria = element.getAttribute('aria-label');
  if (aria && aria.trim()) return trimLabel(aria);
  const title = element.getAttribute('title');
  if (title && title.trim()) return trimLabel(title);
  const text = element.textContent || '';
  return trimLabel(text);
}

/** 被禁用 / 隐藏 / 主动声明忽略的元素不参与锁定 */
function isLockable(element: Element): boolean {
  if (element.hasAttribute('disabled')) return false;
  if (element.getAttribute('aria-disabled') === 'true') return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (element.closest('[data-cursor-ignore]')) return false;
  if (element instanceof HTMLElement) {
    if (element.dataset.cursorIgnore !== undefined) return false;
    // 尺寸为 0（display:none / 折叠起来的）不该被框住
    if (!element.getClientRects().length) return false;
  }
  return true;
}

const TargetCursor = ({
  targetSelector = DEFAULT_TARGET_SELECTOR,
  cursorColor = '#ffffff',
  cursorBg,
  cursorColorOnTarget,
  spinDuration = 2,
  hoverDuration = 0.2,
  parallaxOn = true,
  hideDefaultCursor = true,
  size = 36,
  cornerSize = 12,
  thickness = 3,
  padding = 6,
  matchRadius = true,
  dotSize = 4,
  blendMode = 'difference',
  showLabel = true,
  clickEffect = true,
  container,
  touchMode = 'tap',
  touchHold = 720,
  maxTargetArea = 0.5,
  cursorPointerFallback = true
}: TargetCursorProps) => {
  const [mode, setMode] = useState<'none' | 'mouse' | 'touch'>('none');
  const rootRef = useRef<HTMLDivElement>(null);
  const cornerRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const dotRef = useRef<HTMLSpanElement>(null);
  const labelRef = useRef<HTMLSpanElement>(null);
  const wakeRef = useRef<(() => void) | null>(null);
  const settings = {
    targetSelector,
    cursorColor,
    cursorBg,
    cursorColorOnTarget,
    spinDuration,
    hoverDuration: Math.max(0.05, hoverDuration),
    parallaxOn,
    hideDefaultCursor,
    size: Math.max(4, size),
    cornerSize: Math.max(2, cornerSize),
    thickness: Math.max(0.5, thickness),
    padding,
    matchRadius,
    dotSize: Math.max(0, dotSize),
    showLabel,
    clickEffect,
    container,
    touchMode,
    touchHold,
    maxTargetArea,
    cursorPointerFallback
  };
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /**
   * 原版只认 `(hover: hover) and (pointer: fine)`，手机上直接不渲染。
   * 这里多留一条触屏分支：粗指针设备照样挂上，只是走「点一下锁一下」的轻量玩法
   * （不隐藏系统光标、不自转、松手后自行淡出）。
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      setMode('none');
      return undefined;
    }
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
    const update = () => setMode(finePointer.matches ? 'mouse' : touchMode === 'off' ? 'none' : 'touch');
    update();
    finePointer.addEventListener('change', update);
    return () => finePointer.removeEventListener('change', update);
  }, [touchMode]);

  useEffect(() => {
    const root = rootRef.current;
    if (mode === 'none' || !root) return undefined;

    const fine = mode === 'mouse';
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const style = document.createElement('style');
    style.setAttribute('data-target-cursor', '');
    document.head.appendChild(style);

    const pointer = { x: 0, y: 0, inside: false, seen: false, pressed: false };
    const centerX = { x: 0, v: 0 };
    const centerY = { x: 0, v: 0 };
    const halfW = { x: 0, v: 0 };
    const halfH = { x: 0, v: 0 };
    const radius = { x: 0, v: 0 };
    const turn = { x: 0, v: 0 };
    const lock = { x: 0, v: 0 };
    const press = { x: 0, v: 0 };
    const presence = { x: 0, v: 0 };
    let target: Element | null = null;
    let targetRadius = 0;
    let quarter = 0;
    let spinSpeed = 0;
    let raf = 0;
    let last = 0;
    let lastLabel = '';
    let lastLabelFor: Element | null = null;
    let lastColor = '';
    let lastBg = '';
    let lastScope: HTMLElement | null = null;
    let touchTimer = 0;

    const scopeOf = () => resolveElement(settingsRef.current.container);

    /**
     * 隐藏系统光标时的豁免名单：文本录入框要留着 I 型光标，
     * 否则在输入框里既看不到插入点、也定位不准（而它们本来也不参与锁定）。
     * 规则写在 hide 规则之后，同权重时后来者生效。
     */
    const EXEMPT_SELECTOR =
      "input:not([type='button']):not([type='submit']):not([type='reset']):not([type='checkbox'])" +
      ":not([type='radio']):not([type='range']):not([type='color']):not([type='file'])," +
      "textarea,[contenteditable='true']";

    const hideCursor = () => {
      const s = settingsRef.current;
      const scope = scopeOf();
      if (scope !== lastScope) {
        lastScope?.removeAttribute('data-target-cursor-scope');
        scope?.setAttribute('data-target-cursor-scope', '');
        lastScope = scope;
      }
      const selector = scope ? '[data-target-cursor-scope]' : 'html';
      const rule =
        s.hideDefaultCursor && fine && pointer.inside
          ? `${selector}, ${selector} * { cursor: none !important; }` +
            `${EXEMPT_SELECTOR} { cursor: auto !important; }`
          : '';
      if (style.textContent !== rule) style.textContent = rule;
    };

    /**
     * 兜底命中：语义选择器没中时，向上最多看 3 层，谁的计算 cursor 是 pointer 就认谁。
     * 用来覆盖那些自绘的、没写 role 的可点击块（卡片 / 行 / 图标块 / 插件自带界面）。
     *
     * 坑：hideDefaultCursor 生效后 `html, html * { cursor: none !important }` 会把
     * 全站的计算 cursor 都盖成 none，直接读 getComputedStyle 永远读不到 pointer。
     * 所以这里读之前把自己注入的样式表临时 disabled 掉，读完再恢复；
     * 结果按元素记忆（WeakMap），每个元素只付一次重算样式的成本。
     */
    const cursorMemo = new WeakMap<Element, string>();
    const rawCursorOf = (element: Element): string => {
      const memo = cursorMemo.get(element);
      if (memo !== undefined) return memo;
      let value = '';
      try {
        style.disabled = true;
        value = getComputedStyle(element).cursor;
      } catch {
        value = '';
      } finally {
        style.disabled = false;
      }
      cursorMemo.set(element, value);
      return value;
    };

    const findByPointerCursor = (node: Element | null): Element | null => {
      let current = node;
      for (let depth = 0; current && depth < 3; depth++) {
        if (current === document.body || current === document.documentElement) return null;
        if (rawCursorOf(current) === 'pointer') return current;
        current = current.parentElement;
      }
      return null;
    };

    const findTarget = (x: number, y: number, element?: Element | null): Element | null => {
      const s = settingsRef.current;
      const node = element || document.elementFromPoint(x, y);
      const found = node?.closest(s.targetSelector) || (s.cursorPointerFallback ? findByPointerCursor(node ?? null) : null);
      if (!found) return null;
      // 目标没变就别再量一遍布局（pointermove 可能远超 60Hz）
      if (found === target) return found;
      const scope = scopeOf();
      if (scope && !scope.contains(found)) return null;
      if (!isLockable(found)) return null;
      if (s.maxTargetArea > 0) {
        const box = found.getBoundingClientRect();
        const viewport = Math.max(1, window.innerWidth * window.innerHeight);
        if (box.width > 0 && box.height > 0 && (box.width * box.height) / viewport > s.maxTargetArea) {
          return null;
        }
      }
      return found;
    };

    const lockOn = (next: Element | null) => {
      if (next === target) return;
      target = next;
      if (target) {
        const angle = turn.x;
        quarter = Math.round(angle / QUARTER);
        const corner = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0;
        targetRadius = corner;
        spinSpeed = 0;
      }
    };

    const frame = (now: number) => {
      raf = 0;
      const s = settingsRef.current;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;

      if (target && !target.isConnected) lockOn(null);
      const rect = target ? target.getBoundingClientRect() : null;
      const locked = !!rect && pointer.inside;
      const snapW = 4.6 / s.hoverDuration;
      const snapK = snapW * snapW;
      const snapC = 2 * 0.62 * snapW;

      spring(presence, pointer.inside ? 1 : 0, 260, 32, dt);
      spring(lock, locked ? 1 : 0, snapK, 2 * snapW, dt);
      spring(press, pointer.pressed && s.clickEffect ? 1 : 0, 900, 40, dt);

      let goalX = pointer.x;
      let goalY = pointer.y;
      let goalW = s.size / 2;
      let goalH = s.size / 2;
      let goalR = Math.min(2, s.cornerSize / 4);
      if (locked) {
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        // 视差偏移按目标尺寸收缩：大目标（整条滑条）上 8% 会被放大到几十像素，框看着偏离目标
        const lean = s.parallaxOn ? 0.08 * Math.min(1, 56 / Math.max(rect.width, rect.height)) : 0;
        goalX = cx + (pointer.x - cx) * lean;
        goalY = cy + (pointer.y - cy) * lean;
        const odd = Math.abs(quarter) % 2 === 1;
        const w = rect.width / 2 + s.padding;
        const h = rect.height / 2 + s.padding;
        goalW = odd ? h : w;
        goalH = odd ? w : h;
        goalR = s.matchRadius ? Math.min(targetRadius + Math.max(0, s.padding), s.cornerSize) : 0;
      }

      if (!pointer.inside && presence.x < 0.01) pointer.seen = false;
      if (!pointer.seen) {
        centerX.x = goalX;
        centerY.x = goalY;
        halfW.x = goalW;
        halfH.x = goalH;
        pointer.seen = pointer.inside;
      }

      const follow = locked ? snapK : 2200;
      const followC = locked ? snapC : 2 * Math.sqrt(2200);
      spring(centerX, goalX, follow, followC, dt);
      spring(centerY, goalY, follow, followC, dt);
      spring(halfW, goalW, snapK, snapC, dt);
      spring(halfH, goalH, snapK, snapC, dt);
      spring(radius, goalR, snapK, 2 * snapW, dt);

      if (locked) {
        spring(turn, quarter * QUARTER, snapK, snapC, dt);
      } else {
        // 触屏没有「漫游」这回事，停转即可
        const speed = fine && s.spinDuration > 0 && !reduce ? (Math.PI * 2) / s.spinDuration : 0;
        spinSpeed += (speed - spinSpeed) * (1 - Math.exp(-dt * 3));
        turn.v = spinSpeed;
        turn.x += spinSpeed * dt;
      }

      const squeeze = 1 - press.x * 0.14;
      const cos = Math.cos(turn.x);
      const sin = Math.sin(turn.x);
      const w = Math.max(0, halfW.x) * squeeze;
      const h = Math.max(0, halfH.x) * squeeze;
      const local = [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h]
      ];
      const r = Math.max(0, Math.min(radius.x, s.cornerSize));
      const degrees = (turn.x * 180) / Math.PI;
      let left = Infinity;
      let top = Infinity;
      cornerRefs.current.forEach((corner, i) => {
        if (!corner) return;
        const [lx, ly] = local[i];
        const x = centerX.x + lx * cos - ly * sin;
        const y = centerY.x + lx * sin + ly * cos;
        if (x < left) left = x;
        if (y < top) top = y;
        corner.style.transform = `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0) rotate(${(
          CORNER_ANGLES[i] + degrees
        ).toFixed(2)}deg)`;
        corner.style.width = `${s.cornerSize}px`;
        corner.style.height = `${s.cornerSize}px`;
        corner.style.borderWidth = `${s.thickness}px 0 0 ${s.thickness}px`;
        corner.style.borderTopLeftRadius = `${r.toFixed(2)}px`;
      });

      const dot = dotRef.current;
      if (dot) {
        const dotScale = 1 - press.x * 0.35;
        dot.style.transform = `translate3d(${pointer.x}px, ${pointer.y}px, 0) translate(-50%, -50%) scale(${dotScale.toFixed(
          3
        )})`;
        dot.style.width = `${s.dotSize}px`;
        dot.style.height = `${s.dotSize}px`;
      }

      const label = labelRef.current;
      if (label) {
        // 标签只在「锁定目标变了」时才重新解析，别每帧读 DOM 文本
        if (target !== lastLabelFor) {
          lastLabelFor = target;
          lastLabel = resolveLabel(target);
          label.textContent = lastLabel;
        }
        const text = lastLabel;
        const shown = text ? Math.max(0, Math.min(1, lock.x)) : 0;
        label.style.transform =
          `translate3d(${left.toFixed(2)}px, ${(top - 8).toFixed(2)}px, 0) translateY(-100%) ` +
          `translateY(${((1 - shown) * 4).toFixed(2)}px)`;
        label.style.opacity = shown.toFixed(3);
      }

      const onTarget = s.cursorColorOnTarget;
      const mix = onTarget ? Math.max(0, Math.min(1, lock.x)) : 0;
      const color = onTarget && mix > 0 ? mixColor(s.cursorColor, onTarget, mix) : s.cursorColor;
      if (color !== lastColor) {
        root.style.setProperty('--target-cursor-color', color);
        lastColor = color;
      }
      const bg = s.cursorBg ?? '';
      if (bg !== lastBg) {
        root.style.setProperty('--target-cursor-bg', bg);
        lastBg = bg;
      }
      root.style.opacity = Math.max(0, Math.min(1, presence.x)).toFixed(3);

      const resting =
        !pointer.inside &&
        presence.x < 0.002 &&
        Math.abs(presence.v) < 0.002 &&
        Math.abs(lock.x) < 0.002 &&
        Math.abs(press.x) < 0.002;
      const spinning = pointer.inside && !locked && spinSpeed > 0.0001;
      const moving =
        Math.abs(centerX.v) + Math.abs(centerY.v) + Math.abs(halfW.v) + Math.abs(halfH.v) + Math.abs(turn.v) > 0.01 ||
        Math.abs(goalX - centerX.x) + Math.abs(goalY - centerY.x) > 0.05 ||
        Math.abs(lock.v) + Math.abs(press.v) + Math.abs(presence.v) > 0.001;
      if (!resting && (spinning || moving || locked)) raf = requestAnimationFrame(frame);
      else last = 0;
    };

    const wake = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    wakeRef.current = () => {
      hideCursor();
      wake();
    };

    const insideScope = (x: number, y: number, element?: Element | null) => {
      const scope = scopeOf();
      if (!scope) return true;
      if (element && scope.contains(element)) return true;
      const box = scope.getBoundingClientRect();
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    };

    /** 触屏：点一下就锁住，松手后停 touchHold 毫秒自行淡出 */
    const clearTouchTimer = () => {
      if (touchTimer) {
        window.clearTimeout(touchTimer);
        touchTimer = 0;
      }
    };
    const releaseLater = () => {
      clearTouchTimer();
      touchTimer = window.setTimeout(() => {
        touchTimer = 0;
        pointer.inside = false;
        pointer.pressed = false;
        lockOn(null);
        hideCursor();
        wake();
      }, Math.max(160, settingsRef.current.touchHold));
    };

    const onPointerMove = (event: PointerEvent) => {
      const type = event.pointerType;
      if (!fine) {
        // 触屏：只在一次点按会话内跟随手指，平时完全不出现
        if (type === 'touch') {
          if (!pointer.inside) return;
          pointer.x = event.clientX;
          pointer.y = event.clientY;
          lockOn(findTarget(pointer.x, pointer.y, event.target as Element | null));
          wake();
        }
        return;
      }
      if (type && type !== 'mouse') return;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      const inside = insideScope(pointer.x, pointer.y, event.target as Element | null);
      if (inside !== pointer.inside) {
        pointer.inside = inside;
        hideCursor();
      }
      lockOn(inside ? findTarget(pointer.x, pointer.y, event.target as Element | null) : null);
      wake();
    };

    const onPointerDown = (event: PointerEvent) => {
      const type = event.pointerType;
      if (!fine) {
        if (type !== 'touch') return;
        clearTouchTimer();
        pointer.x = event.clientX;
        pointer.y = event.clientY;
        pointer.inside = true;
        pointer.pressed = true;
        pointer.seen = true;
        lockOn(findTarget(pointer.x, pointer.y, event.target as Element | null));
        hideCursor();
        wake();
        return;
      }
      if (type && type !== 'mouse') return;
      pointer.pressed = true;
      wake();
    };

    const onPointerUp = (event: PointerEvent) => {
      const type = event.pointerType;
      if (!fine) {
        if (type !== 'touch') return;
        pointer.pressed = false;
        releaseLater();
        wake();
        return;
      }
      if (type && type !== 'mouse') return;
      pointer.pressed = false;
      wake();
    };

    const onLeave = () => {
      pointer.inside = false;
      pointer.pressed = false;
      lockOn(null);
      hideCursor();
      wake();
    };

    const onScroll = () => {
      if (!pointer.inside) return;
      lockOn(findTarget(pointer.x, pointer.y));
      wake();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('pointercancel', onPointerUp, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);

    return () => {
      cancelAnimationFrame(raf);
      clearTouchTimer();
      wakeRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('scroll', onScroll, { capture: true });
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
      lastScope?.removeAttribute('data-target-cursor-scope');
      style.remove();
    };
  }, [mode]);

  useEffect(() => {
    wakeRef.current?.();
  });

  if (mode === 'none') return null;

  return createPortal(
    <div
      ref={rootRef}
      className="target-cursor"
      data-mode={mode}
      style={{ mixBlendMode: mode === 'mouse' ? blendMode : undefined, opacity: 0 }}
      aria-hidden="true"
    >
      {CORNER_ANGLES.map((angle, i) => (
        <span
          key={angle}
          ref={(element) => {
            cornerRefs.current[i] = element;
          }}
          className="target-cursor__corner"
        />
      ))}
      <span ref={dotRef} className="target-cursor__dot" />
      <span ref={labelRef} className="target-cursor__label" />
    </div>,
    getPortalRoot()
  );
};

export default TargetCursor;
