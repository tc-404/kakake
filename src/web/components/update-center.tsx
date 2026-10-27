import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { getPortalRoot } from '@/lib/portal-root';
import {
  ChevronDown,
  DownloadCloud,
  ExternalLink,
  FlaskConical,
  Loader2,
  RefreshCw,
  Settings2,
  Zap,
} from 'lucide-react';
import { toast } from 'sonner';
import { api, type UpdateChannel, type UpdateStateResp, type UpdateVersionInfo } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { svcText } from '@/lib/server-error';
import {
  useInstallState,
  openInstallRisk,
  cancelInstall,
  refreshInstall,
} from '@/components/update-install-overlay';

/**
 * 更新中心：侧栏版本号徽标 + 悬浮窗（标题/状态 → 版本对比 → 安装版本 → 主操作 → 高级）。
 * 自动检查按后端 10 分钟 TTL 节流；预发布不会对正式版用户点亮 NEW。
 */

/* ---------------- 跨实例共享状态 ---------------- */

let shared: UpdateStateResp | null = null;
let autoStarted = false;
let pingMode: 'all' | 'one' | null = null;
let pingIds: string[] = [];

const SELECTED_KEY = 'kakake_update_mirror';
let selectedMirror = readSelected();
/** 版本下拉的选择（内存态，默认最新） */
let selectedVersionTag = '';

const listeners = new Set<() => void>();

function readSelected(): string {
  try {
    return (typeof localStorage !== 'undefined' && localStorage.getItem(SELECTED_KEY)) || '';
  } catch {
    return '';
  }
}

function emit() {
  for (const l of listeners) l();
}

function setSelectedMirror(id: string): void {
  selectedMirror = id;
  try {
    localStorage.setItem(SELECTED_KEY, id);
  } catch {
    /* 隐私模式忽略 */
  }
  emit();
}

function setSelectedVersion(tag: string): void {
  selectedVersionTag = tag;
  emit();
}

let refreshInflight = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

async function refresh(): Promise<void> {
  // 同时触发（挂载 + 切回前台 + 打开悬浮窗）时只发一次请求
  if (refreshInflight) return;
  refreshInflight = true;
  try {
    shared = await api.updateState();
    emit();
  } catch {
    /* 保持原状 */
  } finally {
    refreshInflight = false;
  }
}

/**
 * 自动检查是后台异步的，第一次请求通常只拿到 status=checking。
 * 这里按状态轮询直到出结果；60 秒仍未完成就再做一次兜底请求后收手，
 * 不再像旧版那样 20 秒一到就彻底放弃（慢网络下会永远不亮 NEW）。
 */
function pollUntilSettled(): void {
  if (pollTimer) return;
  let ticks = 0;
  pollTimer = setInterval(() => {
    ticks += 1;
    const done = !!shared && shared.status !== 'checking' && shared.status !== 'idle';
    if (done || ticks > 24) {
      clearInterval(pollTimer as ReturnType<typeof setInterval>);
      pollTimer = null;
      if (!done) void refresh();
      return;
    }
    void refresh();
  }, 2500);
}

/** 拉一次状态；若后端刚开始重查（status=checking）则继续轮询 */
async function refreshAndPoll(): Promise<void> {
  await refresh();
  if (shared?.status === 'checking') pollUntilSettled();
}

function ensureAutoStarted(): void {
  if (autoStarted) return;
  autoStarted = true;
  void refreshAndPoll();
}

/** 把单个镜像的 ping 结果就地并入共享状态（不整体替换，避免相互覆盖） */
function applyPingResult(resp: UpdateStateResp, id: string): void {
  if (!shared) {
    shared = resp;
    return;
  }
  const inc = resp.mirrors.find((m) => m.id === id);
  const nextMirrors = inc ? shared.mirrors.map((m) => (m.id === id ? inc : m)) : shared.mirrors;
  const nextHasUpdate = resp.hasUpdate || shared.hasUpdate;
  shared = {
    ...shared,
    mirrors: nextMirrors,
    versions: resp.versions && resp.versions.length ? resp.versions : shared.versions,
    /*
     * 手动 Ping 现在也会让后端把 remoteVersion 向上修正；这些字段必须一起并进来，
     * 否则镜像列表刷新了、版本列表也出现了新版本，侧边栏的 NEW 红点却仍然不亮。
     * hasUpdate 只做「或」——并行 ping 时落后镜像的结果不能把已发现的新版本抹掉。
     */
    hasUpdate: nextHasUpdate,
    remoteVersion: resp.remoteVersion || shared.remoteVersion,
    remoteChannel: resp.remoteChannel || shared.remoteChannel,
    currentChannel: resp.currentChannel || shared.currentChannel,
    latestPrerelease: resp.latestPrerelease || shared.latestPrerelease,
    latestPrereleaseTag: resp.latestPrereleaseTag || shared.latestPrereleaseTag,
    hasPrerelease: resp.hasPrerelease || shared.hasPrerelease,
    activeMirrorId: resp.activeMirrorId || shared.activeMirrorId,
    status: nextHasUpdate ? 'update' : resp.status && resp.status !== 'idle' ? resp.status : shared.status,
    checkedThisSession: resp.checkedThisSession || shared.checkedThisSession,
  };
}

/** 一键 Ping：每个镜像各发一次请求，出一个显示一个（不等全部完成） */
async function runPingAll(): Promise<void> {
  if (pingMode) return;
  const ids = (shared?.mirrors || []).map((m) => m.id);
  if (!ids.length) return;
  pingMode = 'all';
  pingIds = [...ids];
  emit();
  await Promise.allSettled(
    ids.map(async (id) => {
      try {
        const r = await api.updatePing([id]);
        applyPingResult(r, id);
      } catch {
        /* 单个失败不影响其它 */
      } finally {
        pingIds = pingIds.filter((x) => x !== id);
        emit(); // 该镜像出结果就立刻刷新
      }
    }),
  );
  pingMode = null;
  pingIds = [];
  emit();
}

/** 测试所选：只 ping 一个镜像 */
async function runPingOne(id: string): Promise<UpdateStateResp | null> {
  if (pingMode) return shared;
  pingMode = 'one';
  pingIds = [id];
  emit();
  try {
    const r = await api.updatePing([id]);
    applyPingResult(r, id);
    return shared;
  } catch {
    return shared;
  } finally {
    pingMode = null;
    pingIds = [];
    emit();
  }
}

function isMirrorPinging(id: string): boolean {
  return !!pingMode && pingIds.includes(id);
}

function useUpdateState(): UpdateStateResp | null {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    ensureAutoStarted();
    const l = () => force();
    listeners.add(l);
    /*
     * 长时间开着后台页面时，自动检查不会自己再跑。
     * 切回前台 / 窗口重新获得焦点时补拉一次：后端按 10 分钟 TTL 决定是否真正访问镜像，
     * 所以这里不会造成额外请求风暴，却能让期间发布的新版本及时亮起 NEW。
     */
    const onWake = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refreshAndPoll();
    };
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    return () => {
      listeners.delete(l);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
    };
  }, []);
  return shared;
}

/* ---------------- 展示辅助 ---------------- */

function latencyTone(ms: number | null, reachable: boolean): string {
  if (!reachable) return 'text-rose-600 bg-rose-500/10';
  if (ms == null) return 'text-slate-400 bg-white/20';
  if (ms < 300) return 'text-emerald-600 bg-emerald-500/10';
  if (ms < 800) return 'text-amber-600 bg-amber-500/10';
  return 'text-rose-600 bg-rose-500/10';
}

/** 取文案的函数签名（= i18n 的 t），用于把模块级纯函数也接进双语 */
type TFn = (key: string, params?: Record<string, string | number | undefined>) => string;

function latencyLabel(
  m: {
    latencyMs: number | null;
    reachable: boolean;
    error: string;
    lastCheckedAt: string;
  },
  t: TFn,
): string {
  // 注意：'超时' 是后端返回的原始错误串，这里只做相等比较，不做展示
  if (!m.lastCheckedAt) return t('uc.latencyUntested');
  if (m.reachable) return m.latencyMs == null ? t('uc.latencyOk') : `${m.latencyMs}ms`;
  if (m.error === '超时') return t('uc.latencyTimeout');
  return t('uc.latencyFailed');
}

function fmtDate(iso: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * 「上次检查」文案：取所有镜像里最近的一次探测时间。
 * 面板打开时间通常很短，不做定时跳动；状态更新（重新检查 / 切回前台）会自然刷新。
 */
function lastCheckedText(state: UpdateStateResp | null, t: TFn): string {
  let newest = 0;
  for (const m of state?.mirrors || []) {
    const ts = Date.parse(m.lastCheckedAt || '');
    if (Number.isFinite(ts) && ts > newest) newest = ts;
  }
  if (!newest) return t('uc.lastCheckedNever');
  const diff = Date.now() - newest;
  if (diff < 60_000) return t('uc.lastCheckedJustNow');
  if (diff < 3_600_000) return t('uc.lastCheckedMinutes', { n: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('uc.lastCheckedHours', { n: Math.floor(diff / 3_600_000) });
  return t('uc.lastCheckedAt', { time: fmtDate(new Date(newest).toISOString()) });
}

/* ---------------- 发布通道标签 ---------------- */

/**
 * 通道标签配色：正式版 LTS（绿）/ BETA（琥珀）/ RC（紫）/ ALPHA（玫红）。
 * 产品约定「正式版 = LTS」；以后若要区分真正的 LTS 线，只改 stable.label。
 */
const CHANNEL_META: Record<UpdateChannel, { label: string; titleKey: string; className: string }> = {
  stable: { label: 'LTS', titleKey: 'uc.channelStable', className: 'bg-emerald-500/15 text-emerald-700' },
  beta: { label: 'BETA', titleKey: 'uc.channelBeta', className: 'bg-amber-500/15 text-amber-700' },
  rc: { label: 'RC', titleKey: 'uc.channelRc', className: 'bg-violet-500/15 text-violet-700' },
  alpha: { label: 'ALPHA', titleKey: 'uc.channelAlpha', className: 'bg-rose-500/15 text-rose-700' },
};

function channelMeta(channel: UpdateChannel) {
  return CHANNEL_META[channel] ?? CHANNEL_META.stable;
}

function ChannelTag({ channel, className }: { channel: UpdateChannel; className?: string }) {
  const t = useT();
  const meta = channelMeta(channel);
  return (
    <span
      title={t(meta.titleKey)}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide',
        meta.className,
        className,
      )}
    >
      {meta.label}
    </span>
  );
}

const MOBILE_BP = 768;

/* ---------------- 锚定浮层（窗中窗复用） ---------------- */

type Pos = { top: number; left: number; width: number };

function useAnchoredPos(anchor: HTMLElement, opts: { matchWidth?: boolean; centerMobile?: boolean; fixedWidth?: number }) {
  const { matchWidth, centerMobile, fixedWidth } = opts;
  const [pos, setPos] = useState<Pos>({ top: -9999, left: -9999, width: fixedWidth ?? 340 });
  const place = useCallback(() => {
    const isMobile = window.innerWidth < MOBILE_BP;
    const r = anchor.getBoundingClientRect();
    const width = matchWidth ? Math.round(r.width) : fixedWidth ?? (isMobile ? Math.min(340, window.innerWidth - 24) : 340);
    let left: number;
    if (matchWidth) {
      left = r.left;
    } else if (isMobile && centerMobile) {
      left = Math.round((window.innerWidth - width) / 2);
    } else {
      left = r.left;
    }
    if (left + width > window.innerWidth - 8) left = window.innerWidth - 8 - width;
    if (left < 8) left = 8;
    let top = r.bottom + 8;
    if (isMobile && centerMobile) {
      // 手机：整体下移到置顶栏下方，避免与顶栏重叠
      const header = anchor.closest('header');
      const hb = header?.getBoundingClientRect().bottom;
      top = (typeof hb === 'number' ? hb : r.bottom) + 12;
    }
    setPos({ top, left, width });
  }, [anchor, matchWidth, centerMobile, fixedWidth]);

  useLayoutEffect(() => {
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [place]);

  return pos;
}

// 与设置里的原生选择框/下拉保持一致的进场动画：animate-in fade+zoom（时长统一受
// --kk-motion 控制，无显式 duration，行为与 Radix Select/Dropdown 完全一致）。
const PANEL_BASE =
  'fixed overflow-y-auto overscroll-contain no-scrollbar rounded-2xl kk-glass-2 kk-glass-2-strong text-slate-800 ' +
  'origin-top animate-in fade-in-0 zoom-in-95';

/** 「窗中窗」：镜像/版本选择展开的浮层。z 轴在主悬浮窗之上，各自独立关闭。 */
function NestedPanel({
  anchor,
  onClose,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  children: ReactNode;
}) {
  const t = useT();
  const pos = useAnchoredPos(anchor, { matchWidth: true });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      <button
        type="button"
        aria-label={t('btn.close')}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-[70] cursor-default bg-transparent"
      />
      <div
        role="listbox"
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 'min(50dvh, 22rem)' }}
        className={cn(PANEL_BASE, 'z-[71] p-1.5')}
      >
        {children}
      </div>
    </>,
    getPortalRoot(),
  );
}

/** 选择器触发行：左标签 + 右当前值 + 展开箭头，点击弹出窗中窗 */
function FloatingSelect({
  label,
  valueNode,
  disabled,
  children,
}: {
  label: string;
  valueNode: ReactNode;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-white/40 bg-white/20 px-3 py-2 text-left transition-colors',
          'hover:bg-white/35 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span className="shrink-0 text-[11px] font-semibold text-slate-500">{label}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{valueNode}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && ref.current ? (
        <NestedPanel anchor={ref.current} onClose={() => setOpen(false)}>
          {children(() => setOpen(false))}
        </NestedPanel>
      ) : null}
    </>
  );
}

/* ---------------- 主悬浮窗 ---------------- */

function UpdatePopover({
  anchor,
  onClose,
  state,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  state: UpdateStateResp | null;
}) {
  const t = useT();
  const pos = useAnchoredPos(anchor, { centerMobile: true });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const mirrors = state?.mirrors || [];
  const versions = state?.versions || [];

  const current = state?.currentVersion || '';
  const currentChannel = state?.currentChannel || 'stable';
  const remote = state?.remoteVersion || '';
  const remoteChannel = state?.remoteChannel || 'stable';
  const hasUpdate = !!state?.hasUpdate;
  const hasPrerelease = !!state?.hasPrerelease;
  const latestPrerelease = state?.latestPrerelease || '';
  const latestPrereleaseTag = state?.latestPrereleaseTag || '';
  const status = state?.status || 'idle';

  const effectiveSelected =
    (selectedMirror && mirrors.some((m) => m.id === selectedMirror) ? selectedMirror : '') ||
    (state?.activeMirrorId && mirrors.some((m) => m.id === state.activeMirrorId) ? state.activeMirrorId : '') ||
    (mirrors[0]?.id ?? '');

  const selMirror = mirrors.find((m) => m.id === effectiveSelected) || null;

  const selVersion: UpdateVersionInfo | null =
    versions.find((v) => v.tag === selectedVersionTag) ||
    // 默认选中「当前通道该跟的那个版本」：正式版用户不要一打开就选中 beta
    versions.find((v) => v.version === remote) ||
    versions.find((v) => v.channel === 'stable') ||
    versions[0] ||
    null;

  /** 预发布提示里的「选用」是否已经点过（避免重复点同一个按钮） */
  const prereleaseSelected = !!selVersion && selVersion.tag === latestPrereleaseTag;

  /* ---------- 在线安装（共享全局状态；就绪/风险弹窗由 UpdateInstallOverlay 负责） ---------- */
  const install = useInstallState();

  useEffect(() => {
    // 打开悬浮窗时同步一次更新状态：若距上次检查已超过 TTL，后端会重新访问镜像，
    // 结果回来后侧边栏的 NEW 会立刻亮起；安装进度也一并同步。
    void refreshAndPoll();
    void refreshInstall();
  }, []);

  const doInstall = useCallback(() => {
    if (!selVersion) return;
    // 不直接下载：先弹风险提示 + 5s 倒计时，确认后才开始
    openInstallRisk(selVersion.tag, selVersion.version, effectiveSelected || null);
  }, [selVersion, effectiveSelected]);

  const doCancelInstall = useCallback(async () => {
    await cancelInstall();
    toast.success(t('uc.cancelled'));
  }, [t]);

  const installJob = install?.job || null;
  const installActive =
    !!install?.inflight ||
    installJob?.phase === 'downloading' ||
    installJob?.phase === 'verifying' ||
    installJob?.phase === 'resolving';
  const staged = !!install?.pending || installJob?.phase === 'staged';
  const onlineSupported = install ? install.onlineUpdateSupported : true;

  const pingAll = async () => {
    if (pingMode) return;
    await runPingAll();
    const r = shared;
    if (r && !r.mirrors.some((m) => m.reachable)) toast.error(t('uc.pingAllDown'));
    else if (r) toast.success(t('uc.pingAllDone'));
  };

  const testOne = async () => {
    if (pingMode || !effectiveSelected) return;
    const r = await runPingOne(effectiveSelected);
    const m = r?.mirrors.find((x) => x.id === effectiveSelected);
    if (m?.reachable) toast.success(t('uc.available', { ms: m.latencyMs ?? '?' }));
    else toast.error(t('uc.unavailable', { err: svcText(m?.error) || t('uc.connectFailed') }));
  };

  const busyAll = pingMode === 'all';
  const busyOne = pingMode === 'one';
  const busy = pingMode !== null || status === 'checking';

  const statusText =
    status === 'checking' || pingMode
      ? t('uc.statusChecking')
      : hasUpdate
        ? remoteChannel === 'stable'
          ? t('uc.statusFoundNew')
          : t('uc.statusFoundPre')
        : status === 'latest' && hasPrerelease
          ? t('uc.statusLatestStable')
          : status === 'latest'
            ? t('uc.statusLatest')
            : status === 'unreachable'
              ? t('uc.statusUnreachable')
              : t('uc.statusIdle');

  const [advancedOpen, setAdvancedOpen] = useState(false);

  /** 用户是否在版本下拉里明确选过（没选时主按钮就是「检查更新」，不会误装旧版） */
  const explicitVersion = versions.some((v) => v.tag === selectedVersionTag);
  const installVisible = hasUpdate || explicitVersion;
  const selectedPrerelease =
    !!selVersion && !!selVersion.channel && selVersion.channel !== 'stable';
  const remoteInfo = versions.find((v) => v.version === remote) || null;
  const remoteDate = fmtDate(remoteInfo?.publishedAt || '');
  const prereleaseInfo = versions.find((v) => v.tag === latestPrereleaseTag) || null;
  const releaseHref = selVersion?.url || state?.releaseUrl || '';
  const lastChecked = lastCheckedText(state, t);
  const statusDot = hasUpdate
    ? remoteChannel === 'stable'
      ? 'bg-rose-500'
      : 'bg-amber-500'
    : status === 'latest'
      ? 'bg-emerald-500'
      : status === 'unreachable'
        ? 'bg-rose-500'
        : 'bg-slate-300';

  /** 重新检查：走手动 ping（绕过后端 10 分钟 TTL），状态/版本列表一起刷新 */
  const doRefresh = useCallback(async () => {
    if (pingMode || status === 'checking') return;
    await runPingAll();
    const r = shared;
    if (r && !r.mirrors.some((m) => m.reachable)) toast.error(t('uc.pingAllDown'));
  }, [status, t]);

  return createPortal(
    <>
      <button
        type="button"
        aria-label={t('btn.close')}
        onClick={onClose}
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
      />
      <div
        role="dialog"
        aria-label={t('uc.title')}
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 'min(80dvh, 40rem)' }}
        className={cn(PANEL_BASE, 'z-[61] p-4')}
      >
        {/* 顶部：标题 + 上次检查 + 状态 + 版本对比 */}
        <div data-tour="uc-header" className="mb-3">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-teal-500/15">
              <DownloadCloud className="h-4 w-4 text-teal-600" />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <h3 className="truncate text-sm font-bold text-slate-800">{t('uc.title')}</h3>
              <div className="truncate text-[10px] tabular-nums text-slate-400">{lastChecked}</div>
            </div>
            {installVisible ? (
              <button
                type="button"
                onClick={() => void doRefresh()}
                disabled={busy}
                title={t('uc.checkUpdate')}
                aria-label={t('uc.checkUpdate')}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 transition-colors hover:bg-white/40 hover:text-slate-800 disabled:opacity-50"
              >
                <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              </button>
            ) : null}
          </div>

          <div className="mt-3 flex min-w-0 items-center gap-2">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-600" />
            ) : (
              <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot)} />
            )}
            <p className="shrink-0 text-[15px] font-bold leading-tight text-slate-800">{statusText}</p>
            {!hasUpdate && current ? (
              <div className="ml-auto flex min-w-0 items-center gap-1.5 text-sm tabular-nums">
                <span className="min-w-0 truncate font-semibold text-slate-700">v{current}</span>
                <ChannelTag channel={currentChannel} />
              </div>
            ) : null}
          </div>
          {hasUpdate ? (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-sm tabular-nums">
              <span className="min-w-0 truncate font-semibold text-slate-400 line-through decoration-rose-400/80">
                v{current || '—'}
              </span>
              <ChannelTag channel={currentChannel} />
              <span className="shrink-0 text-slate-400">→</span>
              <span className="min-w-0 truncate font-bold text-teal-600">v{remote}</span>
              <ChannelTag channel={remoteChannel} />
              {remoteDate ? (
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-slate-400">{remoteDate}</span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* 安装版本（窗中窗选择；默认当前通道，选 beta 才会有风险提示） */}
        <div data-tour="uc-version" className="mb-2">
          <FloatingSelect
            label={t('uc.installVersion')}
            disabled={versions.length === 0}
            valueNode={
              selVersion ? (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="min-w-0 truncate text-xs font-semibold tabular-nums text-slate-700">
                    v{selVersion.version}
                  </span>
                  <ChannelTag channel={selVersion.channel} />
                  {selVersion.name && selVersion.name !== selVersion.tag ? (
                    <span className="min-w-0 truncate text-[10px] font-normal text-slate-400">
                      {selVersion.name}
                    </span>
                  ) : null}
                </span>
              ) : (
                <span className="text-xs text-slate-400">{t('uc.noVersionData')}</span>
              )
            }
          >
            {(close) => (
              <ul className="flex flex-col gap-1">
                {versions.length === 0 ? (
                  <li className="px-2.5 py-3 text-center text-xs text-slate-400">
                    {t('uc.noVersionHint')}
                  </li>
                ) : (
                  versions.map((v) => {
                    const active = selVersion?.tag === v.tag;
                    return (
                      <li key={v.tag}>
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedVersion(v.tag);
                            close();
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                            active ? 'bg-teal-500/15' : 'hover:bg-white/40',
                          )}
                        >
                          <span
                            aria-hidden
                            className={cn(
                              'h-3 w-3 shrink-0 rounded-full border-2',
                              active ? 'border-teal-500 bg-teal-500' : 'border-slate-300',
                            )}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <span className="min-w-0 truncate text-xs font-semibold tabular-nums text-slate-700">
                                v{v.version}
                              </span>
                              <ChannelTag channel={v.channel} />
                              {v.version === current ? (
                                <span className="shrink-0 rounded bg-white/35 px-1 py-px text-[9px] font-semibold leading-none text-slate-500">
                                  {t('uc.currentBadge')}
                                </span>
                              ) : null}
                            </span>
                            {v.name && v.name !== v.tag ? (
                              <span className="block truncate text-[10px] text-slate-400">{v.name}</span>
                            ) : null}
                          </span>
                          {fmtDate(v.publishedAt) ? (
                            <span className="shrink-0 whitespace-nowrap text-[10px] tabular-nums text-slate-400">
                              {fmtDate(v.publishedAt)}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </FloatingSelect>
        </div>

        {/* 选中预发布版本时的风险提醒 */}
        {selectedPrerelease && selVersion ? (
          <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-300/50 bg-amber-500/10 px-2.5 py-2 text-[11px] leading-relaxed text-amber-800">
            <FlaskConical className="mt-px h-3.5 w-3.5 shrink-0 text-amber-600" />
            <span>
              {t('uc.prereleaseSelected', {
                channel: t(channelMeta(selVersion.channel).titleKey),
              })}
            </span>
          </p>
        ) : null}

        {/* 正式版已最新、但存在更高的预发布时：只提示，不点亮 NEW */}
        {!hasUpdate && hasPrerelease && !selectedPrerelease && status !== 'unreachable' && latestPrerelease && latestPrereleaseTag ? (
          <div className="mb-2 flex items-center gap-2 rounded-xl border border-amber-300/50 bg-amber-500/10 px-2.5 py-2">
            <FlaskConical className="h-3.5 w-3.5 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[11px] font-semibold text-amber-800">
                  {t('uc.prereleaseAvailable', { v: latestPrerelease })}
                </span>
                {prereleaseInfo ? <ChannelTag channel={prereleaseInfo.channel} /> : null}
              </div>
              <div className="truncate text-[10px] leading-relaxed text-amber-700/80">
                {t('uc.prereleaseHint')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedVersion(latestPrereleaseTag)}
              className="shrink-0 rounded-md bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/25 active:scale-95"
            >
              {t('uc.prereleaseSelect')}
            </button>
          </div>
        ) : null}

        {/* 主操作：只保留一个实心主按钮；没显式选版本时它就是「检查更新」 */}
        <div data-tour="uc-actions" className="mt-1 flex flex-col gap-2">
          {installVisible ? (
            <button
              type="button"
              onClick={() => void doInstall()}
              disabled={!selVersion || installActive || !onlineSupported}
              title={
                !onlineSupported
                  ? install?.launchNote || t('uc.onlineUnsupported')
                  : t('uc.installTitleHint')
              }
              className={cn(
                'inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all',
                selVersion && !installActive && onlineSupported
                  ? 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-lg kk-glow-emerald hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98]'
                  : 'cursor-not-allowed bg-white/30 text-slate-500',
              )}
            >
              {installActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DownloadCloud className="h-4 w-4" />
              )}
              {installActive
                ? t('uc.processing')
                : hasUpdate && selVersion?.version === remote
                  ? t('uc.installUpdate')
                  : t('uc.installThis')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void doRefresh()}
              disabled={busy}
              className={cn(
                'inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-all',
                busy
                  ? 'cursor-not-allowed bg-white/30 text-slate-400'
                  : 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-lg kk-glow-emerald hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98]',
              )}
            >
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              {busy ? t('uc.statusChecking') : t('uc.checkUpdate')}
            </button>
          )}

          {releaseHref ? (
            <a
              href={releaseHref}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-1 self-center rounded px-1 py-1 text-[11px] font-medium text-teal-700 transition-colors hover:text-teal-800 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {t('uc.viewRelease')}
            </a>
          ) : null}

          {/* 在线安装进度 / 已就绪 / 出错 */}
          {installActive && installJob ? (
            <div className="rounded-lg border border-white/40 bg-white/25 p-2.5">
              <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-slate-600">
                <span className="truncate">{svcText(installJob.message) || t('uc.processing')}</span>
                <span className="tabular-nums text-teal-700">{installJob.percent}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/40">
                <div
                  className="h-full rounded-full bg-teal-500 transition-[width] duration-300"
                  style={{ width: `${Math.max(2, Math.min(100, installJob.percent))}%` }}
                />
              </div>
              <button
                type="button"
                onClick={() => void doCancelInstall()}
                className="mt-2 text-[11px] font-medium text-slate-400 underline-offset-2 hover:text-rose-500 hover:underline"
              >
                {t('uc.cancelDownload')}
              </button>
            </div>
          ) : null}

          {installJob?.phase === 'error' && !installActive ? (
            <div className="rounded-lg border border-rose-300/50 bg-rose-500/10 p-2.5 text-[11px] font-medium text-rose-600">
              {svcText(installJob.message) || t('uc.installFailed')}
            </div>
          ) : null}

          {staged && !installActive ? (
            <div className="rounded-lg border border-emerald-300/50 bg-emerald-500/10 p-2.5 text-[11px] font-medium text-emerald-700">
              {t('uc.stagedReady', { v: install?.pending?.version || installJob?.version || '' })}
            </div>
          ) : null}

          {!staged && !installActive && !onlineSupported && install?.launchNote ? (
            <p className="text-[11px] leading-relaxed text-amber-700">{install.launchNote}</p>
          ) : null}
        </div>

        {/* 高级：镜像源 / 测速，默认收起，日常更新不用管 */}
        <div className="mt-3 border-t border-white/40 pt-2">
          <button
            type="button"
            data-tour="uc-mirror"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-[11px] font-medium text-slate-500 transition-colors hover:text-slate-800"
          >
            <Settings2 className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 text-left">{t('uc.advanced')}</span>
            <ChevronDown
              className={cn('h-3.5 w-3.5 shrink-0 transition-transform', advancedOpen && 'rotate-180')}
            />
          </button>

          {advancedOpen ? (
            <div className="mt-2 flex flex-col gap-2">
              <FloatingSelect
                label={t('uc.mirrorLabel')}
                valueNode={
                  <>
                    <span className="truncate text-xs font-medium text-slate-700">
                      {selMirror?.label || t('uc.noMirror')}
                    </span>
                    {selMirror ? (
                      isMirrorPinging(selMirror.id) ? (
                        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />
                      ) : (
                        <span
                          className={cn(
                            'shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                            latencyTone(selMirror.latencyMs, selMirror.reachable),
                          )}
                        >
                          {latencyLabel(selMirror, t)}
                        </span>
                      )
                    ) : null}
                  </>
                }
              >
                {(close) => (
                  <ul className="flex flex-col gap-1">
                    {mirrors.map((m) => {
                      const active = m.id === effectiveSelected;
                      const pinging = isMirrorPinging(m.id);
                      return (
                        <li key={m.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedMirror(m.id);
                              close();
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left transition-colors',
                              active ? 'bg-teal-500/15' : 'hover:bg-white/40',
                            )}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                'h-3 w-3 shrink-0 rounded-full border-2',
                                active ? 'border-teal-500 bg-teal-500' : 'border-slate-300',
                              )}
                            />
                            <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
                              {m.label}
                              {active ? <span className="ml-1 text-[10px] font-normal text-teal-600">{t('uc.currentMark')}</span> : null}
                            </span>
                            {pinging ? (
                              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />
                            ) : (
                              <span
                                className={cn(
                                  'shrink-0 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums',
                                  latencyTone(m.latencyMs, m.reachable),
                                )}
                              >
                                {latencyLabel(m, t)}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </FloatingSelect>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pingAll()}
                  disabled={!!pingMode}
                  className={cn(
                    'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-xs font-medium text-slate-600 transition-colors',
                    'hover:bg-white/40 active:scale-[0.98] disabled:opacity-60',
                  )}
                >
                  {busyAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                  {t('uc.pingAll')}
                </button>
                <button
                  type="button"
                  onClick={() => void testOne()}
                  disabled={!!pingMode || !effectiveSelected}
                  className={cn(
                    'inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-xs font-medium text-slate-600 transition-colors',
                    'hover:bg-white/40 active:scale-[0.98] disabled:opacity-60',
                  )}
                >
                  {busyOne ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t('uc.testSelected')}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>,
    getPortalRoot(),
  );
}

/* ---------------- 版本号徽标（对外主组件） ---------------- */

export function UpdateCenter({ version, large = false }: { version: string; large?: boolean }) {
  const t = useT();
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  const display = (state?.currentVersion || version || '').trim();
  const hasUpdate = !!state?.hasUpdate;
  // NEW 的颜色跟通道走：正式版红、预发布琥珀，避免把 beta 误看成正式更新
  const newTone = state?.remoteChannel && state.remoteChannel !== 'stable' ? 'bg-amber-600' : 'bg-rose-500';

  if (!display) return null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-tour="update-center"
        onClick={() => setOpen((v) => !v)}
        title={t('uc.checkUpdate')}
        className={cn(
          // 透明度用 10（Tailwind 3.4 的透明度刻度只有 5 的倍数，/12 不会生成）
          'relative shrink-0 rounded-md bg-primary/10 font-semibold tabular-nums text-primary',
          'transition-colors hover:bg-primary/20 active:scale-95',
          large ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-px text-[10px]',
        )}
      >
        v{display}
        {hasUpdate ? (
          <span
            className={cn(
              'absolute -right-1.5 -top-1.5 inline-flex items-center rounded-full px-1 py-px text-[8px] font-bold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.7)]',
              newTone,
            )}
          >
            NEW
          </span>
        ) : null}
      </button>
      {open && btnRef.current ? (
        <UpdatePopover anchor={btnRef.current} onClose={() => setOpen(false)} state={state} />
      ) : null}
    </>
  );
}
