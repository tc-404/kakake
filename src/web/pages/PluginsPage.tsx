import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type RefObject } from 'react';
import { toast } from 'sonner';
import {
  Loader2, Package, Puzzle, RefreshCw, Upload, BookOpen, ExternalLink, Search, Activity, Trash2, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { ExtensionPage, PluginItem } from '@/lib/types';
import { DEFAULT_API_TIMEOUT_MS, STATUS_MAP } from '@/lib/types';
import { cn } from '@/lib/utils';
import { pluginHostConsolePath } from '@/lib/plugin-host-paths';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginDocsDialog } from '@/components/plugin-docs-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type QueueItemStatus = 'pending' | 'queued' | 'uploading' | 'success' | 'error' | 'timeout';

type UploadQueueItem = {
  id: string;
  file: File;
  status: QueueItemStatus;
  message?: string;
};

function isZipFile(file: File): boolean {
  // 放宽：常见压缩包格式都接受，后端按魔数识别再解压
  return /\.(zip|tar|tar\.gz|tgz|gz|rar|7z|xz|bz2)$/i.test(file.name || '');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function queueStatusLabel(status: QueueItemStatus): string {
  switch (status) {
    case 'pending': return '等待确认';
    case 'queued': return '排队中';
    case 'uploading': return '上传中';
    case 'success': return '成功';
    case 'error': return '失败';
    case 'timeout': return '超时';
    default: return status;
  }
}

function mergePlugin(list: PluginItem[], item: PluginItem): PluginItem[] {
  const i = list.findIndex((p) => p.id === item.id);
  if (i < 0) return [...list, item];
  const next = [...list];
  next[i] = { ...list[i], ...item };
  return next;
}

function hasRealDescription(text?: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t === '暂无描述' || t === '无描述') return false;
  return true;
}

function StatusPill({ status }: { status: PluginItem['status'] }) {
  const st = STATUS_MAP[status] || STATUS_MAP.disabled;
  const active = status === 'active';
  const disabled = status === 'disabled' || status === 'stopped';
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-xl border px-2 py-0.5 text-[11px] font-medium backdrop-blur-sm',
        active && 'border-emerald-300/50 bg-emerald-400/15 text-emerald-700',
        status === 'error' && 'border-rose-300/50 bg-rose-400/15 text-rose-700',
        status === 'stopped' && 'border-amber-300/50 bg-amber-400/15 text-amber-700',
        status === 'disabled' && 'border-white/40 bg-white/25 text-slate-500',
      )}
    >
      {active ? (
        <span className="relative flex h-1.5 w-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
        </span>
      ) : (
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            status === 'error' && 'bg-rose-400',
            status === 'stopped' && 'bg-amber-400',
            disabled && status === 'disabled' && 'bg-slate-300',
          )}
        />
      )}
      {st.text}
    </span>
  );
}

// 统计条 / 筛选栏 / 搜索框 / 空状态等次级面板：跟随「组件1」（卡片透明度 / 组件模糊度）
const GLASS_CTRL =
  'kk-glass shadow-sm transition-all duration-300 hover:bg-white/30';

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [pages, setPages] = useState<ExtensionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'kakake' | 'gf' | 'wx' | 'ss'>('all');
  const [query, setQuery] = useState('');
  const [docsPlugin, setDocsPlugin] = useState<PluginItem | null>(null);
  const [deletePlugin, setDeletePlugin] = useState<PluginItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [queueItems, setQueueItems] = useState<UploadQueueItem[]>([]);
  const [queueRunning, setQueueRunning] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const queueRunningRef = useRef(false);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const res = await api.plugins.list();
      setPlugins(res.data.plugins);
      setPages(res.data.extensionPages);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await api.plugins.list();
        if (cancelled) return;
        setPlugins(res.data.plugins);
        setPages(res.data.extensionPages);
      } catch (e) {
        if (!cancelled) toast.error(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => ({
    all: plugins.length,
    kakake: plugins.filter((p) => (p.kind ?? 'kakake') === 'kakake').length,
    gf: plugins.filter((p) => p.kind === 'gf').length,
    wx: plugins.filter((p) => p.kind === 'wx').length,
    ss: plugins.filter((p) => p.kind === 'ss').length,
  }), [plugins]);

  const filterTabs = useMemo(() => (
    [
      { id: 'all' as const, label: '全部', count: counts.all },
      { id: 'kakake' as const, label: '三方', count: counts.kakake },
      { id: 'gf' as const, label: '官方', count: counts.gf },
      { id: 'wx' as const, label: '微信', count: counts.wx },
      { id: 'ss' as const, label: 'KOOK', count: counts.ss },
    ]
  ), [counts]);

  const filterIndex = Math.max(0, filterTabs.findIndex((t) => t.id === filter));
  const layoutKey = `${counts.all}-${counts.kakake}-${counts.gf}-${counts.wx}-${counts.ss}`;
  const { navRef, setItemRef, box } = useLiquidIndicator(filterIndex, filterTabs.length, layoutKey);

  const stats = useMemo(() => {
    const masterOn = plugins.filter((p) => p.masterEnabled !== false).length;
    const active = plugins.filter((p) => p.status === 'active').length;
    return { total: plugins.length, masterOn, active };
  }, [plugins]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filter !== 'all' && (p.kind ?? 'kakake') !== filter) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.id} ${p.description} ${p.author}`.toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, filter, query]);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.plugins.rescan();
      setPlugins(res.data.plugins);
      setPages(res.data.extensionPages);
      toast.success(`已刷新，共 ${res.data.count} 个插件`);
    } catch (e) {
      toast.error(String(e));
      await load({ silent: true });
    } finally {
      setLoading(false);
    }
  };

  const onMasterToggle = async (plugin: PluginItem, enable: boolean) => {
    setTogglingId(plugin.id);
    try {
      const res = await api.plugins.setStatus(plugin.id, enable);
      if (res.data?.plugin) {
        setPlugins((prev) => mergePlugin(prev, res.data!.plugin));
        toast.success(enable ? `${plugin.name} 总开关已开启` : `${plugin.name} 总开关已关闭`);
      } else {
        await load({ silent: true });
      }
    } catch (e) {
      toast.error(String(e));
      await load({ silent: true });
    } finally {
      setTogglingId(null);
    }
  };

  const enqueueFiles = useCallback((files: FileList | File[]) => {
    if (queueRunningRef.current) {
      toast.message('正在上传中，请等待当前队列完成');
      return;
    }
    const list = Array.from(files);
    const zips = list.filter(isZipFile);
    const skipped = list.length - zips.length;
    if (skipped > 0) {
      toast.message(`已忽略 ${skipped} 个不支持的文件`);
    }
    if (!zips.length) {
      if (list.length > 0) toast.error('仅支持 zip / tar / rar / 7z 等压缩包');
      return;
    }
    const next: UploadQueueItem[] = zips.map((file) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}-${file.name}`,
      file,
      status: 'pending',
    }));
    setQueueItems((prev) => {
      const active = prev.some((item) => (
        item.status === 'pending' || item.status === 'queued' || item.status === 'uploading'
      ));
      return active ? [...prev, ...next] : next;
    });
    setQueueOpen(true);
  }, []);

  const removeQueueItem = (id: string) => {
    if (queueRunningRef.current) return;
    setQueueItems((prev) => {
      const next = prev.filter((item) => item.id !== id);
      if (!next.length) setQueueOpen(false);
      return next;
    });
  };

  const clearQueue = () => {
    if (queueRunningRef.current) return;
    setQueueItems([]);
    setQueueOpen(false);
  };

  const confirmUploadQueue = async () => {
    if (queueRunningRef.current) return;
    const pending = queueItems.filter((item) => item.status === 'pending');
    if (!pending.length) return;

    queueRunningRef.current = true;
    setQueueRunning(true);

    let timeoutMs = DEFAULT_API_TIMEOUT_MS;
    try {
      const settings = await api.settings.get();
      timeoutMs = settings.config.apiTimeoutMs ?? DEFAULT_API_TIMEOUT_MS;
    } catch {
      /* 用默认超时 */
    }

    const pendingIds = new Set(pending.map((item) => item.id));
    setQueueItems((prev) => prev.map((item) => (
      pendingIds.has(item.id) ? { ...item, status: 'queued' as const } : item
    )));

    let success = 0;
    let failed = 0;

    for (const item of pending) {
      setQueueItems((prev) => prev.map((q) => (
        q.id === item.id ? { ...q, status: 'uploading', message: undefined } : q
      )));
      try {
        const r = await api.plugins.importZip(item.file, timeoutMs);
        if (r.ok) {
          success += 1;
          const hint = r.kind === 'gf'
            ? '官方机器人插件'
            : r.kind === 'wx'
              ? '微信机器人插件'
              : r.kind === 'ss'
                ? '其他（KOOK）插件'
                : 'OneBot 插件';
          setQueueItems((prev) => prev.map((q) => (
            q.id === item.id
              ? {
                  ...q,
                  status: 'success',
                  message: r.message || `安装成功${r.pluginId ? `：${r.pluginId}` : ''}（${hint}）`,
                }
              : q
          )));
        } else {
          failed += 1;
          setQueueItems((prev) => prev.map((q) => (
            q.id === item.id
              ? { ...q, status: 'error', message: r.message || '安装失败' }
              : q
          )));
        }
      } catch (e) {
        failed += 1;
        const msg = e instanceof Error ? e.message : String(e);
        const isTimeout = msg.includes('超时');
        setQueueItems((prev) => prev.map((q) => (
          q.id === item.id
            ? { ...q, status: isTimeout ? 'timeout' : 'error', message: msg }
            : q
        )));
      }
    }

    await load({ silent: true });
    queueRunningRef.current = false;
    setQueueRunning(false);

    if (failed === 0) {
      toast.success(`全部完成：成功 ${success} 个`);
    } else if (success === 0) {
      toast.error(`全部失败：${failed} 个`);
    } else {
      toast.message(`完成：成功 ${success}，失败 ${failed}`);
    }
  };

  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (queueRunningRef.current) return;
    dragDepthRef.current += 1;
    if (e.dataTransfer?.types?.includes('Files')) setDragActive(true);
  };

  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (queueRunningRef.current) return;
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setDragActive(false);
    if (queueRunningRef.current) {
      toast.message('正在上传中，请等待当前队列完成');
      return;
    }
    const files = e.dataTransfer?.files;
    if (files?.length) enqueueFiles(files);
  };

  const pagesOf = (id: string) => pages.filter((p) => p.pluginId === id);

  const queueFinished = queueItems.length > 0
    && queueItems.every((item) => item.status === 'success' || item.status === 'error' || item.status === 'timeout');

  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col gap-4 md:gap-5"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {dragActive ? (
        <div className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-teal-400/60 bg-teal-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border border-white/50 bg-white/70 px-6 py-4 text-center shadow-lg">
            <Upload className="mx-auto h-8 w-8 text-teal-600" />
            <p className="mt-2 text-sm font-medium text-slate-800">松开以添加插件压缩包</p>
            <p className="mt-1 text-xs text-slate-500">支持 zip/tar/rar/7z 等，确认后才会上传</p>
          </div>
        </div>
      ) : null}
      <div className="kk-stagger-item kk-stagger-1 shrink-0 space-y-3">
        <h1 className="kk-page-title hidden md:block">插件</h1>
        <div data-tour="plugins-toolbar" className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative min-w-0 w-full md:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索插件名称、ID…"
              className={cn(
                'h-10 w-full rounded-xl pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-400',
                'focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/15',
                GLASS_CTRL,
              )}
            />
          </div>
          <div
            className={cn(
              'flex w-full items-center justify-center gap-2',
              'md:w-auto md:shrink-0 md:gap-1.5 md:rounded-xl md:p-1',
              'md:border md:border-white/40 md:shadow-sm md:shadow-slate-200/20 md:bg-[rgba(255,255,255,var(--kk-card-alpha))] md:backdrop-blur-[var(--kk-blur)]',
            )}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.tar,.tar.gz,.tgz,.gz,.rar,.7z,.xz,.bz2,application/zip,application/x-tar,application/gzip,application/x-rar-compressed,application/x-7z-compressed"
              multiple
              className="hidden"
              onChange={(e) => {
                const files = e.target.files;
                if (files?.length) enqueueFiles(files);
                e.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              data-tour="plugins-upload"
              className={cn(
                'h-10 min-w-0 flex-1 rounded-xl px-3 text-slate-600 hover:bg-white/40',
                GLASS_CTRL,
                'md:h-8 md:flex-none md:rounded-lg md:border-0 md:bg-transparent md:shadow-none md:backdrop-blur-none',
              )}
              disabled={queueRunning}
              onClick={() => fileRef.current?.click()}
            >
              {queueRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              上传 zip
            </Button>
            <Button
              variant="ghost"
              data-tour="plugins-refresh"
              className={cn(
                'h-10 min-w-0 flex-1 rounded-xl px-3 text-slate-600 hover:bg-white/40',
                GLASS_CTRL,
                'md:h-8 md:flex-none md:rounded-lg md:border-0 md:bg-transparent md:shadow-none md:backdrop-blur-none',
              )}
              disabled={loading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              刷新
            </Button>
          </div>
        </div>
      </div>

      {/* 水平紧凑统计条 */}
      <div
        data-tour="plugins-stats"
        className={cn(
          'kk-stagger-item kk-stagger-2 grid shrink-0 grid-cols-3 gap-px overflow-hidden rounded-[1.15rem]',
          GLASS_CTRL,
        )}
      >
        <div className="flex items-center gap-2.5 px-3 py-2.5 sm:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-sky-400/15 text-sky-600">
            <Package className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">已安装</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.total}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 border-l border-white/35 px-3 py-2.5 sm:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-teal-400/15 text-teal-700">
            <Puzzle className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">总开关开</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.masterOn}</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5 border-l border-white/35 px-3 py-2.5 sm:px-4">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-emerald-400/15 text-emerald-600">
            <Activity className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">运行中</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.active}</p>
          </div>
        </div>
      </div>

      {/* 悬浮玻璃药丸 Tabs · 液态滑动指示 */}
      <div data-tour="plugins-filter" className="sticky top-0 z-20 -mx-1 shrink-0 px-1 py-1">
        <div
          ref={navRef as RefObject<HTMLDivElement>}
          className={cn(
            // 不换行 + 等分：四个按钮永远在同一行且宽度一致
            'relative flex flex-nowrap items-stretch gap-1 rounded-[1.15rem] p-1 sm:gap-1.5 sm:p-1.5',
            GLASS_CTRL,
          )}
        >
          <div
            aria-hidden
            className={cn('kk-nav-liquid !rounded-xl', box.ready && 'kk-nav-liquid-ready')}
            style={{
              transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
              width: box.width,
              height: box.height,
            }}
          />
          {filterTabs.map((t, index) => {
            const active = filter === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => setItemRef(index, el)}
                type="button"
                onClick={() => setFilter(t.id)}
                className={cn(
                  // basis-0 + flex-1：等宽均分，宽度与文字长短无关；whitespace-nowrap 保证单行
                  'relative z-[1] flex min-w-0 flex-1 basis-0 items-center justify-center gap-1',
                  'whitespace-nowrap rounded-xl px-1.5 py-1.5 text-sm font-medium transition-colors duration-300 sm:gap-1.5 sm:px-2',
                  active
                    ? 'border border-transparent text-teal-700'
                    : 'border border-transparent bg-transparent text-slate-500 hover:bg-white/20 hover:text-slate-700',
                )}
              >
                {t.label}
                <span
                  className={cn(
                    // 手机端隐藏数量，桌面端（sm+）正常显示
                    'hidden shrink-0 rounded-lg px-1 py-px text-[11px] tabular-nums sm:inline sm:px-1.5',
                    active ? 'bg-teal-500/15 text-teal-700' : 'bg-white/25 text-slate-500',
                  )}
                >
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="min-h-0 flex-1 pb-2">
        {loading && plugins.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            加载插件列表…
          </div>
        ) : visible.length === 0 ? (
          <div className={cn('flex flex-col items-center justify-center gap-3 rounded-[1.25rem] border-dashed py-16', GLASS_CTRL)}>
            <Package className="h-10 w-10 text-slate-300" />
            <p className="text-sm text-slate-400">
              {query.trim() ? '无匹配插件' : '暂无插件，点击上方「上传 zip」安装'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            {visible.map((plugin, index) => {
              const masterOn = plugin.masterEnabled !== false;
              const kindLabel = plugin.kind === 'gf'
                ? '官方'
                : plugin.kind === 'wx'
                  ? '微信'
                  : plugin.kind === 'ss'
                    ? 'KOOK'
                    : 'OneBot';
              const hasAdmin = (plugin.hasPages || pagesOf(plugin.id).length > 0)
                && masterOn
                && plugin.status === 'active';
              const showDesc = hasRealDescription(plugin.description);
              return (
                <article
                  key={plugin.id}
                  style={{ animationDelay: `${Math.min(index, 14) * 0.07}s` }}
                  className={cn(
                    'kk-plugin-card kk-stagger-item group flex flex-col gap-2.5 overflow-hidden rounded-2xl p-4',
                    'kk-glass shadow-lg',
                    'transition-all duration-300 hover:-translate-y-0.5 hover:shadow-xl',
                  )}
                >
                  <div className="flex shrink-0 items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-xl border border-white/50 bg-white/25">
                        {plugin.iconUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={plugin.iconUrl} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <span className="flex h-full items-center justify-center text-slate-300">
                            <Puzzle className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <h2 className="truncate text-[15px] font-semibold text-slate-800">{plugin.name}</h2>
                          <span className="shrink-0 rounded-lg bg-white/30 px-1.5 py-px text-[10px] font-medium text-slate-500">
                            v{plugin.version}
                          </span>
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-slate-400">{plugin.id}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <StatusPill status={plugin.status} />
                      <Switch
                        data-tour="plugin-master-switch"
                        checked={masterOn}
                        disabled={togglingId === plugin.id}
                        onCheckedChange={(v) => void onMasterToggle(plugin, v)}
                        aria-label={`${plugin.name} 总开关`}
                        title={masterOn ? '关闭总开关' : '打开总开关'}
                      />
                    </div>
                  </div>

                  {showDesc ? (
                    <p className="line-clamp-2 text-sm leading-snug text-slate-600">
                      {plugin.description}
                    </p>
                  ) : null}

                  {plugin.errorMessage && plugin.status === 'error' ? (
                    <p className="line-clamp-1 text-xs text-rose-500">{plugin.errorMessage}</p>
                  ) : null}

                  <div className="mt-auto flex items-center justify-between gap-2 border-t border-white/30 pt-2.5">
                    <div className="flex min-w-0 flex-wrap gap-1">
                      <span className="rounded-md bg-white/25 px-1.5 py-0.5 text-[10px] text-slate-500">{kindLabel}</span>
                      {plugin.author ? (
                        <span className="truncate rounded-md bg-white/25 px-1.5 py-0.5 text-[10px] text-slate-500">
                          {plugin.author}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {plugin.hasDocs ? (
                        <button
                          type="button"
                          title="查看说明"
                          onClick={() => setDocsPlugin(plugin)}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium',
                            'text-slate-500 transition-colors hover:bg-white/40 hover:text-teal-700 active:scale-95',
                          )}
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          说明
                        </button>
                      ) : null}
                      {hasAdmin ? (
                        <button
                          type="button"
                          title="打开控制台"
                          onClick={() => {
                            const list = pagesOf(plugin.id);
                            const path = list[0]?.path || 'admin';
                            const host = list[0]?.hostPath;
                            const accounts = plugin.loadedAccounts || [];
                            let target = host || pluginHostConsolePath(plugin.id, path);
                            if (accounts.length === 1) {
                              target = host && host.includes('/a/')
                                ? host
                                : pluginHostConsolePath(plugin.id, path, accounts[0]);
                            }
                            window.open(target, '_blank', 'noopener,noreferrer');
                          }}
                          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-white/40 hover:text-slate-700 active:scale-95"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title="删除插件（plugins 安装目录）"
                        onClick={() => setDeletePlugin(plugin)}
                        className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-400/15 hover:text-rose-600 active:scale-95"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      <PluginDocsDialog
        plugin={docsPlugin}
        open={!!docsPlugin}
        onClose={() => setDocsPlugin(null)}
      />

      <Dialog
        open={queueOpen}
        onOpenChange={(open) => {
          if (queueRunning) return;
          if (!open) clearQueue();
          else setQueueOpen(true);
        }}
      >
        <DialogContent
          className="max-w-lg"
          hideClose={queueRunning}
          onPointerDownOutside={(e: Event) => {
            if (queueRunning) e.preventDefault();
          }}
          onEscapeKeyDown={(e: KeyboardEvent) => {
            if (queueRunning) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{queueRunning ? '正在上传插件' : queueFinished ? '上传完成' : '确认上传插件'}</DialogTitle>
            {queueRunning || queueFinished ? (
              <DialogDescription>
                {queueRunning
                  ? '按队列逐个上传，超时仅对当前正在上传的文件计时。'
                  : '本批已全部处理完毕，可关闭窗口。'}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <ul className="max-h-[min(50dvh,22rem)] space-y-2 overflow-y-auto">
            {queueItems.map((item) => (
              <li
                key={item.id}
                className="flex items-start gap-2 rounded-xl border border-white/40 bg-white/25 px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-slate-800">{item.file.name}</span>
                    <span
                      className={cn(
                        'shrink-0 rounded-full px-2 py-0.5 text-[11px]',
                        item.status === 'success' && 'bg-teal-500/15 text-teal-700',
                        item.status === 'error' && 'bg-rose-500/10 text-rose-600',
                        item.status === 'timeout' && 'bg-amber-500/15 text-amber-700',
                        item.status === 'uploading' && 'bg-sky-500/15 text-sky-700',
                        (item.status === 'pending' || item.status === 'queued') && 'bg-slate-500/10 text-slate-500',
                      )}
                    >
                      {item.status === 'uploading' ? (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          上传中
                        </span>
                      ) : queueStatusLabel(item.status)}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">{formatBytes(item.file.size)}</p>
                  {item.message ? (
                    <p className="mt-1 line-clamp-2 text-xs text-slate-500" title={item.message}>
                      {item.message}
                    </p>
                  ) : null}
                </div>
                {!queueRunning && item.status === 'pending' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-slate-400 hover:text-rose-500"
                    onClick={() => removeQueueItem(item.id)}
                    aria-label={`移除 ${item.file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <DialogFooter>
            {queueFinished ? (
              <Button type="button" onClick={clearQueue}>完成</Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={queueRunning} onClick={clearQueue}>
                  取消
                </Button>
                <Button
                  type="button"
                  disabled={queueRunning || !queueItems.some((item) => item.status === 'pending')}
                  onClick={() => void confirmUploadQueue()}
                >
                  {queueRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  确定上传
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={!!deletePlugin}
        onOpenChange={(v) => {
          if (!v && !deleting) setDeletePlugin(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-slate-800">删除插件？</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-500">
              {deletePlugin?.name}（{deletePlugin?.id}）— 将删除 plugins/ 安装目录，并清理各账号
              plugins_two 运行副本。是否同时删除插件数据？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3 sm:gap-3">
            <AlertDialogCancel
              className="mt-0"
              disabled={deleting}
              onClick={() => setDeletePlugin(null)}
            >
              取消
            </AlertDialogCancel>
            <Button
              type="button"
              variant="outline"
              disabled={deleting}
              onClick={() => {
                void (async () => {
                  if (!deletePlugin) return;
                  setDeleting(true);
                  try {
                    await api.plugins.uninstall(deletePlugin.id, false);
                    toast.success('已删除插件');
                    setDeletePlugin(null);
                    await load({ silent: true });
                  } catch (e) {
                    toast.error(String(e));
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              仅删除
            </Button>
            <AlertDialogAction
              className="bg-rose-500 text-white hover:bg-rose-600"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                void (async () => {
                  if (!deletePlugin) return;
                  setDeleting(true);
                  try {
                    await api.plugins.uninstall(deletePlugin.id, true);
                    toast.success('已删除插件并清空数据');
                    setDeletePlugin(null);
                    await load({ silent: true });
                  } catch (err) {
                    toast.error(String(err));
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              删除并清数据
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
