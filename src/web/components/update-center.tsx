import {
  useCallback,
  useEffect,
  useId,
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
  RotateCw,
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
  showStagedPrompt,
} from '@/components/update-install-overlay';

/**
 * 更新中心：侧栏版本号徽标 / 侧栏收起时的顶栏图标 + 悬浮窗
 * （标题/状态（含目标版本）→ 主操作 → 高级）。
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

/**
 * 登出复位：只清用户态（拉到的更新状态、版本选择、自动检查标记），
 * 不动镜像偏好（localStorage）与轮询句柄——更新功能本身不受影响。
 */
export function resetUpdateCenterState(): void {
  shared = null;
  autoStarted = false;
  pingMode = null;
  pingIds = [];
  selectedVersionTag = '';
  emit();
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
 * 通道标签配色：BETA（琥珀）/ RC（紫）/ ALPHA（玫红）。
 * 正式版是默认状态，不再每行挂一个 LTS —— 只有预发布才需要提醒；
 * 这样版本行里不会出现两个小标签占位，也不会把「LTS」和「稳定版」混用。
 */
const CHANNEL_META: Record<UpdateChannel, { label: string; titleKey: string; className: string }> = {
  stable: { label: 'LTS', titleKey: 'uc.channelStable', className: 'bg-emerald-500/15 text-emerald-700' },
  beta: { label: 'BETA', titleKey: 'uc.channelBeta', className: 'bg-amber-500/15 text-amber-700' },
  rc: { label: 'RC', titleKey: 'uc.channelRc', className: 'bg-violet-500/15 text-violet-700' },
  alpha: { label: 'ALPHA', titleKey: 'uc.channelAlpha', className: 'bg-rose-500/15 text-rose-700' },
  unknown: { label: 'PRE', titleKey: 'uc.channelUnknown', className: 'bg-slate-500/15 text-slate-600' },
};

function channelMeta(channel: UpdateChannel) {
  // 兜底不能是 stable：认不出的通道宁可显示 PRE，也不能伪装成 LTS
  return CHANNEL_META[channel] ?? CHANNEL_META.unknown;
}

/** 正式版不打标签：没有标签就是正式版，BETA / RC / ALPHA 才需要提醒 */
function ChannelTag({ channel, className }: { channel: UpdateChannel; className?: string }) {
  const t = useT();
  if (channel === 'stable') return null;
  const meta = channelMeta(channel);
  return (
    <span
      title={t(meta.titleKey)}
      className={cn(
        'inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide',
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

/**
 * 「窗中窗」：镜像/版本选择展开的浮层。z 轴在主悬浮窗之上，各自独立关闭。
 * width 省略时与触发器同宽（镜像选择）；给数字时用固定宽度（版本列表），
 * 这样从一个小文字链接打开也有足够宽的列表。
 */
function NestedPanel({
  anchor,
  onClose,
  width,
  label,
  children,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  width?: number;
  label?: string;
  children: ReactNode;
}) {
  const t = useT();
  const pos = useAnchoredPos(anchor, width ? { fixedWidth: width } : { matchWidth: true });
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    panelRef.current?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return createPortal(
    <>
      <button
        type="button"
        aria-label={t('btn.close')}
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-[70] cursor-default bg-transparent"
      />
      <div
        ref={panelRef}
        role="listbox"
        aria-label={label}
        tabIndex={-1}
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 'min(50dvh, 22rem)' }}
        className={cn(PANEL_BASE, 'z-[71] p-1.5 outline-none')}
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
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => ref.current?.focus({ preventScroll: true }));
  }, []);

  return (
    <>
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 rounded-xl border border-white/40 bg-white/20 px-3 py-2 text-left transition-colors',
          'hover:bg-white/35 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60',
        )}
      >
        <span className="shrink-0 text-[12px] font-semibold text-slate-600">{label}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">{valueNode}</span>
        <ChevronDown
          className={cn('h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && ref.current ? (
        <NestedPanel anchor={ref.current} onClose={close} label={label}>
          {children(close)}
        </NestedPanel>
      ) : null}
    </>
  );
}

/** 版本选择浮层：从比较行的目标版本号、或底部「选择其他版本」打开 */
function VersionPicker({
  anchor,
  versions,
  current,
  selectedTag,
  onSelect,
  onClose,
}: {
  anchor: HTMLElement;
  versions: UpdateVersionInfo[];
  current: string;
  selectedTag: string;
  onSelect: (tag: string) => void;
  onClose: () => void;
}) {
  const t = useT();

  return (
    <NestedPanel anchor={anchor} onClose={onClose} width={300} label={t('uc.installVersion')}>
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-semibold text-slate-500">
        {t('uc.installVersion')}
      </div>
      {versions.length === 0 ? (
        <p className="px-2.5 py-3 text-center text-xs text-slate-500">{t('uc.noVersionHint')}</p>
      ) : (
        <div className="flex flex-col gap-1">
          {versions.map((v) => {
            const active = v.tag === selectedTag;
            return (
              <div key={v.tag}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => onSelect(v.tag)}
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
                      <span
                        title={`v${v.version}`}
                        className="min-w-0 break-all text-xs font-semibold tabular-nums text-slate-700"
                      >
                        v{v.version}
                      </span>
                      <ChannelTag channel={v.channel} />
                      {compareReleaseVersions(v.version, current) === 0 ? (
                        <span className="shrink-0 rounded bg-white/45 px-1 py-px text-[10px] font-semibold leading-none text-slate-600">
                          {t('uc.currentBadge')}
                        </span>
                      ) : null}
                    </span>
                    {v.name && v.name !== v.tag ? (
                      <span className="block truncate text-[11px] text-slate-500">{v.name}</span>
                    ) : null}
                  </span>
                  {fmtDate(v.publishedAt) ? (
                    <span className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-slate-500">
                      {fmtDate(v.publishedAt)}
                    </span>
                  ) : null}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </NestedPanel>
  );
}

/** 下载进度的字节数：只在安装进度块里用，避免为一个格式化再拉依赖 */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/* ---------------- 主悬浮窗 ---------------- */

/* ---------- 版本比较（与后端 compareReleaseVersions 同规则） ---------- */

const CHANNEL_RANK: Record<string, number> = { stable: 4, rc: 3, beta: 2, unknown: 2, alpha: 1 };

function parseReleaseInfo(version: string): { core: number[]; rank: number; preNum: number } {
  const raw = String(version || '').trim().replace(/^v/i, '').toLowerCase();
  const coreText = /^\d+(?:\.\d+)*/.exec(raw)?.[0] ?? '';
  const core = coreText ? coreText.split('.').map((n) => parseInt(n, 10) || 0) : [];
  const after = raw.slice(coreText.length);
  const ch = /(?:^|[.\-_+]|\d)(alpha|beta|rc)(?:[.\-_+]?(\d+))?/.exec(raw);
  let rank = 4;
  let preNum = 0;
  if (ch) {
    rank = ch[1] === 'alpha' ? 1 : ch[1] === 'rc' ? 3 : 2;
    preNum = ch[2] ? parseInt(ch[2], 10) || 0 : 0;
  } else {
    // 核心后还挂着字母 token：未知预发布（bata.2 / preview.3），按 beta 一档比
    const token = /^[.\-_+]*([a-z][a-z0-9]*)/.exec(after)?.[1] ?? '';
    if (token) {
      rank = 2;
      preNum = parseInt(/[.\-_+][a-z][a-z0-9]*[.\-_+]?(\d+)/.exec(after)?.[1] ?? '', 10) || 0;
    }
  }
  return { core, rank, preNum };
}

/** 发行版比较：数字核心逐段 → 通道权重（正式 > rc > beta/未知 > alpha）→ 预发布序号。>0 = a 更新 */
function compareReleaseVersions(a: string, b: string): number {
  const pa = parseReleaseInfo(a);
  const pb = parseReleaseInfo(b);
  const len = Math.max(pa.core.length, pb.core.length);
  for (let i = 0; i < len; i++) {
    const d = (pa.core[i] || 0) - (pb.core[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  if (pa.rank !== pb.rank) return pa.rank > pb.rank ? 1 : -1;
  if (pa.rank !== 4 && pa.preNum !== pb.preNum) return pa.preNum > pb.preNum ? 1 : -1;
  return 0;
}

function UpdatePopover({
  anchor,
  onClose,
  state,
  popoverId,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  state: UpdateStateResp | null;
  popoverId: string;
}) {
  const t = useT();
  const pos = useAnchoredPos(anchor, { centerMobile: true });
  const panelRef = useRef<HTMLDivElement>(null);

  // 打开后把焦点移进面板：否则键盘用户要沿整页 Tab 到文档末尾的 portal 才能进来
  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, []);

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

  /** 默认目标：远端最新版 → 当前通道稳定版 → 列表第一个 */
  const defaultVersion: UpdateVersionInfo | null =
    versions.find((v) => v.version === remote) ||
    versions.find((v) => v.channel === 'stable') ||
    versions[0] ||
    null;

  const selVersion: UpdateVersionInfo | null =
    versions.find((v) => v.tag === selectedVersionTag) || defaultVersion;

  const explicitVersion = versions.some((v) => v.tag === selectedVersionTag);
  const isCustomTarget = !!explicitVersion && !!selVersion && selVersion.tag !== (defaultVersion?.tag || '');
  /*
   * 选中版本与当前版本的真实关系（>0 升级 / 0 同版 / <0 降级）。
   * 用值比较而不是列表下标 + 字符串全等：当前版本不在列表里（本地构建比已发布的新、
   * 列表被截断）时，下标法找不到当前版本，会把降级误判成「安装此版本」。
   */
  const relToCurrent = selVersion && current ? compareReleaseVersions(selVersion.version, current) : null;
  const isReinstall = relToCurrent === 0;
  const isDowngrade = relToCurrent !== null && relToCurrent < 0;

  const targetDate = fmtDate(selVersion?.publishedAt || '');
  const showDelta = !!selVersion && (hasUpdate || isCustomTarget);
  const showInstall = !!selVersion && (hasUpdate || explicitVersion);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pickerAnchor, setPickerAnchor] = useState<HTMLElement | null>(null);

  const closePicker = useCallback(() => {
    const el = pickerAnchor;
    setPickerAnchor(null);
    requestAnimationFrame(() => el?.focus({ preventScroll: true }));
  }, [pickerAnchor]);

  const pickVersion = useCallback(
    (tag: string) => {
      setSelectedVersion(tag);
      closePicker();
    },
    [closePicker],
  );

  const resetTarget = useCallback(() => {
    setSelectedVersion('');
  }, []);

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
    openInstallRisk(selVersion.tag, selVersion.version, effectiveSelected || null, selVersion.channel);
  }, [selVersion, effectiveSelected]);

  const doCancelInstall = useCallback(async () => {
    await cancelInstall();
    toast(t('uc.cancelled'));
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

  // 有新版本用主色（预发布用琥珀），红色只留给「连不上」这类错误
  const statusDot = hasUpdate
    ? remoteChannel === 'stable'
      ? 'bg-teal-500'
      : 'bg-amber-500'
    : status === 'latest'
      ? 'bg-emerald-500'
      : status === 'unreachable'
        ? 'bg-rose-500'
        : 'bg-slate-300';

  // 只提醒「从别的通道切到预发布」：当前就在 beta/rc 上追同通道更新时不再重复警示；
  // 另外 no-update + 未显式选版本时 selVersion 只是当前版本，不该弹「你选了预发布」。
  const selectedPrerelease =
    !!selVersion &&
    selVersion.channel !== 'stable' &&
    selVersion.channel !== currentChannel &&
    (hasUpdate || explicitVersion);
  const prereleaseInfo = versions.find((v) => v.tag === latestPrereleaseTag) || null;
  const releaseHref = selVersion?.url || state?.releaseUrl || '';
  const lastChecked = lastCheckedText(state, t);

  /** 重新检查：走手动 ping（绕过后端 10 分钟 TTL），状态/版本列表一起刷新 */
  const doRefresh = useCallback(async () => {
    if (pingMode || status === 'checking') return;
    await runPingAll();
    const r = shared;
    if (r && !r.mirrors.some((m) => m.reachable)) toast.error(t('uc.pingAllDown'));
  }, [status, t]);

  const installLabel = installActive
    ? t('uc.processing')
    : isReinstall
      ? t('uc.reinstall')
      : isDowngrade
        ? t('uc.installDowngrade')
        : hasUpdate && selVersion?.version === remote
          ? t('uc.installUpdate')
          : t('uc.installThis');

  const bytesText = installJob && (installJob.totalBytes > 0 || installJob.receivedBytes > 0)
    ? installJob.totalBytes > 0
      ? `${fmtBytes(installJob.receivedBytes)} / ${fmtBytes(installJob.totalBytes)}`
      : fmtBytes(installJob.receivedBytes)
    : '';

  return createPortal(
    <>
      <button
        type="button"
        aria-label={t('btn.close')}
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-[60] cursor-default bg-transparent"
      />
      <div
        ref={panelRef}
        id={popoverId}
        role="dialog"
        aria-label={t('uc.title')}
        tabIndex={-1}
        style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: 'min(80dvh, 40rem)' }}
        className={cn(PANEL_BASE, 'kk-update-surface z-[61] p-4 outline-none')}
      >
        {/* 顶部：标题 + 上次检查 + 状态 + 版本对比 */}
        <div data-tour="uc-header" className="mb-3">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-teal-500/15">
              <DownloadCloud className="h-4 w-4 text-teal-600" />
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <h3 className="truncate text-sm font-bold text-slate-800">{t('uc.title')}</h3>
              <div className="truncate text-[11px] tabular-nums text-slate-500">{lastChecked}</div>
            </div>
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
          </div>

          <div className="mt-3 flex min-w-0 items-center gap-2">
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-teal-600" />
            ) : (
              <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDot)} />
            )}
            <p aria-live="polite" className="shrink-0 text-[15px] font-bold leading-tight text-slate-800">
              {statusText}
            </p>
            {!hasUpdate && !isCustomTarget && current ? (
              <div className="ml-auto flex min-w-0 max-w-[55%] items-center gap-1.5 text-sm tabular-nums">
                <span title={`v${current}`} className="min-w-0 break-all text-right font-semibold text-slate-700">
                  v{current}
                </span>
                <ChannelTag channel={currentChannel} />
              </div>
            ) : null}
          </div>

          {showDelta && selVersion ? (
            <div className="mt-1 min-w-0 text-sm tabular-nums">
              {/* 两行显示：版本号标识是判断更新的核心，宁可换行，不截断预发布后缀 */}
              <div className="flex min-w-0 items-center gap-1.5">
                <span
                  title={`v${current || '—'}`}
                  className={cn(
                    'min-w-0 break-all font-semibold',
                    isReinstall ? 'text-slate-700' : 'text-slate-500 line-through decoration-slate-300',
                  )}
                >
                  v{current || '—'}
                </span>
                <ChannelTag channel={currentChannel} />
              </div>
              <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                <span className="shrink-0 text-slate-400">→</span>
                <button
                  type="button"
                  onClick={(e) => setPickerAnchor(e.currentTarget)}
                  aria-haspopup="listbox"
                  aria-expanded={!!pickerAnchor}
                  title={`v${selVersion.version} · ${t('uc.chooseVersion')}`}
                  className="-mx-1 inline-flex min-w-0 max-w-full items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:bg-white/40 active:scale-[0.98]"
                >
                  <span className={cn('min-w-0 break-all font-bold', isDowngrade ? 'text-amber-700' : 'text-teal-700')}>
                    v{selVersion.version}
                  </span>
                  <ChannelTag channel={selVersion.channel} />
                  <ChevronDown className="h-3 w-3 shrink-0 text-slate-400" />
                </button>
                {isCustomTarget && !isReinstall ? (
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold leading-none',
                      isDowngrade ? 'bg-amber-500/15 text-amber-700' : 'bg-teal-500/15 text-teal-700',
                    )}
                  >
                    {isDowngrade ? t('uc.downgrade') : t('uc.customVersion')}
                  </span>
                ) : null}
                {targetDate ? (
                  <span className="ml-auto shrink-0 text-[11px] tabular-nums text-slate-500">{targetDate}</span>
                ) : null}
              </div>
            </div>
          ) : null}
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
                <span
                  title={t('uc.prereleaseAvailable', { v: latestPrerelease })}
                  className="min-w-0 break-all text-[12px] font-semibold text-amber-800"
                >
                  {t('uc.prereleaseAvailable', { v: latestPrerelease })}
                </span>
                {prereleaseInfo ? <ChannelTag channel={prereleaseInfo.channel} /> : null}
              </div>
              <div className="truncate text-[11px] leading-relaxed text-amber-800/80">
                {t('uc.prereleaseHint')}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelectedVersion(latestPrereleaseTag)}
              className="shrink-0 rounded-md bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-700 transition-colors hover:bg-amber-500/25 active:scale-95"
            >
              {t('uc.prereleaseSelect')}
            </button>
          </div>
        ) : null}

        {/* 主操作：只有「安装」用实心渐变；检查更新是安静的次级按钮 */}
        <div data-tour="uc-actions" className="mt-1 flex flex-col gap-2">
          {staged && !installActive ? (
            <p className="rounded-lg border border-emerald-300/50 bg-emerald-500/10 px-2.5 py-2 text-[12px] font-medium leading-relaxed text-emerald-800">
              {t('uc.stagedReady', { v: install?.pending?.version || installJob?.version || '' })}
            </p>
          ) : null}

          {staged && !installActive ? (
            <button
              type="button"
              onClick={showStagedPrompt}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-semibold text-white shadow-lg kk-glow-emerald transition-all hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98]"
            >
              <RotateCw className="h-4 w-4" />
              {t('uc.viewStagedPrompt')}
            </button>
          ) : showInstall ? (
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
                  ? isDowngrade
                    ? 'border border-amber-500/50 bg-amber-500/15 text-amber-800 hover:bg-amber-500/25 active:scale-[0.98]'
                    : 'bg-gradient-to-r from-teal-500 to-emerald-500 text-white shadow-lg kk-glow-emerald hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.98]'
                  : 'cursor-not-allowed bg-white/30 text-slate-500',
              )}
            >
              {installActive ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <DownloadCloud className="h-4 w-4" />
              )}
              {installLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void doRefresh()}
              disabled={busy}
              aria-busy={busy}
              className={cn(
                'inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border text-sm font-semibold transition-colors',
                busy
                  ? 'cursor-not-allowed border-white/25 bg-white/10 text-slate-400'
                  : 'border-white/40 bg-white/20 text-slate-600 hover:bg-white/35 active:scale-[0.98]',
              )}
            >
              <RefreshCw className={cn('h-4 w-4', busy && 'animate-spin')} />
              {busy ? t('uc.statusChecking') : t('uc.checkUpdate')}
            </button>
          )}

          <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
            {releaseHref ? (
              <a
                href={releaseHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded px-1 py-1 text-[12px] font-medium text-teal-700 transition-colors hover:text-teal-800 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {t('uc.viewRelease')}
              </a>
            ) : null}
            <div data-tour="uc-version" className="inline-flex items-center">
              {isCustomTarget ? (
                <button
                  type="button"
                  onClick={resetTarget}
                  className="inline-flex items-center gap-1 rounded px-1 py-1 text-[12px] font-medium text-teal-700 transition-colors hover:text-teal-800 hover:underline"
                >
                  {t('uc.restoreRecommended')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={versions.length === 0}
                  onClick={(e) => setPickerAnchor(e.currentTarget)}
                  aria-haspopup="listbox"
                  aria-expanded={!!pickerAnchor}
                  title={versions.length === 0 ? t('uc.noVersionData') : t('uc.chooseVersion')}
                  className="inline-flex items-center gap-1 rounded px-1 py-1 text-[12px] font-medium text-slate-600 transition-colors hover:text-slate-800 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {t('uc.chooseVersion')}
                  <ChevronDown className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>

          {/* 在线安装进度 / 出错 / 环境说明 */}
          {installActive && installJob ? (
            <div className="rounded-lg border border-white/40 bg-white/25 p-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] font-medium text-slate-600">
                <span className="truncate">{svcText(installJob.message) || t('uc.processing')}</span>
                <span className="shrink-0 tabular-nums text-teal-700">{installJob.percent}%</span>
              </div>
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.max(0, Math.min(100, installJob.percent))}
                aria-label={t('uc.processing')}
                className="h-1.5 w-full overflow-hidden rounded-full bg-white/40"
              >
                <div
                  className="h-full rounded-full bg-teal-500 transition-[width] duration-300"
                  style={{ width: `${Math.max(2, Math.min(100, installJob.percent))}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] tabular-nums text-slate-500">
                {bytesText ? <span>{bytesText}</span> : <span />}
                <button
                  type="button"
                  onClick={() => void doCancelInstall()}
                  className="rounded px-1 py-0.5 text-[11px] font-medium text-slate-500 underline-offset-2 hover:text-rose-600 hover:underline"
                >
                  {t('uc.cancelDownload')}
                </button>
              </div>
            </div>
          ) : null}

          {installJob?.phase === 'error' && !installActive ? (
            <div className="rounded-lg border border-rose-300/50 bg-rose-500/10 p-2.5 text-[12px] font-medium text-rose-700">
              {svcText(installJob.message) || t('uc.installFailed')}
            </div>
          ) : null}

          {!staged && !installActive && install && install.launchNote && (!onlineSupported || !install.canRestart) ? (
            <p className="text-[11px] leading-relaxed text-amber-700">{install.launchNote}</p>
          ) : null}
        </div>

        {/* 高级：镜像源 / 测速，默认收起，日常更新不用管 */}
        <div className="mt-3 border-t border-white/50 pt-2">
          <button
            type="button"
            data-tour="uc-mirror"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-[12px] font-medium text-slate-500 transition-colors hover:text-slate-800"
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
                  <div className="flex flex-col gap-1">
                    {mirrors.map((m) => {
                      const active = m.id === effectiveSelected;
                      const pinging = isMirrorPinging(m.id);
                      return (
                        <div key={m.id}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
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
                        </div>
                      );
                    })}
                  </div>
                )}
              </FloatingSelect>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void pingAll()}
                  disabled={!!pingMode}
                  className={cn(
                    'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-xs font-medium text-slate-600 transition-colors',
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
                    'inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-white/40 bg-white/25 px-3 text-xs font-medium text-slate-600 transition-colors',
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

      {pickerAnchor ? (
        <VersionPicker
          anchor={pickerAnchor}
          versions={versions}
          current={current}
          selectedTag={selVersion?.tag || ''}
          onSelect={pickVersion}
          onClose={closePicker}
        />
      ) : null}
    </>,
    getPortalRoot(),
  );
}

/* ---------------- 版本号徽标（对外主组件） ---------------- */

/**
 * 更新入口。两种形态：
 * - 默认：侧栏品牌行里的版本号徽标（点击展开更新中心）；
 * - icon：手机/侧栏收起时的顶栏图标，只有下载云 + NEW 点，宽度固定 32px，不与页面操作抢地方。
 */
export function UpdateCenter({
  version,
  large = false,
  icon = false,
}: {
  version: string;
  large?: boolean;
  icon?: boolean;
}) {
  const t = useT();
  const state = useUpdateState();
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  const display = (state?.currentVersion || version || '').trim();
  const hasUpdate = !!state?.hasUpdate;
  // NEW 的颜色跟通道走：正式版红、预发布琥珀，避免把 beta 误看成正式更新
  const newTone = state?.remoteChannel && state.remoteChannel !== 'stable' ? 'bg-amber-600' : 'bg-rose-500';

  const closePopover = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => btnRef.current?.focus({ preventScroll: true }));
  }, []);

  if (!display) return null;

  return (
    <>
      {icon ? (
        <button
          ref={btnRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={`${t('uc.checkUpdate')} · v${display}`}
          aria-label={`${t('uc.checkUpdate')} · v${display}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          className="relative grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-600 transition-colors hover:bg-white/35 hover:text-slate-800 active:scale-95"
        >
          <DownloadCloud className="h-4 w-4" />
          {hasUpdate ? (
            <span
              className={cn(
                'absolute right-1 top-1 h-1.5 w-1.5 rounded-full ring-2 ring-white/80',
                newTone,
              )}
            />
          ) : null}
        </button>
      ) : (
        <button
          ref={btnRef}
          type="button"
          data-tour="update-center"
          onClick={() => setOpen((v) => !v)}
          title={`${t('uc.checkUpdate')} · v${display}`}
          aria-label={`${t('uc.checkUpdate')} · v${display}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
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
                'absolute -right-1.5 -top-1.5 inline-flex items-center rounded-full px-1 py-px text-[9px] font-bold leading-none text-white shadow-[0_0_0_1.5px_rgba(255,255,255,0.7)]',
                newTone,
              )}
            >
              NEW
            </span>
          ) : null}
        </button>
      )}
      {open && btnRef.current ? (
        <UpdatePopover anchor={btnRef.current} onClose={closePopover} state={state} popoverId={popoverId} />
      ) : null}
    </>
  );
}
