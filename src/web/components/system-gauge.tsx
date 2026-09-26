import { cn } from '@/lib/utils';

type GaugeTone = {
  arc: string;
  tip: string;
  track: string;
};

const TONES: Record<string, GaugeTone> = {
  memory: { arc: '#F472B6', tip: '#818CF8', track: 'rgba(148, 163, 184, 0.35)' },
  cpu: { arc: '#2DD4BF', tip: '#0EA5E9', track: 'rgba(148, 163, 184, 0.35)' },
  disk: { arc: '#FBBF24', tip: '#F97316', track: 'rgba(148, 163, 184, 0.35)' },
};

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export function SystemGauge({
  label,
  percent,
  processPercent,
  tone = 'memory',
  hint,
  legend,
  className,
}: {
  label: string;
  percent: number;
  processPercent?: number;
  tone?: keyof typeof TONES;
  hint?: string;
  /** 扇形图例：系统色 / 本进程(Node)色 */
  legend?: { systemLabel: string; processLabel: string };
  className?: string;
}) {
  const colors = TONES[tone] ?? TONES.memory;
  const pct = clampPct(percent);
  const proc = clampPct(processPercent ?? 0);
  const size = 148;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const procDash = (proc / 100) * c;
  const tipAngle = -Math.PI / 2 + (pct / 100) * 2 * Math.PI;
  const cx = size / 2;
  const cy = size / 2;
  const tipX = cx + r * Math.cos(tipAngle);
  const tipY = cy + r * Math.sin(tipAngle);
  const display = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;

  return (
    <div
      className={cn(
        // 固定最小高度，避免 hint 文本长度变化导致卡片高度抖动、整排回流
        'kk-glass flex min-h-[15.5rem] flex-col items-center justify-center rounded-[1.35rem] px-3 py-4',
        className,
      )}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="block">
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={colors.track}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.45)"
            strokeWidth={Math.max(1, stroke - 6)}
            opacity={0.5}
          />
          {/* 系统已用 */}
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={colors.arc}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${Math.max(0, c - dash)}`}
            transform={`rotate(-90 ${cx} ${cy})`}
            style={{ transition: 'stroke-dasharray 0.6s ease' }}
          />
          {/* 咔咔 Node 本进程（仅本进程，不含其它 node） */}
          {proc > 0.05 ? (
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke={colors.tip}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${procDash} ${Math.max(0, c - procDash)}`}
              transform={`rotate(-90 ${cx} ${cy})`}
              style={{ transition: 'stroke-dasharray 0.6s ease' }}
            />
          ) : null}
          <circle
            cx={cx}
            cy={stroke / 2}
            r={stroke / 2}
            fill={colors.tip}
            style={{ filter: `drop-shadow(0 0 5px ${colors.tip}66)` }}
          />
          {pct > 1.5 ? (
            <circle
              cx={tipX}
              cy={tipY}
              r={stroke / 2 - 1.5}
              fill={colors.arc}
              style={{ filter: `drop-shadow(0 0 4px ${colors.arc}55)` }}
            />
          ) : null}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-[12px] font-medium tracking-wide text-slate-500">{label}</div>
          <div className="mt-0.5 flex items-baseline leading-none text-slate-800">
            <span className="text-[1.75rem] font-bold tabular-nums tracking-tight sm:text-[1.85rem]">{display}</span>
            <span className="ml-0.5 text-sm font-semibold text-slate-500">%</span>
          </div>
          <div className="mt-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-400">占用</div>
        </div>
      </div>
      {legend ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-[10px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: colors.arc }} />
            {legend.systemLabel}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-full" style={{ background: colors.tip }} />
            {legend.processLabel}
          </span>
        </div>
      ) : null}
      {hint ? (
        <p className="mt-1.5 flex h-8 max-w-[14rem] items-center justify-center text-center text-[11px] tabular-nums text-muted-foreground">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
