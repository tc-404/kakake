import { useState, type ReactNode } from 'react';

/**
 * 系统监控可视化卡片：
 *  - ColumnHistogramCard：CPU 柱状历史条（向左滚动）
 *  - SparklineCard：内存趋势面积图
 *  - SegmentBarCard：磁盘方块点阵（10×5）
 *  - CoreGridCard：CPU 核心点阵（备选，暂未使用）
 * 均固定最小高度，避免数值抖动导致回流。
 */

const CARD = 'kk-glass flex min-h-[15.5rem] flex-col gap-2 rounded-[1.35rem] px-4 py-4';

/** 占用色阶：低=青，中=琥珀，高=红 */
function loadColor(pct: number): string {
  if (pct >= 80) return '#F87171';
  if (pct >= 50) return '#FBBF24';
  return '#2DD4BF';
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
                title={offline ? `核 ${i}（离线）` : `核 ${i}：${Math.round(pct)}%`}
                className="h-6 w-6 rounded-[6px] border border-white/50 transition-[background-color] duration-500"
                style={{
                  background: offline
                    ? 'rgba(148,163,184,0.15)'
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

/* ============ 方案 1：内存趋势面积图（支持双序列叠加） ============ */
export function SparklineCard({
  label, history, currentPercent, color = '#F472B6', hint,
  history2, current2, color2 = '#8B5CF6', legend,
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
}) {
  const w = 240;
  const h = 96;
  const pad = 3;
  const yOf = (v: number) => h - pad - (clampPct(v) / 100) * (h - pad * 2);
  const build = (raw: number[]) => {
    const arr = raw.length > 0 ? raw : [0];
    const m = arr.length;
    const ddx = m > 1 ? (w - pad * 2) / (m - 1) : 0;
    const p = arr.map((v, i) => [pad + i * ddx, yOf(v)] as const);
    const ln = p.map((pt, i) => `${i === 0 ? 'M' : 'L'}${pt[0].toFixed(1)},${pt[1].toFixed(1)}`).join(' ');
    const ar = m > 1 ? `${ln} L${(pad + (m - 1) * ddx).toFixed(1)},${h} L${pad},${h} Z` : '';
    return { line: ln, area: ar, last: p[p.length - 1] };
  };
  const primary = build(history.length > 0 ? history : [currentPercent]);
  const secondary = history2 ? build(history2.length > 0 ? history2 : [current2 ?? 0]) : null;
  const gid = `spark-${label}`;
  const gid2 = `spark2-${label}`;
  const fmt = (v: number) => (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

  return (
    <div className={CARD}>
      <CardHead label={label} value={currentPercent} />
      {legend ? (
        <div className="flex items-center gap-3.5 text-[11px] tabular-nums text-slate-500">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: color }} />
            {legend.primary} {fmt(clampPct(currentPercent))}%
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: color2 }} />
            {legend.secondary} {fmt(clampPct(current2 ?? 0))}%
          </span>
        </div>
      ) : null}
      <div className="flex flex-1 items-center">
        <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="overflow-visible">
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.35" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={gid2} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color2} stopOpacity="0.32" />
              <stop offset="100%" stopColor={color2} stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* 主序列：总内存 */}
          {primary.area ? <path d={primary.area} fill={`url(#${gid})`} /> : null}
          <path d={primary.line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {primary.last ? (
            <circle cx={primary.last[0]} cy={primary.last[1]} r={3} fill={color} style={{ filter: `drop-shadow(0 0 4px ${color}88)` }} />
          ) : null}
          {/* 副序列：进程占用 */}
          {secondary ? (
            <>
              {secondary.area ? <path d={secondary.area} fill={`url(#${gid2})`} /> : null}
              <path d={secondary.line} fill="none" stroke={color2} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {secondary.last ? (
                <circle cx={secondary.last[0]} cy={secondary.last[1]} r={3} fill={color2} style={{ filter: `drop-shadow(0 0 4px ${color2}88)` }} />
              ) : null}
            </>
          ) : null}
        </svg>
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
              return <div key={i} className="flex-1 rounded-[2px]" style={{ height: '2px', background: 'rgba(148,163,184,0.12)' }} />;
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
            <span className="ml-1 text-slate-400">{hover.ago === 0 ? '此刻' : `${hover.ago}秒前`}</span>
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
