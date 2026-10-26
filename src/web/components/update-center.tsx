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
import { ChevronDown, Download, DownloadCloud, Loader2, RefreshCw, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { api, type UpdateStateResp, type UpdateVersionInfo } from '@/lib/api';
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
 * 更新中心：版本号徽标 +（有新版本时）右上角红色 NEW 气泡；点击呼出悬浮窗。
 * 悬浮窗内：镜像源选择、版本选择（各自展开为「窗中窗」的浮层）、底部操作按钮
 * （一键 Ping 仅测速 / 测试所选 / 去下载该版本）。
 *
 * 自动检查由后端按 10 分钟 TTL 节流（进入后台 / 切回前台 / 打开悬浮窗都会读一次状态，
 * 后台异步、不阻塞）。检查到新版本时，版本号右上角显示红色 NEW；
 * 手动「一键 Ping / 测试访问」也会向上修正版本对比，结果同样会点亮 NEW。
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
  'fixed overflow-y-auto no-scrollbar rounded-2xl kk-glass-2 kk-glass-2-strong text-slate-800 ' +
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

  const effectiveSelected =
    (selectedMirror && mirrors.some((m) => m.id === selectedMirror) ? selectedMirror : '') ||
    (state?.activeMirrorId && mirrors.some((m) => m.id === state.activeMirrorId) ? state.activeMirrorId : '') ||
    (mirrors[0]?.id ?? '');

  const selMirror = mirrors.find((m) => m.id === effectiveSelected) || null;

  const selVersion: UpdateVersionInfo | null =
    versions.find((v) => v.tag === selectedVersionTag) || versions[0] || null;

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

  const current = state?.currentVersion || '';
  const remote = state?.remoteVersion || '';
  const hasUpdate = !!state?.hasUpdate;
  const status = state?.status || 'idle';
  const busyAll = pingMode === 'all';
  const busyOne = pingMode === 'one';

  const statusText =
    status === 'checking' || pingMode
      ? t('uc.statusChecking')
      : hasUpdate
        ? t('uc.statusFoundNew')
        : status === 'latest'
          ? t('uc.statusLatest')
          : status === 'unreachable'
            ? t('uc.statusUnreachable')
            : t('uc.statusIdle');

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
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 'min(80dvh, 40rem)' }}
        className={cn(PANEL_BASE, 'z-[61] p-4')}
      >
        {/* 头部：版本对比 + 状态 */}
        <div data-tour="uc-header" className="mb-3 flex items-center gap-2 text-sm tabular-nums">
          <span
            className={cn(
              'font-semibold',
              hasUpdate ? 'text-slate-400 line-through decoration-rose-400/80' : 'text-slate-700',
            )}
          >
            v{current || '—'}
          </span>
          {hasUpdate ? (
            <>
              <span className="text-slate-400">→</span>
              <span className="font-bold text-teal-600">v{remote}</span>
            </>
          ) : null}
          <span
            className={cn(
              'ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
              hasUpdate
                ? 'bg-rose-500/15 text-rose-600'
                : status === 'latest'
                  ? 'bg-emerald-500/15 text-emerald-600'
                  : 'bg-white/30 text-slate-500',
            )}
          >
            {status === 'checking' || pingMode ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
            {statusText}
          </span>
        </div>

        {/* 两个选择器（窗中窗） */}
        <div className="flex flex-col gap-2">
          {/* 镜像源 */}
          <div data-tour="uc-mirror">
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
          </div>

          {/* 版本 */}
          <div data-tour="uc-version">
          <FloatingSelect
            label={t('uc.versionLabel')}
            disabled={versions.length === 0}
            valueNode={
              selVersion ? (
                <span className="truncate text-xs font-semibold tabular-nums text-slate-700">
                  v{selVersion.version}
                  {selVersion.name && selVersion.name !== selVersion.tag ? (
                    <span className="ml-1 font-normal text-slate-400">· {selVersion.name}</span>
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
                            <span className="block truncate text-xs font-semibold tabular-nums text-slate-700">
                              v{v.version}
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
        </div>

        {/* 底部操作按钮 */}
        <div data-tour="uc-actions" className="mt-3 flex flex-col gap-2">
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
          <div className="flex items-center gap-2">
            <a
              href={selVersion?.url || state?.releaseUrl || '#'}
              target="_blank"
              rel="noreferrer"
              aria-disabled={!selVersion}
              onClick={(e) => {
                if (!selVersion) e.preventDefault();
              }}
              className={cn(
                'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-sm font-medium text-teal-700 transition-colors',
                'hover:bg-white/40 active:scale-[0.99]',
                !selVersion && 'pointer-events-none opacity-50',
              )}
            >
              <Download className="h-4 w-4" />
              {t('uc.gotoGithub')}
            </a>
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
                'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-sm font-medium text-teal-700 transition-colors',
                'hover:bg-white/40 active:scale-[0.99]',
                (!selVersion || installActive || !onlineSupported) && 'pointer-events-none opacity-50',
              )}
            >
              {installActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DownloadCloud className="h-4 w-4" />
              )}
              {t('uc.installThis')}
            </button>
          </div>

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
          'relative shrink-0 rounded-md bg-primary/12 font-semibold tabular-nums text-primary',
          'transition-colors hover:bg-primary/20 active:scale-95',
          large ? 'px-2 py-0.5 text-xs' : 'px-1.5 py-px text-[10px]',
        )}
      >
        v{display}
        {hasUpdate ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex items-center rounded-full bg-rose-500 px-1 py-px text-[8px] font-bold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.7)]">
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
