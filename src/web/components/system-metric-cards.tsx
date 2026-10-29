import { useEffect, useId, useState, type MouseEvent, type ReactNode } from 'react';
import { getDeviceTier } from '@/lib/device-tier';
import { useT } from '@/lib/i18n';

/**
 * 系统监控可视化卡片：
 *  - ColumnHistogramCard：CPU 柱状历史条（向左滚动）
 *  - SparklineCard：内存趋势面积图
 *  - SegmentBarCard：磁盘方块点阵（10×5）
 *  - CoreGridCard：CPU 核心点阵（备选，暂未使用）
 * 均固定最小高度，避免数值抖动导致回流。
 */

const CARD = 'kk-glass flex min-h-[15.5rem] flex-col gap-2 rounded-[1.35rem] px-4 py-4';

/**
 * 占用色阶：低=组件色、中=警示、高=危险。
 * 走 CSS 变量：正常态跟「组件及按钮」配色走，阈值色走语义 token，
 * 暗色预设下也不会出现"低占用看不清"的死色。
 */
function loadColor(pct: number): string {
  if (pct >= 80) return 'hsl(var(--destructive))';
  if (pct >= 50) return 'hsl(var(--warning))';
  return 'rgb(var(--kk-comp-rgb))';
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function CardHead({ label, value, unit = '%' }: { label: string; value: number; unit?: string }) {
  const pct = clampPct(value);
  const display = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[13px] font-medium text-slate-500">{label}</span>
      <span className="flex items-baseline text-slate-800">
        <span className="text-[1.7rem] font-bold tabular-nums leading-none tracking-tight">{display}</span>
        <span className="ml-0.5 text-sm font-semibold text-slate-500">{unit}</span>
      </span>
    </div>
  );
}

function CardHint({ text }: { text: ReactNode }) {
  return (
    <p className="mt-auto flex h-8 items-center text-[11px] tabular-nums text-muted-foreground">{text}</p>
  );
}

/* ============ 方案 4：CPU 核心点阵 ============ */
export function CoreGridCard({
  label, systemPercent, perCore, cores, coresOnline, hint,
}: {
  label: string;
  systemPercent: number;
  perCore?: number[];
  cores: number;
  coresOnline?: number;
  hint: string;
}) {
  const t = useT();
  // 无每核数据时退化：用总占用铺满 cores 个格子
  const list = perCore && perCore.length > 0
    ? perCore
    : Array.from({ length: Math.max(1, cores) }, () => systemPercent);
  const online = coresOnline ?? list.length;

  return (
    <div className={CARD}>
      <CardHead label={label} value={systemPercent} />
      <div className="flex flex-1 items-center py-1">
        <div className="flex flex-wrap content-center gap-1.5">
          {list.map((v, i) => {
            const pct = clampPct(v);
            const offline = i >= online;
            return (
              <div
                key={i}
                title={offline ? t('dashboard.coreOffline', { i }) : t('dashboard.coreLoad', { i, pct: Math.round(pct) })}
                className="h-6 w-6 rounded-[6px] border border-white/50 transition-[background-color] duration-500"
                style={{
                  background: offline
                    ? 'hsl(var(--foreground) / 0.1)'
                    : loadColor(pct),
                  opacity: offline ? 0.5 : 0.32 + (pct / 100) * 0.68,
                }}
              />
            );
          })}
        </div>
      </div>
      <CardHint text={hint} />
    </div>
  );
}

/** 自适应平滑折线：相邻点落差小 → Catmull-Rom 曲线；落差 ≥ bigDeltaPx → 直线段（折线）。
 *  既让小幅波动圆润、又让尖峰保持棱角，还顺带规避了样条在陡变处的过冲。 */
function smoothLinePath(pts: { x: number; y: number }[], bigDeltaPx: number): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  const big = Math.max(1, bigDeltaPx);
  let d = `M${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    // 平滑系数：段内落差越大越接近 0（走直线），越小越接近 1（走曲线）
    const k = Math.max(0, Math.min(1, 1 - Math.abs(p2.y - p1.y) / big));
    if (k < 0.02) {
      d += ` L${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
      continue;
    }
    const c1x = p1.x + ((p2.x - p0.x) / 6) * k;
    const c1y = p1.y + ((p2.y - p0.y) / 6) * k;
    const c2x = p2.x - ((p3.x - p1.x) / 6) * k;
    const c2y = p2.y - ((p3.y - p1.y) / 6) * k;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2.x.toFixed(2)},${p2.y.toFixed(2)}`;
  }
  return d;
}

/** 把折线/曲线路径向下闭合成面积（落到底边 bottomY） */
function areaFromLine(lineD: string, pts: { x: number; y: number }[], bottomY: number): string {
  if (!lineD || pts.length < 2) return '';
  const last = pts[pts.length - 1];
  const first = pts[0];
  return `${lineD} L${last.x.toFixed(2)},${bottomY} L${first.x.toFixed(2)},${bottomY} Z`;
}

/** 按时间线性插值取值（times 升序）：目标时刻落在两采样之间时平滑过渡，
 *  用于让「右边缘末端点」随时间连续移动，而不是每来一个采样才跳一下。 */
function valueAtTime(times: number[], vals: number[], target: number): number | null {
  const n = Math.min(times.length, vals.length);
  if (n === 0) return null;
  if (target <= times[0]) return vals[0];
  if (target >= times[n - 1]) return vals[n - 1];
  for (let i = n - 1; i >= 0; i--) {
    if (times[i] <= target) {
      const t0 = times[i];
      const t1 = times[i + 1] ?? t0;
      const v0 = vals[i];
      const v1 = vals[i + 1] ?? v0;
      return t1 === t0 ? v0 : v0 + (v1 - v0) * ((target - t0) / (t1 - t0));
    }
  }
  return vals[0];
}

/** 动画时钟：active 时每一 rAF 帧回传一次 Date.now()（随显示器刷新率，通常 45–60Hz），
 *  驱动按真实时间平滑左滚；标签页切后台时浏览器会自动暂停 rAF，不空耗 CPU。 */
function useAnimationClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const loop = () => {
      setNow(Date.now());
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return now;
}

/* ====== 面积趋势图（双序列叠加 + 按真实时间平滑滚动 + 自适应曲线/折线 + 悬浮读数） ====== */
export function SparklineCard({
  label, history, currentPercent, color = 'rgb(var(--kk-logo-rgb))', hint,
  history2, current2, color2 = 'rgb(var(--kk-logo-alt-rgb))', legend,
  times, windowMs = 60_000, curveMaxDeltaPct = 10, delayMs = 1200, windowLabel,
}: {
  label: string;
  history: number[];
  currentPercent: number;
  color?: string;
  hint: ReactNode;
  /** 可选第二条序列（如 kakake 进程占用），与主序列共用坐标叠加显示 */
  history2?: number[];
  current2?: number;
  color2?: string;
  /** 图例文字：primary=主色序列名，secondary=副色序列名 */
  legend?: { primary: string; secondary: string };
  /** 各采样点时间戳（与 history 对齐）；提供后按真实时间平滑左滚 */
  times?: number[];
  /** 时间窗口（毫秒），默认 60s */
  windowMs?: number;
  /** 落差阈值（百分点）：段内变化 ≥ 它画折线，否则画平滑曲线 */
  curveMaxDeltaPct?: number;
  /** 渲染延迟（毫秒）：画面只呈现 delayMs 之前的数据，让右边缘始终有「已到货」的采样可画，
   *  从而右边缘也能逐帧平滑滚入，而不是等新采样到了才一秒一跳。取略大于采样间隔即可。 */
  delayMs?: number;
  /** 图例行右侧窗口说明，如「最近 60 秒」 */
  windowLabel?: string;
}) {
  const t = useT();
  const w = 240;
  const h = 96;
  const pad = 3;
  const span = w - pad * 2;
  const yOf = (v: number) => h - pad - (clampPct(v) / 100) * (h - pad * 2);
  const bigDeltaPx = (curveMaxDeltaPct / 100) * (h - pad * 2);

  // 低端设备（.kk-lowtier）不跑逐帧动画：仅在收到新数据时重绘，省电省 CPU
  const [animate] = useState(() => getDeviceTier() !== 'low');
  const clock = useAnimationClock(animate);
  // animate 时用 rAF 时钟（随刷新率 45–60fps 平滑滚动）；否则用每次渲染的实时时间（随数据到达刷新）
  const now = animate ? clock : Date.now();

  const hasTimes = Array.isArray(times) && times.length > 0;
  // 右边缘代表的时刻比真实 now 落后 delayMs：此刻的采样此时还在屏幕右侧「排队」，
  // 随 renderNow 推进再平滑滚入可视区——右边缘因此永远有已到货的数据可画，不再一秒一跳。
  const renderNow = now - delayMs;

  /** 一条序列 → 坐标点：有时间戳按真实时间定 x（可平滑左滚），否则按索引均布 */
  const toPts = (vals: number[]): { x: number; y: number }[] => {
    if (!hasTimes) {
      const arr = vals.length > 0 ? vals : [currentPercent];
      const m = arr.length;
      const ddx = m > 1 ? span / (m - 1) : 0;
      return arr.map((v, i) => ({ x: pad + i * ddx, y: yOf(v) }));
    }
    const tArr = times as number[];
    const m = Math.min(vals.length, tArr.length);
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < m; i++) {
      out.push({ x: (w - pad) - ((renderNow - tArr[i]) / windowMs) * span, y: yOf(vals[i]) });
    }
    return out;
  };

  const arr1 = history.length > 0 ? history : [currentPercent];
  const arr2 = history2 && history2.length > 0 ? history2 : null;
  const pts1 = toPts(arr1);
  const pts2 = history2 ? toPts(arr2 ?? [current2 ?? 0]) : null;
  const line1 = smoothLinePath(pts1, bigDeltaPx);
  const area1 = areaFromLine(line1, pts1, h);
  const line2 = pts2 ? smoothLinePath(pts2, bigDeltaPx) : '';
  const area2 = pts2 ? areaFromLine(line2, pts2, h) : '';

  const uid = useId().replace(/:/g, '');
  const gid = `spark-${uid}`;
  const gid2 = `spark2-${uid}`;
  const clipId = `sparkclip-${uid}`;
  const fmt = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

  // —— 悬浮读数：十字线钉在鼠标所在的屏幕位置（不随数据流左移漂走）；
  //    位置固定 → 「多久以前」固定（最右=此刻，最左=整窗），每帧按此位置取当前落在这里的数据。 ——
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const canHover = arr1.length > 1;
  const hx = hoverRatio != null ? pad + hoverRatio * span : 0;
  const leftPct = hoverRatio != null ? Math.max(6, Math.min(94, hoverRatio * 100)) : 50;
  const agoMs = hoverRatio != null ? (1 - hoverRatio) * windowMs : 0;
  const agoText = agoMs < 500
    ? t('dashboard.metricNow')
    : agoMs < 1000
      ? t('dashboard.metricAgoMs', { n: Math.round(agoMs) })
      : t('dashboard.metricAgoSec', { n: (agoMs / 1000).toFixed(1) });
  // 读数按时间线性插值（valueAtTime），而不是就近取采样点——这样数据随时间流过悬停位置时是
  // 连续平滑地变化，不会每秒「跳一下」像闪烁加载。
  const hoverTime = hoverRatio == null ? 0 : renderNow - (1 - hoverRatio) * windowMs;
  const hv1 = hoverRatio == null
    ? null
    : hasTimes
      ? valueAtTime(times as number[], arr1, hoverTime)
      : arr1[Math.max(0, Math.min(arr1.length - 1, Math.round(hoverRatio * (arr1.length - 1))))] ?? null;
  const hv2 = hoverRatio == null || !arr2
    ? null
    : hasTimes
      ? valueAtTime(times as number[], arr2, hoverTime)
      : arr2[Math.max(0, Math.min(arr2.length - 1, Math.round(hoverRatio * (arr2.length - 1))))] ?? null;

  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!canHover) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    setHoverRatio(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
  };

  return (
    <div className={CARD}>
      <CardHead label={label} value={currentPercent} />
      {legend ? (
        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums text-slate-500">
          <span className="flex items-center gap-3.5">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: color }} />
              {legend.primary} {fmt(clampPct(currentPercent))}%
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full" style={{ background: color2 }} />
              {legend.secondary} {fmt(clampPct(current2 ?? 0))}%
            </span>
          </span>
          {windowLabel ? <span className="shrink-0 text-slate-400">{windowLabel}</span> : null}
        </div>
      ) : null}
      <div
        className="relative flex flex-1 items-center"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverRatio(null)}
      >
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="overflow-visible">
          <defs>
            {/* 面积渐变：stopColor 用 style 下发（表现属性不保证解析 var()） */}
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: color, stopOpacity: 0.35 }} />
              <stop offset="100%" style={{ stopColor: color, stopOpacity: 0.02 }} />
            </linearGradient>
            <linearGradient id={gid2} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: color2, stopOpacity: 0.32 }} />
              <stop offset="100%" style={{ stopColor: color2, stopOpacity: 0.02 }} />
            </linearGradient>
            {/* 左右裁剪：滚出 60 秒窗口的旧点不画到图框外 */}
            <clipPath id={clipId}>
              <rect x={pad} y={-40} width={span} height={h + 80} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${clipId})`}>
            {/* 主序列：总内存 / CPU 系统 */}
            {area1 ? <path d={area1} fill={`url(#${gid})`} /> : null}
            {line1 ? <path d={line1} fill="none" style={{ stroke: color }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
            {/* 副序列：进程占用 */}
            {pts2 ? (
              <>
                {area2 ? <path d={area2} fill={`url(#${gid2})`} /> : null}
                {line2 ? <path d={line2} fill="none" style={{ stroke: color2 }} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
              </>
            ) : null}
          </g>
          {/* 悬浮竖线：钉在鼠标屏幕位置（hx）。不画落点圆——preserveAspectRatio=none 会把圆横向
              拉伸成椭圆「小豆」，且落点随采样跳动，故去掉，只留一根定位竖线。 */}
          {hoverRatio != null && canHover ? (
            <line
              x1={hx}
              y1={0}
              x2={hx}
              y2={h}
              style={{ stroke: 'hsl(var(--foreground) / 0.35)' }}
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          ) : null}
        </svg>
        {hoverRatio != null && canHover && hv1 != null ? (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-1 whitespace-nowrap rounded-lg bg-slate-900/90 px-2 py-1 text-[10px] font-medium leading-tight tabular-nums text-white shadow-lg"
            style={{ left: `${leftPct}%` }}
          >
            <span>
              <span style={{ color }}>●</span> {legend?.primary ?? label} {fmt(clampPct(hv1))}%
            </span>
            {hv2 != null ? (
              <span className="ml-2">
                <span style={{ color: color2 }}>●</span> {legend?.secondary} {fmt(clampPct(hv2))}%
              </span>
            ) : null}
            <span className="ml-2 text-slate-400">{agoText}</span>
          </div>
        ) : null}
      </div>
      <CardHint text={hint} />
    </div>
  );
}

/* ============ CPU：柱状历史条（向左滚动） ============ */
export function ColumnHistogramCard({
  label, history, currentPercent, hint, bars = 30,
}: {
  label: string;
  history: number[];
  currentPercent: number;
  hint: string;
  bars?: number;
}) {
  const t = useT();
  // 右对齐：不足 bars 根时左侧留空，历史从右往左推进（仅保留最近 1 分钟）
  const vals = history.slice(-bars);
  const pad = bars - vals.length;
  const cells: (number | null)[] = [...Array.from({ length: pad }, () => null), ...vals];
  // 悬浮提示：跟随鼠标显示某根柱子的具体占用
  const [hover, setHover] = useState<{ x: number; y: number; pct: number; ago: number } | null>(null);

  return (
    <div className={CARD}>
      <CardHead label={label} value={currentPercent} />
      <div className="relative flex flex-1 items-end">
        <div className="flex h-24 w-full items-end gap-[2px]">
          {cells.map((v, i) => {
            if (v === null) {
              return <div key={i} className="flex-1 rounded-[2px]" style={{ height: '2px', background: 'hsl(var(--foreground) / 0.08)' }} />;
            }
            const pct = clampPct(v);
            // 距当前的秒数：最右是 0 秒（此刻），每根 2 秒
            const ago = (cells.length - 1 - i) * 2;
            return (
              <div
                key={i}
                className="flex-1 cursor-crosshair rounded-[2px] transition-[height,opacity] duration-300 hover:opacity-100"
                style={{
                  height: `${Math.max(3, pct)}%`,
                  background: loadColor(pct),
                  opacity: hover && hover.pct === pct && hover.ago === ago ? 1 : 0.4 + (pct / 100) * 0.6,
                }}
                onMouseEnter={(e) => {
                  const box = (e.currentTarget.parentElement?.parentElement as HTMLElement)?.getBoundingClientRect();
                  const r = e.currentTarget.getBoundingClientRect();
                  if (box) setHover({ x: r.left - box.left + r.width / 2, y: r.top - box.top, pct, ago });
                }}
                onMouseLeave={() => setHover(null)}
              />
            );
          })}
        </div>
        {hover ? (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg bg-slate-900/90 px-2 py-1 text-[11px] font-medium text-white shadow-lg"
            style={{ left: hover.x, top: hover.y - 4 }}
          >
            {hover.pct >= 10 ? Math.round(hover.pct) : Math.round(hover.pct * 10) / 10}%
            <span className="ml-1 text-slate-400">{hover.ago === 0 ? t('dashboard.metricNow') : t('dashboard.metricAgoSecInt', { n: hover.ago })}</span>
          </div>
        ) : null}
      </div>
      <CardHint text={hint} />
    </div>
  );
}

/* ============ 磁盘：方块点阵（10 列 × 5 行） ============ */
export function SegmentBarCard({
  label, percent, hint, cols = 10, rows = 5,
}: {
  label: string;
  percent: number;
  hint: string;
  cols?: number;
  rows?: number;
}) {
  const total = cols * rows;
  const pct = clampPct(percent);
  const lit = Math.round((pct / 100) * total);
  const color = loadColor(pct);

  return (
    <div className={CARD}>
      <CardHead label={label} value={percent} />
      <div className="flex flex-1 items-center">
        <div
          className="grid w-full gap-1.5"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: total }, (_, i) => {
            const on = i < lit;
            return (
              <div
                key={i}
                className="aspect-square rounded-[5px] border border-white/40 transition-[background-color,opacity] duration-300"
                style={{
                  background: on ? color : 'rgba(148,163,184,0.16)',
                  opacity: on ? 0.5 + (i / total) * 0.5 : 1,
                }}
              />
            );
          })}
        </div>
      </div>
      <CardHint text={hint} />
    </div>
  );
}
