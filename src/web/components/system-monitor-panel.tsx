import { useEffect, useRef, useState } from 'react';
import {
  Activity, Info, MonitorSmartphone, Cpu,
  HardDrive, Boxes, Clock, Timer, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { ColumnHistogramCard, SparklineCard, SegmentBarCard } from '@/components/system-metric-cards';
import { cn } from '@/lib/utils';

/** 临时曲线数据仅保留最近 1 分钟（2s 一次 → 30 个采样点） */
const HISTORY_LEN = 30;

type Metrics = Awaited<ReturnType<typeof api.systemMetrics>>;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function formatUptime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const HOUR = 3600;
  const DAY = 86400;
  const MONTH = 31 * DAY; // 按 31 天记一个月

  // 满 31 天：x月x天x时x分x秒
  if (s >= MONTH) {
    const mo = Math.floor(s / MONTH);
    const d = Math.floor((s % MONTH) / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return `${mo}月${d}天${h}时${m}分${r}秒`;
  }
  // 满 72 小时：x天x时x分x秒
  if (s >= 72 * HOUR) {
    const d = Math.floor(s / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return `${d}天${h}时${m}分${r}秒`;
  }
  // 72 小时以内：沿用简洁格式
  const h = Math.floor(s / HOUR);
  const m = Math.floor((s % HOUR) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function MiniBar({
  percent,
  tone = 'teal',
}: {
  percent: number;
  tone?: 'teal' | 'pink' | 'amber' | 'violet';
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const fill =
    tone === 'pink'
      ? 'bg-pink-400'
      : tone === 'amber'
        ? 'bg-amber-400'
        : tone === 'violet'
          ? 'bg-indigo-400'
          : 'bg-teal-400';
  return (
    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/45">
      <div
        className={cn('h-full rounded-full transition-[width] duration-500 ease-out', fill)}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

type InfoTone = 'slate' | 'teal' | 'pink' | 'amber' | 'violet' | 'sky';

type InfoItem = {
  key: string;
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  tone: InfoTone;
  bar?: { percent: number; tone: 'teal' | 'pink' | 'amber' | 'violet' };
  /** 跨两列显示（长文本，如 CPU 型号） */
  wide?: boolean;
};

const TONE_ICON: Record<InfoTone, string> = {
  slate: 'bg-slate-500/12 text-slate-600',
  teal: 'bg-teal-500/15 text-teal-600',
  pink: 'bg-pink-500/12 text-pink-600',
  amber: 'bg-amber-500/15 text-amber-600',
  violet: 'bg-indigo-500/12 text-indigo-600',
  sky: 'bg-sky-500/12 text-sky-600',
};

function InfoCard({ item }: { item: InfoItem }) {
  const Icon = item.icon;
  return (
    <div
      className={cn(
        'kk-glass flex flex-col gap-2 rounded-[1.1rem] p-3.5',
        item.wide && 'sm:col-span-2',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className={cn('flex h-9 w-9 shrink-0 items-center justify-center rounded-xl', TONE_ICON[item.tone])}>
          <Icon className="h-[1.15rem] w-[1.15rem]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{item.label}</div>
          <div className="truncate text-sm font-semibold text-foreground" title={item.value}>{item.value}</div>
        </div>
      </div>
      {item.sub ? <div className="text-[11px] tabular-nums text-muted-foreground">{item.sub}</div> : null}
      {item.bar ? <MiniBar percent={item.bar.percent} tone={item.bar.tone} /> : null}
    </div>
  );
}

function SystemInfoCards({ metrics }: { metrics: Metrics | null }) {
  if (!metrics) {
    return (
      <section className="space-y-3">
        <SystemInfoHeader />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {['系统', 'CPU', '项目占用', '磁盘', '系统运行时长', 'kakake 运行时长'].map((l) => (
            <div key={l} className="kk-glass flex items-center gap-2.5 rounded-[1.1rem] p-3.5">
              <span className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-white/40" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{l}</div>
                <div className="text-sm text-muted-foreground">采集中…</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const online = metrics.cpu.coresOnline ?? 0;
  const coreText =
    online > 0 && online < metrics.cpu.cores
      ? `${metrics.cpu.cores} 核（在线 ${online}）`
      : `${metrics.cpu.cores} 核`;
  const rss = metrics.memory.nodeRssBytes ?? metrics.memory.processRssBytes;
  const heap = metrics.memory.nodeHeapUsedBytes ?? metrics.memory.processHeapUsedBytes;
  const projPct = metrics.memory.nodePercent ?? metrics.memory.processPercent;

  const items: InfoItem[] = [
    {
      key: 'os', label: '操作系统', icon: MonitorSmartphone, tone: 'slate',
      value: metrics.host.platformLabel,
      sub: `${metrics.host.arch} · ${metrics.host.hostname || '—'}`,
    },
    {
      key: 'cpu', label: 'CPU', icon: Cpu, tone: 'teal',
      value: metrics.cpu.model || '—',
      sub: [coreText, metrics.cpu.speedMHz > 0 ? `${metrics.cpu.speedMHz} MHz` : '']
        .filter(Boolean).join(' · '),
    },
    {
      key: 'proj', label: '项目占用', icon: Boxes, tone: 'violet',
      value: `${formatBytes(rss)} · 堆 ${formatBytes(heap)}`,
      sub: `占系统内存 ${formatPct(projPct)}%`,
      bar: { percent: projPct, tone: 'violet' },
    },
    {
      key: 'disk', label: '磁盘', icon: HardDrive, tone: 'amber',
      value: metrics.disk.totalBytes
        ? `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}`
        : '—',
      sub: metrics.disk.totalBytes ? `已用 ${formatPct(metrics.disk.usedPercent)}%` : undefined,
      bar: metrics.disk.totalBytes ? { percent: metrics.disk.usedPercent, tone: 'amber' } : undefined,
    },
    {
      key: 'sysUptime', label: '系统运行时长', icon: Timer, tone: 'sky',
      value: metrics.systemUptimeSec != null ? formatUptime(metrics.systemUptimeSec) : '—',
      sub: '自开机以来',
    },
    {
      key: 'runtime', label: 'kakake 运行时长', icon: Clock, tone: 'sky',
      value: formatUptime(metrics.uptimeSec),
      sub: `Node.js ${metrics.host.nodeVersion}`,
    },
  ];

  return (
    <section className="space-y-3">
      <SystemInfoHeader />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <InfoCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

function SystemInfoHeader() {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Info className="h-4 w-4 text-primary" />
        系统信息
      </h2>
      <p className="text-xs text-muted-foreground">主机与运行环境只读信息</p>
    </div>
  );
}

export function SystemMonitorPanel({ className }: { className?: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');
  // 内存占用历史（趋势曲线）+ CPU 占用历史（柱状条）
  const [memHistory, setMemHistory] = useState<number[]>([]);
  const memRef = useRef<number[]>([]);
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const cpuRef = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const m = await api.systemMetrics();
        if (cancelled) return;
        setMetrics(m);
        setError('');
        const nextMem = [...memRef.current, clampPercent(m.memory.systemPercent)].slice(-HISTORY_LEN);
        memRef.current = nextMem;
        setMemHistory(nextMem);
        const nextCpu = [...cpuRef.current, clampPercent(m.cpu.systemPercent ?? 0)].slice(-HISTORY_LEN);
        cpuRef.current = nextCpu;
        setCpuHistory(nextCpu);
      } catch (e) {
        if (!cancelled) setError(String(e).replace(/^Error:\s*/i, '') || '采集失败');
      }
    };

    void tick();
    timer = setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  return (
    <div className={cn('space-y-6', className)}>
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Activity className="h-4 w-4 text-primary" />
              系统监控
            </h2>
          </div>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
          {/* CPU：柱状历史条 */}
          <ColumnHistogramCard
            label="CPU 占用"
            history={cpuHistory}
            currentPercent={metrics?.cpu.systemPercent ?? 0}
            hint={
              metrics
                ? `系统 ${formatPct(metrics.cpu.systemPercent ?? 0)}% · 项目 ${formatPct(metrics.cpu.processPercent)}% · ${metrics.cpu.cores} 核`
                : '采集中…'
            }
          />
          {/* 方案 1：内存趋势面积图 */}
          <SparklineCard
            label="内存占用"
            history={memHistory}
            currentPercent={metrics?.memory.systemPercent ?? 0}
            hint={
              metrics
                ? `系统 ${formatBytes(metrics.memory.systemUsedBytes)}/${formatBytes(metrics.memory.systemTotalBytes)} · 项目 ${formatPct(metrics.memory.nodePercent ?? metrics.memory.processPercent)}%`
                : '采集中…'
            }
          />
          {/* 方案 2：磁盘分段电量条 */}
          <SegmentBarCard
            label="磁盘占用"
            percent={metrics?.disk.usedPercent ?? 0}
            hint={
              metrics?.disk.totalBytes
                ? `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}`
                : '采集中…'
            }
          />
        </div>
      </section>

      <SystemInfoCards metrics={metrics} />
    </div>
  );
}
