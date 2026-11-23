import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  Loader2, Wrench, Copy, CheckCircle2, AlertTriangle, RotateCcw, Play, Square,
  Radio, Trash2, CircleHelp, CircleSlash, MonitorCheck, PackageCheck,
  ChevronDown, ChevronUp, Chrome, Globe, Atom, ExternalLink, ArrowDown, MonitorOff,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  api,
  type BrowserId,
  type BrowserMode,
  type BrowserSettings,
  type BrowserSetting,
  type BrowserStatusResponse,
  type SystemBrowser,
  type BrowserRuntime,
  type BrowserInstallJob,
  type InstallBlock,
  type SharpEnvState,
} from '@/lib/api';
import { useT, t as translate } from '@/lib/i18n';

type Translate = typeof translate;
import { copyToClipboard } from '@/lib/clipboard';
import { errText, svcText } from '@/lib/server-error';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const UPDATE_MIRROR_KEY = 'kakake_update_mirror';
function currentUpdateMirror(): string {
  try { return localStorage.getItem(UPDATE_MIRROR_KEY) || ''; } catch { return ''; }
}

function fmtSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '-';
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${Math.round(bytes / 1048576)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function fmtSpeed(bytesPerSec: number): string {
  if (!bytesPerSec || bytesPerSec <= 0) return '-';
  if (bytesPerSec >= 1048576) return `${(bytesPerSec / 1048576).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSec / 1024))} KB/s`;
}

const BROWSER_ORDER: BrowserId[] = ['chrome', 'edge', 'chromium'];
const ACTIVE_PHASES: BrowserInstallJob['phase'][] = ['resolving', 'downloading', 'extracting', 'deps', 'verifying'];
const EMPTY_JOB: BrowserInstallJob = {
  phase: 'idle', percent: 0, message: '', error: '',
  browserId: '', downloadedBytes: 0, totalBytes: 0, bytesPerSec: 0, errorCode: '',
  startedAt: '', finishedAt: '',
};
/** sharp 后端只给已落盘字节；估算分母仅用于换算百分比，文案里明示为估算值 */
const SHARP_EXPECTED_BYTES = 32 * 1024 * 1024;

/** 状态色为固定 token，不随主题变化；只用于描边 / 圆点 / 图标 / 胶囊底 */
const STATUS_TONE = {
  green: { dot: 'bg-[#16A34A]', border: 'border-[#16A34A]', icon: 'text-[#16A34A]', chip: 'bg-[#16A34A]/15' },
  yellow: { dot: 'bg-[#D97706]', border: 'border-[#D97706]', icon: 'text-[#D97706]', chip: 'bg-[#D97706]/15' },
  red: { dot: 'bg-[#DC2626]', border: 'border-[#DC2626]', icon: 'text-[#DC2626]', chip: 'bg-[#DC2626]/15' },
  gray: { dot: 'bg-[#64748B]', border: 'border-[#64748B]', icon: 'text-[#64748B]', chip: 'bg-[#64748B]/15' },
  // 已安装但未运行：中性，无彩色描边（绿只留给真正启动成功）
  neutral: { dot: 'bg-[#64748B]', border: 'border-transparent', icon: 'text-[#64748B]', chip: 'bg-[#64748B]/15' },
} as const;
type ToneKey = keyof typeof STATUS_TONE;

type RowStatus = { tone: ToneKey; label: string; Icon: LucideIcon; spin?: boolean };

/** installBlock 四档映射：必须按优先级从契约字段推导，严禁从 reason 非空猜档位 */
type BlockTier = 'none' | 'platform' | 'source' | 'degraded';
function blockTier(block?: InstallBlock): BlockTier {
  if (!block) return 'none';
  if (!block.platformSupported) return 'platform';
  if (block.downloadSourceOk === false) return 'source';
  if (block.degraded === true) return 'degraded';
  return 'none';
}
const TIER_META: Record<Exclude<BlockTier, 'none'>, { Icon: LucideIcon; tone: ToneKey; labelKey: string }> = {
  platform: { Icon: CircleSlash, tone: 'gray', labelKey: 'render.warn.platform' },
  source: { Icon: AlertTriangle, tone: 'yellow', labelKey: 'render.warn.source' },
  degraded: { Icon: CircleHelp, tone: 'yellow', labelKey: 'render.warn.degraded' },
};

const BROWSER_ICONS: Record<BrowserId, LucideIcon> = { chrome: Chrome, edge: Globe, chromium: Atom };

/** 分区标题：强调条 + 标题 + 副标题，容器自带 mb-4 */
function SectionTitle({ title, desc, descHiddenOnMobile, action }: {
  title: string;
  desc?: string;
  descHiddenOnMobile?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start gap-2.5">
      <span aria-hidden className="mt-[3px] h-4 w-1 shrink-0 rounded-full bg-[rgb(var(--kk-comp-rgb))]" />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold leading-5 text-slate-800 dark:text-slate-100">{title}</h2>
        {desc ? (
          <p className={cn('mt-1 text-xs leading-5 text-slate-500', descHiddenOnMobile && 'hidden sm:block')}>
            {desc}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** 图片引擎（sharp）卡：与设置页「图片引擎环境」同一套安装操作，布局收紧 */
function SharpCard() {
  const t = useT();
  const [env, setEnv] = useState<SharpEnvState | null>(null);
  const [starting, setStarting] = useState(false);
  const phaseRef = useRef('');

  const refresh = useCallback(async () => {
    try {
      const s = await api.systemSharp(currentUpdateMirror());
      const prev = phaseRef.current;
      const now = s.job?.phase || '';
      if (prev === 'running' && now && now !== 'running') {
        if (now === 'done') toast.success(t('settings.sharpInstallDone'));
        else toast.error(svcText(s.job?.error) || t('settings.installFailed'));
      }
      phaseRef.current = now;
      setEnv(s);
    } catch { /* 保持上次状态 */ }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (env?.job?.phase !== 'running') return;
    const timer = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(timer);
  }, [env?.job?.phase, refresh]);

  const install = () => {
    if (starting || env?.job?.phase === 'running') return;
    setStarting(true);
    api.systemSharpInstall(currentUpdateMirror())
      .then(() => { toast.success(t('settings.installStarted')); void refresh(); })
      .catch((e) => toast.error(errText(e)))
      .finally(() => setStarting(false));
  };

  const tone: ToneKey = env?.loadable ? 'green' : env ? 'yellow' : 'gray';
  const StatusIcon: LucideIcon = env?.loadable ? CheckCircle2 : env ? CircleHelp : Loader2;
  const statusLabel = env
    ? (env.loadable ? t('settings.ready') : t('settings.notInstalled'))
    : t('label.loading');
  const running = env?.job?.phase === 'running';
  // 真实已落盘字节数 / 估算分母；不再使用硬编码 60% 的假进度
  const downloaded = Math.max(0, env?.job?.downloadedBytes ?? 0);
  const total = Math.max(1, (env?.job?.totalBytes && env.job.totalBytes > 0 ? env.job.totalBytes : SHARP_EXPECTED_BYTES));
  const sharpPercent = env?.job?.phase === 'done' ? 100 : Math.min(99, Math.round(downloaded / total * 100));

  return (
    <section className="kk-glass rounded-[1.25rem] p-4">
      <header className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t('render.sharp.title')}</h3>
        <span className={cn(
          'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-foreground',
          STATUS_TONE[tone].chip,
        )}>
          <StatusIcon className={cn('h-3.5 w-3.5', tone === 'gray' ? 'animate-spin' : STATUS_TONE[tone].icon)} />
          {statusLabel}
        </span>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!env?.canInstall || starting || running} onClick={install}>
          {starting || running
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Wrench className="h-3.5 w-3.5" />}
          {running ? t('settings.installing')
            : env?.loadable ? t('settings.reinstall') : t('settings.install')}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void copyToClipboard(`cd "${env?.installDir ?? ''}"\nnpm install --omit=dev --include=optional --no-audit --no-fund`);
            toast.success(t('settings.commandCopied'));
          }}
        >
          <Copy className="h-3.5 w-3.5" />{t('settings.copyCommand')}
        </Button>
        {env?.loadable ? (
          <span className="font-mono text-[11px] text-slate-500">sharp {env.version} · libvips {env.vips}</span>
        ) : null}
        {env?.npmRegistry ? (
          <span className="text-[11px] text-slate-500">npm: {env.npmRegistry}</span>
        ) : null}
      </div>

      {env?.job?.message ? (
        <p className={cn('mt-2 text-xs', env.job.phase === 'error' ? 'text-[#DC2626]' : 'text-slate-500')}>
          {env.job.message}{env.job.error ? `：${env.job.error}` : ''}
        </p>
      ) : null}

      {running ? (
        <div className="mt-2 space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
            <span className="min-w-0 truncate font-mono tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {t('render.progress.sharp', { a: fmtSize(downloaded), b: fmtSize(total) })}
            </span>
            <span className="shrink-0 font-mono text-foreground tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {sharpPercent}%
            </span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
            role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={sharpPercent} aria-label={t('render.progress')}
          >
            <div
              className="h-full rounded-full bg-[#D97706] transition-[width] duration-300 motion-reduce:transition-none"
              style={{ width: `${sharpPercent}%` }}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}

/** B1 进度 strip：三行恒高，aria-live 只挂阶段，百分比/速度不进 live */
function InstallProgressStrip({ job, percentValue, downloadedBytes, total, totalApprox, speedBps, stalled, t }: {
  job: BrowserInstallJob;
  /** 前端单调不减的百分比，避免后端回退造成数字跳变 */
  percentValue: number;
  downloadedBytes: number;
  total: number;
  totalApprox: boolean;
  speedBps: number;
  stalled: boolean;
  t: Translate;
}) {
  const phase = job.phase;
  const downloading = phase === 'downloading';
  const writing = phase === 'extracting' || phase === 'deps' || phase === 'verifying';
  const pulse = !downloading || total <= 0;
  // 只有「下载中 + 总量已知」才显示真实百分比；写入/校验阶段不锁定 100%，改为不定态 + 阶段文字。
  const percent = downloading && total > 0
    ? Math.min(100, Math.max(0, Math.round(percentValue)))
    : null;
  const indeterminate = percent === null;
  const totalLabel = total > 0
    ? (totalApprox ? t('render.progress.approx', { v: fmtSize(total) }) : fmtSize(total))
    : t('render.progress.unknownTotal');
  const speedText = stalled && downloading
    ? t('render.progress.stalled')
    : downloading ? fmtSpeed(speedBps) : '—';

  return (
    <div className="bg-black/5 px-4 py-2.5 dark:bg-white/10">
      {/* 行1：阶段（唯一 live 节点）+ 百分比 */}
      <div className="flex items-center gap-2">
        <span aria-live="polite" className="min-w-0 truncate text-xs font-medium text-foreground">
          {t(`render.progress.${phase}`)}
        </span>
        <span
          className={cn(
            'ml-auto shrink-0 min-w-[3.5rem] text-right font-mono text-lg font-semibold leading-none tabular-nums',
            !downloading || indeterminate ? 'text-slate-500' : 'text-foreground',
          )}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {indeterminate ? '—' : `${percent}%`}
        </span>
      </div>

      {/* 行2：h-1.5 进度条，非下载阶段 / 总量未知时脉冲不定态 */}
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        role="progressbar" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={indeterminate ? undefined : percent ?? undefined}
        aria-valuetext={indeterminate
          ? (writing ? t(`render.progress.${phase}`) : t('render.progress.unknownTotal'))
          : undefined}
        aria-label={t('render.progress')}
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-linear motion-reduce:transition-none',
            pulse || indeterminate ? 'animate-pulse bg-[#D97706]/60 motion-reduce:animate-none' : 'bg-[#D97706]',
          )}
          style={{ width: `${indeterminate ? 35 : percent}%` }}
        />
      </div>

      {/* 行3：已下载÷总量 + 实时速度 + 最右取消 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-500">
        <span className="min-w-0 truncate font-mono tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('render.progress.bytes', { a: fmtSize(downloadedBytes), b: totalLabel })}
        </span>
        <span className="ml-1 inline-flex shrink-0 items-center gap-1 font-mono tabular-nums" style={{ fontVariantNumeric: 'tabular-nums' }}>
          <ArrowDown aria-hidden className="h-3 w-3" />{speedText}
        </span>
      </div>
    </div>
  );
}

/** B2 installBlock strip：两行；技术 reason 收进 details，不铺屏 */
function InstallBlockStrip({ tier, block, homepage, probing, reasonId, onRetryProbe, t }: {
  tier: Exclude<BlockTier, 'none'>;
  block: InstallBlock;
  homepage: string;
  probing: boolean;
  reasonId: string;
  onRetryProbe: () => void;
  t: Translate;
}) {
  const meta = TIER_META[tier];
  const Tone = STATUS_TONE[meta.tone];
  const Icon = meta.Icon;
  const human = t(meta.labelKey);
  return (
    <div className="bg-black/5 px-4 py-2 dark:bg-white/10">
      <div className="flex items-center gap-1.5">
        <Icon aria-hidden className={cn('h-3.5 w-3.5 shrink-0', Tone.icon)} />
        <span className="text-xs font-medium text-foreground">{human}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p id={reasonId} className="min-w-0 flex-1 truncate text-[11px] leading-4 text-slate-500" title={human}>{human}</p>
        {tier === 'source' ? (
          <Button variant="outline" size="sm" disabled={probing} onClick={onRetryProbe}>
            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
            {t('render.block.retryProbe')}
          </Button>
        ) : null}
        <a
          href={homepage}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-600 underline decoration-slate-400 underline-offset-2 hover:text-foreground dark:text-slate-300"
        >
          <ExternalLink aria-hidden className="h-3 w-3" />{t('render.browser.homepage')}
        </a>
      </div>
      {block.reason ? (
        <details className="mt-1 text-[11px] text-slate-500">
          <summary className="cursor-pointer">{t('render.warn.details')}</summary>
          <pre className="whitespace-pre-wrap break-all font-mono text-[10px]">{block.reason}</pre>
        </details>
      ) : null}
    </div>
  );
}

/** B3 错误终态载体：独立于折叠面板，常驻可查 */
function InstallErrorStrip({ job, homepage, onRetry, t }: {
  job: BrowserInstallJob;
  homepage: string;
  onRetry: () => void;
  t: Translate;
}) {
  const detail = job.error && job.error !== job.message ? job.error : (job.message || job.error);
  return (
    <div className="rounded-lg border border-[#DC2626]/45 bg-[#DC2626]/5 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <AlertTriangle aria-hidden className="h-3.5 w-3.5 shrink-0 text-[#DC2626]" />
        <span className="text-xs font-medium text-foreground">{t('render.error.title')}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[11px] leading-4 text-slate-600 dark:text-slate-300" title={detail}>{detail}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="h-3.5 w-3.5" />{t('render.progress.retry')}
        </Button>
        <a
          href={homepage}
          target="_blank"
          rel="noreferrer"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-slate-600 underline decoration-slate-400 underline-offset-2 hover:text-foreground dark:text-slate-300"
        >
          <ExternalLink aria-hidden className="h-3 w-3" />{t('render.browser.homepage')}
        </a>
      </div>
    </div>
  );
}

function ModeSelect({ value, onChange, t }: {
  value: BrowserMode;
  onChange: (m: BrowserMode) => void;
  t: Translate;
}) {
  const modes: BrowserMode[] = ['always', 'plugin', 'idle'];
  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg bg-black/5 p-1 dark:bg-white/10" role="group" aria-label={t('render.mode.label')}>
      {modes.map((m) => {
        const active = value === m;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(m)}
            className={cn(
              'flex items-center justify-center gap-1 rounded-md border px-1 py-1.5 text-xs font-medium transition-colors motion-reduce:transition-none',
              active
                ? 'border-[rgb(var(--kk-comp-rgb))] bg-[rgb(var(--kk-comp-rgb)/0.12)] text-[rgb(var(--kk-comp-rgb))]'
                : 'border-transparent text-slate-500 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10',
            )}
          >
            <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', active ? 'bg-[rgb(var(--kk-comp-rgb))]' : 'bg-slate-400')} />
            {t(`render.mode.${m}`)}
          </button>
        );
      })}
    </div>
  );
}

function BrowserCard({
  info,
  runtime,
  setting,
  job,
  installBlock,
  speedBps,
  stalled,
  busy,
  detecting,
  starting,
  canceling,
  onInstall,
  onCancel,
  onUninstall,
  onControl,
  onSetting,
  onSaveSetting,
  onRetryProbe,
  t,
}: {
  info: SystemBrowser;
  runtime?: BrowserRuntime;
  setting: BrowserSetting;
  job: BrowserInstallJob;
  installBlock?: InstallBlock;
  speedBps: number;
  stalled: boolean;
  busy: boolean;
  detecting: boolean;
  starting: boolean;
  canceling: boolean;
  onInstall: () => void;
  onCancel: () => void;
  onUninstall: () => void;
  onControl: (action: 'start' | 'stop' | 'restart') => void;
  onSetting: (patch: Partial<BrowserSetting>) => void;
  onSaveSetting: () => void;
  onRetryProbe: () => void;
  t: Translate;
}) {
  const [expanded, setExpanded] = useState(false);
  const expandable = !!info.managed;
  const panelId = `browser-panel-${info.id}`;
  const reasonId = `browser-block-reason-${info.id}`;

  const tier = blockTier(installBlock);
  const ownsJob = job.browserId === info.id && job.phase !== 'idle';
  const installing = ownsJob && ACTIVE_PHASES.includes(job.phase);
  const jobCancelled = ownsJob && job.phase === 'error' && job.errorCode === 'cancelled';
  const jobError = ownsJob && job.phase === 'error' && !jobCancelled;
  const verified = info.verified ?? info.found;
  const runningProcess = info.runningProcess === true;
  const running = !!runtime?.running;
  const dirty = JSON.stringify(setting) !== JSON.stringify(runtime?.setting ?? setting);
  const modeDesc = t(`render.mode.${setting.mode}.desc`);

  /** 百分比单调不减；切任务/切阶段保留上一帧数值，避免归零闪动 */
  const valueRef = useRef({ startedAt: '', percent: 0, bytes: 0, total: 0 });
  if (ownsJob) {
    const v = valueRef.current;
    if (v.startedAt !== job.startedAt) {
      v.startedAt = job.startedAt; v.percent = 0; v.bytes = 0; v.total = 0;
    }
    if (job.phase === 'downloading') v.percent = Math.max(v.percent, Math.round(job.percent || 0));
    v.bytes = Math.max(v.bytes, job.downloadedBytes || 0);
    v.total = Math.max(v.total, job.totalBytes || 0);
  }
  const shown = valueRef.current;
  const jobTotal = shown.total > 0 ? shown.total : 0;
  const approxTotal = jobTotal === 0 && info.archiveBytes > 0 ? info.archiveBytes : 0;
  const total = jobTotal || approxTotal;
  const totalApprox = jobTotal === 0 && approxTotal > 0;

  let status: RowStatus;
  if (detecting) status = { tone: 'yellow', label: t('render.browser.detecting'), Icon: Loader2, spin: true };
  else if (installing) status = { tone: 'yellow', label: t('render.browser.installing'), Icon: Loader2, spin: true };
  else if (starting) status = { tone: 'yellow', label: t('render.browser.starting'), Icon: Loader2, spin: true };
  else if (jobCancelled) status = { tone: 'gray', label: t('render.progress.cancelled'), Icon: CircleSlash };
  else if (jobError) status = { tone: 'red', label: t('render.browser.error'), Icon: AlertTriangle };
  else if (running || runningProcess) status = { tone: 'green', label: t('render.browser.running'), Icon: Radio };
  // 已安装但未启动成功：中性无描边，绿色只属于真正在运行的浏览器
  else if (verified) status = { tone: 'neutral', label: t('render.browser.verified'), Icon: CheckCircle2 };
  else status = { tone: 'yellow', label: t('render.browser.unverified'), Icon: CircleHelp };

  const tone = STATUS_TONE[status.tone];
  const StatusIcon = status.Icon;
  const BrowserIcon = BROWSER_ICONS[info.id];
  const SourceIcon = info.managed ? PackageCheck : MonitorCheck;
  const sourceLabel = info.managed
    ? t('render.browser.managed')
    : info.found ? t('render.browser.system')
      : runningProcess ? t('render.browser.processOnly')
        : t('render.browser.notFound');

  // 已安装/已验证的浏览器不再展示安装前置警示
  const blockTierActive = info.found ? 'none' : tier;
  const installDisabled = blockTierActive === 'platform' || blockTierActive === 'source';
  const installTitle = blockTierActive === 'degraded'
    ? t('render.warn.degraded')
    : blockTierActive !== 'none'
      ? `${t(TIER_META[blockTierActive].labelKey)}${installBlock?.reason ? `：${installBlock.reason}` : ''}`
      : t('render.browser.hint.install', { a: fmtSize(info.archiveBytes), b: fmtSize(info.unpackedBytes) });
  // 正常态不显示次要文案：已装/就绪时不占用版面；仅在未装、拦截、取消、异常时给提示。
  const secondaryText = jobCancelled ? t('render.progress.cancelled')
    : blockTierActive !== 'none' ? t(TIER_META[blockTierActive].labelKey)
      : '';

  const toggle = () => { if (expandable) setExpanded((v) => !v); };
  const stop = (e: MouseEvent) => e.stopPropagation();
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!expandable || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggle();
  };
  const iconBtn = 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/55 bg-white/40 text-slate-600 transition-colors hover:bg-white/65 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none dark:text-slate-200';
  // 三操作按钮：长方形圆角 + 图标 + 两字文字；手机端从头部移到展开区底部
  const actionBtn = 'inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-white/55 bg-white/40 px-2.5 text-xs font-medium text-slate-600 transition-colors hover:bg-white/65 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none dark:text-slate-200';

  // 三种 strip 全在折叠面板之外；切换时缓存上一帧节点，grid-rows 200ms 收起不闪动
  const stripNode: ReactNode = installing ? (
    <InstallProgressStrip
      job={job} percentValue={shown.percent} downloadedBytes={shown.bytes} total={total} totalApprox={totalApprox}
      speedBps={speedBps} stalled={stalled} t={t}
    />
  ) : jobError ? (
    <InstallErrorStrip job={job} homepage={info.homepage} onRetry={onInstall} t={t} />
  ) : blockTierActive !== 'none' && installBlock ? (
    <InstallBlockStrip
      tier={blockTierActive} block={installBlock} homepage={info.homepage} probing={detecting}
      reasonId={reasonId} onRetryProbe={onRetryProbe} t={t}
    />
  ) : null;
  const stripCacheRef = useRef<ReactNode>(null);
  if (stripNode) stripCacheRef.current = stripNode;
  const stripVisible = !!stripNode;

  return (
    <section
      aria-busy={installing}
      className={cn('kk-glass overflow-hidden rounded-xl border-2 transition-colors motion-reduce:transition-none', tone.border)}
    >
      {/* 行骨架：身份簇 flex-1 + 操作簇 ml-auto shrink-0，2xl 细分隔 */}
      <div
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-controls={expandable ? panelId : undefined}
        aria-label={expandable ? `${info.label} ${expanded ? t('render.browser.collapse') : t('render.browser.expand')}` : undefined}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className="flex min-h-11 min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2.5 sm:py-3"
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span aria-hidden className={cn('h-2.5 w-2.5 shrink-0 rounded-full', tone.dot)} />
          <BrowserIcon aria-hidden className="h-5 w-5 shrink-0 text-slate-500 dark:text-slate-300" />
          <span className="max-w-[14rem] min-w-0 truncate text-sm font-medium text-foreground">{info.label}</span>

          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-black/5 px-1.5 py-0.5 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-300">
            <SourceIcon aria-hidden className="h-3.5 w-3.5" />
            <span className="hidden min-w-0 truncate sm:inline">{sourceLabel}</span>
          </span>

          {/* 咔咔珂托管的 Chromium 是官方 headless-shell；未安装时也提前告知安装产物形态。
              系统自带 Chromium（非托管）保持完整 GUI，不打此标签。 */}
          {info.id === 'chromium' && (!info.found || info.managed) ? (
            <span
              title={t('render.browser.headless.desc')}
              className="hidden shrink-0 items-center rounded-md bg-[#D97706]/10 px-1.5 py-0.5 text-[11px] font-medium text-[#D97706] sm:inline-flex"
            >
              {t('render.browser.headless')}
            </span>
          ) : null}

          <span className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-foreground',
            tone.chip,
          )}>
            <StatusIcon aria-hidden className={cn('h-3.5 w-3.5', status.spin ? 'animate-spin motion-reduce:animate-none' : tone.icon)} />
            <span className="min-w-0 truncate">{status.label}</span>
          </span>

          {verified && !running && !runningProcess && !detecting && !installing && !starting ? (
            <span className="hidden shrink-0 items-center gap-1 text-[11px] text-[#64748B] sm:inline-flex">
              <CircleSlash aria-hidden className="h-3.5 w-3.5" />{t('render.browser.stopped')}
            </span>
          ) : null}
        </div>

        {/* 操作簇：不放取消，只保留安装中禁用态 */}
        <div className="ml-auto flex shrink-0 items-center gap-1 pl-3 2xl:gap-1.5" onClick={stop}>
          <span aria-hidden className="mx-1 hidden h-5 w-px bg-black/10 dark:bg-white/10 2xl:block" />
          {installing ? (
            <Button
              size="sm"
              disabled={canceling}
              title={t('render.browser.cancel')}
              onClick={(e) => { stop(e); onCancel(); }}
            >
              {canceling
                ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                : <CircleSlash className="h-3.5 w-3.5" />}
              {canceling ? t('render.browser.cancelling') : t('render.browser.cancel')}
            </Button>
          ) : info.managed ? (
            <>
              <button type="button" className={cn(actionBtn, 'hidden sm:inline-flex')} disabled={busy || starting} onClick={(e) => { stop(e); onControl('start'); }}>
                <Play aria-hidden className="h-3.5 w-3.5" />{t('render.browser.start')}
              </button>
              <button type="button" className={cn(actionBtn, 'hidden sm:inline-flex')} disabled={busy || starting} onClick={(e) => { stop(e); onControl('stop'); }}>
                <Square aria-hidden className="h-3.5 w-3.5" />{t('render.browser.stop')}
              </button>
              <button type="button" className={cn(actionBtn, 'hidden sm:inline-flex')} disabled={busy || starting} onClick={(e) => { stop(e); onControl('restart'); }}>
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />{t('render.browser.restart')}
              </button>
            </>
          ) : !info.found ? (
            <Button
              size="sm"
              disabled={busy || installDisabled}
              title={installTitle}
              aria-describedby={installDisabled ? reasonId : undefined}
              onClick={(e) => { stop(e); onInstall(); }}
            >
              <Wrench className="h-3.5 w-3.5" />{t('render.browser.install')}
            </Button>
          ) : null}
          {expandable ? (
            <button
              type="button"
              aria-label={expanded ? t('render.browser.collapse') : t('render.browser.expand')}
              title={expanded ? t('render.browser.collapse') : t('render.browser.expand')}
              onClick={(e) => { stop(e); toggle(); }}
              className="inline-flex h-7 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 hover:bg-black/5 dark:text-slate-300 dark:hover:bg-white/10"
            >
              {expanded ? <ChevronUp aria-hidden className="h-3.5 w-3.5" /> : <ChevronDown aria-hidden className="h-3.5 w-3.5" />}
            </button>
          ) : null}
        </div>
      </div>

      {/* 三种 strip：恒在 header 下方、折叠面板之外 */}
      <div className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        stripVisible ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}>
        <div className="overflow-hidden" inert={!stripVisible}>
          {stripVisible ? stripNode : stripCacheRef.current}
        </div>
      </div>

      {/* 次要信息轨：仅在非正常态显示（未装 / 拦截 / 取消 / 异常）；正常态留白 */}
      {secondaryText ? (
        <p className="px-4 pb-2 text-[11px] leading-4 text-slate-500">{secondaryText}</p>
      ) : null}

      {/* 折叠配置面板：不再放进度 / 错误 */}
      <div className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}>
        <div className="overflow-hidden">
          <div id={panelId} inert={!expanded} className="space-y-3 border-t border-white/40 px-4 py-3 dark:border-white/10">
            {running ? (
              <div className="space-y-0.5 rounded-lg bg-black/5 p-2.5 text-[11px] text-slate-600 dark:bg-white/10 dark:text-slate-300">
                <p className="break-all font-mono">{t('render.browser.cdp')}: {runtime?.cdpUrl}</p>
                <p>{t('render.browser.pid')}: {runtime?.pid}</p>
                {runtime?.holders.length ? <p>{t('render.mode.holders')}: {runtime.holders.join(', ')}</p> : null}
                {(runtime?.idleRemainSec ?? 0) > 0 ? (
                  <p>{t('render.mode.idleRemain', { n: runtime?.idleRemainSec })}</p>
                ) : null}
              </div>
            ) : null}

            <div>
              <p className="mb-1.5 text-xs font-medium">{t('render.mode.label')}</p>
              <ModeSelect value={setting.mode} onChange={(m) => onSetting({ mode: m })} t={t} />
              <p className="mt-1 text-[11px] text-slate-500">{modeDesc}</p>
              {/* 无头模式归入「启动方式」组：紧凑整行开关条，消除原先与端口并排的空余 */}
              <button
                type="button"
                role="switch"
                aria-checked={setting.headless}
                onClick={() => onSetting({ headless: !setting.headless })}
                className="mt-2 flex w-full items-center gap-2 rounded-lg bg-black/5 px-3 py-2 text-left transition-colors hover:bg-black/10 motion-reduce:transition-none dark:bg-white/10 dark:hover:bg-white/15"
              >
                <MonitorOff aria-hidden className="h-4 w-4 shrink-0 text-slate-500 dark:text-slate-300" />
                <span className="min-w-0 flex-1 text-xs text-slate-600 dark:text-slate-200">{t('render.mode.headless')}</span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors motion-reduce:transition-none',
                    setting.headless ? 'bg-[rgb(var(--kk-comp-rgb))]' : 'bg-slate-400/60',
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform motion-reduce:transition-none',
                      setting.headless ? 'translate-x-[18px]' : 'translate-x-0.5',
                    )}
                  />
                </span>
              </button>
            </div>

            {setting.mode === 'idle' ? (
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-500">{t('render.mode.grace')}</span>
                  <input
                    type="number" min={5} max={86400}
                    className="kk-field w-full rounded-lg px-2 py-1.5 text-sm"
                    value={setting.idleGraceSec}
                    onChange={(e) => onSetting({ idleGraceSec: Number(e.target.value) })}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] text-slate-500">{t('render.mode.active')}</span>
                  <input
                    type="number" min={3} max={86400}
                    className="kk-field w-full rounded-lg px-2 py-1.5 text-sm"
                    value={setting.idleActiveSec}
                    onChange={(e) => onSetting({ idleActiveSec: Number(e.target.value) })}
                  />
                </label>
              </div>
            ) : null}

            <label className="block space-y-1">
              <span className="text-[11px] text-slate-500">{t('render.mode.port')}</span>
              <input
                type="number" min={1025} max={65534}
                className="kk-field w-full rounded-lg px-2 py-1.5 text-sm"
                value={setting.port}
                onChange={(e) => onSetting({ port: Number(e.target.value) })}
              />
            </label>

            <div className="flex flex-wrap items-center gap-2">
              {/* 手机端：三操作按钮从头部移到这里，与保存/卸载同行（电脑端在头部行内） */}
              <button type="button" className={cn(actionBtn, 'sm:hidden')} disabled={busy || starting} onClick={() => onControl('start')}>
                <Play aria-hidden className="h-3.5 w-3.5" />{t('render.browser.start')}
              </button>
              <button type="button" className={cn(actionBtn, 'sm:hidden')} disabled={busy || starting} onClick={() => onControl('stop')}>
                <Square aria-hidden className="h-3.5 w-3.5" />{t('render.browser.stop')}
              </button>
              <button type="button" className={cn(actionBtn, 'sm:hidden')} disabled={busy || starting} onClick={() => onControl('restart')}>
                <RotateCcw aria-hidden className="h-3.5 w-3.5" />{t('render.browser.restart')}
              </button>
              <Button size="sm" disabled={busy || !dirty} onClick={onSaveSetting}>{t('render.save')}</Button>
              {dirty ? <span className="text-[11px] text-[#D97706]">{t('render.browser.unsaved')}</span> : null}
              <Button variant="ghost" size="sm" className="ml-auto text-slate-500" disabled={busy} onClick={onUninstall}>
                <Trash2 className="h-3.5 w-3.5" />{t('render.browser.uninstall')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

type SpeedSample = { key: string; at: number; bytes: number; ema: number; stall: number };

export default function RenderToolsPage() {
  const t = useT();
  const [status, setStatus] = useState<BrowserStatusResponse | null>(null);
  const [draft, setDraft] = useState<BrowserSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [startingId, setStartingId] = useState<BrowserId | ''>('');
  const [canceling, setCanceling] = useState(false);
  const [speedBps, setSpeedBps] = useState(0);
  const [stalled, setStalled] = useState(false);
  const jobPhaseRef = useRef('');
  /** 1s 轮询：后端 bytesPerSec 优先，前端按增量 EMA(0.7/0.3) 兜底；切 phase/browserId 归零 */
  const speedRef = useRef<SpeedSample>({ key: '', at: 0, bytes: 0, ema: 0, stall: 0 });

  const refresh = useCallback(async (force = false) => {
    if (force) setDetecting(true);
    try {
      const s = await api.browser.status(force);
      setStatus(s);
      setDraft((d) => d ?? s.settings);
      const j = s.job;
      const prev = jobPhaseRef.current;
      const now = j?.phase || '';
      if ((prev === 'downloading' || prev === 'extracting' || prev === 'verifying') && now === 'done') {
        toast.success(j.message || t('settings.installDone'));
      }
      if (prev !== now && now === 'error') {
        if (j?.errorCode === 'cancelled') toast.message(t('render.browser.cancelled'));
        else toast.error(j?.error || j?.message || t('settings.installFailed'));
      }
      jobPhaseRef.current = now;

      const key = j?.browserId ? `${j.browserId}|${j.phase}` : '';
      if (!j || j.phase !== 'downloading' || !j.browserId) {
        if (speedRef.current.key !== key) {
          speedRef.current = { key, at: 0, bytes: 0, ema: 0, stall: 0 };
          setSpeedBps(0);
          setStalled(false);
        }
      } else {
        const cur = speedRef.current;
        const at = Date.now();
        const backend = j.bytesPerSec && j.bytesPerSec > 0 ? j.bytesPerSec : 0;
        if (cur.key !== key || cur.at === 0 || cur.bytes > j.downloadedBytes) {
          speedRef.current = { key, at, bytes: j.downloadedBytes, ema: backend, stall: 0 };
          setSpeedBps(backend);
          setStalled(false);
        } else {
          const delta = j.downloadedBytes - cur.bytes;
          const inst = backend || Math.max(0, Math.round(delta * 1000 / Math.max(1, at - cur.at)));
          const ema = Math.round(0.7 * cur.ema + 0.3 * inst);
          const stall = delta <= 0 ? cur.stall + 1 : 0;
          speedRef.current = { key, at, bytes: j.downloadedBytes, ema, stall };
          setSpeedBps(stall >= 3 ? 0 : ema);
          setStalled(stall >= 3);
        }
      }
    } catch (e) {
      toast.error(errText(e));
    } finally {
      if (force) setDetecting(false);
    }
  }, [t]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const active = status?.job && ACTIVE_PHASES.includes(status.job.phase);
    // 安装中 1 秒轮询（进度实时）；平时 2.5 秒轮询，保证手动启动/暂停后状态能自动刷新，
    // 不必靠用户手动刷新页面。后台标签页不轮询，避免空转。
    const interval = active ? 1000 : 2500;
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void refresh();
    }, interval);
    return () => clearInterval(timer);
  }, [status?.job?.phase, refresh]);
  /** 取消中锁：直到 phase 变为 cancelled / idle / done 才解锁，防轮询延迟导致连点 */
  useEffect(() => {
    if (!canceling) return;
    const phase = status?.job?.phase;
    if (!phase || phase === 'idle' || phase === 'done' || (phase === 'error' && status?.job?.errorCode === 'cancelled')) {
      setCanceling(false);
    }
  }, [canceling, status?.job?.phase, status?.job?.errorCode]);

  const settingOf = (id: BrowserId): BrowserSetting =>
    draft?.[id] ?? status?.settings[id] ?? {
      mode: 'idle', port: 9333, idleGraceSec: 180, idleActiveSec: 30, headless: true, extraArgs: '',
    };

  const updateSetting = (id: BrowserId, patch: Partial<BrowserSetting>) => {
    setDraft((d) => {
      const base = d ?? status?.settings ?? ({} as BrowserSettings);
      return { ...base, [id]: { ...settingOf(id), ...patch } };
    });
  };

  const saveSetting = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      await api.browser.saveConfig(draft);
      toast.success(t('render.saved'));
      await refresh();
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); }
  };

  const doInstall = async (id: BrowserId) => {
    // 四档映射拦截：platform / source 不发 POST；degraded 放行并给提示
    const block = status?.installBlocks?.[id] ?? status?.browsers.find((b) => b.id === id)?.installBlock;
    const tier = blockTier(block);
    if (tier === 'platform' || tier === 'source') {
      toast.error(block?.reason || t(tier === 'platform' ? 'render.warn.platform' : 'render.warn.source'));
      return;
    }
    if (tier === 'degraded') toast.message(t('render.warn.degraded'));
    setBusy(true);
    try {
      const r = await api.browser.install(id);
      if (!r.ok) toast.error(r.message || t('settings.cannotStartInstall'));
      else toast.success(t('settings.installStarted'));
      await refresh();
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); }
  };

  const doCancel = async () => {
    setCanceling(true);
    try {
      const r = await api.browser.cancel();
      if (!r.ok) {
        toast.error(t('render.browser.cancelFailed'));
        setCanceling(false); // 接口失败：恢复按钮、strip 保持原进度
        return;
      }
      // 成功结局由 status 的 errorCode=cancelled 统一播报并解锁
      await refresh();
    } catch (e) {
      toast.error(errText(e));
      setCanceling(false);
    }
  };

  const doUninstall = async (id: BrowserId) => {
    setBusy(true);
    try {
      const r = await api.browser.uninstall(id);
      if (r.ok) toast.success(r.message); else toast.error(r.message);
      await refresh();
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); }
  };

  const doControl = async (id: BrowserId, action: 'start' | 'stop' | 'restart') => {
    setBusy(true);
    if (action !== 'stop') setStartingId(id);
    try {
      const r = await api.browser[action](id);
      if (!r.ok) toast.error(r.message || t('tip.operationFailed'));
      await refresh();
    } catch (e) { toast.error(errText(e)); }
    finally { setBusy(false); setStartingId(''); }
  };

  return (
    <div className="no-scrollbar flex h-full min-h-0 w-full flex-col gap-6 overflow-auto pt-1 lg:gap-8">
      <section>
        <SectionTitle title={t('render.section.image')} desc={t('render.section.image.desc')} />
        <SharpCard />
      </section>

      <section>
        <SectionTitle
          title={t('render.section.browser')}
          desc={t('render.browser.hint')}
          descHiddenOnMobile
          action={
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={detecting || busy}
              aria-label={t('render.browser.redetect')}
              onClick={() => { void refresh(true); }}
            >
              {detecting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <RotateCcw className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">
                {detecting ? t('render.browser.detecting') : t('render.browser.redetect')}
              </span>
            </Button>
          }
        />
        {status?.browsers.every((b) => !b.found && !b.runningProcess && !b.verified) ? (
          <p className="mb-3 text-xs text-[#D97706]">{t('render.browser.needInstall')}</p>
        ) : null}
        <div className="flex w-full min-w-0 flex-col gap-2.5">
          {[...BROWSER_ORDER]
            .sort((a, b) => {
              // 排序按「启动成功」优先：真正运行中的排最前；其次已装但未运行；再系统自带；最后未装/异常
              const score = (id2: BrowserId): number => {
                const info = status?.browsers.find((x) => x.id === id2);
                const rt = status?.runtimes.find((x) => x.id === id2);
                if (!info) return 9;
                // 启动成功 = 咔咔珂托管进程在跑，或检测到浏览器进程
                if (rt?.running || info.runningProcess) return 0;
                // 已由咔咔珂安装但未启动
                if (info.managed || info.verified) return 1;
                // 系统自带
                if (info.found) return 2;
                return 3;
              };
              return score(a) - score(b);
            })
            .map((id) => {
            const info = status?.browsers.find((b) => b.id === id);
            if (!info) return null;
            return (
              <BrowserCard
                key={id}
                info={info}
                runtime={status?.runtimes.find((r) => r.id === id)}
                setting={settingOf(id)}
                job={status?.job ?? EMPTY_JOB}
                installBlock={status?.installBlocks?.[id] ?? info.installBlock}
                speedBps={speedBps}
                stalled={stalled}
                busy={busy}
                detecting={detecting}
                starting={startingId === id}
                canceling={canceling}
                onInstall={() => { void doInstall(id); }}
                onCancel={() => { void doCancel(); }}
                onUninstall={() => { void doUninstall(id); }}
                onControl={(action) => { void doControl(id, action); }}
                onSetting={(patch) => updateSetting(id, patch)}
                onSaveSetting={() => { void saveSetting(); }}
                onRetryProbe={() => { void refresh(true); }}
                t={t}
              />
            );
          })}
        </div>
      </section>
    </div>
  );
}
