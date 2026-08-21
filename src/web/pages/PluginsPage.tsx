import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { toast } from 'sonner';
import {
  Loader2, Package, Puzzle, RefreshCw, Upload, BookOpen, ExternalLink, Search, Activity, Trash2,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { ExtensionPage, PluginItem } from '@/lib/types';
import { STATUS_MAP } from '@/lib/types';
import { cn } from '@/lib/utils';
import { pluginHostConsolePath } from '@/lib/plugin-host-paths';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { PluginDocsDialog } from '@/components/plugin-docs-dialog';
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

const GLASS_CTRL =
  'border border-white/50 bg-white/20 shadow-sm backdrop-blur-md transition-all duration-300 hover:bg-white/30';

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginItem[]>([]);
  const [pages, setPages] = useState<ExtensionPage[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'kakake' | 'gf' | 'wx'>('all');
  const [query, setQuery] = useState('');
  const [docsPlugin, setDocsPlugin] = useState<PluginItem | null>(null);
  const [deletePlugin, setDeletePlugin] = useState<PluginItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
  }), [plugins]);

  const filterTabs = useMemo(() => (
    [
      { id: 'all' as const, label: '全部', count: counts.all },
      { id: 'kakake' as const, label: 'OneBot', count: counts.kakake },
      { id: 'gf' as const, label: '官方机器人', count: counts.gf },
      { id: 'wx' as const, label: '微信机器人', count: counts.wx },
    ]
  ), [counts]);

  const filterIndex = Math.max(0, filterTabs.findIndex((t) => t.id === filter));
  const layoutKey = `${counts.all}-${counts.kakake}-${counts.gf}-${counts.wx}`;
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

  const handleImport = async (file: File) => {
    setUploading(true);
    const toastId = toast.loading('正在上传并安装插件…', { description: file.name });
    try {
      const r = await api.plugins.importZip(file);
      if (r.ok) {
        toast.success(r.message || `安装成功${r.pluginId ? `：${r.pluginId}` : ''}`, {
          id: toastId,
          description: r.kind === 'gf'
            ? '已识别为官方机器人插件 · 请到对应连接打开子开关'
            : r.kind === 'wx'
              ? '已识别为微信机器人插件 · 请到对应连接打开子开关'
              : '已识别为 OneBot 插件 · 请到对应连接打开子开关',
        });
        await load({ silent: true });
      } else {
        toast.error(r.message || '安装失败', { id: toastId });
      }
    } catch (e) {
      toast.error(String(e), { id: toastId });
    } finally {
      setUploading(false);
    }
  };

  const pagesOf = (id: string) => pages.filter((p) => p.pluginId === id);

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-4 md:gap-5">
      <div className="kk-stagger-item kk-stagger-1 shrink-0 space-y-3">
        <h1 className="kk-page-title hidden md:block">插件</h1>
        <div className="flex flex-col gap-2 md:flex-row md:items-center">
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
              'md:border md:border-white/40 md:bg-white/20 md:shadow-sm md:shadow-slate-200/20 md:backdrop-blur-md',
            )}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".zip"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleImport(f);
                e.target.value = '';
              }}
            />
            <Button
              variant="ghost"
              className={cn(
                'h-10 min-w-0 flex-1 rounded-xl px-3 text-slate-600 hover:bg-white/40',
                GLASS_CTRL,
                'md:h-8 md:flex-none md:rounded-lg md:border-0 md:bg-transparent md:shadow-none md:backdrop-blur-none',
              )}
              disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              上传 zip
            </Button>
            <Button
              variant="ghost"
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
      <div className="sticky top-0 z-20 -mx-1 shrink-0 px-1 py-1">
        <div
          ref={navRef as RefObject<HTMLDivElement>}
          className={cn('relative flex flex-wrap gap-1.5 rounded-[1.15rem] p-1.5', GLASS_CTRL)}
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
                  'relative z-[1] inline-flex items-center gap-1.5 rounded-xl px-3.5 py-1.5 text-sm font-medium transition-colors duration-300',
                  active
                    ? 'border border-transparent text-teal-700'
                    : 'border border-transparent bg-transparent text-slate-500 hover:bg-white/20 hover:text-slate-700',
                )}
              >
                {t.label}
                <span
                  className={cn(
                    'rounded-lg px-1.5 py-px text-[11px] tabular-nums',
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
                    'bg-white/20 backdrop-blur-xl border border-white/50 shadow-lg',
                    'transition-all duration-300 hover:-translate-y-0.5 hover:bg-white/30 hover:shadow-xl',
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
