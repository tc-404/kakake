import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle, ArrowUpDown, Check, Download, ExternalLink, Github, Loader2, Package, RefreshCw,
  Search, ShieldAlert, Star, Tags, X,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
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
import { errText, resText, svcText } from '@/lib/server-error';
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
  DropdownMenuSeparator,
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

/** 详情头部「作者 · 版本 · 上传者」行：作者与插件名撞名省作者段，上传者与作者撞名省上传段 */
function detailMetaLine(
  detail: Pick<StoreResource, 'title' | 'author' | 'version' | 'uploader_name'>,
  unknownAuthor: string,
  uploadedBy: (name: string) => string,
): string {
  const title = (detail.title || '').trim();
  const author = (detail.author || '').trim();
  const uploader = displayUploader(detail.uploader_name);
  const authorSeg = author ? (author === title ? '' : author) : unknownAuthor;
  const uploaderSeg = uploader && uploader !== author ? uploadedBy(uploader) : '';
  return [authorSeg, detail.version ? `v${detail.version}` : '', uploaderSeg]
    .filter(Boolean)
    .join(' · ');
}

/**
 * 资源分类（顶栏筛选与卡片角标共用同一套判定）。
 *
 * `label` 是筛选用的叫法，`badge` 是卡片角标上的叫法——「野鸡 / 野生」是同一档，
 * 只是两个源的原始字段名不同（`resource_type` 用野鸡、`type` 用野生），这里统一归一到同一档。
 */
type StoreCategoryId = 'wild' | 'official' | 'twin' | 'wechat' | 'other';

interface StoreCategory {
  id: StoreCategoryId;
  /** 顶栏筛选里显示的四个字以内的名字（目前五档都是两个字） */
  label: string;
  /** 卡片角标上显示的名字 */
  badge: string;
  /** 卡片角标配色（实底） */
  badgeClass: string;
  /** 该档的文字色：顶栏选中态与下拉菜单选中态共用 */
  textClass: string;
  /** 顶栏按钮选中态配色（只上底色 + 文字色，避免顶栏出现一块实底） */
  chipClass: string;
  /** 该档认哪些原始类型值 */
  raw: string[];
}

const STORE_CATEGORIES: StoreCategory[] = [
  {
    id: 'wild',
    label: '野鸡',
    badge: '野生',
    badgeClass: 'border-orange-300/50 bg-orange-500/90 text-white',
    textClass: 'text-orange-600',
    chipClass: 'bg-white/45 text-orange-600 ring-1 ring-inset ring-orange-300/60',
    raw: ['野生', '野鸡'],
  },
  {
    id: 'official',
    label: '官方',
    badge: '官方',
    badgeClass: 'border-sky-300/50 bg-sky-500/90 text-white',
    textClass: 'text-sky-600',
    chipClass: 'bg-white/45 text-sky-600 ring-1 ring-inset ring-sky-300/60',
    raw: ['官方', '官鸡'],
  },
  {
    id: 'twin',
    label: '双生',
    badge: '双生',
    // 双生 = OneBot + QQ 官方双协议。配色用品红 fuchsia，与天蓝/橙/翠绿/紫都不撞
    badgeClass: 'border-fuchsia-300/50 bg-fuchsia-500/90 text-white',
    textClass: 'text-fuchsia-600',
    chipClass: 'bg-white/45 text-fuchsia-600 ring-1 ring-inset ring-fuchsia-300/60',
    raw: ['双生', '双生插件', 'sssx', 'sssx-plugin', 'twin'],
  },
  {
    id: 'wechat',
    label: '微信',
    badge: '微信',
    badgeClass: 'border-emerald-300/50 bg-emerald-500/90 text-white',
    textClass: 'text-emerald-600',
    chipClass: 'bg-white/45 text-emerald-600 ring-1 ring-inset ring-emerald-300/60',
    raw: ['微信', 'wxbot'],
  },
  {
    id: 'other',
    label: '其他',
    badge: '其他',
    badgeClass: 'border-purple-300/50 bg-purple-500/90 text-white',
    textClass: 'text-purple-600',
    chipClass: 'bg-white/45 text-purple-600 ring-1 ring-inset ring-purple-300/60',
    raw: ['其他'],
  },
];

/** 原始类型值 → 内部分类 id；认不出来返回 null（这类资源在任何一档筛选下都不出现） */
function storeCategoryOf(raw?: string): StoreCategoryId | null {
  const t = (raw || '').trim().toLowerCase();
  if (!t) return null;
  for (const c of STORE_CATEGORIES) {
    if (c.raw.some((r) => r.toLowerCase() === t)) return c.id;
  }
  return null;
}

/** 类型 → 角标（兼容咔咔源 官鸡/野鸡/wxbot 与 GitHub 源 野生/官方/微信/其他/双生） */
function typeBadge(raw?: string): { key: StoreCategoryId; className: string } | null {
  const id = storeCategoryOf(raw);
  if (!id) return null;
  const c = STORE_CATEGORIES.find((x) => x.id === id);
  return c ? { key: c.id, className: c.badgeClass } : null;
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
   * 压成一片半白，看着像「贴在白盘上」。层次改由 border + ring 承担。
   * 兜底态（无图标 / 加载失败）用纯矢量 GitHub 图案：无框、无底、绝对透明，只有图案本身。
   */
  const frame =
    'shrink-0 overflow-hidden rounded-full border border-white/50 shadow-sm';
  if (!src || failed) {
    return (
      <Github
        role="img"
        aria-label={resource.title}
        className={cn('shrink-0 text-slate-300', box)}
      />
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
  'kk-store-btn kk-store-btn-primary inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 px-3 text-sm font-medium text-white shadow-md kk-glow disabled:pointer-events-none disabled:opacity-50';

const btnUpdate =
  'kk-store-btn kk-store-btn-update inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 px-3 text-sm font-medium text-white shadow-md kk-glow-amber disabled:pointer-events-none disabled:opacity-50';

/** 卡片内紧凑按钮：固定宽度、不撑满整行 */
const btnCompactBase =
  'kk-store-btn inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border px-3.5 text-xs font-semibold disabled:pointer-events-none disabled:opacity-50';
const btnCompactPrimary = 'kk-store-btn-primary border-white/30 text-white shadow-sm kk-glow';
const btnCompactUpdate = 'kk-store-btn-update border-white/30 text-white shadow-sm kk-glow-amber';
const btnCompactReinstall = 'border-slate-400/50 bg-slate-500/70 text-white shadow-sm';

/** 卡内底部裸文字按钮：无背景无边框（版本号/下载次数胶囊才有背景），居中由外层控制 */
const btnBarePrimary =
  'inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-teal-700 transition-colors hover:text-teal-800 disabled:pointer-events-none disabled:opacity-50';
const btnBareUpdate =
  'inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-amber-600 transition-colors hover:text-amber-700 disabled:pointer-events-none disabled:opacity-50';

/** 重新安装：灰色系（区别于安装的青色与更新的琥珀色），三形态各一份 */
const btnReinstall =
  'kk-store-btn inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/30 bg-slate-500/80 px-3 text-sm font-medium text-white shadow-md disabled:pointer-events-none disabled:opacity-50';
const btnBareReinstall =
  'inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-slate-500 transition-colors hover:text-slate-600 disabled:pointer-events-none disabled:opacity-50';

export default function PluginStorePage() {
  const t = useT();
  const [origin, setOrigin] = useState<StoreOrigin>('github');
  const [resources, setResources] = useState<StoreResource[]>([]);
  const [pinnedIds, setPinnedIds] = useState<Set<number>>(new Set());
  const [installed, setInstalled] = useState<PluginItem[]>([]);
  const [currentVersion, setCurrentVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<StoreSortMode>('default');
  /**
   * 顶栏分类筛选。
   *
   * 刻意只放在组件 state 里：不写 localStorage、不进 URL、不跨路由保留。
   * 刷新网页 / 切走页面 → 组件卸载 → 选择自动清空（一次性筛选）。
   * 而停留在本页内的下载、更新、刷新、安装都只是换数据 / 换 state，组件不卸载，
   * 选择保留；刷新拉回来的新资源也会立刻按当前分类重新过滤。
   */
  const [category, setCategory] = useState<StoreCategoryId | null>(null);
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
          toast.error(resText(res) || t('plugin-store.loadFailed'));
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
      if (!silent) toast.error(errText(e));
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
      if (ok) toast.success(t('plugin-store.refreshed'));
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

  /** 当前选中的分类对象（未选择时为 null） */
  const activeCategory = useMemo(
    () => (category ? STORE_CATEGORIES.find((c) => c.id === category) || null : null),
    [category],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    let filtered = indexed;
    // 分类筛选：派生计算，所以刷新 / 拉到新资源后会自动按当前分类重新生效
    if (activeCategory) {
      const id = activeCategory.id;
      filtered = filtered.filter((r) => storeCategoryOf(r.type || r.resource_type) === id);
    }
    if (q) {
      filtered = filtered.filter((r) => {
        const hay = `${r.title} ${r.author} ${r.summary} ${r.description} ${r.update_notes} ${r.tags.join(' ')}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return sortStoreResources(filtered, sortMode, authorCounts);
  }, [indexed, query, sortMode, authorCounts, activeCategory]);

  const sortOptions = useMemo(() => getSortOptions(origin, caps), [origin, caps]);
  const sortModeId = sortOptions.find((o) => o.id === sortMode)?.id;
  const sortLabel = sortModeId ? t(`plugin-store.sort-${sortModeId}`) : t('plugin-store.sort');

  // 分页：每页 16 个
  const PAGE_SIZE = 16;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  // 搜索 / 排序 / 分类 / 来源变化后回到第一页
  useEffect(() => { setPage(1); }, [query, sortMode, category, origin]);
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
  /** 分类选中态：按钮里要放两个字，所以不能锁死 w-8 */
  const headerChipClass =
    'inline-flex h-8 shrink-0 items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors hover:bg-white/60';

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
        toast.error(resText(res) || t('plugin-store.commentsLoadFailed'));
      }
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setCommentsLoading(false);
    }
  };

  const doInstall = async (item: StoreResource) => {
    if (!item.allow_download || !item.links.download) {
      toast.error(svcText(item.download_block_reason) || t('plugin-store.downloadNotAllowed'));
      return;
    }
    setInstallingId(item.id);
    const ver = item.version ? ` v${item.version}` : '';
    try {
      const result = await runWithDownloadProgressToast({
        runningLabel: `${item.title}${ver}`,
        task: () => api.pluginStore.install(item.id),
        isOk: (r) => r.ok,
        errorMessage: (r) => resText(r) || t('plugin-store.installFailed'),
        // 波浪预设下失败胶囊整颗可点，点了就重来一次
        onRetry: () => void doInstall(item),
      });
      if (!result.ok && result.code === 'sha256_mismatch') {
        setSha256Warn(resText(result) || t('plugin-store.sha256DefaultWarn'));
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

  const renderInstallButton = (item: StoreResource, compact = false, tourId?: string, bare = false) => {
    const canInstall = !!item.allow_download && !!item.links.download;
    const { state } = resolveInstallState(item, installed);
    const busy = installingId === item.id;
    const isUpdate = state === 'update';
    const isReinstall = state === 'installed'; // 已安装也允许再跑一遍安装流程（重新安装）
    const cls = bare
      ? (isUpdate ? btnBareUpdate : isReinstall ? btnBareReinstall : btnBarePrimary)
      : compact
        ? cn(btnCompactBase, isUpdate ? btnCompactUpdate : isReinstall ? btnCompactReinstall : btnCompactPrimary)
        : (isUpdate ? btnUpdate : isReinstall ? btnReinstall : btnPrimary);
    return (
      <button
        type="button"
        className={cls}
        data-tour={tourId}
        disabled={!canInstall || busy}
        onClick={(e) => { e.stopPropagation(); onInstallClick(item); }}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {isUpdate
          ? t('plugin-store.update')
          : isReinstall ? t('plugin-store.reinstall') : t('plugin-store.install')}
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
            title={t('plugin-store.openSource')}
            aria-label={t('plugin-store.openSource')}
            data-tour="store-origin"
            className={headerBtnClass}
          >
            <ExternalLink className="h-4 w-4" />
          </QuietExternal>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={activeCategory ? `${t('plugin-store.category')}：${t(`plugin-store.cat-${activeCategory.id}`)}（${t('plugin-store.clickAgainToCancel')}）` : t('plugin-store.filterByCategory')}
                aria-label={activeCategory ? `${t('plugin-store.category')}：${t(`plugin-store.cat-${activeCategory.id}`)}` : t('plugin-store.filterByCategory')}
                data-tour="store-category"
                // 当前选中的分类 id（未筛选为空串）：导览靠它判断/切换/取消筛选，
                // 不读按钮文字——按钮上显示的是当前语言的分类名，英文模式下对不上
                data-tour-cat={category ?? ''}
                className={activeCategory ? cn(headerChipClass, activeCategory.chipClass) : headerBtnClass}
              >
                {/* 文字包 span：button 里的裸文本节点染不上全局字体渐变（同排序菜单） */}
                {activeCategory ? <span>{t(`plugin-store.cat-${activeCategory.id}`)}</span> : <Tags className="h-4 w-4" />}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-tour="store-category-menu" className="min-w-[9rem]">
              {STORE_CATEGORIES.map((c) => (
                <DropdownMenuItem
                  key={c.id}
                  // 再点一次已选中的分类 = 取消筛选（回到全部）
                  onSelect={() => setCategory((cur) => (cur === c.id ? null : c.id))}
                  data-tour="store-category-item"
                  data-tour-cat={c.id}
                  className={cn(category === c.id && 'bg-white/45 font-medium')}
                >
                  <Check className={cn('h-4 w-4', category === c.id ? 'opacity-100' : 'opacity-0')} />
                  <span className={cn(category === c.id && c.textClass)}>{t(`plugin-store.cat-${c.id}`)}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <p className="px-2.5 py-1 text-[11px] leading-snug text-slate-400">
                {t('plugin-store.categoryClearHint')}
              </p>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                title={`${t('plugin-store.sort')}：${sortLabel}`}
                aria-label={`${t('plugin-store.sort')}：${sortLabel}`}
                data-tour="store-sort"
                className={headerBtnClass}
              >
                <ArrowUpDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" data-tour="store-sort-menu" className="min-w-[11rem]">
              {sortOptions.map((opt) => (
                <DropdownMenuItem
                  key={opt.id}
                  onSelect={() => setSortMode(opt.id)}
                  data-tour="store-sort-item"
                  className={cn(sortMode === opt.id && 'bg-white/45 font-medium text-teal-800')}
                >
                  <Check className={cn('h-4 w-4', sortMode === opt.id ? 'opacity-100' : 'opacity-0')} />
                  {t(`plugin-store.sort-${opt.id}`)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            disabled={loading || refreshing}
            onClick={() => { void handleRefresh(); }}
            title={t('btn.refresh')}
            aria-label={t('btn.refresh')}
            data-tour="store-refresh"
            className={headerBtnClass}
          >
            {loading || refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        </>
      ),
    }),
    [isGithub, sortLabel, sortOptions, sortMode, handleRefresh, loading, refreshing,
      category, activeCategory],
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
          <div data-tour="store-search" className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 z-[1] h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('plugin-store.searchPlaceholder')}
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
              {t('plugin-store.loadingResources')}
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/40 bg-white/15 py-16 text-center text-sm text-slate-400 backdrop-blur-md">
              {query.trim()
                ? t('plugin-store.noMatch')
                : activeCategory
                  ? t('plugin-store.categoryEmpty', { label: t(`plugin-store.cat-${activeCategory.id}`) })
                  : t('plugin-store.noResources')}
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
                data-tour="store-card"
                style={{ animationDelay: `${Math.min(index, 12) * 0.05}s` }}
                className={cn(
                  'kk-stagger-item group relative flex h-full min-h-[9.5rem] cursor-pointer flex-col overflow-hidden rounded-2xl p-3',
                  'kk-glass',
                  'transition-all duration-300 hover:-translate-y-1 hover:shadow-[var(--glass-shadow-hover)]',
                )}
                onClick={() => void openDetail(item)}
              >
                {/* 右上角插件类型标签，居右对齐；其正下方为下载次数标签（同为右对齐） */}
                {badge ? (
                  <span
                    className={cn(
                      'absolute right-2.5 top-2.5 z-10 shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-medium leading-none',
                      badge.className,
                    )}
                  >
                    {t(`plugin-store.badge-${badge.key}`)}
                  </span>
                ) : null}
                {typeof item.download_count === 'number' ? (
                  <span
                    className="absolute right-2.5 top-8 z-10 inline-flex shrink-0 items-center gap-1 rounded border border-slate-300/60 bg-white/40 px-1.5 py-0.5 text-[9px] font-medium leading-none text-slate-500"
                    title={t('plugin-store.downloadTimes', { n: item.download_count })}
                  >
                    <Download className="h-2.5 w-2.5" />
                    {formatDownloadCount(item.download_count)}
                  </span>
                ) : null}
                {/* 头像 + 名称/作者。头像即入口：有仓库地址点击跳仓库，没有则点击进详情 */}
                <div className="flex items-center gap-2.5">
                  <div className="relative">
                    {item.homepage ? (
                      <span className="block" onClick={(e) => e.stopPropagation()}>
                        <QuietExternal
                          href={item.homepage}
                          title={item.homepage.replace(/^https?:\/\//, '')}
                          className="block rounded-full transition-transform hover:scale-105"
                        >
                          <StoreAvatar resource={item} />
                        </QuietExternal>
                      </span>
                    ) : (
                      <StoreAvatar resource={item} />
                    )}
                    {pinned ? (
                      <span
                        className="absolute -left-1 -top-1 z-10 h-3.5 w-3.5 rounded-full border-2 border-white bg-amber-500 shadow"
                        title={t('plugin-store.pinned')}
                      />
                    ) : null}
                  </div>
                  <div className={cn('min-w-0 flex-1', (badge || typeof item.download_count === 'number') && 'pr-12')}>
                    <h2 className="truncate text-base font-semibold leading-snug text-slate-800">
                      {item.title}
                    </h2>
                    <p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-slate-500">
                      <span className="truncate">{item.author || t('plugin-store.unknownAuthor')}</span>
                      {item.version ? (
                        <span className="translate-y-px shrink-0 rounded border border-teal-300/60 bg-teal-400/10 px-1 py-px text-[9px] font-semibold leading-none text-teal-700">
                          v{item.version}
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
                  {showSummary ? summary : t('plugin-store.noIntro')}
                </p>

                {/* 底部操作条：与简介区域固定 15px 间距，不再用 mt-auto 吸底。
                    卡片其余部分高度均已确定（头像行 48px + 简介两行 40px + 按钮条 48px），
                    间距固定后整卡高度恒定 → 同行等高，跨行也完全一致 */}
                <div className="mt-[15px] flex h-12 w-full items-end rounded-xl border border-white/40 bg-white/10 p-1">
                  {renderInstallButton(item, false, 'store-install', true)}
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
              {t('plugin-store.refreshingResources')}
            </span>
          </div>
        ) : null}
      </div>

      <Dialog open={!!detail} onOpenChange={(v) => !v && setDetail(null)}>
        <DialogContent
          hideClose
          data-tour="store-detail"
          className="flex max-h-[min(88dvh,100dvh-2rem)] max-w-lg flex-col gap-0 overflow-hidden p-0 sm:p-0 landscape:max-w-2xl"
        >
          {detail ? (
            /*
             * 两个源共用同一套详情版式（区块顺序与位置完全一致）：
             * 头部头像+标题 → 封面 → 简介 → 版本+标签 → 插件信息 → 文档 → 评论 → 底部按钮。
             * 某个源没有数据的区块（GitHub 无封面/评论，咔咔源无文档）自动隐藏，位置不动。
             */
            <>
              <DialogHeader data-tour="store-detail-head" className="relative shrink-0 space-y-0 px-5 pb-3 pr-14 pt-4 text-left">
                <div className="flex items-center gap-3.5">
                  {detail.homepage ? (
                    <QuietExternal
                      href={detail.homepage}
                      title={`${t('plugin-store.openRepo')} ${detail.homepage.replace(/^https?:\/\//, '')}`}
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
                      {detailMetaLine(detail, t('plugin-store.unknownAuthor'), (n) => t('plugin-store.uploadedBy', { name: n }))}
                    </DialogDescription>
                  </div>
                </div>
                <DialogClose
                  className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-slate-500 transition-colors hover:bg-white/30 hover:text-slate-800"
                  aria-label={t('btn.close')}
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
                <section data-tour="store-detail-intro" className="relative z-0 space-y-2 text-sm text-slate-600">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('plugin-store.intro')}</h3>
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {detailIntro(detail) || t('plugin-store.noIntro')}
                  </p>
                </section>

                {/* 版本 + 标签 */}
                {detail.version || detail.tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    {detail.version ? (
                      <span className="rounded-md border border-teal-300/40 bg-gradient-to-br from-teal-400/90 to-teal-600/90 bg-origin-border px-2 py-0.5 text-xs font-semibold text-white shadow-sm">
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
                      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('plugin-store.pluginInfo')}</h3>
                      <dl className="space-y-1.5 rounded-2xl border border-white/30 bg-white/15 p-3.5 text-sm backdrop-blur-sm">
                        {detailInstall.state !== 'none' && detailInstall.localVersion ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">{t('plugin-store.currentVersion')}</dt>
                            <dd className={cn(
                              'font-medium',
                              detailInstall.state === 'update' ? 'text-amber-600' : 'text-slate-700',
                            )}>
                              {detailInstall.localVersion}
                              {detailInstall.state === 'update' ? t('plugin-store.updatable') : ''}
                            </dd>
                          </div>
                        ) : null}
                        {detail.min_kakake ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">{t('plugin-store.minVersionReq')}</dt>
                            <dd className={cn('font-medium', minKakakeUnmet ? 'text-rose-600' : 'text-slate-700')}>
                              咔咔珂 ≥ {detail.min_kakake}
                              {minKakakeUnmet ? t('plugin-store.versionTooLow') : ''}
                            </dd>
                          </div>
                        ) : null}
                        {typeof detail.stars === 'number' ? (
                          <div className="flex items-center justify-between gap-3">
                            <dt className="text-slate-400">{t('plugin-store.repoStars')}</dt>
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
                    {t('plugin-store.loadingDocs')}
                  </div>
                ) : readme ? (
                  <section data-tour="store-detail-doc" className="relative z-0 space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">{t('plugin-store.docs')}</h3>
                    <div className="rounded-2xl border border-white/30 bg-white/15 p-3.5 backdrop-blur-sm">
                      <MarkdownContent markdown={readme} />
                    </div>
                  </section>
                ) : null}

                {/* 评论：仅咔咔源商城有评论数据 */}
                {detail.origin !== 'github' ? (
                  <section className="relative z-0 space-y-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      {t('plugin-store.comments')}
                      <span className="ml-1 font-normal normal-case text-slate-400">({commentTotal})</span>
                    </h3>
                    {commentsLoading ? (
                      <div className="flex items-center gap-2 py-4 text-xs text-slate-400">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        {t('plugin-store.loadingComments')}
                      </div>
                    ) : comments.length === 0 ? (
                      <p className="py-3 text-sm text-slate-400">{t('plugin-store.noComments')}</p>
                    ) : (
                      <ul className="no-scrollbar max-h-48 space-y-2 overflow-y-auto rounded-2xl border border-white/30 bg-white/15 p-2 backdrop-blur-sm">
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
                    <p className="text-[11px] text-slate-400">{t('plugin-store.commentsViewOnly')}</p>
                  </section>
                ) : null}
              </div>

              <div className="shrink-0 px-5 pb-4 pt-2.5">
                {!detail.allow_download || !detail.links.download ? (
                  <p className="mb-2.5 text-center text-xs text-amber-600">
                    {detail.download_block_reason || t('plugin-store.cannotDownloadNow')}
                  </p>
                ) : null}
                <div className="flex items-center gap-2.5">
                  {/*
                    导览要能关掉这个弹窗，靠的就是这个锚点。
                    以前导览按按钮文字「关闭」去找它——切到英文模式按钮变成 "Close"，
                    匹配不上，弹窗就一直盖着，后面的步骤全被挡住。
                    按文字找控件本质是拿 UI 文案当接口，语言一换就断，一律换成 data 属性。
                  */}
                  <button
                    type="button"
                    className={btnGhost}
                    data-tour="store-detail-close"
                    onClick={() => setDetail(null)}
                  >
                    {t('btn.close')}
                  </button>
                  {renderInstallButton(detail, false, 'store-detail-install')}
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
              {t('plugin-store.riskTitle')}
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1 text-left text-slate-600">
              <span className="block">
                {t('plugin-store.riskIntro', { title: riskItem?.title ?? '' })}
              </span>
              <span className="block text-sm leading-relaxed">
                {t('plugin-store.riskDetail')}
              </span>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex flex-row justify-end gap-2">
            <button type="button" className={btnGhost} onClick={() => setRiskItem(null)}>
              {t('btn.cancel')}
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
              {t('plugin-store.riskConfirm')}
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
              {t('plugin-store.sha256Title')}
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-1 text-left text-slate-600">
              <span className="block text-sm leading-relaxed">
                {t('plugin-store.sha256Detail')}
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
              {t('plugin-store.gotIt')}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
