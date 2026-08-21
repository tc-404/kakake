import { useEffect, useState } from 'react';
import { Activity, Info } from 'lucide-react';
import { api } from '@/lib/api';
import { SystemGauge } from '@/components/system-gauge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

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
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function formatPct(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n >= 10 ? String(Math.round(n)) : String(Math.round(n * 10) / 10);
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

type InfoRow = {
  label: string;
  value: string;
  bar?: { percent: number; tone: 'teal' | 'pink' | 'amber' | 'violet' };
  /** 词条标签强调色（用于项目占用等） */
  labelClassName?: string;
  valueClassName?: string;
};

function SystemInfoTable({ metrics }: { metrics: Metrics | null }) {
  const rows: InfoRow[] = metrics
    ? [
        { label: '系统', value: `${metrics.host.platformLabel}（${metrics.host.arch}）` },
        { label: '主机名', value: metrics.host.hostname || '—' },
        {
          label: 'CPU',
          value: [
            metrics.cpu.model || '—',
            `${metrics.cpu.cores} 核`,
            metrics.cpu.speedMHz > 0 ? `${metrics.cpu.speedMHz} MHz` : '',
          ].filter(Boolean).join(' · '),
        },
        {
          label: '内存',
          value: `${formatBytes(metrics.memory.systemUsedBytes)} / ${formatBytes(metrics.memory.systemTotalBytes)}（${formatPct(metrics.memory.systemPercent)}%）`,
          bar: { percent: metrics.memory.systemPercent, tone: 'pink' },
        },
        {
          label: '项目占用',
          value: (() => {
            const rss = metrics.memory.nodeRssBytes ?? metrics.memory.processRssBytes;
            const heap = metrics.memory.nodeHeapUsedBytes ?? metrics.memory.processHeapUsedBytes;
            const pct = metrics.memory.nodePercent ?? metrics.memory.processPercent;
            return `${formatBytes(rss)} · 堆 ${formatBytes(heap)}（占系统 ${formatPct(pct)}%）`;
          })(),
          bar: {
            percent: metrics.memory.nodePercent ?? metrics.memory.processPercent,
            tone: 'violet',
          },
          labelClassName: 'text-indigo-600',
          valueClassName: 'text-indigo-700',
        },
        {
          label: '磁盘',
          value: metrics.disk.totalBytes
            ? `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}（${formatPct(metrics.disk.usedPercent)}%）`
            : '—',
          bar: metrics.disk.totalBytes
            ? { percent: metrics.disk.usedPercent, tone: 'amber' }
            : undefined,
        },
        { label: 'Node.js 版本', value: metrics.host.nodeVersion },
        { label: '咔咔珂版本', value: `v${metrics.frameworkVersion}` },
        { label: '进程运行', value: formatUptime(metrics.uptimeSec) },
      ]
    : [
        { label: '系统', value: '采集中…' },
        { label: 'CPU', value: '采集中…' },
        { label: '内存', value: '采集中…' },
        { label: '项目占用', value: '采集中…', labelClassName: 'text-indigo-600' },
        { label: '咔咔珂版本', value: '采集中…' },
      ];

  return (
    <section className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Info className="h-4 w-4 text-primary" />
          系统信息
        </h2>
        <p className="text-xs text-muted-foreground">主机与运行环境只读信息</p>
      </div>
      <div className="kk-card overflow-hidden rounded-[1.25rem]">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[7.5rem] bg-white/25">项目</TableHead>
              <TableHead className="bg-white/25">内容</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.label} className="hover:bg-white/25">
                <TableCell className={cn('align-top font-medium text-muted-foreground', row.labelClassName)}>
                  {row.label}
                </TableCell>
                <TableCell className={cn('break-all text-foreground', row.valueClassName)}>
                  <div>{row.value}</div>
                  {row.bar ? <MiniBar percent={row.bar.percent} tone={row.bar.tone} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  );
}

export function SystemMonitorPanel({ className }: { className?: string }) {
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    const tick = async () => {
      try {
        const m = await api.systemMetrics();
        if (cancelled) return;
        setMetrics(m);
        setError('');
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
          <SystemGauge
            label="CPU 占用"
            tone="cpu"
            percent={metrics?.cpu.processPercent ?? 0}
            processPercent={metrics?.cpu.processPercent}
            hint={metrics ? `本进程 · ${metrics.cpu.cores} 核` : '采集中…'}
          />
          <SystemGauge
            label="内存占用"
            tone="memory"
            percent={metrics?.memory.systemPercent ?? 0}
            processPercent={metrics?.memory.nodePercent ?? metrics?.memory.processPercent}
            legend={{ systemLabel: '系统', processLabel: '项目占用' }}
            hint={
              metrics
                ? `系统 ${formatBytes(metrics.memory.systemUsedBytes)}/${formatBytes(metrics.memory.systemTotalBytes)} · 项目 ${formatBytes(metrics.memory.nodeRssBytes ?? metrics.memory.processRssBytes)}（${formatPct(metrics.memory.nodePercent ?? metrics.memory.processPercent)}%）`
                : '采集中…'
            }
          />
          <SystemGauge
            label="磁盘占用"
            tone="disk"
            percent={metrics?.disk.usedPercent ?? 0}
            hint={
              metrics?.disk.totalBytes
                ? `${formatBytes(metrics.disk.usedBytes)} / ${formatBytes(metrics.disk.totalBytes)}`
                : '采集中…'
            }
            className="sm:col-span-2 md:col-span-1"
          />
        </div>
      </section>

      <SystemInfoTable metrics={metrics} />
    </div>
  );
}
