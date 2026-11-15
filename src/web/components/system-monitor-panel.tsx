import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  Activity, Info, MonitorSmartphone, Cpu,
  Clock, Timer, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { SparklineCard } from '@/components/system-metric-cards';
import { DiskCard } from '@/components/disk-card';
import { cn } from '@/lib/utils';
import { t, useT } from '@/lib/i18n';
import { getPerfMode, perfPollMs, subscribeDeviceTier } from '@/lib/device-tier';

const LIVE_SAMPLE_MS = 1000;
const LIVE_WINDOW_MS = 60_000;
const FULL_POLL_MS = 2000;

type Metrics = Awaited<ReturnType<typeof api.systemMetrics>>;
type LiveMetrics = Awaited<ReturnType<typeof api.systemMetricsLive>>;

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
  const MONTH = 31 * DAY;

  if (s >= MONTH) {
    const mo = Math.floor(s / MONTH);
    const d = Math.floor((s % MONTH) / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return t('dashboard.uptimeMonths', { mo, d, h, m, r });
  }

  if (s >= 72 * HOUR) {
    const d = Math.floor(s / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return t('dashboard.uptimeDays', { d, h, m, r });
  }

  const h = Math.floor(s / HOUR);
  const m = Math.floor((s % HOUR) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
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
  
  tone?: 'teal' | 'brand' | 'amber';
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const fill =
    tone === 'brand'
      ? 'bg-brand-400'
      : tone === 'amber'
        ? 'bg-amber-400'
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

type InfoTone = 'slate' | 'teal' | 'brand' | 'amber';

type InfoItem = {
  key: string;
  label: string;
  value: string;
  sub?: string;
  icon: LucideIcon;
  tone: InfoTone;
  bar?: { percent: number; tone: 'teal' | 'brand' | 'amber' };
  
  wide?: boolean;
};

const TONE_ICON: Record<InfoTone, string> = {
  slate: 'bg-slate-500/15 text-slate-600',
  teal: 'bg-teal-500/15 text-teal-600',
  brand: 'bg-brand-500/15 text-brand-600',
  
  amber: 'bg-amber-500/15 text-amber-600',
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
  const t = useT();
  if (!metrics) {
    return (
      <section className="space-y-3">
        <SystemInfoHeader />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {[t('dashboard.infoOs'), 'CPU', t('dashboard.infoSysUptime'), t('dashboard.infoRuntime')].map((l) => (
            <div key={l} className="kk-glass flex items-center gap-2.5 rounded-[1.1rem] p-3.5">
              <span className="h-9 w-9 shrink-0 animate-pulse rounded-xl bg-white/40" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{l}</div>
                <div className="text-sm text-muted-foreground">{t('dashboard.collecting')}</div>
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
      ? t('dashboard.coresOnline', { n: metrics.cpu.cores, m: online })
      : t('dashboard.cores', { n: metrics.cpu.cores });

  const items: InfoItem[] = [
    {
      key: 'os', label: t('dashboard.infoOs'), icon: MonitorSmartphone, tone: 'slate',
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
      key: 'sysUptime', label: t('dashboard.infoSysUptime'), icon: Timer, tone: 'brand',
      value: metrics.systemUptimeSec != null ? formatUptime(metrics.systemUptimeSec) : '—',
      sub: t('dashboard.infoSinceBoot'),
    },
    {
      key: 'runtime', label: t('dashboard.infoRuntime'), icon: Clock, tone: 'brand',
      value: formatUptime(metrics.uptimeSec),
      sub: `Node.js ${metrics.host.nodeVersion}`,
    },
  ];

  return (
    <section className="space-y-3">
      <SystemInfoHeader />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {items.map((item) => (
          <InfoCard key={item.key} item={item} />
        ))}
      </div>
    </section>
  );
}

function SystemInfoHeader() {
  const t = useT();
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Info className="h-4 w-4 text-primary" />
        {}
        <span>{t('dashboard.sysInfoTitle')}</span>
      </h2>
      <p className="text-xs text-muted-foreground">{t('dashboard.sysInfoDesc')}</p>
    </div>
  );
}

export function SystemMonitorPanel({ className }: { className?: string }) {
  const t = useT();
  const perfMode = useSyncExternalStore(subscribeDeviceTier, getPerfMode, () => 'auto' as const);
  const sampleMs = perfPollMs(LIVE_SAMPLE_MS);
  const delayMs = Math.round(sampleMs * 1.5);
  const keep = Math.round(LIVE_WINDOW_MS / sampleMs) + Math.ceil(delayMs / sampleMs) + 4;
  const rateLabel = sampleMs >= 1000 ? `${sampleMs / 1000}s` : `${sampleMs}ms`;

  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [cpuSys, setCpuSys] = useState<number[]>([]);
  const [cpuProc, setCpuProc] = useState<number[]>([]);
  const [memSys, setMemSys] = useState<number[]>([]);
  const [memProc, setMemProc] = useState<number[]>([]);
  const cpuSysRef = useRef<number[]>([]);
  const cpuProcRef = useRef<number[]>([]);
  const memSysRef = useRef<number[]>([]);
  const memProcRef = useRef<number[]>([]);

  const [ts, setTs] = useState<number[]>([]);
  const tsRef = useRef<number[]>([]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const push = (ref: { current: number[] }, set: (v: number[]) => void, v: number) => {
      const next = [...ref.current, clampPercent(v)].slice(-keep);
      ref.current = next;
      set(next);
    };

    const tick = async () => {
      try {
        const m = await api.systemMetricsLive();
        if (cancelled) return;
        setLive(m);
        setError('');

        tsRef.current = [...tsRef.current, Date.now()].slice(-keep);
        setTs(tsRef.current);
        push(cpuSysRef, setCpuSys, m.cpu.systemPercent ?? 0);
        push(cpuProcRef, setCpuProc, m.cpu.processPercent ?? 0);
        push(memSysRef, setMemSys, m.memory.systemPercent ?? 0);
        push(memProcRef, setMemProc, m.memory.nodePercent ?? 0);
      } catch (e) {
        if (!cancelled) setError(String(e).replace(/^Error:\s*/i, '') || t('dashboard.fetchFailed'));
      }
    };

    const start = () => { if (!timer) timer = setInterval(() => void tick(), sampleMs); };
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };

    const syncVisibility = () => {
      if (document.hidden) stop();
      else { void tick(); start(); }
    };

    void tick();
    start();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, [perfMode, sampleMs, keep]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const m = await api.systemMetrics();
        if (!cancelled) setMetrics(m);
      } catch { void 0; }
    };

    const start = () => { if (!timer) timer = setInterval(() => void tick(), perfPollMs(FULL_POLL_MS)); };
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    const syncVisibility = () => {
      if (document.hidden) stop();
      else { void tick(); start(); }
    };

    void tick();
    start();
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', syncVisibility);
    };
  }, [perfMode]);

  const cores = metrics?.cpu.cores ?? 0;
  const coresOnline = metrics?.cpu.coresOnline ?? 0;
  const coreText = cores > 0
    ? (coresOnline > 0 && coresOnline < cores
      ? t('dashboard.coresOnline', { n: cores, m: coresOnline })
      : t('dashboard.cores', { n: cores }))
    : '';

  return (
    <div className={cn('space-y-6', className)}>
      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Activity className="h-4 w-4 text-primary" />
              {}
              <span>{t('dashboard.sysMonitorTitle')}</span>
            </h2>
          </div>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {}
          <SparklineCard
            label={t('dashboard.cpuUsage')}
            history={cpuSys}
            currentPercent={live?.cpu.systemPercent ?? 0}
            color="rgb(var(--kk-comp-rgb))"
            history2={cpuProc}
            current2={live?.cpu.processPercent ?? 0}
            color2="rgb(var(--kk-comp-alt-rgb))"
            legend={{ primary: t('dashboard.legendSystem'), secondary: t('dashboard.legendProcess') }}
            times={ts}
            windowMs={LIVE_WINDOW_MS}
            delayMs={delayMs}
            windowLabel={t('dashboard.window60s')}
            hint={live ? `${coreText || 'CPU'} · ${t('dashboard.refreshRate', { rate: rateLabel })}` : t('dashboard.collecting')}
          />
          {}
          <SparklineCard
            label={t('dashboard.memUsage')}
            history={memSys}
            currentPercent={live?.memory.systemPercent ?? 0}
            color="rgb(var(--kk-logo-rgb))"
            history2={memProc}
            current2={live?.memory.nodePercent ?? 0}
            color2="rgb(var(--kk-logo-alt-rgb))"
            legend={{ primary: t('dashboard.legendTotalMem'), secondary: t('dashboard.legendProc') }}
            times={ts}
            windowMs={LIVE_WINDOW_MS}
            delayMs={delayMs}
            windowLabel={t('dashboard.window60s')}
            hint={
              live ? (
                <>
                  {}
                  <span>
                    {t('dashboard.memTotalPrefix')} {formatBytes(live.memory.systemUsedBytes)}/{formatBytes(live.memory.systemTotalBytes)}
                  </span>
                  <span className="mx-1">·</span>
                  <span>
                    {t('dashboard.memProcPrefix')} {formatBytes(live.memory.nodeRssBytes)}{t('dashboard.memHeap', { n: formatBytes(live.memory.nodeHeapUsedBytes) })}
                  </span>
                </>
              ) : (
                t('dashboard.collecting')
              )
            }
          />
        </div>
      </section>

      <DiskCard disk={metrics?.disk ?? null} disks={metrics?.disks} />

      <SystemInfoCards metrics={metrics} />
    </div>
  );
}
