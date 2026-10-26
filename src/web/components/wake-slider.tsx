import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import './wake-slider.css';

/**
 * 尾迹滑动条（React Bits 的 WakeSlider，按本项目改造）。
 *
 * 唯一改动：**不依赖 motion**。原版用 useMotionValue / useSpring / useVelocity /
 * useMotionValueEvent / frame.render 串起两级弹簧（手柄跟随 + 速度平滑），
 * 这里换成一条自写的固定步长积分器（见 sim），数值与观感对齐：
 *   - head = 位置弹簧，stiffness=(SETTLE/glide)²，damping=2*(SETTLE/glide)（临界阻尼）；
 *   - speed = 速度弹簧，跟的是 head 的瞬时速度 d(head)/dt，stiffness=(2000/smoothing)²，
 *     damping=2.5*(2000/smoothing)（略过阻尼）。
 * 只在「还在动」的时候跑 rAF，彻底静止后自动停，不常驻占帧。
 *
 * 拖动时手柄两侧会被拉起一道尾迹（身后的更宽，由 skew 决定），速度越快抬得越高。
 */

const SETTLE = 9.23;
const FULL_SPEED = 320;
const MIN_REACH = 1.5;
const FLAT = 0.002;
/** 积分定步长：1/480 s。最大的 stiffness 出现在 glide 极小时，这个步长下仍然稳定 */
const SUB_DT = 1 / 480;
const MAX_SUB = 24;

export interface WakeSliderProps {
  id?: string;
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /** 轨道由几根竖条组成。量出轨道宽度后会被 cellWidth 重算，这个值只作为首帧兜底 */
  bars?: number;
  /*
   * 竖条的目标宽度（px）。轨道变宽时优先「加根数」而不是把每根拉胖——
   * 固定根数的话，桌面端一根能有 17px 宽、12px 高，读起来就是横向的小条；
   * 手机端到不了那么宽，于是同一套 UI 在两端形态不一致。现在按宽度反推根数，
   * 两端每格都落在同一档尺寸上。minBars / maxBars 是根数上下限。
   */
  cellWidth?: number;
  minBars?: number;
  maxBars?: number;
  /** 静止时「高 ≥ 宽 × cellRatio」才算竖向小长方形；够不着就把静止高度抬起来补 */
  cellRatio?: number;
  /** 竖条抬起后的最大高度（px） */
  height?: number;
  /** 静止时的竖条高度（px） */
  restHeight?: number;
  gap?: number;
  fillColor?: string;
  trackColor?: string;
  /** 抬起的竖条额外叠的一层色调；留空则不叠 */
  crestColor?: string;
  sensitivity?: number;
  /** 全速时尾迹的半宽（单位：竖条根数） */
  reach?: number;
  skew?: number;
  glide?: number;
  smoothing?: number;
  showValue?: boolean;
  formatValue?: (value: number) => string;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smoothstep = (s: number) => s * s * (3 - 2 * s);
const toPct = (v: number, min: number, max: number) => (max > min ? ((v - min) / (max - min)) * 100 : 0);
const snap = (v: number, min: number, max: number, step: number) => {
  if (!(max > min)) return min;
  if (!(step > 0)) return clamp(v, min, max);
  const lastWhole = min + Math.floor(+((max - min) / step).toFixed(6)) * step;
  const grid = clamp(Math.round((v - min) / step) * step + min, min, lastWhole);
  return +(lastWhole < max && Math.abs(v - max) <= Math.abs(v - grid) ? max : grid).toFixed(6);
};

function usePrefersReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduce(mq.matches);
    const onChange = () => setReduce(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return reduce;
}

export function WakeSlider({
  id,
  value: valueProp,
  defaultValue = 50,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  bars = 32,
  cellWidth = 6,
  minBars = 14,
  // 上限给得宽：桌面端设置页一排能有 1000px 出头，写死根数时一根会被拉到 10px+，
  // 「加根数」比「把一根拉胖」更符合原设计（每格 6px 上下）
  maxBars = 160,
  cellRatio = 2.2,
  height = 56,
  restHeight = 12,
  gap = 4,
  fillColor = 'rgb(var(--kk-comp-rgb))',
  trackColor = 'hsl(var(--foreground) / 0.16)',
  crestColor = '',
  sensitivity = 1,
  reach = 6,
  skew = 0.6,
  glide = 0.3,
  smoothing = 100,
  showValue = false,
  formatValue,
  disabled = false,
  ariaLabel = 'Value',
  className = '',
}: WakeSliderProps) {
  const [inner, setInner] = useState(defaultValue);
  const value = clamp(valueProp ?? inner, min, max);
  const pct = toPct(value, min, max);
  const reduce = usePrefersReducedMotion();
  const format = formatValue ?? String;

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const barEls = useRef<(HTMLSpanElement | null)[]>([]);
  const crestEls = useRef<(HTMLSpanElement | null)[]>([]);
  const pointerId = useRef<number | null>(null);
  const lastAmp = useRef(0);
  const latest = useRef(value);
  latest.current = value;

  /** 两级弹簧的状态：head 追位置、speed 追 head 的速度 */
  const sim = useRef({ head: pct, headV: 0, speed: 0, speedV: 0, target: pct });
  const raf = useRef(0);
  const lastT = useRef(0);
  const running = useRef(false);

  /** 轨道实测宽度（px）。首帧还没布局完是 0，那时候先用 props 给的 bars 顶上 */
  const [trackW, setTrackW] = useState(0);
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return undefined;
    const measure = () => setTrackW(el.getBoundingClientRect().width);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** 竖条根数：按「每根大约 cellWidth 宽」反推，宽度变了根数跟着变 */
  const count = useMemo(() => {
    if (!trackW) return Math.max(1, bars);
    // 单格再宽也不能超过 height / cellRatio，否则抬到顶都不是竖向的
    const target = Math.min(cellWidth, Math.max(2, height / Math.max(0.5, cellRatio)));
    const n = Math.floor((trackW + gap) / (target + gap));
    return Math.round(clamp(n, Math.min(minBars, maxBars), maxBars));
  }, [trackW, gap, cellWidth, height, cellRatio, minBars, maxBars, bars]);

  /** 均分之后每一根的实际宽度 */
  const cellW = trackW ? Math.max(1, (trackW - gap * (count - 1)) / count) : Math.min(cellWidth, 6);

  /*
   * 静止时的视觉高度（px，即 scaleY 之后的高度）。
   * 至少要到「宽度 × cellRatio」，保证每一格在任何屏宽下都是竖向的小长方形；
   * 宽度够窄时仍然沿用调用方给的 restHeight，观感不变。
   */
  const restVisual = Math.min(height - 1, Math.max(Math.min(restHeight, height - 1), cellW * cellRatio));
  const rest = restVisual / height;

  /*
   * 这两个几何量必须进 ref：paint 会被「上一次渲染」的 tick（rAF 回调）持有，
   * 如果它按闭包里的旧 count / 旧 rest 落笔，就会把刚纠正过的形态又压回去 ——
   * 屏宽一变、静止比例被抬起来之后，画面上仍看得见旧的那组 scaleY。
   * 走 ref 则无论哪个闭包落笔，写的都是当前这一帧的几何。
   */
  const geom = useRef({ count, rest });
  geom.current = { count, rest };

  const paint = useCallback(
    (force = false) => {
      const { count: n, rest: r0 } = geom.current;
      const s = sim.current;
      const h = ((reduce ? s.target : s.head) / 100) * (n - 1);
      const v = reduce ? 0 : s.speed;
      const amp = smoothstep(clamp((Math.abs(v) * sensitivity) / FULL_SPEED, 0, 1));
      const dir = Math.sign(v) || 1;
      const r = MIN_REACH + (reach - MIN_REACH) * amp;
      const behind = r * (1 + skew);
      const ahead = r * (1 - 0.5 * skew);
      const lit = Math.round(h);
      const flat = !force && amp < FLAT && lastAmp.current < FLAT;
      for (let i = 0; i < n; i += 1) {
        const el = barEls.current[i];
        if (!el) continue;
        const on = i <= lit ? 'true' : 'false';
        if (el.dataset.on !== on) el.dataset.on = on;
        if (flat) continue;
        const d = i - h;
        const R = d * dir < 0 ? behind : ahead;
        const lift = Math.abs(d) < R ? amp * Math.cos((Math.PI * d) / (2 * R)) ** 2 : 0;
        el.style.transform = `scaleY(${r0 + lift * (1 - r0)})`;
        const crest = crestEls.current[i];
        if (crest) crest.style.opacity = String(lift);
      }
      lastAmp.current = amp;
    },
    [reduce, reach, sensitivity, skew],
  );

  /** 推进一步固定步长；返回是否还需要继续跑 */
  const advance = useCallback(() => {
    const s = sim.current;
    const w0 = SETTLE / Math.max(0.01, glide);
    const wv = 2000 / Math.max(1, smoothing);
    const aHead = w0 * w0 * (s.target - s.head) - 2 * w0 * s.headV;
    s.headV += aHead * SUB_DT;
    s.head += s.headV * SUB_DT;
    const rawSpeed = s.headV;
    const aSpeed = wv * wv * (rawSpeed - s.speed) - 2.5 * wv * s.speedV;
    s.speedV += aSpeed * SUB_DT;
    s.speed += s.speedV * SUB_DT;
  }, [glide, smoothing]);

  const settleEnough = useCallback(() => {
    const s = sim.current;
    const amp = smoothstep(clamp((Math.abs(s.speed) * sensitivity) / FULL_SPEED, 0, 1));
    return amp < FLAT && Math.abs(s.target - s.head) < 0.01 && Math.abs(s.headV) < 0.05;
  }, [sensitivity]);

  const stop = useCallback(() => {
    running.current = false;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = 0;
  }, []);

  const tick = useCallback(
    (now: number) => {
      const dt = Math.min(0.1, (now - lastT.current) / 1000 || 0);
      lastT.current = now;
      const n = Math.min(MAX_SUB, Math.max(1, Math.ceil(dt / SUB_DT)));
      for (let i = 0; i < n; i += 1) advance();
      paint();
      if (settleEnough()) {
        // 收尾：再画一次把竖条按回静止高度，然后停机
        paint(true);
        stop();
        return;
      }
      raf.current = requestAnimationFrame(tick);
    },
    [paint, settleEnough, advance, stop],
  );

  /** 目标变了 / 有交互 → 起机（已在跑就只更新目标） */
  const wake = useCallback(() => {
    if (reduce) {
      paint(true);
      return;
    }
    if (running.current) return;
    running.current = true;
    lastT.current = performance.now();
    raf.current = requestAnimationFrame(tick);
  }, [paint, reduce, tick]);

  useEffect(() => {
    sim.current.target = pct;
    wake();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pct]);

  useLayoutEffect(() => {
    paint(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  useEffect(() => stop, [stop]);

  /** 键盘跳档：直接把弹簧与目标都落到终点，不做补间（原版的 jump） */
  const jumpTo = (p: number) => {
    const s = sim.current;
    s.head = p;
    s.headV = 0;
    s.speed = 0;
    s.speedV = 0;
    s.target = p;
    lastAmp.current = 0;
    paint(true);
  };

  const commit = (next: number) => {
    const clean = snap(next, min, max, step);
    if (clean === latest.current) return;
    latest.current = clean;
    if (valueProp === undefined) setInner(clean);
    onChange?.(clean);
  };
  const commitFromX = (x: number) => {
    const track = trackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    let ratio = clamp((x - rect.left) / rect.width, 0, 1);
    if (getComputedStyle(track).direction === 'rtl') ratio = 1 - ratio;
    commit(min + ratio * (max - min));
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || pointerId.current !== null) return;
    pointerId.current = e.pointerId;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* 指针已释放等情况，忽略 */ }
    rootRef.current?.removeAttribute('data-instant');
    handleRef.current?.focus({ preventScroll: true });
    wake();
    commitFromX(e.clientX);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId === pointerId.current) commitFromX(e.clientX);
  };
  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerId !== pointerId.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    pointerId.current = null;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const jumps: Record<string, number> = {
      ArrowRight: value + step,
      ArrowUp: value + step,
      ArrowLeft: value - step,
      ArrowDown: value - step,
      PageUp: value + step * 10,
      PageDown: value - step * 10,
      Home: min,
      End: max,
    };
    if (!(e.key in jumps)) return;
    e.preventDefault();
    const clean = snap(jumps[e.key], min, max, step);
    rootRef.current?.setAttribute('data-instant', 'true');
    jumpTo(toPct(clean, min, max));
    commit(clean);
    // 跳档是瞬时的，别让它残留到下一次拖动
    requestAnimationFrame(() => rootRef.current?.removeAttribute('data-instant'));
  };

  const barNodes = useMemo(() => {
    barEls.current.length = count;
    crestEls.current.length = count;
    return Array.from({ length: count }, (_, i) => (
      <span
        key={i}
        ref={(el) => {
          barEls.current[i] = el;
        }}
        className="wake-slider__bar"
      >
        {crestColor ? (
          <span
            ref={(el) => {
              crestEls.current[i] = el;
            }}
            className="wake-slider__crest"
          />
        ) : null}
      </span>
    ));
  }, [count, crestColor]);

  return (
    <div
      ref={rootRef}
      className={`wake-slider${className ? ` ${className}` : ''}`}
      aria-disabled={disabled || undefined}
      style={
        {
          '--ws-fill': fillColor,
          '--ws-track': trackColor,
          '--ws-crest': crestColor || fillColor,
          '--ws-height': `${height}px`,
          '--ws-gap': `${gap}px`,
          '--ws-rest': rest,
        } as CSSProperties
      }
    >
      <div
        ref={trackRef}
        className="wake-slider__track"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        {barNodes}
        <button
          ref={handleRef}
          id={id}
          type="button"
          role="slider"
          className="wake-slider__handle"
          tabIndex={disabled ? -1 : 0}
          aria-label={ariaLabel}
          aria-valuemin={min}
          aria-valuemax={max}
          aria-valuenow={value}
          aria-valuetext={format(value)}
          aria-disabled={disabled || undefined}
          onKeyDown={onKeyDown}
        />
      </div>
      {showValue ? (
        <span className="wake-slider__value" aria-hidden="true">
          {format(value)}
        </span>
      ) : null}
    </div>
  );
}

export default WakeSlider;
