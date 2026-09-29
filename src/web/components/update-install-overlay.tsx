import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Loader2, RotateCw, ShieldAlert } from 'lucide-react';
import { api, type UpdateInstallState } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * 在线更新的「全局层」：与「更新中心」悬浮窗共享同一份安装状态，负责两个不受页面切换影响、
 * 且不能靠点空白关闭的模态：
 *  1) 风险确认弹窗：点「安装此版本」后先弹，需等待 5 秒（精美环形倒计时）才能点确定；
 *  2) 就绪弹窗：下载完成（已暂存）后，无论当前在哪个控制台页面都会弹出，作为最终提示，
 *     只能通过明确的按钮（重启应用 / 撤销 / 我知道了）操作。
 *
 * 轮询只在「有进行中的下载任务」时以 1s 频率运行，任务结束即停；组件挂载时另做一次性探测，
 * 用于页面刷新后恢复「下载中 / 已就绪」状态。避免常驻定时器空转（不占用无谓 CPU）。
 */

/* ----------------------------- 共享状态（模块单例） ----------------------------- */

let installState: UpdateInstallState | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

type RiskState = { open: boolean; tag: string; version: string; mirrorId: string | null };
let risk: RiskState = { open: false, tag: '', version: '', mirrorId: null };

/** 就绪弹窗「本次会话隐藏」标记；出现新的待应用版本时自动复位 */
let stagedHidden = false;
let lastPendingTag = '';

/** 是否处于「已请求重启、正在等待服务恢复」阶段（全局，覆盖所有页面） */
let restarting = false;
let restartWatchStarted = false;

const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}

function isActive(s: UpdateInstallState | null): boolean {
  if (!s) return false;
  return (
    s.inflight ||
    s.job?.phase === 'downloading' ||
    s.job?.phase === 'verifying' ||
    s.job?.phase === 'resolving'
  );
}

function managePolling() {
  if (isActive(installState)) {
    if (!pollTimer) {
      pollTimer = setInterval(() => {
        void refreshInstall();
      }, 1000);
    }
  } else if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

export async function refreshInstall(): Promise<UpdateInstallState | null> {
  try {
    const s = await api.updateInstallState();
    installState = s;
    const pendingTag = s.pending?.tag || '';
    if (pendingTag && pendingTag !== lastPendingTag) {
      // 出现新的待应用版本：复位「本次隐藏」，确保就绪弹窗会再弹
      stagedHidden = false;
    }
    lastPendingTag = pendingTag;
    managePolling();
    emit();
    return s;
  } catch {
    return null;
  }
}

/** 由「更新中心」按钮调用：打开风险确认弹窗（不立即下载） */
export function openInstallRisk(tag: string, version: string, mirrorId: string | null): void {
  risk = { open: true, tag, version, mirrorId };
  emit();
}

function closeRisk() {
  risk = { ...risk, open: false };
  emit();
}

/** 风险确认通过：真正开始下载并暂存 */
async function confirmRiskAndInstall() {
  const { tag, version, mirrorId } = risk;
  closeRisk();
  try {
    installState = await api.updateInstall(tag, mirrorId);
    managePolling();
    emit();
    toast.success(`开始下载 v${version}`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : '无法开始安装');
  }
}

export async function cancelInstall(): Promise<void> {
  try {
    installState = await api.updateInstallCancel();
    managePolling();
    emit();
  } catch {
    /* ignore */
  }
}

function hideStaged() {
  stagedHidden = true;
  emit();
}

/* --------------------- 重启 → 等待服务恢复 → 强制刷新 --------------------- */

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/** 探测后端是否在线：任何 HTTP 响应（含 401/404/405）都算在线；网络错误/超时算离线 */
async function pingServerUp(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    await fetch(`/?_kkhb=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

/** 清理浏览器侧缓存（若有 Service Worker / Cache Storage），配合硬刷新彻底释放旧资源 */
async function clearClientCaches(): Promise<void> {
  try {
    if (typeof caches !== 'undefined') {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* ignore */
  }
}

/**
 * 监听「下线 → 重新在线」的完整过程，确认重启真正完成后，硬刷新整页。
 * - 后端约 800ms 后才退出，先等它真的下线，避免把「退出前仍在线」误判为已恢复；
 * - 低配设备源码版需重建，可能耗时 2–5 分钟，故最长等待放宽到 12 分钟；
 * - location.reload() 会丢弃当前 SPA 的整个 JS 堆与状态，等于释放/清理内存。
 */
async function watchRestartThenReload(): Promise<void> {
  if (restartWatchStarted) return;
  restartWatchStarted = true;
  const startedAt = Date.now();
  const MAX_WAIT = 12 * 60 * 1000;
  let sawDown = false;
  // 后端约 800ms 后才退出；等到 ~1.5s 时它应已下线，从这里开始探测能稳定捕捉「下线」窗口
  await sleep(1500);
  while (Date.now() - startedAt < MAX_WAIT) {
    const up = await pingServerUp();
    if (!up) sawDown = true;
    else if (sawDown) break; // 经历「下线 → 重新在线」= 重启完成
    await sleep(1000);
  }
  await clearClientCaches();
  window.location.reload();
}

export function useRestarting(): boolean {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return restarting;
}

/* ------------------------------- React 绑定 ------------------------------- */

export function useInstallState(): UpdateInstallState | null {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return installState;
}

function useRisk(): RiskState {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
  return risk;
}

/* ------------------------------ 环形倒计时（5s） ------------------------------ */

const COUNTDOWN_MS = 5000;

function CountdownRing({ onReady }: { onReady: () => void }) {
  const [remaining, setRemaining] = useState(COUNTDOWN_MS);

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    let done = false;
    const tick = (now: number) => {
      const left = Math.max(0, COUNTDOWN_MS - (now - start));
      setRemaining(left);
      if (left <= 0) {
        if (!done) {
          done = true;
          onReady();
        }
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // 只在挂载时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const R = 52;
  const C = 2 * Math.PI * R;
  const frac = remaining / COUNTDOWN_MS; // 1 → 0
  const offset = C * (1 - frac); // 环随时间收缩
  const seconds = Math.ceil(remaining / 1000);
  const ready = remaining <= 0;

  return (
    <div className="relative mx-auto grid h-36 w-36 place-items-center">
      {/* 柔和光晕 */}
      <div
        className={cn(
          'absolute inset-2 rounded-full blur-2xl transition-opacity duration-700',
          ready ? 'bg-emerald-400/40 opacity-90' : 'bg-teal-400/25 opacity-70',
        )}
      />
      <svg viewBox="0 0 120 120" className="absolute inset-0 h-full w-full -rotate-90">
        <defs>
          <linearGradient id="kk-count-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#2dd4bf" />
            <stop offset="55%" stopColor="#14b8a6" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        {/* 轨道 */}
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(148,163,184,0.22)" strokeWidth="7" />
        {/* 进度 */}
        <circle
          cx="60"
          cy="60"
          r={R}
          fill="none"
          stroke="url(#kk-count-grad)"
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={C}
          strokeDashoffset={offset}
          style={{
            transition: 'stroke-dashoffset 80ms linear',
            filter: 'drop-shadow(0 0 6px rgba(20,184,166,0.55))',
          }}
        />
      </svg>
      <div className="relative flex flex-col items-center">
        {ready ? (
          <CheckCircle2 className="h-12 w-12 text-emerald-500 kk-count-num" />
        ) : (
          <>
            <span
              key={seconds}
              className="kk-count-num bg-gradient-to-br from-teal-500 to-emerald-500 bg-clip-text text-5xl font-black tabular-nums text-transparent"
            >
              {seconds}
            </span>
            <span className="mt-0.5 text-[10px] font-medium tracking-[0.3em] text-slate-400">
              请仔细阅读
            </span>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------- 风险确认弹窗 -------------------------------- */

function RiskDialog() {
  const r = useRisk();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (r.open) setReady(false);
  }, [r.open]);

  if (!r.open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[80] grid place-items-center p-4">
      {/* 遮罩：点空白不关闭（无 onClick） */}
      <div className="absolute inset-0 bg-black/25 backdrop-blur-md kk-overlay-in" />
      <div
        role="alertdialog"
        aria-modal="true"
        className="kk-glass-2 kk-modal-in relative z-[81] w-full max-w-md rounded-2xl p-6 shadow-[0_16px_48px_rgba(0,0,0,0.16)]"
      >
        <div className="mb-2 flex items-center justify-center gap-2 text-amber-600">
          <ShieldAlert className="h-5 w-5" />
          <h2 className="text-base font-bold text-slate-800">安装前风险提示</h2>
        </div>

        <CountdownRing onReady={() => setReady(true)} />

        <div className="mt-4 rounded-xl border border-amber-300/40 bg-amber-500/10 p-3 text-[12px] leading-relaxed text-slate-700">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5" />
            即将下载并安装 <span className="tabular-nums">v{r.version}</span>，请知悉：
          </div>
          <ul className="ml-4 list-disc space-y-1 text-slate-600">
            <li>安装会替换程序文件；点击「重启」后将中断服务并重新启动，期间控制台会短暂离线。</li>
            <li>源码版重启需重新构建，配置较低的设备可能需要 <span className="font-semibold text-amber-700">2–5 分钟</span>，请耐心等待，其间勿断电或关闭窗口。</li>
            <li>data / 日志 / 插件 等数据目录会被保留；新版已移除的多余文件会被清理，建议提前备份重要数据。</li>
            <li>若当前启动方式不支持自动重启，需下载完成后手动重启才会生效。</li>
          </ul>
        </div>

        <div className="mt-5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => closeRisk()}
            className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-white/40 bg-white/25 text-sm font-medium text-slate-600 transition-colors hover:bg-white/40 active:scale-[0.98]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={!ready}
            onClick={() => void confirmRiskAndInstall()}
            className={cn(
              'inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-semibold text-white transition-all',
              ready
                ? 'bg-gradient-to-r from-teal-500 to-emerald-500 shadow-lg shadow-emerald-500/30 hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.97]'
                : 'cursor-not-allowed bg-slate-300/70',
            )}
          >
            {ready ? '我已知悉，开始安装' : '请阅读须知…'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* --------------------------------- 就绪弹窗 --------------------------------- */

function StagedDialog() {
  const state = useInstallState();
  const r = useRisk();
  const busy = useRestarting();

  const pending = state?.pending || null;
  const active = isActive(state);
  // 风险弹窗打开、正在下载、本次已隐藏、没有待应用项、或已在重启中时都不弹
  const show = !!pending && !active && !stagedHidden && !r.open && !restarting;

  if (!show || !pending) return null;

  const canRestart = !!state?.canRestart;

  const doRestart = async () => {
    try {
      const res = await api.updateRestart();
      if (res.ok) {
        toast.success(res.willApplyUpdate ? '正在应用更新并重启…' : '正在重启…');
        // 进入全局「重启中」：显示等待遮罩，并监听服务恢复后强制刷新
        restarting = true;
        emit();
        void watchRestartThenReload();
      } else {
        toast.error(res.message || '当前启动方式不支持自动重启');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重启请求失败');
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[75] grid place-items-center p-4">
      {/* 遮罩：点空白不关闭 */}
      <div className="absolute inset-0 bg-black/25 backdrop-blur-md kk-overlay-in" />
      <div
        role="alertdialog"
        aria-modal="true"
        className="kk-glass-2 kk-modal-in relative z-[76] w-full max-w-md rounded-2xl p-6 shadow-[0_16px_48px_rgba(0,0,0,0.16)]"
      >
        <div className="mb-3 flex flex-col items-center text-center">
          <div className="mb-2 grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15">
            <CheckCircle2 className="h-8 w-8 text-emerald-500" />
          </div>
          <h2 className="text-base font-bold text-slate-800">
            新版本 v{pending.version} 已下载就绪
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {canRestart
              ? '点击「重启」应用更新。重启期间控制台会短暂离线，配置较低的设备可能需要 2–5 分钟，完成后本页将自动刷新，请勿关闭。'
              : state?.launchNote || '当前启动方式不支持自动重启，请手动重启进程后新版本生效。'}
          </p>
        </div>

        {canRestart ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void cancelInstall()}
              disabled={busy}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-white/40 bg-white/25 text-sm font-medium text-slate-600 transition-colors hover:bg-white/40 active:scale-[0.98] disabled:opacity-60"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void doRestart()}
              disabled={busy}
              className="inline-flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition-all hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.97] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              重启
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void cancelInstall()}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-white/40 bg-white/25 text-sm font-medium text-slate-600 transition-colors hover:bg-white/40 active:scale-[0.98]"
            >
              撤销安装
            </button>
            <button
              type="button"
              onClick={() => hideStaged()}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition-all hover:-translate-y-0.5 active:scale-[0.97]"
            >
              我知道了
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------- 重启等待遮罩 ------------------------------- */

function RestartingOverlay() {
  const busy = useRestarting();
  if (!busy) return null;

  return createPortal(
    <div className="fixed inset-0 z-[90] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-md kk-overlay-in" />
      <div
        role="alertdialog"
        aria-modal="true"
        className="kk-glass-2 kk-modal-in relative z-[91] w-full max-w-sm rounded-2xl p-7 text-center shadow-[0_16px_48px_rgba(0,0,0,0.18)]"
      >
        <div className="mx-auto mb-4 grid h-16 w-16 place-items-center rounded-full bg-teal-500/12">
          <Loader2 className="h-9 w-9 animate-spin text-teal-500" />
        </div>
        <h2 className="text-base font-bold text-slate-800">正在重启并应用更新…</h2>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          控制台已断开连接。配置较低的设备重建可能需要 <span className="font-semibold text-teal-700">2–5 分钟</span>，
          请保持本页开启——服务恢复后将自动刷新并重新登录。
        </p>
      </div>
    </div>,
    document.body,
  );
}

/* -------------------------------- 对外主组件 -------------------------------- */

export function UpdateInstallOverlay() {
  useEffect(() => {
    // 挂载时一次性探测：恢复刷新页面前的「下载中 / 已就绪」状态
    void refreshInstall();
  }, []);

  return (
    <>
      <RiskDialog />
      <StagedDialog />
      <RestartingOverlay />
    </>
  );
}
