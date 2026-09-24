import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowUpDown, Check, ExternalLink, Loader2, MessageSquare, Package, RefreshCw, Search, Store, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { StoreComment, StoreResource } from '@/lib/types';
import { cn } from '@/lib/utils';
import { PLUGIN_STORE_OFFICIAL_URL } from '@/lib/plugin-store-origin';
import {
  STORE_SORT_OPTIONS,
  buildAuthorCounts,
  sortStoreResources,
  withOrderIndex,
  type StoreSortMode,
} from '@/lib/plugin-store-sort';
import { runWithDownloadProgressToast } from '@/components/download-progress-toast';
import { QuietExternal } from '@/components/quiet-link';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
function hasRealSummary(text?: string): boolean {
  const t = (text || '').trim();
  if (!t) return false;
  if (t === '暂无简介' || t === '暂无描述' || t === '无简介') return false;
  return true;
}

/** 远端隐私占位名，不当真上传者展示 */
function displayUploader(name?: string): string {
  const t = (name || '').trim();
  if (!t) return '';
  if (/^(x{2,}|X{2,}|\*{2,}|…+|\.+|匿名|unknown|n\/?a)$/i.test(t)) return '';
  return t;
}

/** 上游 resource_type → 卡片两字角标 + 颜色 */
function resourceTypeBadge(raw?: string): { label: string; className: string } | null {
  const t = (raw || '').trim();
  if (t === '官鸡') {
    return {
      label: '官方',
      className: 'border-sky-300/50 bg-sky-500/90 text-white shadow-sky-500/25',
    };
  }
  if (t === '野鸡') {
    return {
      label: '野生',
      className: 'border-orange-300/50 bg-orange-500/90 text-white shadow-orange-500/25',
    };
  }
  if (t === 'wxbot') {
    return {
      label: '微信',
      className: 'border-emerald-300/50 bg-emerald-500/90 text-white shadow-emerald-500/25',
    };
  }
  if (t === '其他') {
    return {
      label: '其他',
      className: 'border-purple-300/50 bg-purple-500/90 text-white shadow-purple-500/25',
    };
  }
  return null;
}

function CoverImg({ id, title, allow }: { id: number; title: string; allow: boolean }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [id, allow]);

  if (!allow || failed) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-white/10 text-slate-400/50">
        <Package className="h-10 w-10 opacity-50" />
      </div>
    );
  }
  return (
    /* 不垫任何底色：透明 PNG 的透明区域要能直接透出卡片玻璃与全站背景 */
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={api.pluginStore.coverUrl(id)}
      alt={title}
      decoding="async"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  );
}

const btnGhost =
  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/20 px-3 text-sm font-medium text-slate-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-white/40 disabled:pointer-events-none disabled:opacity-50';

const btnPrimary =
  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 bg-teal-500/80 px-3 text-sm font-medium text-white shadow-md shadow-teal-500/30 backdrop-blur-sm transition-all hover:bg-teal-600/90 disabled:pointer-events-none disabled:opacity-50';

export default function PluginStorePage() {
  const [resources, setResources] = useState<StoreResource[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<StoreSortMode>('default');
  const [detail, setDetail] = useState<StoreResource | null>(null);
  const [comments, setComments] = useState<StoreComment[]>([]);
  const [commentTotal, setCommentTotal] = useState(0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [installingId, setInstallingId] = useState<number | null>(null);

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await api.pluginStore.list(refresh);
      if (!res.ok) {
        toast.error(res.message || '加载商城失败');
        setResources([]);
        setPinnedIds(new Set());
        return;
      }
      setResources(res.resources || []);
      setPinnedIds(new Set((res.pinned || []).map((p) => p.id)));
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const indexed = useMemo(() => withOrderIndex(resources), [resources]);
  const authorCounts = useMemo(() => buildAuthorCounts(resources), [resources]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? indexed
      : indexed.filter((r) => {
        const hay = `${r.title} ${r.author} ${r.summary} ${r.tags.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    return sortStoreResources(filtered, sortMode, authorCounts);
  }, [indexed, query, sortMode, authorCounts]);

  const sortLabel = STORE_SORT_OPTIONS.find((o) => o.id === sortMode)?.label || '排序';

  const toolbarBtnClass =
    'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/40 bg-white/20 text-slate-700 backdrop-blur-sm transition-colors hover:bg-white/30 disabled:opacity-50 md:w-auto md:gap-2 md:px-4 md:text-sm md:font-medium';
  const openDetail = async (item: StoreResource) => {
    setDetail(item);
    setComments([]);
    setCommentTotal(0);
    setCommentsLoading(true);
    try {
      const res = await api.pluginStore.comments(item.id);
      if (res.ok) {
        setComments(res.comments || []);
        setCommentTotal(res.total ?? res.comments?.length ?? 0);
      } else {
        toast.error(res.message || '评论加载失败');
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setCommentsLoading(false);
    }
  };

  const onInstall = async (item: StoreResource) => {
    if (!item.allow_download || !item.links.download) {
      toast.error(item.download_block_reason || '该资源不允许下载');
      return;
    }
    setInstallingId(item.id);
    const ver = item.version ? ` v${item.version}` : '';
    try {
      await runWithDownloadProgressToast({
        runningLabel: `${item.title}${ver}`,
        task: () => api.pluginStore.install(item.id),
        isOk: (r) => r.ok,
        errorMessage: (r) => r.message || '安装失败',
      });
    } catch {
      /* toast 已展示错误 */
    } finally {
      setInstallingId(null);
    }
  };

  return (
    <div className="mx-auto flex w-full flex-col gap-4 md:gap-5">
      <header className="hidden flex-wrap items-end justify-between gap-3 md:flex">
        <QuietExternal
          href={PLUGIN_STORE_OFFICIAL_URL}
          className="group flex items-center gap-2 text-slate-800 transition-colors hover:text-teal-700"
        >
          <Store className="h-5 w-5 text-teal-600" />
          <h1 className="kk-page-title text-xl md:text-[1.75rem]">资源</h1>
          <ExternalLink className="h-3.5 w-3.5 text-slate-300 transition-colors group-hover:text-teal-600" />
        </QuietExternal>
      </header>

      <div className="flex w-full items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索标题、作者、标签…"
            className="h-10 w-full rounded-xl border border-white/40 bg-white/20 pl-9 pr-3 text-sm text-slate-800 outline-none backdrop-blur-md placeholder:text-slate-500 focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/20"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title={`排序：${sortLabel}`}
              aria-label={`排序：${sortLabel}`}
              className={toolbarBtnClass}
            >
              <ArrowUpDown className="h-4 w-4" />
              <span className="hidden md:inline">排序</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[11rem]">
            {STORE_SORT_OPTIONS.map((opt) => (
              <DropdownMenuItem
                key={opt.id}
                onSelect={() => setSortMode(opt.id)}
                className={cn(sortMode === opt.id && 'bg-white/45 font-medium text-teal-800')}
              >
                <Check className={cn('h-4 w-4', sortMode === opt.id ? 'opacity-100' : 'opacity-0')} />
                {opt.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          disabled={loading}
          onClick={() => void load(true)}
          title="刷新"
          className={toolbarBtnClass}
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          <span className="hidden md:inline">刷新</span>
        </button>
      </div>

      {loading && resources.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
          正在加载资源…
        </div>
      ) : visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/40 bg-white/15 py-16 text-center text-sm text-slate-400 backdrop-blur-md">
          {query.trim() ? '无匹配资源' : '暂无资源'}
        </div>
      ) : (
        <div className="kk-resource-grid">
          {visible.map((item, index) => {
            const canInstall = !!item.allow_download && !!item.links.download;
            const pinned = pinnedIds.has(item.id);
            const typeBadge = resourceTypeBadge(item.resource_type);
            const summary = item.summary || item.description;
            const showSummary = hasRealSummary(summary);
            return (
              <article
                key={item.id}
                style={{ animationDelay: `${Math.min(index, 12) * 0.05}s` }}
                className={cn(
                  'kk-resource-card kk-stagger-item group relative flex h-full flex-col overflow-hidden rounded-2xl p-4',
                  'kk-glass shadow-lg shadow-slate-200/30',
                  'transition-all duration-300 hover:-translate-y-1 hover:shadow-xl',
                )}
              >
                <button
                  type="button"
                  className="relative mb-3 aspect-[3/2] w-full overflow-hidden rounded-xl border border-white/30 text-left"
                  onClick={() => void openDetail(item)}
                >
                  <CoverImg
                    id={item.id}
                    title={item.title}
                    allow={!!item.allow_cover_preview}
                  />
                  {pinned ? (
                    <span className="absolute left-2 top-2 z-20 rounded-lg border border-white/30 bg-amber-500/85 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
                      置顶
                    </span>
                  ) : null}
                  {typeBadge ? (
                    <span
                      className={cn(
                        'pointer-events-none absolute right-2 top-2 z-30 rounded-lg border px-1.5 py-0.5 text-[10px] font-medium tracking-wide shadow-sm backdrop-blur-sm',
                        typeBadge.className,
                      )}
                    >
                      {typeBadge.label}
                    </span>
                  ) : null}
                </button>

                <div className="flex flex-1 flex-col justify-between gap-3">
                  <div>
                    <h2 className="truncate text-base font-semibold text-slate-800">{item.title}</h2>
                    <p className="mt-0.5 truncate text-xs text-slate-500">
                      {item.author || '未知作者'}
                      {item.version ? ` · v${item.version}` : ''}
                    </p>
                    <p className="mt-1.5 text-xs tabular-nums text-slate-500">
                      ↓{item.download_count} · 览{item.preview_count}
                    </p>
                    {showSummary ? (
                      <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-slate-600">
                        {summary}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex w-full items-center justify-center gap-2 border-t border-white/30 pt-3">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={() => void openDetail(item)}
                    >
                      详情
                    </button>
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={!canInstall || installingId === item.id}
                      title={!canInstall ? (item.download_block_reason || '不可下载') : '安装到本地'}
                      onClick={() => void onInstall(item)}
                    >
                      {installingId === item.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      安装
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent
          hideClose
          className="flex max-h-[min(88dvh,100dvh-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 landscape:max-w-2xl"
        >
          {detail ? (
            <>
              <DialogHeader className="relative shrink-0 space-y-0 border-b border-white/25 px-5 py-4 pr-14 text-left">
                <DialogTitle className="pr-1">{detail.title}</DialogTitle>
                <DialogDescription>
                  {[
                    detail.author || '未知作者',
                    detail.version ? `v${detail.version}` : '',
                    displayUploader(detail.uploader_name)
                      ? `上传 ${displayUploader(detail.uploader_name)}`
                      : '',
                  ].filter(Boolean).join(' · ')}
                </DialogDescription>
                <DialogClose
                  className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-white/30 hover:text-slate-800"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </DialogClose>
              </DialogHeader>

              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4 no-scrollbar">
                <div className="relative aspect-[3/2] overflow-hidden rounded-xl border border-white/30">
                  <CoverImg
                    id={detail.id}
                    title={detail.title}
                    allow={!!detail.allow_cover_preview}
                  />
                </div>

                {detail.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {detail.tags.map((t) => (
                      <span key={t} className="rounded-md bg-white/25 px-1.5 py-0.5 text-[10px] text-slate-500">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}

                <section className="relative z-0 space-y-2 text-sm text-slate-600">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">简介</h3>
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {detail.description || detail.summary || '暂无描述'}
                  </p>
                </section>

                {detail.update_notes ? (
                  <section className="relative z-0 space-y-2 text-sm text-slate-600">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">更新说明</h3>
                    <p className="whitespace-pre-wrap break-words leading-relaxed">{detail.update_notes}</p>
                  </section>
                ) : null}

                <section className="relative z-0 space-y-2">
                  <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-400">
                    <MessageSquare className="h-3.5 w-3.5 shrink-0" />
                    评论
                    <span className="font-normal normal-case text-slate-400">({commentTotal})</span>
                  </h3>
                  {commentsLoading ? (
                    <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      加载评论…
                    </div>
                  ) : comments.length === 0 ? (
                    <p className="py-3 text-sm text-slate-400">暂无评论</p>
                  ) : (
                    <ul className="max-h-48 space-y-2 overflow-y-auto rounded-xl border border-white/30 bg-white/15 p-2 backdrop-blur-sm">
                      {comments.map((c) => (
                        <li key={c.id} className="rounded-lg border border-white/25 bg-white/25 px-3 py-2 text-sm backdrop-blur-sm">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-medium text-slate-700">{c.nickname}</span>
                            <span className="shrink-0 text-[10px] text-slate-400">
                              {c.created_at_label || c.created_at}
                            </span>
                          </div>
                          <p className="mt-0.5 whitespace-pre-wrap break-words text-slate-600">{c.body}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                  <p className="text-[11px] text-slate-400">商城内仅支持查看评论，不支持发表</p>
                </section>
              </div>

              <DialogFooter className="shrink-0 flex w-full flex-row flex-wrap items-center justify-center gap-2 border-t border-white/25 bg-gradient-to-t from-white/15 to-transparent px-5 py-4 sm:justify-center">
                {!detail.allow_download || !detail.links.download ? (
                  <p className="w-full text-center text-xs text-amber-600">
                    {detail.download_block_reason || '当前不可下载安装'}
                  </p>
                ) : null}
                <button type="button" className={btnGhost} onClick={() => setDetail(null)}>
                  关闭
                </button>
                <button
                  type="button"
                  className={btnPrimary}
                  disabled={
                    !detail.allow_download
                    || !detail.links.download
                    || installingId === detail.id
                  }
                  onClick={() => void onInstall(detail)}
                >
                  {installingId === detail.id ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : null}
                  安装到本地
                </button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
