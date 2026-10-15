import { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { cn } from '@/lib/utils';

/** 独立磁盘卡片：环形占用 + 容量拆分（总量 / 已用 / 可用）+ 挂载路径。 */

export interface DiskInfo {
  usedPercent: number;
  usedBytes: number;
  totalBytes: number;
  freeBytes: number;
  path: string;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

/** 占用色阶：低=青、中=琥珀、高=红，与其余监控卡一致 */
function diskTone(pct: number): { arc: string; tip: string; soft: string } {
  if (pct >= 80) return { arc: '#F87171', tip: '#FB7185', soft: 'rgba(248,113,113,0.14)' };
  if (pct >= 50) return { arc: '#FBBF24', tip: '#F97316', soft: 'rgba(251,191,36,0.16)' };
  return { arc: '#2DD4BF', tip: '#0EA5E9', soft: 'rgba(45,212,191,0.14)' };
}

/** 断点媒体查询（默认 sm=640px）：区分横屏（宽）/竖屏（窄）以切换展示数据 */
function useIsWide(query = '(min-width: 640px)'): boolean {
  const get = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : true;
  const [match, setMatch] = useState(get);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const on = () => setMatch(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** 盘符标签：Windows 取盘符（C: / D:），其它平台回退挂载路径 */
function driveLabel(path: string): string {
  const m = /^([A-Za-z]):/.exec(path);
  if (m) return `${m[1].toUpperCase()}:`;
  return path || '磁盘';
}

/** 合并多个卷为一个汇总卷（用于圆球与统计的“全部磁盘”结果） */
function mergeDisks(list: DiskInfo[], path = '全部磁盘'): DiskInfo {
  const totalBytes = list.reduce((a, d) => a + (d.totalBytes || 0), 0);
  const usedBytes = list.reduce((a, d) => a + (d.usedBytes || 0), 0);
  const freeBytes = list.reduce((a, d) => a + (d.freeBytes || 0), 0);
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return { usedPercent, usedBytes, totalBytes, freeBytes, path };
}

/** 最多 4 条进度条：≤4 每盘一条；>4 前 3 盘各一条，其余合并成第 4 条 */
function buildBars(list: DiskInfo[]): { label: string; disk: DiskInfo }[] {
  if (list.length <= 4) return list.map((d) => ({ label: driveLabel(d.path), disk: d }));
  const first = list.slice(0, 3).map((d) => ({ label: driveLabel(d.path), disk: d }));
  const rest = list.slice(3);
  return [...first, { label: `其他 ${rest.length} 个`, disk: mergeDisks(rest, `其他 ${rest.length} 个磁盘`) }];
}

/** 单条磁盘进度条：盘符在左、容量数值靠最右、渐变条在下 */
function DiskBar({ label, disk }: { label: string; disk: DiskInfo }) {
  const pct = clampPct(disk.usedPercent);
  const tone = diskTone(pct);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs font-semibold text-slate-600" title={disk.path}>{label}</span>
        <span className="flex items-baseline gap-1 whitespace-nowrap">
          <span className="text-sm font-bold tabular-nums text-foreground">{formatBytes(disk.usedBytes)}</span>
          <span className="text-[11px] font-medium text-muted-foreground">/ {formatBytes(disk.totalBytes)}</span>
        </span>
      </div>
      <div className="mt-1 h-2.5 w-full overflow-hidden rounded-full bg-white/45 shadow-inner">
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%`, background: `linear-gradient(90deg, ${tone.arc}cc, ${tone.tip})` }}
        />
      </div>
    </div>
  );
}

/** 液态水位填充：圆形容器按占用灌水到对应高度，表面双层波浪轻微流动 */
function DiskLiquid({ percent, arc, tip }: { percent: number; arc: string; tip: string }) {
  const pct = clampPct(percent);
  const size = 128;
  const r = (size - 8) / 2;
  const cx = size / 2;
  const cy = size / 2;
  // 水面在 SVG 坐标里的 y：占用越高，水面越靠上
  const surfaceY = size - (pct / 100) * size;
  const display = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const clipId = 'kk-disk-liquid-clip';
  const gradId = 'kk-disk-liquid-grad';
  // 一个波形横跨 128px（半 = 一个完整波周期），整段画 256px 便于无缝左移循环
  const wavePath = 'M0 0 q 32 -7 64 0 t 64 0 t 64 0 t 64 0 V 200 H 0 Z';

  return (
    <div className="relative aspect-square h-40 w-40 shrink-0 sm:h-32 sm:w-32">
      <svg width="100%" height="100%" viewBox={`0 0 ${size} ${size}`} className="block h-full w-full">
        <defs>
          <clipPath id={clipId}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={arc} stopOpacity="0.9" />
            <stop offset="100%" stopColor={tip} stopOpacity="0.6" />
          </linearGradient>
        </defs>

        {/* 容器空底 */}
        <circle cx={cx} cy={cy} r={r} fill="rgba(148,163,184,0.12)" />

        {/* 水体：裁剪进圆内，整体随占用上下移动 */}
        <g clipPath={`url(#${clipId})`}>
          <g style={{ transform: `translateY(${surfaceY}px)`, transition: 'transform 0.7s ease' }}>
            {/* 后层波：更淡、更慢、略微错峰，制造层次 */}
            <path d={wavePath} fill={`url(#${gradId})`} opacity={0.45} transform="translate(-8 3)">
              <animateTransform
                attributeName="transform"
                type="translate"
                from="-8 3"
                to="-136 3"
                dur="3.4s"
                repeatCount="indefinite"
              />
            </path>
            {/* 前层波 */}
            <path d={wavePath} fill={`url(#${gradId})`}>
              <animateTransform
                attributeName="transform"
                type="translate"
                from="0 0"
                to="-128 0"
                dur="2.3s"
                repeatCount="indefinite"
              />
            </path>
          </g>
        </g>

        {/* 玻璃描边 */}
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth={2} />
        <circle cx={cx} cy={cy} r={r} fill="none" stroke="rgba(148,163,184,0.35)" strokeWidth={1} />
      </svg>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <div className="flex items-baseline leading-none text-slate-800">
          <span className="text-[2rem] font-bold tabular-nums tracking-tight [text-shadow:0_1px_2px_rgba(255,255,255,0.6)] sm:text-[1.7rem]">{display}</span>
          <span className="ml-0.5 text-sm font-semibold text-slate-500">%</span>
        </div>
        <div className="mt-1 text-[10px] font-medium uppercase tracking-wider text-slate-500">已用</div>
      </div>
    </div>
  );
}

function Stat({ label, value, dotColor }: { label: string; value: string; dotColor?: string }) {
  return (
    <div className="min-w-0 flex-1 text-center">
      <div className="flex items-center justify-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {dotColor ? <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dotColor }} /> : null}
        {label}
      </div>
      <div className="mt-0.5 truncate text-[15px] font-semibold tabular-nums text-foreground" title={value}>{value}</div>
    </div>
  );
}

function DiskHeader({ path }: { path?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-600">
        <HardDrive className="h-[1.15rem] w-[1.15rem]" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold leading-tight">磁盘</h2>
        <p className="truncate text-[11px] text-muted-foreground" title={path || undefined}>
          {path ? `挂载于 ${path}` : '项目所在卷'}
        </p>
      </div>
    </div>
  );
}

export function DiskCard({ disk, disks, className }: { disk: DiskInfo | null; disks?: DiskInfo[]; className?: string }) {
  const isWide = useIsWide();

  // 全部卷：优先用后端枚举的 disks，缺失时退回项目所在卷
  const allDisks = disks && disks.length > 0 ? disks : disk ? [disk] : [];
  const ready = allDisks.length > 0 && allDisks.some((d) => d.totalBytes > 0);

  // 项目所在卷（竖屏用）与全部合并卷（横屏用）
  const root = disk && disk.totalBytes > 0 ? disk : allDisks[0] ?? null;
  const merged = mergeDisks(allDisks);
  // 圆球 / 统计的数据源：横屏=全部合并，竖屏=项目所在卷
  const focus = isWide ? merged : root ?? merged;
  const focusPct = clampPct(focus.usedPercent);
  const tone = diskTone(focusPct);
  const bars = buildBars(allDisks);

  return (
    <section className={cn('space-y-3', className)}>
      <DiskHeader path={root?.path} />
      <div className="kk-glass relative rounded-[1.35rem] p-5">
        {ready ? (
          <>
            {/* 竖屏：容量数值固定在卡片右上角（展示项目所在卷） */}
            {!isWide ? (
              <span className="absolute right-5 top-4 flex items-baseline gap-1 whitespace-nowrap text-slate-800">
                <span className="text-base font-bold tabular-nums leading-none tracking-tight">{formatBytes(root!.usedBytes)}</span>
                <span className="text-xs font-medium text-muted-foreground">/ {formatBytes(root!.totalBytes)}</span>
              </span>
            ) : null}

            <div className="flex flex-col items-center gap-5 sm:flex-row sm:gap-6">
              <DiskLiquid percent={focusPct} arc={tone.arc} tip={tone.tip} />

              <div className="min-w-0 flex-1 space-y-4">
                {/* 横屏：每个磁盘一条进度条（最多 4 条，超出合并） */}
                {isWide ? (
                  <div className="space-y-2.5">
                    {bars.map((b, i) => (
                      <DiskBar key={`${b.label}-${i}`} label={b.label} disk={b.disk} />
                    ))}
                  </div>
                ) : null}

                {/* 统计：横屏=全部合并，竖屏=项目所在卷；三项等宽均分 */}
                <div className="flex items-stretch gap-3">
                  <Stat label="已用" value={formatBytes(focus.usedBytes)} dotColor={tone.arc} />
                  <div className="w-px shrink-0 self-stretch bg-white/40" />
                  <Stat label="可用" value={formatBytes(focus.freeBytes)} dotColor="rgba(148,163,184,0.7)" />
                  <div className="w-px shrink-0 self-stretch bg-white/40" />
                  <Stat label="总容量" value={formatBytes(focus.totalBytes)} />
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex items-center gap-4">
            <span className="h-32 w-32 shrink-0 animate-pulse rounded-full bg-white/40" />
            <div className="flex-1 space-y-3">
              <span className="block h-6 w-40 animate-pulse rounded-md bg-white/40" />
              <span className="block h-2.5 w-full animate-pulse rounded-full bg-white/40" />
              <span className="block h-4 w-52 animate-pulse rounded-md bg-white/40" />
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
