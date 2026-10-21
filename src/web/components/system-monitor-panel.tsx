import { useEffect, useRef, useState } from 'react';
import {
  Activity, Info, MonitorSmartphone, Cpu,
  Clock, Timer, type LucideIcon,
} from 'lucide-react';
import { api } from '@/lib/api';
import { SparklineCard } from '@/components/system-metric-cards';
import { DiskCard } from '@/components/disk-card';
import { cn } from '@/lib/utils';
import { t, useT } from '@/lib/i18n';

/** 实时采样间隔：CPU / 内存共用同一刷新节奏。CPU 占用是在相邻两帧之间做平均得出的——
 *  间隔太小（如 100ms）单次统计窗口太短，CPU 曲线会上蹿下跳、看着「太快」且很躁；
 *  取 1s 与内存图一样平稳，仍是实时滚动。想调快/调慢只改这一个值即可。 */
const LIVE_SAMPLE_MS = 1000;
/** 面积图固定展示最近 60 秒 → 采样点数 = 60000 / 间隔；窗口满后最旧的点会被丢弃（滚动释放） */
const LIVE_WINDOW_MS = 60_000;
const LIVE_HISTORY_LEN = Math.round(LIVE_WINDOW_MS / LIVE_SAMPLE_MS);
/** 渲染延迟：画面只呈现 ~1.5 个采样间隔之前的数据，让右边缘始终有「已到货」的采样可画，
 *  右边缘因此也能逐帧平滑滚入，而不是等新采样到了才一秒一跳（历史段本来就平滑）。 */
const LIVE_DELAY_MS = Math.round(LIVE_SAMPLE_MS * 1.5);
/** 实际多留几个点：窗口 + 右侧「排队中」的新点 + 左侧正要滚出去的旧点，线段才接得上 */
const LIVE_KEEP = LIVE_HISTORY_LEN + Math.ceil(LIVE_DELAY_MS / LIVE_SAMPLE_MS) + 4;
/** 刷新节奏的友好文案（1000ms → 1s） */
const RATE_LABEL = LIVE_SAMPLE_MS >= 1000 ? `${LIVE_SAMPLE_MS / 1000}s` : `${LIVE_SAMPLE_MS}ms`;
/** 磁盘与主机信息变化慢，仍走 2s 全量轮询 */
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
  const MONTH = 31 * DAY; // 按 31 天记一个月

  // 满 31 天：x月x天x时x分x秒
  if (s >= MONTH) {
    const mo = Math.floor(s / MONTH);
    const d = Math.floor((s % MONTH) / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return t('dashboard.uptimeMonths', { mo, d, h, m, r });
  }
  // 满 72 小时：x天x时x分x秒
  if (s >= 72 * HOUR) {
    const d = Math.floor(s / DAY);
    const h = Math.floor((s % DAY) / HOUR);
    const m = Math.floor((s % HOUR) / 60);
    const r = s % 60;
    return t('dashboard.uptimeDays', { d, h, m, r });
  }
  // 72 小时以内：沿用简洁格式
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
      key: 'sysUptime', label: t('dashboard.infoSysUptime'), icon: Timer, tone: 'sky',
      value: metrics.systemUptimeSec != null ? formatUptime(metrics.systemUptimeSec) : '—',
      sub: t('dashboard.infoSinceBoot'),
    },
    {
      key: 'runtime', label: t('dashboard.infoRuntime'), icon: Clock, tone: 'sky',
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
        {t('dashboard.sysInfoTitle')}
      </h2>
      <p className="text-xs text-muted-foreground">{t('dashboard.sysInfoDesc')}</p>
    </div>
  );
}

export function SystemMonitorPanel({ className }: { className?: string }) {
  const t = useT();
  // 磁盘 + 主机信息：变化慢，走 2s 全量轮询
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  // 高频实时 CPU/内存（毫秒级）：总览页面积图的数据源
  const [live, setLive] = useState<LiveMetrics | null>(null);
  const [cpuSys, setCpuSys] = useState<number[]>([]);
  const [cpuProc, setCpuProc] = useState<number[]>([]);
  const [memSys, setMemSys] = useState<number[]>([]);
  const [memProc, setMemProc] = useState<number[]>([]);
  const cpuSysRef = useRef<number[]>([]);
  const cpuProcRef = useRef<number[]>([]);
  const memSysRef = useRef<number[]>([]);
  const memProcRef = useRef<number[]>([]);
  // 采样时间戳（四条序列共用，客户端接收时刻），面积图据此按真实时间平滑左滚
  const [ts, setTs] = useState<number[]>([]);
  const tsRef = useRef<number[]>([]);

  // —— 高频实时轮询（CPU/内存，毫秒级） ——
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const push = (ref: { current: number[] }, set: (v: number[]) => void, v: number) => {
      const next = [...ref.current, clampPercent(v)].slice(-LIVE_KEEP);
      ref.current = next;
      set(next);
    };

    const tick = async () => {
      try {
        const m = await api.systemMetricsLive();
        if (cancelled) return;
        setLive(m);
        setError('');
        // 时间戳按客户端接收时刻记（与前端 rAF 时钟同源，避免服务端时钟偏差）
        tsRef.current = [...tsRef.current, Date.now()].slice(-LIVE_KEEP);
        setTs(tsRef.current);
        push(cpuSysRef, setCpuSys, m.cpu.systemPercent ?? 0);
        push(cpuProcRef, setCpuProc, m.cpu.processPercent ?? 0);
        push(memSysRef, setMemSys, m.memory.systemPercent ?? 0);
        push(memProcRef, setMemProc, m.memory.nodePercent ?? 0);
      } catch (e) {
        if (!cancelled) setError(String(e).replace(/^Error:\s*/i, '') || t('dashboard.fetchFailed'));
      }
    };

    const start = () => { if (!timer) timer = setInterval(() => void tick(), LIVE_SAMPLE_MS); };
    const stop = () => { if (timer) { clearInterval(timer); timer = undefined; } };
    // 页面不可见（切后台/最小化）时暂停轮询，回前台立即刷一次再恢复，后台不空耗请求
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
  }, []);

  // —— 磁盘 + 主机信息（2s 全量轮询，与实时采样各走各的增量基线） ——
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const m = await api.systemMetrics();
        if (!cancelled) setMetrics(m);
      } catch { /* 全量失败不覆盖实时错误提示 */ }
    };

    const start = () => { if (!timer) timer = setInterval(() => void tick(), FULL_POLL_MS); };
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
  }, []);

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
              {t('dashboard.sysMonitorTitle')}
            </h2>
          </div>
          {error ? <span className="text-xs text-destructive">{error}</span> : null}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* CPU 占用：系统（青）叠加 kakake 进程（天蓝）面积图，毫秒级实时 */}
          <SparklineCard
            label={t('dashboard.cpuUsage')}
            history={cpuSys}
            currentPercent={live?.cpu.systemPercent ?? 0}
            color="#2DD4BF"
            history2={cpuProc}
            current2={live?.cpu.processPercent ?? 0}
            color2="#0EA5E9"
            legend={{ primary: t('dashboard.legendSystem'), secondary: t('dashboard.legendProcess') }}
            times={ts}
            windowMs={LIVE_WINDOW_MS}
            delayMs={LIVE_DELAY_MS}
            windowLabel={t('dashboard.window60s')}
            hint={live ? `${coreText || 'CPU'} · ${t('dashboard.refreshRate', { rate: RATE_LABEL })}` : t('dashboard.collecting')}
          />
          {/* 内存占用：总内存（粉）叠加 kakake 进程（紫）面积图，毫秒级实时 */}
          <SparklineCard
            label={t('dashboard.memUsage')}
            history={memSys}
            currentPercent={live?.memory.systemPercent ?? 0}
            color="#F472B6"
            history2={memProc}
            current2={live?.memory.nodePercent ?? 0}
            color2="#8B5CF6"
            legend={{ primary: t('dashboard.legendTotalMem'), secondary: t('dashboard.legendProc') }}
            times={ts}
            windowMs={LIVE_WINDOW_MS}
            delayMs={LIVE_DELAY_MS}
            windowLabel={t('dashboard.window60s')}
            hint={
              live ? (
                <>
                  {/* 与曲线主色（粉）对齐；用固定色写死，不吃全局自定义字体色 */}
                  <span style={{ color: '#DB2777' }}>
                    {t('dashboard.memTotalPrefix')} {formatBytes(live.memory.systemUsedBytes)}/{formatBytes(live.memory.systemTotalBytes)}
                  </span>
                  <span className="mx-1">·</span>
                  {/* 与曲线副色（紫）对齐 */}
                  <span style={{ color: '#7C3AED' }}>
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
