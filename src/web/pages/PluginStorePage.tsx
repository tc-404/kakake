import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowUpDown, Check, Download, ExternalLink, Loader2, Package, RefreshCw,
  Search, ShieldAlert, Star, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { PluginItem, StoreComment, StoreOrigin, StoreResource } from '@/lib/types';
import { cn } from '@/lib/utils';
import {
  PLUGIN_STORE_OFFICIAL_URL,
  PLUGIN_STORE_GITHUB_URL,
  compareVersion,
  resolveInstallState,
} from '@/lib/plugin-store-origin';
import {
  getSortOptions,
  isSortAvailable,
  buildAuthorCounts,
  sortStoreResources,
  withOrderIndex,
  type StoreSortMode,
} from '@/lib/plugin-store-sort';
import { runWithDownloadProgressToast } from '@/components/download-progress-toast';
import { MarkdownContent } from '@/components/markdown-content';
import { StorePagination } from '@/components/store-pagination';
import { QuietExternal } from '@/components/quiet-link';
import { usePageHeader } from '@/components/header-actions';
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

/**
 * 简介正文取值。**咔咔源的简介实际写在 `update_notes` 里**（该源 summary/description 常为空），
 * 所以两个源的简介都必须兜底到 update_notes，否则整列都会显示「暂无简介」。
 */
type StoreIntroSource = Pick<StoreResource, 'summary' | 'description' | 'update_notes'>;

/** 卡片一句话简介：短字段优先 */
function cardIntro(r: StoreIntroSource): string {
  return (r.summary || r.description || r.update_notes || '').trim();
}

/** 详情正文：长字段优先 */
function detailIntro(r: StoreIntroSource): string {
  return (r.description || r.summary || r.update_notes || '').trim();
}

/** 下载次数展示：过万折算为「x.x 万」，其余原样（卡片徽标很窄，避免撑爆一行） */
function formatDownloadCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 10000) return String(n);
  const wan = n / 10000;
  return `${wan >= 100 ? Math.round(wan) : wan.toFixed(1)}万`;
}

/** 远端隐私占位名，不当真上传者展示 */
function displayUploader(name?: string): string {
  const t = (name || '').trim();
  if (!t) return '';
  if (/^(x{2,}|X{2,}|\*{2,}|…+|\.+|匿名|unknown|n\/?a)$/i.test(t)) return '';
  return t;
}

/** 类型 → 角标颜色（兼容咔咔源 官鸡/野鸡/wxbot 与 GitHub 源 野生/官方/微信/其他） */
function typeBadge(raw?: string): { label: string; className: string } | null {
  const t = (raw || '').trim();
  if (t === '官方' || t === '官鸡') {
    return { label: '官方', className: 'border-sky-300/50 bg-sky-500/90 text-white' };
  }
  if (t === '野生' || t === '野鸡') {
    return { label: '野生', className: 'border-orange-300/50 bg-orange-500/90 text-white' };
  }
  if (t === '微信' || t === 'wxbot') {
    return { label: '微信', className: 'border-emerald-300/50 bg-emerald-500/90 text-white' };
  }
  if (t === '其他') {
    return { label: '其他', className: 'border-purple-300/50 bg-purple-500/90 text-white' };
  }
  return null;
}

/** 卡片 / 详情共用的圆形头像框（带描边），取不到就留空等下次加载 */
function StoreAvatar({
  resource,
  size = 'card',
}: {
  resource: StoreResource;
  size?: 'card' | 'detail';
}) {
  const [failed, setFailed] = useState(false);
  const isGithub = resource.origin === 'github';
  const src = isGithub
    ? resource.avatar_url || ''
    : (resource.allow_cover_preview ? api.pluginStore.coverUrl(resource.id) : '');

  useEffect(() => {
    setFailed(false);
  }, [resource.id, src]);

  const box = size === 'detail' ? 'h-14 w-14 sm:h-16 sm:w-16' : 'h-12 w-12';
  /*
   * 图标框不给底色：资源图标多为带透明通道的 PNG，铺一层 bg-white/25 会把透明图层
   * 压成一片半白，看着像「贴在白盘上」。层次改由 border + ring 承担；
   * 只有占位态（无图标 / 加载失败）才补一层白底，免得空框太飘。
   */
  const frame =
    'shrink-0 overflow-hidden rounded-full border border-white/50 shadow-sm ring-2 ring-white/60';

  if (!src || failed) {
    return (
      <div className={cn(box, frame, 'flex items-center justify-center bg-white/25 text-slate-400/60')}>
        <Package className={size === 'detail' ? 'h-6 w-6 sm:h-7 sm:w-7' : 'h-5 w-5'} />
      </div>
    );
  }
  return (
    <div className={cn(box, frame)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={resource.title}
        decoding="async"
        loading="lazy"
        className="h-full w-full object-cover"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

const btnGhost =
  'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/20 px-3 text-sm font-medium text-slate-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-white/40 disabled:pointer-events-none disabled:opacity-50';

const btnPrimary =
  'kk-store-btn kk-store-btn-primary inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 px-3 text-sm font-medium text-white shadow-md shadow-teal-500/30 disabled:pointer-events-none disabled:opacity-50';

const btnUpdate =
  'kk-store-btn kk-store-btn-update inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 px-3 text-sm font-medium text-white shadow-md shadow-amber-500/30 disabled:pointer-events-none disabled:opacity-50';

const btnInstalled =
  'kk-store-btn kk-store-btn-installed inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 px-3 text-sm font-medium text-slate-400 shadow-sm cursor-default';

/** 卡片内紧凑按钮：固定宽度、不撑满整行 */
const btnCompactBase =
  'kk-store-btn inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border px-3.5 text-xs font-semibold disabled:pointer-events-none disabled:opacity-50';
const btnCompactPrimary = 'kk-store-btn-primary border-white/30 text-white shadow-sm shadow-teal-500/30';
const btnCompactUpdate = 'kk-store-btn-update border-white/30 text-white shadow-sm shadow-amber-500/30';
const btnCompactInstalled = 'kk-store-btn-installed border-white/40 text-slate-400 cursor-default';

export default function PluginStorePage() {
  const [origin, setOrigin] = useState<StoreOrigin>('kakake');
  const [resources, setResources] = useState<StoreResource[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(new Set());
  const [installed, setInstalled] = useState<PluginItem[]>([]);
  const [currentVersion, setCurrentVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<StoreSortMode>('default');
  const [detail, setDetail] = useState<StoreResource | null>(null);
  const [comments, setComments] = useState<StoreComment[]>([]);
  const [commentTotal, setCommentTotal] = useState(0);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [readme, setReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [installingId, setInstallingId] = useState<number | null>(null);
  /** GitHub 源安装前的风险声明确认 */
  const [riskItem, setRiskItem] = useState<StoreResource | null>(null);
  /** sha256 校验失败告警 */
  const [sha256Warn, setSha256Warn] = useState<string | null>(null);
  /**
   * 数据能力开关。GitHub 源的「下载次数」要靠本机 GitHub Token 逐个仓库查，
   * 没配就没有数据 → 卡片不显示该徽标、「下载次数」排序也不出现。
   */
  const [caps, setCaps] = useState<{ downloadCounts: boolean }>({ downloadCounts: true });

  const isGithub = origin === 'github';

  const loadInstalled = useCallback(async () => {
    try {
      const res = await api.plugins.list();
      setInstalled(res?.data?.plugins || []);
    } catch { /* 忽略：安装态只是增强信息 */ }
  }, []);

  /**
   * refresh=true 强制走网络（右上角刷新按钮 / 开屏静默校准都用它）；
   * silent=true 时不显示加载态、失败也不打扰（后台校准用），保留已显示的数据。
   * 返回是否成功（供刷新按钮反馈用）。
   */
  const load = useCallback(async (refresh = false, silent = false): Promise<boolean> => {
    if (!silent) setLoading(true);
    try {
      const res = await api.pluginStore.list(refresh);
      if (!res.ok) {
        if (!silent) {
          toast.error(res.message || '加载资源失败');
          setResources([]);
          setPinnedIds(new Set());
        }
        return false;
      }
      if (res.origin === 'github' || res.origin === 'kakake') setOrigin(res.origin);
      setResources(res.resources || []);
      setPinnedIds(new Set((res.pinned || []).map((p) => p.id)));
      setCaps({ downloadCounts: res.capabilities?.downloadCounts !== false });
      return true;
    } catch (e) {
      if (!silent) toast.error(String(e));
      return false;
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // 右上角刷新：强制清缓存重拉列表 + 安装态，并给出界面反馈
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setPage(1);
    try {
      const [ok] = await Promise.all([load(true), loadInstalled()]);
      if (ok) toast.success('资源已刷新');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, load, loadInstalled]);

  useEffect(() => {
    // 先用本地兜底秒开，再后台强制拉一次最新静默替换（等同「不缓存」的观感，但不会冷启动干等超时）
    void load(false).then(() => load(true, true));
    void loadInstalled();
  }, [load, loadInstalled]);

  const indexed = useMemo(() => withOrderIndex(resources), [resources]);
  const authorCounts = useMemo(() => buildAuthorCounts(resources), [resources]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = !q
      ? indexed
      : indexed.filter((r) => {
        const hay = `${r.title} ${r.author} ${r.summary} ${r.description} ${r.update_notes} ${r.tags.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    return sortStoreResources(filtered, sortMode, authorCounts);
  }, [indexed, query, sortMode, authorCounts]);

  const sortOptions = useMemo(() => getSortOptions(origin, caps), [origin, caps]);
  const sortLabel = sortOptions.find((o) => o.id === sortMode)?.label || '排序';

  // 分页：每页 16 个
  const PAGE_SIZE = 16;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // 搜索 / 排序 / 来源变化后回到第一页
  useEffect(() => { setPage(1); }, [query, sortMode, origin]);
  // 列表缩短后夹紧当前页
  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);
  const paged = useMemo(
    () => visible.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [visible, page],
  );

  // 来源切换后，若当前排序在新来源下不可用（如 GitHub 无「浏览」、无 Token 时无「下载次数」），回退到默认
  useEffect(() => {
    if (!isSortAvailable(sortMode, origin, caps)) setSortMode('default');
  }, [origin, sortMode, caps]);

  /** 顶栏操作按钮：与页面内搜索框同高，但只放图标 */
  const headerBtnClass =
    'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-white/35 disabled:opacity-50';

  const openDetail = async (item: StoreResource) => {
    setDetail(item);
    setComments([]);
    setCommentTotal(0);
    setReadme(null);
    if (item.origin === 'github') {
      // 懒加载当前框架版本，用于「最低版本要求」比对（首次打开时才请求）
      if (!currentVersion) {
        api
          .updateState()
          .then((r) => { if (r?.currentVersion) setCurrentVersion(r.currentVersion); })
          .catch(() => { /* 忽略 */ });
      }
      // GitHub 源：拉 README 文档，不拉评论
      if (item.homepage) {
        setReadmeLoading(true);
        try {
          const res = await api.pluginStore.readme(item.homepage);
          setReadme(res.ok && res.markdown ? res.markdown : null);
        } catch {
          setReadme(null);
        } finally {
          setReadmeLoading(false);
        }
      }
      return;
    }
    // 咔咔珂源：拉评论
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

  const doInstall = async (item: StoreResource) => {
    if (!item.allow_download || !item.links.download) {
      toast.error(item.download_block_reason || '该资源不允许下载');
      return;
    }
    setInstallingId(item.id);
    const ver = item.version ? ` v${item.version}` : '';
    try {
      const result = await runWithDownloadProgressToast({
        runningLabel: `${item.title}${ver}`,
        task: () => api.pluginStore.install(item.id),
        isOk: (r) => r.ok,
        errorMessage: (r) => r.message || '安装失败',
      });
      if (!result.ok && result.code === 'sha256_mismatch') {
        setSha256Warn(result.message || '安装包校验未通过，文件可能被篡改或损坏');
      } else if (result.ok) {
        void loadInstalled();
      }
    } catch {
      /* toast 已展示错误 */
    } finally {
      setInstallingId(null);
    }
  };

  /** 点击安装/更新入口：GitHub 源先弹风险声明 */
  const onInstallClick = (item: StoreResource) => {
    if (item.origin === 'github') {
      setRiskItem(item);
      return;
    }
    void doInstall(item);
  };

  const renderInstallButton = (item: StoreResource, compact = false) => {
    const canInstall = !!item.allow_download && !!item.links.download;
    const { state } = resolveInstallState(item, installed);
    const busy = installingId === item.id;
    if (state === 'installed') {
      return (
        <button
          type="button"
          className={compact ? cn(btnCompactBase, btnCompactInstalled) : btnInstalled}
          disabled
          title="已安装"
          onClick={(e) => e.stopPropagation()}
        >
          <Check className="h-3.5 w-3.5" />
          已安装
        </button>
      );
    }
    const isUpdate = state === 'update';
    const cls = compact
      ? cn(btnCompactBase, isUpdate ? btnCompactUpdate : btnCompactPrimary)
      : (isUpdate ? btnUpdate : btnPrimary);
    return (
      <button
        type="button"
        className={cls}
        disabled={!canInstall || busy}
        title={!canInstall ? (item.download_block_reason || '不可下载') : (isUpdate ? '更新到最新版本' : '安装到本地')}
        onClick={(e) => { e.stopPropagation(); onInstallClick(item); }}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {isUpdate ? '更新' : '安装'}
      </button>
    );
  };

  const detailInstall = resolveInstallState(detail || ({} as StoreResource), installed);
  const minKakakeUnmet = !!(
    detail?.min_kakake && currentVersion
    && compareVersion(currentVersion, detail.min_kakake) < 0
  );

  // 界面标题由顶栏显示；排序 / 刷新 / 源站入口一并移到顶栏，页面里只留搜索框
  usePageHeader(
    () => ({
      actions: (
        <>
          <QuietExternal
            href={isGithub ? PLUGIN_STORE_GITHUB_URL : PLUGIN_STORE_OFFICIAL_URL}
            title="打开当前资源来源"
            aria-label="打开当前资源来源"
            className={headerBtnClass}
          >
            <ExternalLink className="h-4 w-4" />
          </QuietExternal>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={`排序：${sortLabel}`}
                aria-label={`排序：${sortLabel}`}
                className={headerBtnClass}
              >
                <ArrowUpDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[11rem]">
              {sortOptions.map((opt) => (
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
            disabled={loading || refreshing}
            onClick={() => { void handleRefresh(); }}
            title="刷新"
            aria-label="刷新"
            className={headerBtnClass}
          >
            {loading || refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </>
      ),
    }),
    [isGithub, sortLabel, sortOptions, sortMode, handleRefresh, loading, refreshing],
  );

  return (
    <div className="mx-auto flex w-full flex-col gap-4 md:gap-5">
      {/*
       * 搜索栏：固定在顶栏正下方（top-12 = 顶栏高度；z-10 低于顶栏 z-20）。
       *
       * 只保留**一层**材质：搜索框自己的 .kk-field。
       * 之前是「kk-glass + kk-glass-strong 卡片」垫在底下、里面再套一个 .kk-field 输入框，
       * 两层背景叠着：外圈 rounded-2xl、内圈 rounded-xl，双边缘看着就是「套了两层壳」。
       * 现在外层只当定位容器，不铺底色 / 阴影，也不留 padding（免得滚动时卡片从
       * 输入框四周的缝里透出来），吸顶位置由外层 sticky 负责，不受影响。
       */}
      <div className="sticky top-12 z-10 shrink-0">
        <div data-tour="store-toolbar" className="flex w-full items-center">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索标题、作者、标签…"
              className="kk-field h-10 w-full rounded-xl pl-9 pr-3 text-sm text-slate-800 outline-none placeholder:text-slate-500"
            />
          </div>
        </div>
      </div>

      <div className="relative">
        <div className={cn('transition-opacity duration-200', refreshing && 'pointer-events-none select-none opacity-50')}>
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
            <div data-tour="store-grid" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {paged.map((item, index) => {
            const pinned = pinnedIds.has(item.id);
            const badge = typeBadge(item.type || item.resource_type);
            const summary = cardIntro(item);
            const showSummary = hasRealSummary(summary);
            return (
              <article
                key={item.id}
                style={{ animationDelay: `${Math.min(index, 12) * 0.05}s` }}
                className={cn(
                  'kk-stagger-item group relative flex h-full min-h-[9.5rem] cursor-pointer flex-col overflow-hidden rounded-2xl p-3',
                  'kk-glass',
                  'transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--glass-shadow-hover)]',
                )}
                onClick={() => void openDetail(item)}
              >
                {/* 右上角版本号（专属高亮） */}
                {item.version ? (
                  <span className="absolute right-2.5 top-2.5 z-10 rounded-md border border-teal-300/40 bg-gradient-to-br from-teal-400/90 to-teal-600/90 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-white shadow-sm">
                    v{item.version}
                  </span>
                ) : null}

                {/* 头像 + 名称/作者 */}
                <div className="flex items-center gap-2.5 pr-12">
                  <div className="relative">
                    <StoreAvatar resource={item} />
                    {pinned ? (
                      <span
                        className="absolute -left-1 -top-1 z-10 h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-500 shadow"
                        title="置顶"
                      />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-base font-semibold leading-snug text-slate-800">
                      {item.title}
                    </h2>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
                      <span className="truncate">{item.author || '未知作者'}</span>
                      {badge ? (
                        <span className={cn('shrink-0 rounded border px-1 py-px text-[9px] font-medium leading-none', badge.className)}>
                          {badge.label}
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>

                {/* 简介：预留两行高度，超出即止 */}
                <p
                  className={cn(
                    'mt-2 line-clamp-2 min-h-[2.5rem] text-[13px] leading-[1.25rem] text-slate-600',
                    !showSummary && 'text-slate-400',
                  )}
                >
                  {showSummary ? summary : '暂无简介'}
                </p>

                {/* 标签：简介正下方，居左；下载次数徽标在最左，与标签同行 */}
                {(typeof item.download_count === 'number' || item.tags.length > 0) ? (
                  <div className="mt-1.5 flex flex-wrap items-center gap-1 overflow-hidden" style={{ maxHeight: '1.5rem' }}>
                    {typeof item.download_count === 'number' ? (
                      <span
                        className="inline-flex shrink-0 items-center gap-0.5 rounded bg-white/30 px-1.5 py-0.5 text-[10px] leading-none text-slate-500"
                        title={`下载 ${item.download_count} 次`}
                      >
                        <Download className="h-2.5 w-2.5" />
                        {formatDownloadCount(item.download_count)}
                      </span>
                    ) : null}
                    {item.tags.slice(0, 4).map((t) => (
                      <span key={t} className="rounded bg-white/30 px-1.5 py-0.5 text-[10px] leading-none text-slate-500">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/* 底部安装按钮：横向铺满 */}
                <div className="mt-auto flex w-full pt-2.5">
                  {renderInstallButton(item)}
                </div>
              </article>
            );
          })}
            </div>
          )}

          {!loading && visible.length > 0 ? (
            <StorePagination page={page} totalPages={totalPages} onChange={setPage} />
          ) : null}
        </div>

        {refreshing ? (
          <div className="pointer-events-none absolute inset-x-0 top-12 z-20 flex justify-center">
            {/* 同样换成受控玻璃：写死的 bg-white/50 + shadow-lg 会盖掉玻璃变量 */}
            <span className="kk-glass kk-glass-strong inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium text-slate-700">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在刷新资源…
            </span>
          </div>
        ) : null}
      </div>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent
          hideClose
          className="flex max-h-[min(88dvh,100dvh-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:p-0 landscape:max-w-2xl"
        >
          {detail ? (
            /*
             * 两个源共用同一套详情版式（区块顺序与位置完全一致）：
             * 头部头像+标题 → 封面 → 简介 → 版本+标签 → 插件信息 → 文档 → 评论 → 底部按钮。
             * 某个源没有数据的区块（GitHub 无封面/评论，咔咔源无文档）自动隐藏，位置不动。
             */
            <>
              <DialogHeader className="relative shrink-0 space-y-0 px-5 pb-3 pr-14 pt-4 text-left">
                <div className="flex items-center gap-3.5">
                  {detail.homepage ? (
                    <QuietExternal
                      href={detail.homepage}
                      title={`打开源码仓库 ${detail.homepage.replace(/^https?:\/\//, '')}`}
                      className="shrink-0 rounded-full transition-transform hover:scale-105"
                    >
                      <StoreAvatar resource={detail} size="detail" />
                    </QuietExternal>
                  ) : (
                    <StoreAvatar resource={detail} size="detail" />
                  )}
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="truncate text-lg sm:text-xl">{detail.title}</DialogTitle>
                    <DialogDescription className="mt-1 truncate">
                      {[
                        detail.author || '未知作者',
                        detail.version ? `v${detail.version}` : '',
                        displayUploader(detail.uploader_name)
                          ? `上传 ${displayUploader(detail.uploader_name)}`
                          : '',
                      ].filter(Boolean).join(' · ')}
                    </DialogDescription>
                  </div>
                </div>
                <DialogClose
                  className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-white/30 hover:text-slate-800"
                  aria-label="关闭"
                >
                  <X className="h-4 w-4" />
                </DialogClose>
              </DialogHeader>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 pb-1 pt-0.5 no-scrollbar">
                {/* 封面：仅咔咔源有封面授权 */}
                {detail.allow_cover_preview ? (
                  <div className="relative aspect-[3/2] overflow-hidden rounded-2xl border border-white/30">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={api.pluginStore.coverUrl(detail.id)}
                      alt={detail.title}
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  </div>
                ) : null}

                {/* 简介：两个源共用一块（详细介绍也走这里；不再单列「更新说明」） */}
                <section className="relative z-0 space-y-2 text-sm text-slate-600">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">简介</h3>
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {detailIntro(detail) || '暂无简介'}
                  </p>
                </section>

                {/* 版本 + 标签 */}
                {detail.version || detail.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {detail.version ? (
                      <span className="rounded-md border border-teal-300/40 bg-gradient-to-br from-teal-400/90 to-teal-600/90 px-2 py-0.5 text-xs font-semibold text-white shadow-sm">
                        v{detail.version}
                      </span>
                    ) : null}
                    {detail.tags.map((t) => (
                      <span key={t} className="rounded-md bg-white/25 px-1.5 py-0.5 text-[10px] text-slate-500">
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}

                {/*
                  插件信息：整块只在有实际行时渲染。
                  「最新版本」不再单列 —— 头部那行已经写了 vX.Y.Z，单独一行是重复信息空壳。
                */}
                {detailInstall.state !== 'none' && detailInstall.localVersion
                  || detail.min_kakake
                  || typeof detail.stars === 'number' ? (
                    <section className="relative z-0 space-y-2">
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">插件信息</h3>
                      <dl className="space-y-1.5 rounded-2xl border border-white/30 bg-white/15 p-3.5 text-sm backdrop-blur-sm">
                        {detailInstall.state !== 'none' && detailInstall.localVersion ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">当前版本</dt>
                            <dd className={cn(
                              'font-medium',
                              detailInstall.state === 'update' ? 'text-amber-600' : 'text-slate-700',
                            )}>
                              {detailInstall.localVersion}
                              {detailInstall.state === 'update' ? '（可更新）' : ''}
                            </dd>
                          </div>
                        ) : null}
                        {detail.min_kakake ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">最低版本要求</dt>
                            <dd className={cn('font-medium', minKakakeUnmet ? 'text-rose-600' : 'text-slate-700')}>
                              咔咔珂 ≥ {detail.min_kakake}
                              {minKakakeUnmet ? '（当前版本偏低）' : ''}
                            </dd>
                          </div>
                        ) : null}
                        {typeof detail.stars === 'number' ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">仓库星数</dt>
                            <dd className="flex items-center gap-1 font-medium text-slate-700">
                              <Star className="h-3.5 w-3.5 text-amber-400" fill="currentColor" />
                              {detail.stars}
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </section>
                  ) : null}

                {/* 文档：仅 GitHub 源有仓库 README */}
                {readmeLoading ? (
                  <div className="flex items-center gap-2 py-3 text-xs text-slate-400">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    加载文档…
                  </div>
                ) : readme ? (
                  <section className="relative z-0 space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">文档</h3>
                    <div className="rounded-2xl border border-white/30 bg-white/15 p-3.5 backdrop-blur-sm">
                      <MarkdownContent markdown={readme} />
                    </div>
                  </section>
                ) : null}

                {/* 评论：仅咔咔源商城有评论数据 */}
                {detail.origin !== 'github' ? (
                  <section className="relative z-0 space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      评论
                      <span className="ml-1 font-normal normal-case text-slate-400">({commentTotal})</span>
                    </h3>
                    {commentsLoading ? (
                      <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        加载评论…
                      </div>
                    ) : comments.length === 0 ? (
                      <p className="py-3 text-sm text-slate-400">暂无评论</p>
                    ) : (
                      <ul className="max-h-48 space-y-2 overflow-y-auto rounded-2xl border border-white/30 bg-white/15 p-2 backdrop-blur-sm">
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
                ) : null}
              </div>

              <div className="shrink-0 px-5 pb-4 pt-2.5">
                {!detail.allow_download || !detail.links.download ? (
                  <p className="mb-2.5 text-center text-xs text-amber-600">
                    {detail.download_block_reason || '当前不可下载安装'}
                  </p>
                ) : null}
                <div className="flex items-center gap-2.5">
                  <button type="button" className={btnGhost} onClick={() => setDetail(null)}>
                    关闭
                  </button>
                  {renderInstallButton(detail)}
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* GitHub 源安装前风险声明 */}
      <Dialog open={!!riskItem} onOpenChange={(v) => !v && setRiskItem(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-amber-600">
              <ShieldAlert className="h-5 w-5" />
              安装风险声明
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1 text-left text-slate-600">
              <span className="block">
                你即将从 GitHub 社区源安装
                <span className="font-medium text-slate-800">「{riskItem?.title}」</span>
                。此为第三方插件，非官方审核内容：
              </span>
              <span className="block text-sm leading-relaxed">
                插件代码由其作者维护，可能访问你的账号、消息与本机数据。请自行确认来源可信，安装即表示你自愿承担相应风险。
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setRiskItem(null)}>
              取消
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={() => {
                const item = riskItem;
                setRiskItem(null);
                if (item) void doInstall(item);
              }}
            >
              我已了解，继续安装
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* sha256 校验失败告警 */}
      <Dialog open={!!sha256Warn} onOpenChange={(v) => !v && setSha256Warn(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader className="text-left">
            <DialogTitle className="flex items-center gap-2 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
              安装包校验未通过
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1 text-left text-slate-600">
              <span className="block text-sm leading-relaxed">
                下载到的安装包与登记的 SHA-256 校验值不一致，文件可能在传输中损坏或被篡改。为保护你的安全，已自动中止安装。
              </span>
              {sha256Warn ? (
                <span className="block break-words rounded-lg bg-white/25 px-2 py-1.5 text-xs text-slate-500">
                  {sha256Warn}
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end">
            <button type="button" className={btnPrimary} onClick={() => setSha256Warn(null)}>
              我知道了
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
