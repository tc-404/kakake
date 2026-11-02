import { Check, Download, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { t, useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { CallChip, type CallChipStatus } from '@/components/call-chip';
import { effectiveBackgroundPreset, getAppearanceSnapshot } from '@/lib/appearance';
import { getDeviceTier } from '@/lib/device-tier';
import { errText } from '@/lib/server-error';

export type DownloadToastPhase = 'running' | 'done' | 'error';

/** 轮询拿到的真实下载进度；null 表示暂时拿不到（回退时间曲线） */
export type DownloadLiveProgress = {
  downloaded: number;
  /** 0 表示总量未知（响应没带 Content-Length） */
  total: number;
  phase: 'downloading' | 'installing';
} | null;

/** 字节数格式化：两位小数（B 级别也同样补齐） */
function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0.00 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

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
  downloaded,
  total,
  installing,
  onCancel,
}: {
  label: string;
  progress: number;
  phase: DownloadToastPhase;
  detail?: string;
  /** 展示用已下载字节数（已与进度条同源缓动） */
  downloaded: number;
  /** 0 表示总量未知 */
  total: number;
  installing: boolean;
  /** 给了它，下载中点击左侧转圈图标即取消 */
  onCancel?: () => void;
}) {
  const pct = Math.round(Math.max(0, Math.min(100, progress)));
  const t = useT();
  const sizes = total > 0
    ? `${fmtBytes(downloaded)} / ${fmtBytes(total)}`
    : `${t('components.downloadedPrefix')} ${fmtBytes(downloaded)}`;

  return (
    <div className="relative kk-glass-2 kk-download-toast min-w-[min(92vw,20rem)] overflow-hidden rounded-2xl px-4 py-3.5">
      <WaveProgress progress={progress} phase={phase} />
      <div className="relative z-[1] flex items-center gap-3">
        {phase === 'running' && onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            aria-label={t('components.cancelDownload')}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-white/40 text-slate-700 backdrop-blur-sm transition-colors hover:bg-rose-500/15 hover:text-rose-700"
          >
            <Loader2 className="h-4 w-4 animate-spin" />
          </button>
        ) : (
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
        )}
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
              {installing ? t('components.installing') : t('components.downloading')}
              {!installing && ` · ${pct}%`} · {sizes}
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
 * - running：填充条跟着真实进度走，meta 显示已下载 / 总大小，右侧毫秒计时实时跳；
 * - done：填充满格 + 绿色水波从底部升起，字形滚成对勾，计时停在真实耗时；
 * - error：填充冻在当前位置 + 红色底 + 抖动，字形滚成重试，整颗可点重来。
 */
export function DownloadCallChipToast({
  argument,
  phase,
  progress,
  downloaded,
  total,
  installing,
  onRetry,
  onCancel,
}: {
  /** 资源名，如「某某插件 v1.2.0」 */
  argument: string;
  phase: DownloadToastPhase;
  /** 实时进度 0~100 */
  progress: number;
  /** 展示用已下载字节数（已与进度条同源缓动） */
  downloaded: number;
  /** 0 表示总量未知 */
  total: number;
  installing: boolean;
  onRetry?: () => void;
  /** 给了它，下载中点击左侧字形区即取消 */
  onCancel?: () => void;
}) {
  const t = useT();
  // 数字与水位条同源：总量已知时由进度反推，保证条和字永远对得上
  const shown = total > 0
    ? Math.round((total * Math.max(0, Math.min(100, progress))) / 100)
    : downloaded;
  const meta = total > 0
    ? `${fmtBytes(shown)} / ${fmtBytes(total)}`
    : `${t('components.downloadedPrefix')} ${fmtBytes(shown)}`;
  return (
    <CallChip
      icon={<Download size={CHIP_GLYPH} strokeWidth={1.8} aria-hidden />}
      name={phase === 'running' && installing ? t('components.installing') : t('components.download')}
      argument={argument}
      meta={meta}
      status={phase as CallChipStatus}
      progress={Math.max(0, Math.min(100, progress)) / 100}
      onCancel={phase === 'running' ? onCancel : undefined}
      cancelLabel={t('components.cancelDownload')}
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
  /** 轮询到的真实已下载字节数 */
  realDownloaded: number;
  /** 总字节数，0 = 未知 */
  total: number;
  /** 总量未知时给数字用的缓动副本 */
  dlEase: number;
  installing: boolean;
  /** 已收到过真实进度 */
  live: boolean;
  /** 首次真实进度是否已对表（见心跳内的处理） */
  liveSynced: boolean;
};

/**
 * 进行中气泡的去重登记（键=taskId）。sonner 气泡是全局的，切页不会死；
 * 页面重挂载的重连逻辑凭这张表判断「原气泡还活着」，避免叠出第二个相同气泡。
 */
const activeProgressKeys = new Set<string>();

export function isDownloadProgressActive(key: string): boolean {
  return activeProgressKeys.has(key);
}

/**
 * 带描边进度的下载 toast。
 * 进度来自 poll 轮询的真实字节数；显示值按 60ms 心跳朝真值缓动，条与数字同源。
 * 还没轮到第一条真实数据（或总量未知）时，沿用时间曲线逼近 92% 兜底，不会出现死 0%。
 */
export async function runWithDownloadProgressToast<T>(opts: {
  /** 进行中标题，如「名称 v1.0」 */
  runningLabel: string;
  task: () => Promise<T>;
  isOk: (result: T) => boolean;
  errorMessage?: (result: T) => string;
  /** 失败后可重来；给了它，波浪版失败胶囊整颗就是重试按钮 */
  onRetry?: () => void;
  /** 轮询真实进度；返回 null / 抛错都只是跳过这一拍 */
  poll?: () => Promise<DownloadLiveProgress>;
  /** 用户在进度窗点击转圈图标取消下载（后端掐断在途请求，POST 会以失败收场） */
  onCancel?: () => void | Promise<void>;
  /** 去重键（=taskId）：登记进进行中气泡表，供切页重连判断「原气泡还活着」 */
  dedupeKey?: string;
}): Promise<T> {
  const key = opts.dedupeKey;
  if (key) activeProgressKeys.add(key);
  try {
    return await runDownloadToastInner(opts);
  } finally {
    if (key) activeProgressKeys.delete(key);
  }
}

async function runDownloadToastInner<T>(opts: {
  runningLabel: string;
  task: () => Promise<T>;
  isOk: (result: T) => boolean;
  errorMessage?: (result: T) => string;
  onRetry?: () => void;
  poll?: () => Promise<DownloadLiveProgress>;
  onCancel?: () => void | Promise<void>;
}): Promise<T> {
  // 并发安装多个资源时各开各的气泡，id 必须互不撞车
  const toastId = `resource-dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 波浪版在开跑这一刻定档：中途改预设不会让胶囊重挂载、动画从头再放一遍
  const waves = isWavesProgress();
  const state: LiveState = {
    label: opts.runningLabel,
    progress: 0,
    phase: 'running',
    realDownloaded: 0,
    total: 0,
    dlEase: 0,
    installing: false,
    live: false,
    liveSynced: false,
  };
  const retry = opts.onRetry
    ? () => {
        toast.dismiss(toastId);
        opts.onRetry?.();
      }
    : undefined;

  /** 展示用已下载字节数：总量已知时由进度反推（与条完全同步），未知时用缓动副本 */
  const displayBytes = () => {
    const pct = Math.max(0, Math.min(100, state.progress));
    return state.total > 0
      ? Math.round((state.total * pct) / 100)
      : Math.max(0, Math.round(state.dlEase));
  };

  const paint = () => {
    toast.custom(
      () =>
        waves ? (
          <DownloadCallChipToast
            argument={opts.runningLabel}
            phase={state.phase}
            progress={state.progress}
            downloaded={displayBytes()}
            total={state.total}
            installing={state.installing}
            onRetry={state.phase === 'error' ? retry : undefined}
            onCancel={opts.onCancel ? () => void opts.onCancel?.() : undefined}
          />
        ) : (
          <DownloadBorderToast
            label={state.label}
            progress={state.progress}
            phase={state.phase}
            detail={state.detail}
            downloaded={displayBytes()}
            total={state.total}
            installing={state.installing}
            onCancel={opts.onCancel ? () => void opts.onCancel?.() : undefined}
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

  // 轮询真实进度：250ms 一拍，单飞防止请求堆积
  let pollTimer: number | undefined;
  let polling = false;
  if (opts.poll) {
    pollTimer = window.setInterval(() => {
      if (polling || state.phase !== 'running') return;
      polling = true;
      void opts.poll()
        .then((p) => {
          if (!p || state.phase !== 'running') return;
          state.live = true;
          state.realDownloaded = p.downloaded;
          state.total = p.total;
          state.installing = p.phase === 'installing';
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
    }, 250);
  }

  /*
   * 心跳：显示进度朝目标缓动（60ms 一拍），数字与条共用这一个值，天然丝滑。
   * 目标优先取真实进度；首拍对表时只允许向下跳一次（假曲线起步快，别倒着爬），
   * 之后纯缓动。真实数据缺席时退回时间曲线：5s 时间常数、上限 92%。
   */
  const timer = window.setInterval(() => {
    if (state.phase !== 'running') return;
    if (state.live && state.total > 0) {
      const target = Math.min(100, (state.realDownloaded / state.total) * 100);
      if (!state.liveSynced) {
        state.liveSynced = true;
        state.progress = Math.min(state.progress, target);
      }
      state.progress += (target - state.progress) * 0.28;
    } else {
      const t = (performance.now() - started) / 1000;
      const target = Math.min(92, 92 * (1 - Math.exp(-t / 5)));
      state.progress += (target - state.progress) * 0.28;
    }
    if (state.live && state.total <= 0) {
      state.dlEase += (state.realDownloaded - state.dlEase) * 0.28;
    }
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
    if (pollTimer) window.clearInterval(pollTimer);
    state.phase = phase;
    if (phase === 'done') {
      // 收口到精确值：显示下载量即总量，别让缓动把结尾留在 99%
      if (state.total > 0) state.realDownloaded = state.total;
      state.dlEase = state.realDownloaded;
      state.installing = false;
    }
    state.detail = waves ? undefined : detail;
    state.label = phase === 'done' ? t('components.downloadDone') : detail || state.label;
    if (waves) {
      if (phase === 'done') state.progress = 100;
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
