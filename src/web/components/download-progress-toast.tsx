import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export type DownloadToastPhase = 'running' | 'done' | 'error';

/**
 * 海水波浪进度：水位随进度上涨，两层波峰横向无缝流动。
 * - 运行中水色跟随外观「组件及按钮」色（--kk-comp-*），随主题实时变化；
 * - 完成 / 失败用语义色（绿 / 红）铺满，一眼看出结果。
 * 动画走 CSS（.kk-wave-strip），toast 重绘不会打断波形。
 */
function WaveProgress({
  progress,
  phase,
}: {
  progress: number;
  phase: DownloadToastPhase;
}) {
  const p = Math.max(0, Math.min(100, progress));
  // 完成 / 失败铺满；运行中按真实进度涨水
  const level = phase === 'running' ? p : 100;

  const fill =
    phase === 'done'
      ? { a: 'rgba(16, 185, 129, 0.55)', b: 'rgba(52, 211, 153, 0.4)' }
      : phase === 'error'
        ? { a: 'rgba(244, 63, 94, 0.5)', b: 'rgba(251, 113, 133, 0.38)' }
        : { a: 'rgb(var(--kk-comp-rgb) / 0.5)', b: 'rgb(var(--kk-comp-soft-rgb) / 0.42)' };

  // viewBox 0 0 240 24：一段含两个完整周期，填充到底，配合 200% 宽度无缝循环
  const wavePath =
    'M0 10 C 20 2 40 2 60 10 S 100 18 120 10 S 160 2 180 10 S 220 18 240 10 V24 H0 Z';

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl">
      {/* 水体 */}
      <div
        className="absolute inset-x-0 bottom-0 transition-[height] duration-300 ease-out"
        style={{ height: `${level}%`, background: `linear-gradient(180deg, ${fill.a}, ${fill.b})` }}
      />
      {/* 波峰（前后两层错峰），坐标随水位上移 */}
      <div
        className="absolute inset-x-0 h-3.5 transition-[bottom] duration-300 ease-out"
        style={{ bottom: `${level}%` }}
      >
        <svg className="kk-wave-strip kk-wave-strip-back" viewBox="0 0 240 24" preserveAspectRatio="none">
          <path d={wavePath} fill={fill.b} />
        </svg>
        <svg className="kk-wave-strip" viewBox="0 0 240 24" preserveAspectRatio="none">
          <path d={wavePath} fill={fill.a} />
        </svg>
      </div>
    </div>
  );
}

export function DownloadBorderToast({
  label,
  progress,
  phase,
  detail,
}: {
  label: string;
  progress: number;
  phase: DownloadToastPhase;
  detail?: string;
}) {
  const pct = Math.round(Math.max(0, Math.min(100, progress)));

  return (
    <div className="relative kk-glass-2 kk-download-toast min-w-[min(92vw,20rem)] overflow-hidden rounded-2xl px-4 py-3.5">
      <WaveProgress progress={progress} phase={phase} />
      <div className="relative z-[1] flex items-center gap-3">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            phase === 'done' && 'bg-emerald-500 text-white',
            phase === 'error' && 'bg-rose-500 text-white',
            phase === 'running' && 'bg-white/40 text-slate-700 backdrop-blur-sm',
          )}
        >
          {phase === 'running' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : phase === 'done' ? (
            <Check className="h-4 w-4" strokeWidth={2.5} />
          ) : (
            <X className="h-4 w-4" strokeWidth={2.5} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-sm font-medium text-slate-800',
              phase === 'done' && 'text-emerald-900',
              phase === 'error' && 'text-rose-900',
            )}
          >
            {label}
          </p>
          {phase === 'running' ? (
            <p className="mt-0.5 text-xs tabular-nums text-slate-600">
              下载中 · {pct}%
            </p>
          ) : detail ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{detail}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

type LiveState = {
  label: string;
  progress: number;
  phase: DownloadToastPhase;
  detail?: string;
};

/**
 * 带描边进度的下载 toast。
 * 请求进行中用缓动逼近 90%；结束后动画到 100% 并显示「下载完成」。
 */
export async function runWithDownloadProgressToast<T>(opts: {
  /** 进行中标题，如「名称 v1.0」 */
  runningLabel: string;
  task: () => Promise<T>;
  isOk: (result: T) => boolean;
  errorMessage?: (result: T) => string;
}): Promise<T> {
  const toastId = `resource-dl-${Date.now()}`;
  const state: LiveState = {
    label: opts.runningLabel,
    progress: 0,
    phase: 'running',
  };

  const paint = () => {
    toast.custom(
      () => (
        <DownloadBorderToast
          label={state.label}
          progress={state.progress}
          phase={state.phase}
          detail={state.detail}
        />
      ),
      {
        id: toastId,
        duration: Infinity,
        unstyled: true,
        className: '!bg-transparent !border-0 !shadow-none !p-0',
      },
    );
  };

  paint();
  const started = performance.now();
  const timer = window.setInterval(() => {
    if (state.phase !== 'running') return;
    const t = (performance.now() - started) / 1000;
    // 指数逼近 90%，越久越慢，避免假进度到顶
    state.progress = Math.min(90, 90 * (1 - Math.exp(-t / 3.2)));
    paint();
  }, 40);

  const animateTo = (target: number, ms: number) =>
    new Promise<void>((resolve) => {
      const from = state.progress;
      const t0 = performance.now();
      const step = (now: number) => {
        const u = Math.min(1, (now - t0) / ms);
        const ease = 1 - (1 - u) ** 2;
        state.progress = from + (target - from) * ease;
        paint();
        if (u < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

  try {
    const result = await opts.task();
    window.clearInterval(timer);

    if (opts.isOk(result)) {
      state.phase = 'done';
      state.label = '下载完成';
      state.detail = undefined;
      await animateTo(100, 280);
      window.setTimeout(() => toast.dismiss(toastId), 1600);
    } else {
      state.phase = 'error';
      state.label = opts.errorMessage?.(result) || '下载失败';
      state.detail = undefined;
      await animateTo(100, 200);
      window.setTimeout(() => toast.dismiss(toastId), 2800);
    }
    return result;
  } catch (e) {
    window.clearInterval(timer);
    state.phase = 'error';
    state.label = e instanceof Error ? e.message : String(e);
    await animateTo(Math.max(state.progress, 100), 200);
    window.setTimeout(() => toast.dismiss(toastId), 3200);
    throw e;
  }
}
