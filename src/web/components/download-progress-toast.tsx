import { Check, Download, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { t, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CallChip, type CallChipStatus } from '@/components/call-chip';
import { effectiveBackgroundPreset, getAppearanceSnapshot } from '@/lib/appearance';
import { getDeviceTier } from '@/lib/device-tier';
import { errText } from '@/lib/server-error';

export type DownloadToastPhase = 'running' | 'done' | 'error';

/**
 * 当前是否走「波浪」那套进度窗。
 * 与设置页、背景渲染层共用 effectiveBackgroundPreset 一个判定：
 * 自定义背景 / 低配档都会退回出厂氛围底，进度窗自然也跟着退回海水波浪版。
 */
function isWavesProgress(): boolean {
  return effectiveBackgroundPreset(getAppearanceSnapshot(), getDeviceTier()) === 'waves';
}

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
      ? { a: 'hsl(var(--success) / 0.55)', b: 'hsl(var(--success) / 0.4)' }
      : phase === 'error'
        ? { a: 'hsl(var(--destructive) / 0.5)', b: 'hsl(var(--destructive) / 0.38)' }
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
          <path d={wavePath} style={{ fill: fill.b }} />
        </svg>
        <svg className="kk-wave-strip" viewBox="0 0 240 24" preserveAspectRatio="none">
          <path d={wavePath} style={{ fill: fill.a }} />
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
  const t = useT();

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
              {t('components.downloading')} · {pct}%
            </p>
          ) : detail ? (
            <p className="mt-0.5 line-clamp-2 text-xs text-slate-600">{detail}</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 胶囊高度 36 → 字号 14 → 字形 16，与 CallChip 内部换算保持一致 */
const CHIP_SIZE = 36;
const CHIP_GLYPH = 16;

/**
 * 波浪预设下的下载 / 更新进度窗：**就是一颗 CallChip 本身**，外面不再套卡片。
 * 结果一律靠 UI 表达，不写「下载完成 / 下载失败」这类文字：
 * - running：填充条跟着实时进度走，右侧毫秒计时实时跳；
 * - done：填充满格 + 绿色水波从底部升起，字形滚成对勾，计时停在真实耗时；
 * - error：填充冻在当前位置 + 红色底 + 抖动，字形滚成重试，整颗可点重来。
 */
export function DownloadCallChipToast({
  argument,
  phase,
  progress,
  onRetry,
}: {
  /** 资源名，如「某某插件 v1.2.0」 */
  argument: string;
  phase: DownloadToastPhase;
  /** 实时进度 0~100 */
  progress: number;
  onRetry?: () => void;
}) {
  const t = useT();
  return (
    <CallChip
      icon={<Download size={CHIP_GLYPH} strokeWidth={1.8} aria-hidden />}
      name={t('components.download')}
      argument={argument}
      status={phase as CallChipStatus}
      progress={Math.max(0, Math.min(100, progress)) / 100}
      size={CHIP_SIZE}
      radius={CHIP_SIZE / 2}
      color="hsl(var(--foreground))"
      surfaceColor="rgb(var(--kk-glass-base) / 0.82)"
      borderColor="hsl(var(--border) / 0.55)"
      progressColor="rgb(var(--kk-comp-rgb))"
      progressOpacity={0.22}
      doneColor="hsl(var(--success))"
      errorColor="hsl(var(--destructive))"
      washOpacity={0.22}
      shake={6}
      showTimer
      onRetry={onRetry}
      style={{ boxShadow: '0 10px 26px rgb(15 40 60 / calc(var(--kk-shadow-alpha) * 1.3))' }}
    />
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
  /** 失败后可重来；给了它，波浪版失败胶囊整颗就是重试按钮 */
  onRetry?: () => void;
}): Promise<T> {
  const toastId = `resource-dl-${Date.now()}`;
  // 波浪版在开跑这一刻定档：中途改预设不会让胶囊重挂载、动画从头再放一遍
  const waves = isWavesProgress();
  const state: LiveState = {
    label: opts.runningLabel,
    progress: 0,
    phase: 'running',
  };
  const retry = opts.onRetry
    ? () => {
        toast.dismiss(toastId);
        opts.onRetry?.();
      }
    : undefined;

  const paint = () => {
    toast.custom(
      () =>
        waves ? (
          <DownloadCallChipToast
            argument={opts.runningLabel}
            phase={state.phase}
            progress={state.progress}
            onRetry={state.phase === 'error' ? retry : undefined}
          />
        ) : (
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
  /*
   * 心跳：把「已经跑了多久」换算成填充条位置，两种外观共用同一条曲线。
   * 时间常数取 5s、上限 92%——指数逼近永远不会提前撞到顶再干等，
   * 而且越往后越慢，看着就是「还在下、只是慢下来了」，不是卡住。
   */
  const timer = window.setInterval(() => {
    if (state.phase !== 'running') return;
    const t = (performance.now() - started) / 1000;
    state.progress = Math.min(92, 92 * (1 - Math.exp(-t / 5)));
    paint();
  }, 60);

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

  /**
   * 收尾：切状态 + 画一次，各自演完终态再收起来。
   * - 波浪版：胶囊自己演（铺满 + 水波 / 冻结 + 抖动 + 字形滚动），hold 毫秒后消失，
   *   结果只靠颜色与字形表达，不额外写字；
   * - 原版：百分比补间到 100%，结果文字顶到标题上，再等 hold 毫秒。
   * 失败且给了重试入口时多留一会儿，否则人还没看见就被收走了。
   */
  const settle = async (phase: DownloadToastPhase, detail: string | undefined, hold: number) => {
    if (timer) window.clearInterval(timer);
    state.phase = phase;
    state.detail = waves ? undefined : detail;
    state.label = phase === 'done' ? t('components.downloadDone') : detail || state.label;
    if (waves) {
      paint();
      window.setTimeout(() => toast.dismiss(toastId), retry && phase === 'error' ? 6000 : Math.max(hold, 1800));
      return;
    }
    await animateTo(100, phase === 'done' ? 280 : 200);
    window.setTimeout(() => toast.dismiss(toastId), hold);
  };

  try {
    const result = await opts.task();
    if (opts.isOk(result)) {
      await settle('done', undefined, 1600);
    } else {
      await settle('error', opts.errorMessage?.(result) || t('components.downloadFailed'), 2800);
    }
    return result;
  } catch (e) {
    await settle('error', errText(e), 3200);
    throw e;
  }
}
