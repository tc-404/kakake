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
            <li>安装会替换程序文件，并在你点击重启后中断服务、重新启动进程。</li>
            <li>过程中请勿断电或强制关闭窗口，避免文件损坏。</li>
            <li>你的 data / 日志 / 插件目录会被保留，但仍建议提前备份重要数据。</li>
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
  const [restarting, setRestarting] = useState(false);

  const pending = state?.pending || null;
  const active = isActive(state);
  // 风险弹窗打开、或正在下载、或本次已隐藏、或没有待应用项时不弹
  const show = !!pending && !active && !stagedHidden && !r.open;

  if (!show || !pending) return null;

  const canRestart = !!state?.canRestart;

  const doRestart = async () => {
    setRestarting(true);
    try {
      const res = await api.updateRestart();
      if (res.ok) {
        toast.success(res.willApplyUpdate ? '正在应用更新并重启，请稍候…' : '正在重启，请稍候…');
      } else {
        toast.error(res.message || '当前启动方式不支持自动重启');
        setRestarting(false);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '重启请求失败');
      setRestarting(false);
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
          <p className="mt-1 text-xs text-slate-500">
            {canRestart
              ? '点击下方按钮重启并应用更新；重启期间控制台会短暂断开，稍后自动恢复。'
              : state?.launchNote || '当前启动方式不支持自动重启，请手动重启进程后新版本生效。'}
          </p>
        </div>

        {canRestart ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void cancelInstall()}
              disabled={restarting}
              className="inline-flex h-10 flex-1 items-center justify-center rounded-xl border border-white/40 bg-white/25 text-sm font-medium text-slate-600 transition-colors hover:bg-white/40 active:scale-[0.98] disabled:opacity-60"
            >
              撤销
            </button>
            <button
              type="button"
              onClick={() => void doRestart()}
              disabled={restarting}
              className="inline-flex h-10 flex-[1.4] items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-teal-500 to-emerald-500 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition-all hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.97] disabled:opacity-60"
            >
              {restarting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
              确定重启并应用
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
    </>
  );
}
