// 注意：这里的 DragEvent 走的是原生 DOM 全局类型（window 上的拖放监听），
// 不要从 react 里 import 同名类型，否则会被 React 合成事件类型遮蔽导致类型不匹配。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import { useLang, useT } from '@/lib/i18n';
import {
  Loader2, Package, Puzzle, RefreshCw, Upload, BookOpen, ExternalLink, Github, Search, Activity, Trash2, X,
  ChevronDown, ChevronUp, Share2, Download, Settings2,
} from 'lucide-react';
import { QuietExternal } from '@/components/quiet-link';
import { api, UPLOAD_TIMEOUT_MS } from '@/lib/api';
import type { ExtensionPage, PluginItem } from '@/lib/types';
import { STATUS_MAP } from '@/lib/types';
import { cn } from '@/lib/utils';
import { pluginHostConsolePath } from '@/lib/plugin-host-paths';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginDocsDialog } from '@/components/plugin-docs-dialog';
import { PluginShareDialog } from '@/components/plugin-share-dialog';
import { PluginConfigDialog } from '@/components/plugin-config-dialog';
import { PluginImportLinkDialog, type PluginLinkImportResult } from '@/components/plugin-import-link-dialog';
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
import { usePageHeader } from '@/components/header-actions';
import { errText, resText, svcText } from '@/lib/server-error';

type QueueItemStatus = 'pending' | 'queued' | 'uploading' | 'success' | 'error' | 'timeout';

type UploadQueueItem = {
  id: string;
  file: File;
  status: QueueItemStatus;
  message?: string;
  /** 上传进度（XHR upload.onprogress 上报的真实字节） */
  loaded?: number;
  total?: number;
};

function isZipFile(file: File): boolean {
  // 放宽：常见压缩包格式都接受，后端按魔数识别再解压
  return /\.(zip|tar|tar\.gz|tgz|gz|rar|7z|xz|bz2)$/i.test(file.name || '');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function queueStatusLabel(t: (key: string) => string, status: QueueItemStatus): string {
  switch (status) {
    case 'pending': return t('plugins.queuePending');
    case 'queued': return t('plugins.queueQueued');
    case 'uploading': return t('plugins.queueUploading');
    case 'success': return t('label.success');
    case 'error': return t('label.failed');
    case 'timeout': return t('plugins.queueTimeout');
    default: return status;
  }
}

/**
 * 队列条目里的结果说明（失败原因 / 超时提示）。
 *
 * 之前是写死的 line-clamp-2：超过两行直接截断，只能靠 hover 的原生 title 看全文，
 * 手机端没有 hover，长错误码根本看不全。现在改成「真的溢出了才出现展开按钮」，
 * 点一下完整显示，再点收起。
 */
function QueueItemMessage({ message, status }: { message: string; status: QueueItemStatus }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    // 展开时不再测量：展开后本来就不溢出了，量出 false 会把「收起」按钮自己弄没
    if (expanded) return;
    const el = ref.current;
    if (!el) return;
    setOverflow(el.scrollHeight - el.clientHeight > 1);
  }, [message, expanded]);

  return (
    <div className="mt-1">
      <p
        ref={ref}
        title={expanded ? undefined : message}
        className={cn(
          'whitespace-pre-wrap break-words text-xs',
          expanded ? '' : 'line-clamp-2',
          status === 'error' ? 'text-rose-600'
            : status === 'timeout' ? 'text-amber-700'
              : 'text-slate-500',
        )}
      >
        {message}
      </p>
      {overflow ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] text-teal-700 transition-colors hover:text-teal-800 active:scale-95"
        >
          {expanded ? t('plugins.collapse') : t('plugins.expand')}
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </button>
      ) : null}
    </div>
  );
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
  const t = useT();
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
      {t(st.textKey)}
    </span>
  );
}

// 统计条 / 筛选栏 / 搜索框 / 空状态等次级面板：跟随「组件1」（卡片透明度 / 组件模糊度）
/*
 * 不要再挂 shadow-sm / shadow-lg 之类的 Tailwind 阴影工具类：
 * 它们落在 utilities 层，会把 .kk-glass 的 box-shadow: var(--glass-shadow)
 * 整条盖掉，于是这些卡片完全不受「阴影透明度」设置影响（表现为阴影压根不存在）。
 * 需要 hover 加浓就显式指向 --glass-shadow-hover。
 */
const GLASS_CTRL =
  'kk-glass transition-all duration-300 hover:bg-white/30';

export default function PluginsPage() {
  const t = useT();
  const lang = useLang();
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [pages, setPages] = useState<ExtensionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx' | 'kz'>('all');
  const [query, setQuery] = useState('');
  const [docsPlugin, setDocsPlugin] = useState<PluginItem | null>(null);
  const [sharePlugin, setSharePlugin] = useState<PluginItem | null>(null);
  /** 配置弹窗目标：多账号插件要带上被选中的账号 */
  const [configTarget, setConfigTarget] = useState<{ plugin: PluginItem; accountKey?: string } | null>(null);
  /** 多账号时先问「打开哪个账号的配置」，与 WebUI 按钮同口径 */
  const [configAccountPick, setConfigAccountPick] = useState<PluginItem | null>(null);
  const [importLinkOpen, setImportLinkOpen] = useState(false);
  /** 链接导入装完本体且包里带数据时，带着安装结果重开对话框问「是否连数据」 */
  const [importLinkResume, setImportLinkResume] = useState<PluginLinkImportResult | null>(null);
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
      toast.error(errText(e));
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
        if (!cancelled) toast.error(errText(e));
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
    sssx: plugins.filter((p) => p.kind === 'sssx').length,
    kz: plugins.filter((p) => p.kind === 'kz').length,
  }), [plugins]);

  const filterTabs = useMemo(() => (
    [
      { id: 'all' as const, label: t('plugins.filterAll'), count: counts.all },
      { id: 'kakake' as const, label: t('plugins.filterThirdParty'), count: counts.kakake },
      { id: 'gf' as const, label: t('plugins.filterOfficial'), count: counts.gf },
      { id: 'wx' as const, label: t('plugins.filterWechat'), count: counts.wx },
      { id: 'ss' as const, label: t('plugins.kindOther'), count: counts.ss },
      { id: 'sssx' as const, label: t('plugins.filterTwin'), count: counts.sssx },
      // 扩展插件有才出现：没人装扩展时保持六格布局（六格是中英文都不挤的上限）
      ...(counts.kz > 0
        ? [{ id: 'kz' as const, label: t('plugins.kindExtension'), count: counts.kz }]
        : []),
    ]
  ), [counts, lang]);

  // 计数归零时标签会消失：兜底回「全部」，避免停在一个不可达的筛选上
  const activeFilter = filterTabs.some((tab) => tab.id === filter) ? filter : 'all';
  const filterIndex = Math.max(0, filterTabs.findIndex((tab) => tab.id === activeFilter));
  // lang 也要进 key：中英切换会改变标签宽度/换行，指示条必须重测
  const layoutKey = `${lang}-${counts.all}-${counts.kakake}-${counts.gf}-${counts.wx}-${counts.ss}-${counts.sssx}-${counts.kz}`;
  const { navRef, setItemRef, box } = useLiquidIndicator(filterIndex, filterTabs.length, layoutKey);
  // 六格是中英文手机端都不挤的上限；出现第七格（扩展）时改为换行排布，避免互相压字
  const tabsWrapped = lang === 'en' || filterTabs.length > 6;

  const stats = useMemo(() => {
    const masterOn = plugins.filter((p) => p.masterEnabled !== false).length;
    const active = plugins.filter((p) => p.status === 'active').length;
    return { total: plugins.length, masterOn, active };
  }, [plugins]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (activeFilter !== 'all' && (p.kind ?? 'kakake') !== activeFilter) return false;
      if (!q) return true;
      const hay = `${p.name} ${p.id} ${p.description} ${p.author}`.toLowerCase();
      return hay.includes(q);
    });
  }, [plugins, activeFilter, query]);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await api.plugins.rescan();
      setPlugins(res.data.plugins);
      setPages(res.data.extensionPages);
      toast.success(t('plugins.refreshed', { n: res.data.count }));
    } catch (e) {
      toast.error(errText(e));
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
        toast.success(enable ? t('plugins.masterOn', { name: plugin.name }) : t('plugins.masterOff', { name: plugin.name }));
      } else {
        await load({ silent: true });
      }
    } catch (e) {
      toast.error(errText(e));
      await load({ silent: true });
    } finally {
      setTogglingId(null);
    }
  };

  const enqueueFiles = useCallback((files: FileList | File[]) => {
    if (queueRunningRef.current) {
      toast.message(t('plugins.uploadWaiting'));
      return;
    }
    const list = Array.from(files);
    const zips = list.filter(isZipFile);
    const skipped = list.length - zips.length;
    // 一个能用的都没有：只讲一条明确原因。
    // 之前是先弹「已忽略 N 个」再弹「仅支持…」，两条气泡叠在一起，像多出一层没用的提示。
    if (!zips.length) {
      if (list.length > 0) toast.error(t('plugins.onlyZip'));
      return;
    }
    if (skipped > 0) {
      toast.message(t('plugins.ignoredFiles', { n: skipped }));
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
        const r = await api.plugins.importZip(item.file, UPLOAD_TIMEOUT_MS, (loaded, total) => {
          // XHR 进度事件直接驱动：真实字节，频率足够顺滑
          setQueueItems((prev) => prev.map((q) => (
            q.id === item.id ? { ...q, loaded, total } : q
          )));
        });
        if (r.ok) {
          success += 1;
          const hint = r.kind === 'kz'
            ? t('plugins.kindExtension')
            : r.kind === 'sssx'
              ? t('plugins.kindTwin')
              : r.kind === 'gf'
                ? t('plugins.kindOfficial')
                : r.kind === 'wx'
                  ? t('plugins.kindWechat')
                  : r.kind === 'ss'
                    ? t('plugins.kindOther')
                    : t('plugins.kindOnebot');
          setQueueItems((prev) => prev.map((q) => (
            q.id === item.id
              ? {
                  ...q,
                  status: 'success',
                  message: svcText(r.message) || `${t('plugins.installSuccess')}${r.pluginId ? `：${r.pluginId}` : ''}（${hint}）`,
                }
              : q
          )));
        } else {
          failed += 1;
          setQueueItems((prev) => prev.map((q) => (
            q.id === item.id
              ? { ...q, status: 'error', message: resText(r) || t('plugins.installFailed') }
              : q
          )));
        }
      } catch (e) {
        failed += 1;
        // 先拿原始报文判超时（翻译后就认不出来了），再翻成当前语言上屏
        const raw = e instanceof Error ? e.message : String(e);
        const isTimeout = /超时|timed ?out|timeout/i.test(raw);
        const msg = errText(e);
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
      toast.success(t('plugins.allDone', { n: success }));
    } else if (success === 0) {
      toast.error(t('plugins.allFailed', { n: failed }));
    } else {
      toast.message(t('plugins.doneSummary', { s: success, f: failed }));
    }
  };

  /**
   * 整页拖拽上传：监听挂在 **window** 上，不是页面 div 上。
   *
   * 挂在页面 div 上时，热区只有页面内容那块——拖到顶栏、侧边栏或页面边缘的空白
   * 就不响应，看着像「拖了没反应」。挂 window 之后整个界面任意位置都能接住，
   * 遮罩也改成 fixed 铺满视口（与连接管理页一致）。
   */
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'));

    const onEnter = (e: DragEvent) => {
      // 只要是拖文件就吃掉默认行为，别让浏览器把压缩包当文件打开
      if (!hasFiles(e)) return;
      if (queueRunningRef.current) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (queueRunningRef.current) return;
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      if (queueRunningRef.current) {
        toast.message(t('plugins.uploadWaiting'));
        return;
      }
      const files = e.dataTransfer?.files;
      if (files?.length) enqueueFiles(files);
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [enqueueFiles]);

  const pagesOf = (id: string) => pages.filter((p) => p.pluginId === id);

  const queueFinished = queueItems.length > 0
    && queueItems.every((item) => item.status === 'success' || item.status === 'error' || item.status === 'timeout');

  // 上传与刷新交给顶栏承载，页面里只留搜索框
  usePageHeader(
    () => ({
      actions: (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            disabled={queueRunning}
            title={t('plugins.uploadArchive')}
            aria-label={t('plugins.uploadArchive')}
            data-tour="plugins-upload"
            onClick={() => fileRef.current?.click()}
          >
            {queueRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            title={t('plugins.importLinkTitle')}
            aria-label={t('plugins.importLinkTitle')}
            data-tour="plugins-import-link"
            onClick={() => setImportLinkOpen(true)}
          >
            <Download className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            disabled={loading}
            title={t('plugins.refresh')}
            aria-label={t('plugins.refresh')}
            data-tour="plugins-refresh"
            onClick={() => void refresh()}
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
          </Button>
        </>
      ),
    }),
    [queueRunning, loading, refresh],
  );

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col gap-4 md:gap-5">
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-teal-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-teal-400/60 bg-white/70 px-6 py-4 text-center shadow-lg">
            <Upload className="mx-auto h-8 w-8 text-teal-600" />
            <p className="mt-2 text-sm font-medium text-slate-800">{t('plugins.dropHint')}</p>
            <p className="mt-1 text-xs text-slate-500">{t('plugins.dropHintSub')}</p>
          </div>
        </div>
      ) : null}
      {/* 界面标题由顶栏显示；上传与刷新也已移到顶栏，这里只留搜索框 */}
      <div className="kk-stagger-item kk-stagger-1 shrink-0 space-y-3">
        <div data-tour="plugins-toolbar" className="flex flex-col gap-2 md:flex-row md:items-center">
          <div className="relative min-w-0 w-full md:flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('plugins.searchPlaceholder')}
              className={cn(
                'h-10 w-full rounded-xl pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-400',
                'focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/15',
                GLASS_CTRL,
              )}
            />
          </div>
          {/* 隐藏的文件选择器：顶栏的「上传」按钮通过 fileRef 触发它 */}
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
        <div className="flex items-center gap-1.5 px-2 py-2.5 sm:gap-2.5 sm:px-4">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-400/15 text-brand-600 sm:h-8 sm:w-8 sm:rounded-xl">
            <Package className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">{t('plugins.statInstalled')}</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.total}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-l border-white/35 px-2 py-2.5 sm:gap-2.5 sm:px-4">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-teal-400/15 text-teal-700 sm:h-8 sm:w-8 sm:rounded-xl">
            <Puzzle className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">{t('plugins.statMasterOn')}</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.masterOn}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 border-l border-white/35 px-2 py-2.5 sm:gap-2.5 sm:px-4">
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-emerald-400/15 text-emerald-600 sm:h-8 sm:w-8 sm:rounded-xl">
            <Activity className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[11px] font-medium text-slate-500">{t('plugins.statActive')}</p>
            <p className="text-lg font-semibold tabular-nums leading-none text-slate-800 sm:text-xl">{stats.active}</p>
          </div>
        </div>
      </div>

      {/* 悬浮玻璃药丸 Tabs · 液态滑动指示 */}
      {/* top-12 = 顶栏高度：顶栏是悬浮的，吸顶栏要停在它下沿而不是滚到它背后。
          z-10 要低于顶栏的 z-20，否则吸顶后会盖住顶栏 */}
      <div data-tour="plugins-filter" className="sticky top-12 z-10 -mx-1 shrink-0 px-1 py-1">
        <div
          ref={navRef as RefObject<HTMLDivElement>}
          className={cn(
            // 中文：不换行 + 等分，四个（六个）按钮永远在同一行且宽度一致
            // 英文：文案明显更长（Third-party / Official / WeChat …），手机上挤一行会互相重叠，
            //       所以英文模式在手机端放开换行、每行 3 个自动折成两行；sm+ 恢复等分单行
            // 中文出现第七格（扩展）时同样换行：每行 4 个，sm+ 恢复单行
            'relative flex items-stretch gap-1 rounded-[1.15rem] p-1 sm:gap-1.5 sm:p-1.5',
            tabsWrapped ? 'flex-wrap sm:flex-nowrap' : 'flex-nowrap',
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
            const active = activeFilter === t.id;
            return (
              <button
                key={t.id}
                ref={(el) => setItemRef(index, el)}
                type="button"
                onClick={() => setFilter(t.id)}
                className={cn(
                  // 中文：basis-0 + flex-1 等宽均分，宽度与文字长短无关；whitespace-nowrap 保证单行
                  // 英文手机端：每行 3 个（折两行），字号也收一档，避免长单词撑破按钮后互相压字
                  // 中文七格：每行 4 个，sm+ 恢复等分单行
                  'relative z-[1] flex min-w-0 items-center justify-center gap-1',
                  'rounded-xl px-1.5 py-1.5 font-medium transition-colors duration-300 sm:gap-1.5 sm:px-2',
                  !tabsWrapped
                    ? 'flex-1 basis-0 whitespace-nowrap text-sm'
                    : lang === 'en'
                      ? 'basis-[calc(33.333%_-_0.5rem)] grow whitespace-normal break-words text-center text-[13px] leading-tight sm:flex-1 sm:basis-0 sm:whitespace-nowrap sm:text-sm'
                      : 'basis-[calc(25%_-_0.375rem)] grow whitespace-normal break-words text-center text-[13px] leading-tight sm:flex-1 sm:basis-0 sm:whitespace-nowrap sm:text-sm',
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
            {t('plugins.loadingList')}
          </div>
        ) : visible.length === 0 ? (
          <div className={cn('flex flex-col items-center justify-center gap-3 rounded-[1.25rem] border-dashed py-16', GLASS_CTRL)}>
            <Package className="h-10 w-10 text-slate-300" />
            <p className="text-sm text-slate-400">
              {query.trim() ? t('plugins.noMatch') : t('plugins.emptyInstall')}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3">
            {visible.map((plugin, index) => {
              const masterOn = plugin.masterEnabled !== false;
              const kindLabel = plugin.kind === 'kz'
                ? t('plugins.kindExtension')
                : plugin.kind === 'sssx'
                  ? t('plugins.kindTwin')
                  : plugin.kind === 'gf'
                    ? t('plugins.kindOfficial')
                    : plugin.kind === 'wx'
                      ? t('plugins.kindWechat')
                      : plugin.kind === 'ss'
                        ? t('plugins.kindOther')
                        : t('plugins.kindOnebot');
              const hasAdmin = (plugin.hasPages || pagesOf(plugin.id).length > 0)
                && masterOn
                && plugin.status === 'active';
              // 类型标签配色：按路线区分，避免与说明按钮的灰色系混淆
              const kindTone = plugin.kind === 'kz'
                ? 'border-amber-300/60 bg-amber-400/10 text-amber-700'
                : plugin.kind === 'gf'
                  ? 'border-sky-300/60 bg-sky-400/10 text-sky-700'
                  : plugin.kind === 'wx'
                    ? 'border-emerald-300/60 bg-emerald-400/10 text-emerald-700'
                    : plugin.kind === 'ss'
                      ? 'border-purple-300/60 bg-purple-400/10 text-purple-700'
                      : plugin.kind === 'sssx'
                        ? 'border-fuchsia-300/60 bg-fuchsia-400/10 text-fuchsia-700'
                        : 'border-teal-300/60 bg-teal-400/10 text-teal-700';
              const showDesc = hasRealDescription(plugin.description);
              return (
                <article
                  key={plugin.id}
                  style={{ animationDelay: `${Math.min(index, 14) * 0.07}s` }}
                  className={cn(
                    'kk-plugin-card kk-stagger-item group flex flex-col gap-2.5 overflow-hidden rounded-2xl p-4',
                    'kk-glass',
                    'transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[var(--glass-shadow-hover)]',
                  )}
                >
                  {/*
                    头部排版：图标 + 「名称 / 版本·作者 / ID」纵向三行。
                    以前 ID 放在右侧 shrink-0 的列里：一个 165px 长的小写 ID
                    （kakake-plugin-comic-downloader）配上 64px 图标，会把插件名
                    挤到只剩 1~16px —— 手机上几乎完全看不见名字。现在 ID 单独占一行，
                    名称只跟状态徽标分宽度，并且允许折两行，永远不会被 ID 挤掉。
                  */}
                  <div className="flex shrink-0 items-start gap-2.5">
                    <div className="h-14 w-14 shrink-0 overflow-hidden rounded-xl border border-white/50 sm:h-16 sm:w-16">
                      {plugin.iconUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={plugin.iconUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center text-slate-300">
                          <Puzzle className="h-6 w-6" />
                        </span>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-start justify-between gap-2">
                        <h2 className="line-clamp-2 min-w-0 break-words text-[15px] font-semibold leading-snug text-slate-800 sm:line-clamp-1">
                          {plugin.name}
                        </h2>
                        <span className="shrink-0">
                          <StatusPill status={plugin.status} />
                        </span>
                      </div>
                      <div className="mt-1 flex min-w-0 items-center gap-1.5">
                        <span className="shrink-0 rounded-lg bg-white/30 px-1.5 py-px text-[10px] font-medium text-slate-500">
                          v{plugin.version}
                        </span>
                        {plugin.author ? (
                          <p className="min-w-0 truncate text-[11px] text-slate-500">{plugin.author}</p>
                        ) : null}
                      </div>
                      <p
                        title={plugin.id}
                        className="mt-0.5 truncate font-mono text-[10px] leading-tight text-slate-400"
                      >
                        {plugin.id}
                      </p>
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
                    <div className="flex min-w-0 items-center gap-1.5">
                      {/* 说明按钮固定左下角：没有文档时淡色且不可点 */}
                      <button
                        type="button"
                        title={plugin.hasDocs ? t('plugins.viewDocs') : t('plugins.noDocs')}
                        disabled={!plugin.hasDocs}
                        onClick={() => {
                          if (!plugin.hasDocs) return;
                          setDocsPlugin(plugin);
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                          plugin.hasDocs
                            ? 'text-slate-500 hover:bg-white/40 hover:text-teal-700 active:scale-95'
                            : 'cursor-not-allowed text-slate-400',
                        )}
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        {t('plugins.docs')}
                      </button>
                      {/* 类型标签：说明右侧，按路线着色 */}
                      <span className={cn('rounded-md border px-1.5 py-0.5 text-[10px] font-medium leading-none', kindTone)}>
                        {kindLabel}
                      </span>
                      {/* 分享按钮：类型标签右侧，打包上传到临时存储点拿分享链接 */}
                      <button
                        type="button"
                        title={t('plugins.share')}
                        aria-label={t('plugins.share')}
                        data-tour="plugin-share"
                        onClick={() => setSharePlugin(plugin)}
                        className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/40 hover:text-teal-700 active:scale-95"
                      >
                        <Share2 className="h-4 w-4" />
                      </button>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {plugin.homepage ? (
                        <QuietExternal
                          href={plugin.homepage}
                          title={plugin.homepage.replace(/^https?:\/\//, '')}
                          className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/40 hover:text-slate-700 active:scale-95"
                        >
                          <Github className="h-4 w-4" />
                        </QuietExternal>
                      ) : null}
                      {/* 配置按钮：只在插件确实有配置窗口时出现，位置固定在 WebUI 跳转按钮左侧 */}
                      {plugin.hasConfig ? (
                        <button
                          type="button"
                          title={t('plugins.openConfig')}
                          aria-label={t('plugins.openConfig')}
                          onClick={() => {
                            const accounts = plugin.loadedAccounts || [];
                            // 多账号：先问打开哪个账号的配置（各账号各有 config.json）
                            if (accounts.length > 1) {
                              setConfigAccountPick(plugin);
                              return;
                            }
                            setConfigTarget({ plugin, accountKey: accounts[0] });
                          }}
                          className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/40 hover:text-teal-700 active:scale-95"
                        >
                          <Settings2 className="h-4 w-4" />
                        </button>
                      ) : null}
                      {hasAdmin ? (
                        <button
                          type="button"
                          title={t('plugins.openConsole')}
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
                          className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/40 hover:text-slate-700 active:scale-95"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        title={t('plugins.deletePluginTitle')}
                        onClick={() => setDeletePlugin(plugin)}
                        className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-rose-400/15 hover:text-rose-600 active:scale-95"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      {/* 开关固定右下角 */}
                      <Switch
                        data-tour="plugin-master-switch"
                        checked={masterOn}
                        disabled={togglingId === plugin.id}
                        onCheckedChange={(v) => void onMasterToggle(plugin, v)}
                        aria-label={t('plugins.masterSwitchAria', { name: plugin.name })}
                        title={masterOn ? t('plugins.switchOff') : t('plugins.switchOn')}
                      />
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

      <PluginShareDialog
        plugin={sharePlugin}
        open={!!sharePlugin}
        onClose={() => setSharePlugin(null)}
      />

      {/* 卡片上的配置入口：与连接面板同一个弹窗，多账号时先选账号 */}
      <PluginConfigDialog
        plugin={configTarget?.plugin ?? null}
        open={!!configTarget}
        accountKey={configTarget?.accountKey}
        onClose={() => setConfigTarget(null)}
        onReload={() => void load({ silent: true })}
      />

      <Dialog open={!!configAccountPick} onOpenChange={(v) => !v && setConfigAccountPick(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('plugins.configPickAccount')}</DialogTitle>
            <DialogDescription>
              {t('plugins.configPickAccountDesc', { name: configAccountPick?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {(configAccountPick?.loadedAccounts || []).map((account) => (
              <Button
                key={account}
                variant="outline"
                onClick={() => {
                  const plugin = configAccountPick;
                  setConfigAccountPick(null);
                  if (plugin) setConfigTarget({ plugin, accountKey: account });
                }}
              >
                {account}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <PluginImportLinkDialog
        open={importLinkOpen}
        onClose={() => {
          setImportLinkOpen(false);
          setImportLinkResume(null);
        }}
        onImported={() => void load({ silent: true })}
        resume={importLinkResume}
        onResumeAskData={(r) => {
          setImportLinkResume(r);
          setImportLinkOpen(true);
        }}
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
            <DialogTitle>{queueRunning ? t('plugins.uploadingTitle') : queueFinished ? t('plugins.uploadDoneTitle') : t('plugins.uploadConfirmTitle')}</DialogTitle>
            {queueRunning || queueFinished ? (
              <DialogDescription>
                {queueRunning
                  ? t('plugins.queueDescRunning')
                  : t('plugins.queueDescDone')}
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
                        item.status === 'uploading' && 'bg-brand-500/15 text-brand-700',
                        (item.status === 'pending' || item.status === 'queued') && 'bg-slate-500/10 text-slate-500',
                      )}
                    >
                      {item.status === 'uploading' ? (
                        <span className="inline-flex items-center gap-1">
                          <Loader2 className="h-3 w-3 animate-spin" />
                          {t('plugins.queueUploading')}
                        </span>
                      ) : queueStatusLabel(t, item.status)}
                    </span>
                  </div>
                  {item.status === 'uploading' ? (
                    <>
                      {/* 真实上传进度：XHR upload.onprogress 的已发送/总字节 */}
                      {item.total && item.total > 0 ? (
                        <>
                          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-slate-500/15">
                            <div
                              className="h-full rounded-full bg-teal-500/80 transition-[width] duration-200 ease-out"
                              style={{ width: `${Math.min(100, Math.round((item.loaded ?? 0) / item.total * 100))}%` }}
                            />
                          </div>
                          <p className="mt-0.5 text-xs tabular-nums text-slate-500">
                            {t('plugins.queueUploading')} · {Math.round((item.loaded ?? 0) / item.total * 100)}% · {formatBytes(item.loaded ?? 0)} / {formatBytes(item.total)}
                          </p>
                        </>
                      ) : (
                        <p className="mt-0.5 text-xs text-slate-400">{formatBytes(item.file.size)}</p>
                      )}
                    </>
                  ) : (
                    <p className="mt-0.5 text-xs text-slate-400">{formatBytes(item.file.size)}</p>
                  )}
                  {item.message ? (
                    <QueueItemMessage message={item.message} status={item.status} />
                  ) : null}
                </div>
                {!queueRunning && item.status === 'pending' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-slate-400 hover:text-rose-500"
                    onClick={() => removeQueueItem(item.id)}
                    aria-label={t('plugins.removeFileAria', { name: item.file.name })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
          <DialogFooter>
            {queueFinished ? (
              <Button type="button" onClick={clearQueue}>{t('plugins.finish')}</Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={queueRunning} onClick={clearQueue}>
                  {t('plugins.cancel')}
                </Button>
                <Button
                  type="button"
                  disabled={queueRunning || !queueItems.some((item) => item.status === 'pending')}
                  onClick={() => void confirmUploadQueue()}
                >
                  {queueRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {t('plugins.confirmUpload')}
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
            <AlertDialogTitle className="text-slate-800">{t('plugins.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription className="text-slate-500">
              {t('plugins.deleteConfirm', { name: deletePlugin?.name, id: deletePlugin?.id })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-3 sm:gap-3">
            <AlertDialogCancel
              className="mt-0"
              disabled={deleting}
              onClick={() => setDeletePlugin(null)}
            >
              {t('plugins.cancel')}
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
                    toast.success(t('plugins.deleted'));
                    setDeletePlugin(null);
                    await load({ silent: true });
                  } catch (e) {
                    toast.error(errText(e));
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {t('plugins.deleteOnly')}
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
                    toast.success(t('plugins.deletedWithData'));
                    setDeletePlugin(null);
                    await load({ silent: true });
                  } catch (err) {
                    toast.error(errText(err));
                  } finally {
                    setDeleting(false);
                  }
                })();
              }}
            >
              {t('plugins.deleteAndClear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
