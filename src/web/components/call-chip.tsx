import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
  type ReactNode,
} from 'react';
import { Check, FileText, PencilLine, RefreshCw, Search, Terminal } from 'lucide-react';
import './call-chip.css';

/**
 * 调用状态胶囊（React Bits 的 CallChip，按本项目改造）。
 *
 * 与原版的三处差异：
 * 1. 不依赖 @hugeicons：图标一律走项目已有的 lucide-react
 *    （terminal/file/search/edit + 对勾 + 重试）；
 * 2. 进度填充不用 color-mix()（旧内核会整块透明 → 看不见进度），
 *    改成 background-color + opacity 两层，效果等价且到处都能渲染；
 * 3. 完成态的绿色水波用 @keyframes 从底部升起，而不是把 clip-path 直接定到
 *    inset(100% 0 0 0) 让它「排空」—— 完成要的是铺满，不是消失。
 *
 * 状态机：running 擦过 90% 并走毫秒计时；done 铺满 + 绿色水波 + 图标滚成对勾；
 * error 冻结在当前进度 + 红色底 + 抖动 + 图标滚成重试（给了 onRetry 就整颗可点）。
 */

export type CallChipStatus = 'idle' | 'running' | 'done' | 'error';
export type CallChipIcon = 'terminal' | 'file' | 'search' | 'edit';

export interface CallChipProps {
  /** 工具字形；结算时它会滚出去。字符串走内置四选一，也可直接塞 ReactNode */
  icon?: CallChipIcon | ReactNode;
  name?: string;
  argument?: string;
  /** 等宽小字附注（如「1.23 MB / 4.56 MB」），排在 argument 之后、计时之前 */
  meta?: string;
  status?: CallChipStatus;
  /**
   * 外部实时进度（0~1）。给了它，running 期间的填充条就由它逐帧驱动，
   * 不再走 expectedMs 那条「按预计耗时擦到 90% 就停在那干等」的固定斜坡；
   * 只有拿不到真实进度时（不给这个 prop）才回退到原版的停泊机制。
   * 完成 / 失败仍由 status 决定：done 铺满、error 冻在当前位置。
   */
  progress?: number;
  /** 填充擦到 90% 停泊位所需毫秒，按你预计的耗时给 */
  expectedMs?: number;
  /** 胶囊高度（px），字号 / 内距 / 字形跟着走 */
  size?: number;
  radius?: number;
  color?: string;
  surfaceColor?: string;
  /** 胶囊描边色，默认透明（原版没有描边） */
  borderColor?: string;
  progressColor?: string;
  progressOpacity?: number;
  doneColor?: string;
  errorColor?: string;
  washOpacity?: number;
  /** 失败抖动幅度（px），0 表示只染色不抖 */
  shake?: number;
  showTimer?: boolean;
  onRetry?: () => void;
  /** 给了它，running 状态下字形区盖一层透明取消热区（点击 = 取消） */
  onCancel?: () => void;
  cancelLabel?: string;
  className?: string;
  style?: CSSProperties;
}

type Glyph = 'tool' | 'check' | 'retry';
type LucideIcon = ComponentType<{ size?: number; strokeWidth?: number; className?: string; 'aria-hidden'?: boolean }>;

const HOLD_AT = 0.9;
const SHAKE = [0, -1, 1, -0.66, 0.66, -0.33, 0];
const ICONS: Record<CallChipIcon, LucideIcon> = {
  terminal: Terminal as LucideIcon,
  file: FileText as LucideIcon,
  search: Search as LucideIcon,
  edit: PencilLine as LucideIcon,
};
const WORDS: Record<CallChipStatus, string> = { running: '进行中', done: '已完成', error: '已失败', idle: '排队中' };

const fmt = (ms: number) => (ms < 10000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const glyphOf = (s: CallChipStatus): Glyph => (s === 'done' ? 'check' : s === 'error' ? 'retry' : 'tool');

export function CallChip({
  icon = 'terminal',
  name = 'bash',
  argument = 'npm test',
  meta,
  status = 'running',
  progress,
  expectedMs = 2500,
  size = 34,
  radius = 10,
  color = 'hsl(var(--foreground))',
  surfaceColor = 'rgb(var(--kk-glass-base) / 0.82)',
  borderColor = 'hsl(var(--border) / 0.6)',
  progressColor = 'rgb(var(--kk-comp-rgb))',
  progressOpacity = 0.08,
  doneColor = 'hsl(var(--success))',
  errorColor = 'hsl(var(--destructive))',
  washOpacity = 0.14,
  shake = 6,
  showTimer = true,
  onRetry,
  onCancel,
  cancelLabel,
  className = '',
  style,
}: CallChipProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLSpanElement>(null);
  const mountedRef = useRef(false);
  const fraction = useRef(0);
  const clock = useRef({ ms: 0 });
  const shakeAnim = useRef<Animation | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const [mounted, setMounted] = useState(false);
  const [pressed, setPressed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const roll = useRef<{ cur: Glyph; prev: Glyph | null }>({ cur: glyphOf(status), prev: null });
  if (glyphOf(status) !== roll.current.cur) roll.current = { cur: glyphOf(status), prev: roll.current.cur };
  const live = progress !== undefined;
  const liveRef = useRef(live);
  liveRef.current = live;
  const progressRef = useRef(progress ?? 0);
  progressRef.current = progress ?? 0;

  const setFraction = (f: number, instant: boolean) => {
    const fill = fillRef.current;
    if (!fill) return;
    fraction.current = f;
    if (instant) fill.style.transition = 'none';
    fill.style.transform = `scaleX(${f})`;
    if (instant) {
      void fill.getBoundingClientRect();
      fill.style.transition = '';
    }
  };

  const apply = (s: CallChipStatus, animate: boolean) => {
    if (s === 'running') {
      shakeAnim.current?.cancel();
      // 有实时进度就交给它，别走那条「擦到 90% 然后干等」的斜坡
      if (liveRef.current) {
        setFraction(Math.min(1, Math.max(0, progressRef.current)), true);
        return;
      }
      setFraction(0, true);
      if (animate) setFraction(HOLD_AT, false);
    } else if (s === 'done') {
      setFraction(1, !animate);
    } else if (s === 'error') {
      const fill = fillRef.current;
      const live = fill ? new DOMMatrix(getComputedStyle(fill).transform).a : fraction.current;
      setFraction(Math.min(1, Math.max(0, live)), true);
      if (animate && shake > 0 && !reduceMotion() && rootRef.current) {
        shakeAnim.current = rootRef.current.animate(
          SHAKE.map((k) => ({ transform: `translateX(${k * shake}px)`, easing: 'cubic-bezier(0.77, 0, 0.175, 1)' })),
          { duration: 450, composite: 'add' },
        );
      }
    } else setFraction(0, true);
  };

  useEffect(() => {
    mountedRef.current = true;
    setMounted(true);
    /*
     * 必须等下一帧再起步：.call-chip:not([data-mounted]) 给 fill 挂了
     * transition:none，而 data-mounted 要等这次 setState 提交后才落到 DOM 上。
     * 同步起跑的话「0 → 90%」会被判成无过渡、直接跳到终点，进度擦除就看不见了。
     */
    let raf = requestAnimationFrame(() => {
      if (!mountedRef.current) return;
      apply(statusRef.current, statusRef.current === 'running');
    });
    if (typeof raf !== 'number') raf = 0;
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      shakeAnim.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    if (mountedRef.current) apply(status, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // 实时进度：running 期间每来一个新值就把填充条推到那个位置（短过渡，看着是连续的）
  useEffect(() => {
    if (!live || status !== 'running') return;
    setFraction(Math.min(1, Math.max(0, progress ?? 0)), false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, progress, status]);

  useEffect(() => {
    const write = (ms: number) => {
      clock.current.ms = ms;
      if (timerRef.current) timerRef.current.textContent = fmt(ms);
    };
    if (status !== 'running') {
      if ((status === 'idle' || !clock.current.ms) && timerRef.current) timerRef.current.textContent = '—';
      return undefined;
    }
    const startedAt = performance.now();
    write(0);
    if (reduceMotion()) {
      const id = window.setInterval(() => write(performance.now() - startedAt), 100);
      return () => {
        window.clearInterval(id);
        write(performance.now() - startedAt);
      };
    }
    let raf = 0;
    const tick = () => {
      write(performance.now() - startedAt);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      write(performance.now() - startedAt);
    };
  }, [status]);

  useEffect(() => {
    const ms = showTimer && clock.current.ms ? Math.round(clock.current.ms) : 0;
    const when = status === 'done' && ms ? `，用时 ${ms} ms` : status === 'error' && ms ? `，${ms} ms 后失败` : '';
    setAnnounce(`${name} ${argument}，${WORDS[status] ?? status}${when}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const font = Math.max(11, Math.round(size * 0.38));
  const glyphState = (g: Glyph) => (g === roll.current.cur ? 'in' : g === roll.current.prev ? 'out' : undefined);
  const ToolIcon = typeof icon === 'string' ? ICONS[icon as CallChipIcon] ?? ICONS.terminal : null;
  const iconSize = font + 2;

  return (
    <span
      ref={rootRef}
      role="status"
      aria-busy={status === 'running' || undefined}
      data-status={status}
      data-live={live ? '' : undefined}
      data-mounted={mounted ? '' : undefined}
      data-pressed={pressed ? '' : undefined}
      className={`call-chip${className ? ` ${className}` : ''}`}
      style={
        {
          '--cc-size': `${size}px`,
          '--cc-font': `${font}px`,
          '--cc-pad': `${Math.round(size * 0.35)}px`,
          '--cc-gap': `${Math.round(font * 0.55)}px`,
          '--cc-radius': `${radius}px`,
          '--cc-color': color,
          '--cc-surface': surfaceColor,
          '--cc-border': borderColor,
          '--cc-progress': progressColor,
          '--cc-progress-opacity': `${progressOpacity}`,
          '--cc-done': doneColor,
          '--cc-error': errorColor,
          '--cc-wash-opacity': `${washOpacity}`,
          '--cc-expected': `${expectedMs}ms`,
          ...style,
        } as CSSProperties
      }
    >
      <span ref={fillRef} className="call-chip__fill" aria-hidden="true" />
      {status === 'running' && onCancel ? (
        <button
          type="button"
          className="call-chip__cancel"
          aria-label={cancelLabel || '取消'}
          onClick={() => onCancel()}
        />
      ) : null}
      <span className="call-chip__slot" aria-hidden="true">
        <span className="call-chip__glyph" data-state={glyphState('tool')}>
          {ToolIcon ? <ToolIcon size={iconSize} strokeWidth={1.8} aria-hidden /> : icon}
        </span>
        <span className="call-chip__glyph" data-state={glyphState('check')}>
          <Check size={iconSize} strokeWidth={2.4} aria-hidden />
        </span>
        <span className="call-chip__glyph" data-state={glyphState('retry')}>
          <RefreshCw size={iconSize} strokeWidth={2} aria-hidden />
        </span>
      </span>
      <span className="call-chip__name" aria-hidden="true">
        {name}
      </span>
      <span className="call-chip__arg" aria-hidden="true">
        {argument}
      </span>
      {meta ? (
        <span className="call-chip__meta" aria-hidden="true">
          {meta}
        </span>
      ) : null}
      {showTimer ? (
        <span ref={timerRef} className="call-chip__timer" aria-hidden="true">
          0 ms
        </span>
      ) : null}
      {status === 'error' && onRetry ? (
        <button
          type="button"
          className="call-chip__retry"
          aria-label={`重试 ${name} ${argument}`}
          onClick={() => onRetry()}
          onPointerDown={() => setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerCancel={() => setPressed(false)}
        />
      ) : null}
      <span className="call-chip__sr">{announce}</span>
    </span>
  );
}

export default CallChip;
