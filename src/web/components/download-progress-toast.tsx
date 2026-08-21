import { Check, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export type DownloadToastPhase = 'running' | 'done' | 'error';

/**
 * 圆角描边进度：conic-gradient 贴合 rounded-2xl，
 * 运行中彩虹色持续旋转渐变；完成/失败用对应色相。
 * （用时间戳算旋转角，避免 toast 重绘重置动画）
 */
function PerimeterProgress({
  progress,
  phase,
}: {
  progress: number;
  phase: DownloadToastPhase;
}) {
  const p = Math.max(0, Math.min(100, progress));
  const endDeg = p * 3.6;
  // ~18°/s
  const spin = phase === 'running' ? ((Date.now() / 1000) * 18) % 360 : 0;

  const gradient =
    phase === 'error'
      ? `conic-gradient(from ${spin - 90}deg, #fecdd3, #fb7185, #e11d48, #9f1239, #fecdd3 ${endDeg}deg, transparent ${endDeg}deg)`
      : phase === 'done'
        ? `conic-gradient(from -90deg, #6ee7b7, #34d399, #10b981, #059669, #6ee7b7)`
        : `conic-gradient(from ${spin - 90}deg, #f43f5e, #f97316, #eab308, #22c55e, #14b8a6, #3b82f6, #8b5cf6, #ec4899, #f43f5e ${endDeg}deg, transparent ${endDeg}deg)`;

  return (
    <>
      <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-slate-200/80" />
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl"
        style={{
          padding: 2.5,
          background: gradient,
          WebkitMask:
            'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          maskComposite: 'exclude',
        }}
      />
    </>
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
    <div
      className={cn(
        'relative kk-glass min-w-[min(92vw,20rem)] overflow-hidden rounded-2xl px-4 py-3.5',
        phase === 'done' && 'bg-emerald-50/70',
        phase === 'error' && 'bg-rose-50/70',
      )}
    >
      <PerimeterProgress progress={progress} phase={phase} />
      <div className="relative z-[1] flex items-center gap-3">
        <span
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            phase === 'done' && 'bg-emerald-500 text-white',
            phase === 'error' && 'bg-rose-500 text-white',
            phase === 'running' && 'bg-teal-500/15 text-teal-700',
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
              'truncate text-sm font-medium',
              phase === 'done' && 'text-emerald-800',
              phase === 'error' && 'text-rose-800',
              phase === 'running' && 'text-slate-800',
            )}
          >
            {label}
          </p>
          {phase === 'running' ? (
            <p className="mt-0.5 text-xs tabular-nums text-slate-500">
              下载中 · {pct}%
            </p>
          ) : detail ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{detail}</p>
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
