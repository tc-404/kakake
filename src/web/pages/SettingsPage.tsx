import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ExternalLink, Loader2, Compass, Eye, EyeOff, Wrench, Copy, CheckCircle2, AlertTriangle, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api, type SharpEnvState } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { copyToClipboard } from '@/lib/clipboard';
import type { KakakeConfig, LogLevel } from '@/lib/types';
import { DEFAULT_AI_MAX_STEPS, DEFAULT_KAKAKE_CONFIG } from '@/lib/types';
import {
  APPEARANCE_RANGES,
  BACKGROUND_ORIENTATIONS,
  CUSTOM_TITLE_MAX_LEN,
  DEFAULT_APPEARANCE_STATE,
  applyAppearance,
  backgroundKindFromFile,
  backgroundKindOf,
  backgroundUrl,
  cacheAppearance,
  hasCustomBackground,
  mergeAppearance,
  normalizeAppearance,
  normalizeCustomTitle,
  readCachedAppearance,
  type AppearanceSettings,
  type AppearanceState,
  type BackgroundFit,
  type BackgroundOrientation,
  type BackgroundPreset,
} from '@/lib/appearance';
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';
import {
  PLUGIN_STORE_OFFICIAL_URL,
  storeOriginLabel,
} from '@/lib/plugin-store-origin';
import type { StoreOrigin } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { AppearancePanel } from '@/components/appearance-panel';
import { BackgroundPresetPanel } from '@/components/background-preset-panel';
import type { BackgroundPreview } from '@/components/background-picker';
import { ColorPanel } from '@/components/color-panel';
import { WatermarkPanel } from '@/components/watermark-panel';
import { PerformanceModePanel } from '@/components/performance-mode-panel';
import { startProductTour } from '@/components/product-tour';
import { QuietExternal } from '@/components/quiet-link';
import { LanguageSwitcher } from '@/components/language-switcher';
import { errText, resText, svcText } from '@/lib/server-error';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select-menu';

function SettingsCard({
  title,
  description,
  children,
  className,
  tourId,
  extra,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  tourId?: string;
  /** 显示在标题右侧的附加信息（如状态徽标 / 操作按钮），与标题同一行 */
  extra?: ReactNode;
}) {
  return (
    <section
      data-tour={tourId}
      className={cn(
        'kk-glass flex h-full flex-col rounded-[1.25rem] p-5 sm:p-6',
        className,
      )}
    >
      <header className="mb-5 shrink-0">
        <div className="flex items-center justify-between gap-3">
          <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-800">
            {title}
          </h2>
          {extra ? (
            <div className="flex min-w-0 shrink-0 items-center gap-2">{extra}</div>
          ) : null}
        </div>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
        ) : null}
      </header>
      <div className="min-w-0 flex-1 space-y-4">{children}</div>
    </section>
  );
}

function FormRow({
  label,
  htmlFor,
  hint,
  error,
  children,
  align = 'center',
  tourId,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  align?: 'center' | 'start';
  tourId?: string;
}) {
  return (
    <div
      data-tour={tourId}
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:gap-4',
        align === 'center' ? 'sm:items-center' : 'sm:items-start',
      )}
    >
      <Label
        htmlFor={htmlFor}
        className="w-full shrink-0 text-sm font-medium text-slate-600 sm:w-32 sm:pt-0"
      >
        {label}
      </Label>
      <div className="min-w-0 flex-1 space-y-1.5">
        {children}
        {error ? (
          <p className="text-xs font-medium text-rose-500">{error}</p>
        ) : hint ? (
          <p className="text-xs text-slate-400">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

/** 带说明的开关卡：标题 + 一句解释 + 开关 */
function SwitchSettingCard({
  id,
  title,
  description,
  checked,
  onChange,
}: {
  id: string;
  title: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <section className="kk-glass kk-stagger-item kk-stagger-slow-4 flex items-center justify-between gap-4 rounded-[1.25rem] p-5 sm:p-6">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold tracking-tight text-slate-800">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        aria-label={title}
        className="shrink-0"
      />
    </section>
  );
}

/** 设置页分区：锚点标题 + 卡片网格（锚点跳转目标，product-tour 的卡片锚点仍在卡上） */
function SettingsSection({
  id,
  labelKey,
  children,
}: {
  id: string;
  labelKey: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section id={id} className="scroll-mt-2 space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-400">
          {t(labelKey)}
        </h2>
        <div aria-hidden className="h-px flex-1 bg-[hsl(var(--foreground)/0.18)]" />
      </div>
      {/* content-visibility：离屏卡片跳过渲染与合成（见 globals.css），长页滚动不再被 blur 层拖垮 */}
      <div className="kk-settings-grid grid grid-cols-1 content-start gap-6 lg:grid-cols-2 lg:gap-8">
        {children}
      </div>
    </section>
  );
}

/**
 * 禁用端口（>1023 的部分）：常见服务默认端口 + 连号/重复数字这类弱端口。
 * 这些端口扫描器必扫、也最容易被人猜出来，控制台暴露在上面风险太大，一律不允许保存。
 * 1–1023 是系统特权端口，另在 portIssue() 里单独拦。
 * 后端落盘侧的同一条规则在 core/listen-address.ts（normalizeListenPort），两边保持一致。
 */
const BLOCKED_PORTS = new Set<number>([
  // 常见服务（暴露面大）
  1080, 1433, 1521, 1723, 2049, 2375, 3128, 3306, 3389, 5432, 5900, 5984, 6379, 6443,
  8080, 8081, 8443, 8880, 8888, 9000, 9090, 9200, 9300, 11211, 27017, 27018,
  // 弱端口（连号 / 重复数字，极易被猜）
  1111, 1234, 2222, 3333, 4444, 5555, 6666, 7777, 9999, 12345, 54321,
]);

/** 系统特权端口上界（不含）：1–1023 一律不允许 */
const PRIVILEGED_PORT_MAX = 1024;

/**
 * 端口校验：返回 '' 表示可用，否则返回一条错误文案的 i18n key。
 * 行内报错与「自动保存前的拦截」共用它，保证「显示不允许」和「实际不允许保存」永远一致。
 */
function portIssue(raw: string): string {
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return 'settings.enterValidNumber';
  const n = Number(s);
  if (n < 1 || n > 65535) return 'settings.portRangeError';
  if (n < PRIVILEGED_PORT_MAX) return 'settings.portPrivilegedBlocked';
  if (BLOCKED_PORTS.has(n)) return 'settings.portWeakBlocked';
  return '';
}

/** 主机名（RFC 1123 简化版）：字母数字连字符的点分标签，与后端 normalizeListenHost 同一条规则 */
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function isDottedIPv4(s: string): boolean {
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(s)) return false;
  return s.split('.').every((p) => Number(p) <= 255);
}

/**
 * 监听地址校验：收 IPv4 / IPv6 / 主机名，空串按「未填，用 0.0.0.0」处理。
 * 纯数字标签（"123"、"999.999.999.999"）按打错的 IP 拒收——与后端同一条规则。
 */
function hostIssue(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  if (isDottedIPv4(s)) return '';
  if (s.includes(':')) {
    // IPv6 粗校验：只允许 hex 与冒号，冒号组数不超限。权威判定在后端 isIP。
    const ok = /^[0-9a-f:]{2,45}$/i.test(s) && (s.match(/:/g) ?? []).length <= 7;
    return ok ? '' : 'settings.hostInvalid';
  }
  if (/^\d+(\.\d+)*$/.test(s)) return 'settings.hostInvalid';
  return s.length <= 253 && HOSTNAME_RE.test(s) ? '' : 'settings.hostInvalid';
}

/** 背景图暂存：选好即上传应用，上传中的本地预览记在草稿里 */
type BackgroundDraft = {
  file: File | null;
  remove: boolean;
  /** 本地预览用的 objectURL，需在替换与卸载时回收 */
  url: string | null;
};

const EMPTY_BACKGROUND_DRAFT: BackgroundDraft = { file: null, remove: false, url: null };

function emptyBackgroundDrafts(): Record<BackgroundOrientation, BackgroundDraft> {
  return {
    portrait: { ...EMPTY_BACKGROUND_DRAFT },
    landscape: { ...EMPTY_BACKGROUND_DRAFT },
  };
}

function pickSettings(state: AppearanceState): AppearanceState {
  const out = {} as AppearanceState;
  // 按区间表取键，新增外观字段不用改这里
  for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceSettings)[]) {
    out[key] = state[key];
  }
  // 渐变色不属于数值区间表，单独带上（空串 = 未启用）
  out.inkGradient = state.inkGradient ?? '';
  out.compGradient = state.compGradient ?? '';
  out.logoGradient = state.logoGradient ?? '';
  // 页面水印同理：不在 RANGES 里，但必须进草稿，否则设置页读不到当前文字、
  // 保存时又会把它当「没提」而保持服务端旧值（表现为输入框永远是空的）
  out.watermarkText = state.watermarkText ?? '';
  return out;
}

/* ══════════════════════ 分区一：运行与安全 ══════════════════════ */

/**
 * 运行与安全分区：监听地址 / 运行参数 / 四个功能开关 / 登录防护。
 * 自成一个组件——别分区（外观滑条等）的重渲染不会打到这里，反之亦然。
 */
function RuntimeSection() {
  const t = useT();
  const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
    debug: t('settings.logLevelDebug'),
    info: t('settings.logLevelInfo'),
    warn: t('settings.logLevelWarn'),
    error: t('settings.logLevelError'),
  };

  const [config, setConfig] = useState<KakakeConfig>(DEFAULT_KAKAKE_CONFIG);
  /** 监听地址走「失焦才提交」：打字中间态（19 / 192.168.1.）不再被自动保存落盘 */
  const [hostText, setHostText] = useState('0.0.0.0');
  const [portText, setPortText] = useState('8787');
  const [timeoutText, setTimeoutText] = useState('120');
  const [stepsText, setStepsText] = useState(String(DEFAULT_AI_MAX_STEPS));
  const [loading, setLoading] = useState(true);
  const [hostTouched, setHostTouched] = useState(false);
  const [portTouched, setPortTouched] = useState(false);
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  const [stepsTouched, setStepsTouched] = useState(false);
  /** 拉到服务端配置后才允许自动保存，避免把加载值又原样写回 */
  const [configReady, setConfigReady] = useState(false);

  /** 最近一次成功保存的端口：输入非法时用它顶上，其余参数照常保存 */
  const lastGoodPort = useRef<number>(8787);
  /** 超时的同一条兜底（此前超时非法会拦下整份配置的自动保存） */
  const lastGoodTimeout = useRef<number>(120);
  /** AI 步数的同一条兜底 */
  const lastGoodSteps = useRef<number>(DEFAULT_AI_MAX_STEPS);

  useEffect(() => {
    api.settings
      .get()
      .then((r) => {
        setConfig(r.config);
        const port = r.config.port ?? 8787;
        lastGoodPort.current = port;
        setPortText(String(port));
        const timeoutSec = Math.round((r.config.apiTimeoutMs ?? 120000) / 1000);
        lastGoodTimeout.current = timeoutSec;
        setTimeoutText(String(timeoutSec));
        const steps = r.config.aiMaxSteps ?? DEFAULT_AI_MAX_STEPS;
        lastGoodSteps.current = steps;
        setStepsText(String(steps));
        setHostText(r.config.host || '0.0.0.0');
        setConfigReady(true);
      })
      .catch((e) => toast.error(errText(e)))
      .finally(() => setLoading(false));
  }, []);

  /** 运行参数 / 监听地址：改动即自动保存（防抖），不弹「已保存」气泡；端口/地址重启后生效 */
  const configSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipConfigSave = useRef(true);
  useEffect(() => {
    if (!configReady) return;
    // 跳过加载完成后的首次运行（那只是把服务端值填进表单）
    if (skipConfigSave.current) {
      skipConfigSave.current = false;
      return;
    }
    // 端口/超时非法时用上一次合法值顶上，其余参数照常保存
    const portValid = portIssue(portText) === '';
    const portToSave = portValid ? Number(portText) : lastGoodPort.current;
    const timeoutOk =
      /^\d+$/.test(timeoutText.trim()) && Number(timeoutText) >= 5 && Number(timeoutText) <= 600;
    const timeoutToSave = timeoutOk ? Number(timeoutText) : lastGoodTimeout.current;
    const stepsOk = /^\d+$/.test(stepsText.trim()) && Number(stepsText) >= 10 && Number(stepsText) <= 200;
    const stepsToSave = stepsOk ? Math.floor(Number(stepsText)) : lastGoodSteps.current;
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    configSaveTimer.current = setTimeout(() => {
      api.settings
        .save({
          ...config,
          host: config.host?.trim() || '0.0.0.0',
          token: '',
          port: portToSave,
          apiTimeoutMs: timeoutToSave * 1000,
          aiMaxSteps: stepsToSave,
        })
        .then(() => {
          if (portValid) lastGoodPort.current = portToSave;
          if (timeoutOk) lastGoodTimeout.current = timeoutToSave;
          if (stepsOk) lastGoodSteps.current = stepsToSave;
        })
        .catch(() => toast.error(t('settings.autoSaveFailed')));
    }, 500);
  }, [config, portText, timeoutText, stepsText, configReady, t]);

  // 卸载时清掉未触发的自动保存计时器
  useEffect(
    () => () => {
      if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    },
    [],
  );

  /** 失焦时才把监听地址提交进 config（触发自动保存）；非法值只留行内报错 */
  const commitHost = () => {
    setHostTouched(true);
    if (hostIssue(hostText) !== '') return;
    const normalized = hostText.trim() || '0.0.0.0';
    setConfig((c) => (c.host === normalized ? c : { ...c, host: normalized }));
  };

  const hostError = useMemo(() => {
    if (!hostTouched) return '';
    const issue = hostIssue(hostText);
    return issue ? t(issue) : '';
  }, [hostText, hostTouched, t]);

  const portError = useMemo(() => {
    if (!portTouched) return '';
    const issue = portIssue(portText);
    return issue ? t(issue) : '';
  }, [portText, portTouched, t]);

  const timeoutError = useMemo(() => {
    if (!timeoutTouched) return '';
    if (!/^\d+$/.test(timeoutText.trim())) return t('settings.enterValidNumber');
    const n = Number(timeoutText);
    if (n < 5 || n > 600) return t('settings.timeoutRangeError');
    return '';
  }, [timeoutText, timeoutTouched, t]);

  const stepsError = useMemo(() => {
    if (!stepsTouched) return '';
    if (!/^\d+$/.test(stepsText.trim())) return t('settings.enterValidNumber');
    const n = Number(stepsText);
    if (n < 10 || n > 200) return t('settings.aiStepsRangeError');
    return '';
  }, [stepsText, stepsTouched, t]);

  const restartHint = t('settings.restartHint');

  if (loading) {
    return (
      <div className="flex w-full items-center gap-2 py-16 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('label.loading')}
      </div>
    );
  }

  return (
    <SettingsSection id="kk-sec-runtime" labelKey="settings.sectionRuntime">
      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-2"
        title={t('settings.listenAddress')}
        tourId="settings-listen"
      >
        <div className="space-y-4">
          <FormRow
            label={t('settings.listenAddress')}
            htmlFor="host"
            tourId="row-host"
            hint={restartHint}
            error={hostError || undefined}
          >
            <Input
              id="host"
              value={hostText}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              aria-invalid={hostError ? true : undefined}
              onChange={(e) => {
                setHostText(e.target.value);
                setHostTouched(true);
              }}
              onBlur={commitHost}
              placeholder="0.0.0.0"
            />
          </FormRow>
          <FormRow
            label={t('settings.backendPort')}
            htmlFor="port"
            tourId="row-port"
            hint={restartHint}
            error={portError || undefined}
          >
            <Input
              id="port"
              inputMode="numeric"
              autoComplete="off"
              value={portText}
              aria-invalid={portError ? true : undefined}
              onChange={(e) => {
                setPortText(e.target.value);
                setPortTouched(true);
              }}
              onBlur={() => setPortTouched(true)}
              placeholder="8787"
            />
          </FormRow>
        </div>
      </SettingsCard>

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-3"
        title={t('settings.runtimeParams')}
        tourId="settings-runtime"
      >
        <div className="space-y-4">
          <FormRow label={t('settings.logLevel')} htmlFor="logLevel" tourId="row-loglevel">
            <Select
              value={config.logLevel}
              onValueChange={(v) => setConfig((c) => ({ ...c, logLevel: v as LogLevel }))}
            >
              <SelectTrigger id="logLevel" aria-label={t('settings.logLevel')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['debug', 'info', 'warn', 'error'] as const).map((v) => (
                  <SelectItem key={v} value={v}>
                    {LOG_LEVEL_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormRow>
          <FormRow
            label={t('settings.apiTimeout')}
            htmlFor="timeout"
            tourId="row-timeout"
            error={timeoutError || undefined}
          >
            <Input
              id="timeout"
              inputMode="numeric"
              autoComplete="off"
              value={timeoutText}
              aria-invalid={timeoutError ? true : undefined}
              onChange={(e) => {
                setTimeoutText(e.target.value);
                setTimeoutTouched(true);
              }}
              onBlur={() => setTimeoutTouched(true)}
              placeholder="120"
            />
          </FormRow>
          <FormRow
            label={t('settings.aiMaxSteps')}
            htmlFor="aiMaxSteps"
            hint={t('settings.aiStepsHint')}
            error={stepsError || undefined}
          >
            <Input
              id="aiMaxSteps"
              inputMode="numeric"
              autoComplete="off"
              value={stepsText}
              aria-invalid={stepsError ? true : undefined}
              onChange={(e) => {
                setStepsText(e.target.value);
                setStepsTouched(true);
              }}
              onBlur={() => {
                // 失焦取整收口：空串/越界回退最近合法值，行内报错只做提示
                const n = Math.floor(Number(stepsText.trim()));
                if (!Number.isFinite(n) || n < 10 || n > 200) setStepsText(String(lastGoodSteps.current));
                else setStepsText(String(n));
                setStepsTouched(true);
              }}
              placeholder={String(DEFAULT_AI_MAX_STEPS)}
            />
          </FormRow>
        </div>
      </SettingsCard>

      <SwitchSettingCard
        id="publicApi"
        title={t('settings.publicApi')}
        description={t('settings.publicApiDesc')}
        checked={config.publicApiEnabled}
        onChange={(v) => setConfig((c) => ({ ...c, publicApiEnabled: v }))}
      />

      <SwitchSettingCard
        id="proxyApi"
        title={t('settings.proxyApi')}
        description={t('settings.proxyApiDesc')}
        checked={config.proxyApiEnabled}
        onChange={(v) => setConfig((c) => ({ ...c, proxyApiEnabled: v }))}
      />

      <SwitchSettingCard
        id="inboundGuard"
        title={t('settings.inboundGuard')}
        description={t('settings.inboundGuardDesc')}
        checked={config.inboundGuard !== false}
        onChange={(v) => setConfig((c) => ({ ...c, inboundGuard: v }))}
      />

      <SwitchSettingCard
        id="logToFile"
        title={t('settings.logToFile')}
        description={t('settings.logToFileDesc')}
        checked={config.logToFile !== false}
        onChange={(v) => setConfig((c) => ({ ...c, logToFile: v }))}
      />

      <LoginGuardCard />
    </SettingsSection>
  );
}

/** 登录防护卡：状态 + 指标 + 一键解封。自成组件，状态变化不打扰其他卡片 */
function LoginGuardCard() {
  const t = useT();
  const [loginGuard, setLoginGuard] = useState<{
    pressure: boolean;
    globalLockedMs: number;
    failsInWindow: number;
    distinctSources: number;
    trustedSources: number;
  } | null>(null);

  const loadLoginGuard = useCallback(() => {
    api.loginGuard
      .state()
      .then((r) => setLoginGuard(r))
      .catch(() => { /* 读不到就不显示这一块，不打扰主流程 */ });
  }, []);
  useEffect(() => {
    loadLoginGuard();
  }, [loadLoginGuard]);

  return (
    <SettingsCard
      className="kk-stagger-item kk-stagger-slow-7 lg:col-span-2"
      title={t('settings.loginGuard')}
      tourId="settings-login-guard"
      extra={
        loginGuard ? (
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              loginGuard.globalLockedMs > 0 || loginGuard.pressure
                ? 'bg-amber-500/10 text-amber-700'
                : 'bg-teal-500/10 text-teal-700',
            )}
          >
            {loginGuard.globalLockedMs > 0 || loginGuard.pressure ? (
              <AlertTriangle className="h-3.5 w-3.5" />
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5" />
            )}
            {loginGuard.globalLockedMs > 0
              ? t('settings.loginGuardLocked')
              : loginGuard.pressure
                ? t('settings.loginGuardPressure')
                : t('settings.loginGuardNormal')}
          </span>
        ) : null
      }
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('settings.loginGuardDesc')}
        </p>
        {loginGuard ? (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-muted-foreground">
            <span>
              {t('settings.loginGuardFails')}{' '}
              <span className="font-semibold">{loginGuard.failsInWindow}</span>
            </span>
            <span>
              {t('settings.loginGuardSources')}{' '}
              <span className="font-semibold">{loginGuard.distinctSources}</span>
            </span>
            <span>
              {t('settings.loginGuardTrusted')}{' '}
              <span className="font-semibold">{loginGuard.trustedSources}</span>
            </span>
          </div>
        ) : null}
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              api.loginGuard
                .clear()
                .then(() => {
                  toast.success(t('settings.loginGuardCleared'));
                  loadLoginGuard();
                })
                .catch(() => toast.error(t('settings.loginGuardClearFailed')));
            }}
          >
            {t('settings.loginGuardClear')}
          </Button>
        </div>
      </div>
    </SettingsCard>
  );
}

/* ══════════════════════ 分区二：外观与主题 ══════════════════════ */

/**
 * 外观与主题分区：自定义标题 / 界面外观 / 配色 / 水印 / 性能模式 / 背景预设。
 * 这些全部共用一份外观草稿——拖动滑条只会重渲染本分区，其他分区完全不受打扰。
 */
function AppearanceSection() {
  const t = useT();
  /** 服务端已保存的外观（含背景图元信息） */
  const [appearance, setAppearance] = useState<AppearanceState>(DEFAULT_APPEARANCE_STATE);
  /** 设备档位：背景预设的性能说明与波浪可用性 */
  const deviceTier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部品牌字）；输入即存，刷新后生效 */
  const [titleText, setTitleText] = useState('');
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const titleTextRef = useRef('');
  titleTextRef.current = titleText;
  /** 表单里正在调的外观数值与渐变色 */
  const [appearanceDraft, setAppearanceDraft] = useState<AppearanceState>(DEFAULT_APPEARANCE_STATE);
  const [bgDrafts, setBgDrafts] = useState(emptyBackgroundDrafts);
  const bgDraftsRef = useRef(bgDrafts);
  bgDraftsRef.current = bgDrafts;
  /** 已保存的外观，离开页面时用它回滚未保存的预览 */
  const savedAppearanceRef = useRef(appearance);
  savedAppearanceRef.current = appearance;
  /** 最新草稿的 ref：防抖保存、卸载补存等脱离渲染闭包的场合读取用 */
  const appearanceDraftRef = useRef(appearanceDraft);
  appearanceDraftRef.current = appearanceDraft;
  /** 外观数值自动保存 / 本地缓存写入的防抖计时器 */
  const appearanceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appearanceCacheTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 还在上传中的背景方向：其本地预览不能被其他外观提交回收 */
  const pendingUploads = useRef(new Set<BackgroundOrientation>());

  useEffect(() => {
    api.appearance
      .get()
      .then((r) => {
        // 渐变字段在旧版后端的返回里不存在（undefined），用本地缓存兜底，避免选好的渐变被冲掉
        const state = mergeAppearance(readCachedAppearance(), r.appearance);
        setAppearance(state);
        setAppearanceDraft(pickSettings(state));
        setTitleText(state.customTitle);
      })
      .catch(() => { /* 外观拉不到就沿用默认值，不打断设置页 */ });
  }, []);

  // 卸载时回收所有本地预览 URL
  useEffect(() => () => {
    for (const draft of Object.values(bgDraftsRef.current)) {
      if (draft.url) URL.revokeObjectURL(draft.url);
    }
  }, []);

  /** 外观数值与渐变色：即时生效，缓存与落库共用防抖；接口失败只提示不回滚草稿 */
  const pushAppearance = (patch: Partial<AppearanceState>) => {
    // 草稿走 ref 同步累加，副作用放 updater 外（StrictMode 会双调用 updater）
    const next = { ...appearanceDraftRef.current, ...patch };
    appearanceDraftRef.current = next;
    setAppearanceDraft(next);
    const nextState = normalizeAppearance({ ...savedAppearanceRef.current, ...next });
    applyAppearance(nextState);
    setAppearance(nextState);
    if (appearanceCacheTimer.current) clearTimeout(appearanceCacheTimer.current);
    appearanceCacheTimer.current = setTimeout(() => cacheAppearance(nextState), 400);
    if (appearanceSaveTimer.current) clearTimeout(appearanceSaveTimer.current);
    appearanceSaveTimer.current = setTimeout(() => {
      api.appearance.save(next).catch(() => toast.error(t('settings.appearanceAutoSaveFailed')));
    }, 400);
  };

  /**
   * 立即把未落库的外观草稿存掉（有防抖在排程才发请求）。
   * 背景图 / 背景适配等操作会返回服务端完整快照并覆盖本地草稿，
   * 先把挂起的配色改动冲进后端，快照才不会带着旧值把新配色冲掉。
   */
  const flushAppearanceSave = () => {
    if (!appearanceSaveTimer.current) return;
    clearTimeout(appearanceSaveTimer.current);
    appearanceSaveTimer.current = null;
    const draft = appearanceDraftRef.current;
    api.appearance.save(draft).catch(() => toast.error(t('settings.appearanceAutoSaveFailed')));
  };

  // 卸载时把未落库的最后一次外观改动补存、缓存立刻写盘（防抖计时器随卸载作废）
  useEffect(() => () => {
    if (appearanceSaveTimer.current) {
      clearTimeout(appearanceSaveTimer.current);
      appearanceSaveTimer.current = null;
      void api.appearance.save(appearanceDraftRef.current).catch(() => { /* 页面已卸载，尽力而为 */ });
    }
    if (appearanceCacheTimer.current) {
      clearTimeout(appearanceCacheTimer.current);
      appearanceCacheTimer.current = null;
      cacheAppearance(savedAppearanceRef.current);
    }
  }, []);

  // 卸载时补存未落库的标题改动（只清定时器的话会静默丢）
  useEffect(() => () => {
    if (titleSaveTimer.current) {
      clearTimeout(titleSaveTimer.current);
      titleSaveTimer.current = null;
      void api.appearance
        .saveTitle(normalizeCustomTitle(titleTextRef.current))
        .catch(() => { /* 页面已卸载，尽力而为 */ });
    }
  }, []);

  const commitAppearance = (state: AppearanceState) => {
    // 合并式提交：服务端快照没带渐变字段（旧版后端）时沿用当前值，显式空串才真正清掉
    const normalized = mergeAppearance(appearance, state);
    setAppearance(normalized);
    setAppearanceDraft(pickSettings(normalized));
    setBgDrafts((prev) => {
      const next = { ...prev };
      for (const orientation of BACKGROUND_ORIENTATIONS) {
        // 仍在上传中的方向保留其本地预览，等它自己的请求收尾再清
        if (pendingUploads.current.has(orientation)) continue;
        if (next[orientation].url) URL.revokeObjectURL(next[orientation].url);
        next[orientation] = { ...EMPTY_BACKGROUND_DRAFT };
      }
      return next;
    });
    applyAppearance(normalized);
    cacheAppearance(normalized);
  };

  const previews = useMemo(() => {
    const out: Record<BackgroundOrientation, BackgroundPreview | null> = {
      portrait: null, landscape: null,
    };
    for (const orientation of BACKGROUND_ORIENTATIONS) {
      const draft = bgDrafts[orientation];
      if (draft.url) {
        // 本地草稿的预览类型按文件判；连 URL 一起给出，图片视频各自成景
        if (draft.file) {
          out[orientation] = {
            url: draft.url,
            kind: backgroundKindFromFile(draft.file),
          };
        }
        continue;
      }
      if (draft.remove) continue;
      const meta = appearance.backgrounds[orientation];
      if (meta) out[orientation] = { url: backgroundUrl(orientation, meta), kind: backgroundKindOf(meta) };
    }
    return out;
  }, [bgDrafts, appearance]);

  /** 选背景图：立即上传并全局应用（背景也属外观，不走保存按钮） */
  const pickBackground = (orientation: BackgroundOrientation, file: File) => {
    flushAppearanceSave();
    // 先给一个本地预览，接口返回后再切成正式地址
    setBgDrafts((prev) => {
      if (prev[orientation].url) URL.revokeObjectURL(prev[orientation].url!);
      return { ...prev, [orientation]: { file, remove: false, url: URL.createObjectURL(file) } };
    });
    pendingUploads.current.add(orientation);
    void (async () => {
      try {
        const r = await api.appearance.uploadBackground(orientation, file);
        if (!r.ok) throw new Error(r.message || '背景图上传失败');
        pendingUploads.current.delete(orientation);
        if (r.appearance) commitAppearance(r.appearance);
      } catch (e) {
        pendingUploads.current.delete(orientation);
        toast.error(errText(e) || t('settings.bgUploadFailed'));
        // 只清失败这一个方向（另一个方向可能还在上传），并回收它的预览 URL
        setBgDrafts((prev) => {
          const draft = prev[orientation];
          if (draft.url) URL.revokeObjectURL(draft.url);
          return { ...prev, [orientation]: { ...EMPTY_BACKGROUND_DRAFT } };
        });
      }
    })();
  };

  /** 背景适配方式：点了即存即生效（与背景图一样，不走保存按钮） */
  const changeBackgroundFit = (fit: BackgroundFit) => {
    if (appearance.bgFit === fit) return;
    flushAppearanceSave();
    // 先本地生效（立即重铺背景），失败再回滚
    const prev = appearance;
    commitAppearance({ ...appearance, bgFit: fit });
    void (async () => {
      try {
        const r = await api.appearance.saveBackgroundFit(fit);
        if (!r.ok) throw new Error('保存失败');
        if (r.appearance) commitAppearance(r.appearance);
      } catch {
        toast.error(t('settings.bgFitSaveFailed'));
        commitAppearance(prev);
      }
    })();
  };

  /**
   * 背景预设（默认 / 波浪）：点了即存即生效。
   * 与背景适配方式同一套路：先本地生效，接口失败再回滚。
   */
  const changeBackgroundPreset = (preset: BackgroundPreset) => {
    if (appearance.bgPreset === preset) return;
    flushAppearanceSave();
    const prev = appearance;
    commitAppearance({ ...appearance, bgPreset: preset });
    void (async () => {
      try {
        const r = await api.appearance.saveBackgroundPreset(preset);
        if (!r.ok) throw new Error('保存失败');
        if (r.appearance) commitAppearance(r.appearance);
      } catch {
        toast.error(t('settings.bgPresetSaveFailed'));
        commitAppearance(prev);
      }
    })();
  };

  /**
   * 自定义标题名：输入即存（防抖），无保存按钮。
   * 同步进本地缓存与已保存外观（保持 savedAppearanceRef 一致，避免其它外观保存把标题冲掉），
   * 但不调用 applyAppearance——按需求「刷新网页后」才在置顶栏/侧边栏生效。
   */
  const changeTitle = (raw: string) => {
    setTitleText(raw);
    const title = normalizeCustomTitle(raw);
    setAppearance((prev) => {
      const nextState = { ...prev, customTitle: title };
      cacheAppearance(nextState);
      return nextState;
    });
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
    titleSaveTimer.current = setTimeout(() => {
      api.appearance.saveTitle(title).catch(() => toast.error(t('settings.titleAutoSaveFailed')));
    }, 500);
  };

  /** 恢复默认外观：数值 / 渐变 / 背景 / 标题 / 水印全部回出厂（后端已有接口，此前没有入口） */
  const resetAppearance = () => {
    void api.appearance
      .reset()
      .then((r) => {
        if (!r.ok) {
          toast.error(resText(r) || t('settings.resetAppearanceFailed'));
          return;
        }
        if (r.appearance) {
          pendingUploads.current.clear();
          commitAppearance(r.appearance);
          setTitleText(r.appearance.customTitle);
        }
        toast.success(t('settings.resetAppearanceDone'));
      })
      .catch((e) => toast.error(errText(e) || t('settings.resetAppearanceFailed')));
  };

  return (
    <SettingsSection id="kk-sec-appearance" labelKey="settings.sectionAppearance">
      {/* 自定义标题：标题 + 输入框同一行，不折行、不加说明文字 */}
      <section
        data-tour="settings-title"
        className="kk-glass kk-stagger-item kk-stagger-slow-4 rounded-[1.25rem] p-5 sm:p-6 lg:col-span-2"
      >
        <div data-tour="row-title" className="flex items-center gap-3 sm:gap-4">
          <Label
            htmlFor="customTitle"
            className="w-20 shrink-0 whitespace-nowrap text-base font-semibold tracking-tight text-slate-800 sm:w-24 sm:text-lg"
          >
            {t('settings.customTitle')}
          </Label>
          <Input
            id="customTitle"
            className="min-w-0 flex-1"
            value={titleText}
            onChange={(e) => changeTitle(e.target.value)}
            maxLength={CUSTOM_TITLE_MAX_LEN}
            placeholder={t('brand.kakake')}
            autoComplete="off"
          />
        </div>
      </section>

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-4 lg:col-span-2"
        title={t('settings.appearance')}
        tourId="settings-appearance"
        extra={
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 rounded-lg px-2.5 text-xs"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.resetAppearance')}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t('settings.resetAppearanceTitle')}</AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.resetAppearanceDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('btn.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={resetAppearance}>
                  {t('settings.resetAppearanceConfirm')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        }
      >
        <AppearancePanel
          settings={appearanceDraft}
          previews={previews}
          disabled={false}
          onChange={pushAppearance}
          onPickBackground={pickBackground}
          onClearBackground={clearBackground}
          bgFit={appearance.bgFit}
          onChangeBgFit={changeBackgroundFit}
        />
      </SettingsCard>

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-5 lg:col-span-2"
        title={t('settings.colorScheme')}
        tourId="settings-color"
      >
        <ColorPanel
          settings={appearanceDraft}
          disabled={false}
          onChange={pushAppearance}
        />
      </SettingsCard>

      {/*
        页面水印：文字属于「全局字体」配色角色（颜色不可单独调），
        非空即开启、清空即关闭，铺满 8787 下的所有界面且高于全部悬浮窗。
        卡片内部只有「标题 + 输入框 + 开关」一行，外加三根滑动条。
      */}
      <section
        data-tour="settings-watermark"
        className="kk-glass kk-stagger-item kk-stagger-slow-5 rounded-[1.25rem] p-5 sm:p-6 lg:col-span-2"
      >
        <WatermarkPanel
          settings={appearanceDraft}
          disabled={false}
          onChange={pushAppearance}
        />
      </section>

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-5 lg:col-span-2"
        title={t('settings.performanceMode')}
        description={t('settings.performanceModeDesc')}
        tourId="settings-performance"
      >
        <PerformanceModePanel />
      </SettingsCard>

      {/* 低配档照常显示（禁用 + 说明），整卡隐藏会显得「开过的东西自己不见了」 */}
      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-5 lg:col-span-2"
        title={t('settings.backgroundPreset')}
        description={t('settings.backgroundPresetDesc')}
        tourId="settings-bg-preset"
      >
        <BackgroundPresetPanel
          value={appearance.bgPreset}
          onChange={changeBackgroundPreset}
          suppressed={hasCustomBackground(appearance)}
          disabled={deviceTier === 'low'}
        />
      </SettingsCard>
    </SettingsSection>
  );

  /** 移除背景图：立即删除并全局应用 */
  function clearBackground(orientation: BackgroundOrientation) {
    flushAppearanceSave();
    const hadSaved = !!appearance.backgrounds[orientation];
    setBgDrafts((prev) => {
      const draft = prev[orientation];
      if (draft.url) URL.revokeObjectURL(draft.url);
      return { ...prev, [orientation]: { file: null, remove: false, url: null } };
    });
    if (!hadSaved) return;
    void (async () => {
      try {
        const r = await api.appearance.deleteBackground(orientation);
        if (!r.ok) throw new Error(r.message || '背景图移除失败');
        if (r.appearance) commitAppearance(r.appearance);
      } catch (e) {
        toast.error(errText(e) || t('settings.bgRemoveFailed'));
      }
    })();
  }
}

/* ══════════════════════ 分区三：资源与商店 ══════════════════════ */

/** 资源商店来源切换卡：滑动高亮的两段选择条，点了即存 */
function StoreOriginCard() {
  const t = useT();
  const [storeOrigin, setStoreOrigin] = useState<StoreOrigin>('kakake');
  const [storeOriginSaving, setStoreOriginSaving] = useState(false);

  useEffect(() => {
    api.pluginStore
      .origin()
      .then((r) => {
        if (r.ok && (r.origin === 'kakake' || r.origin === 'github')) {
          setStoreOrigin(r.origin);
        }
      })
      .catch(() => { /* 保持默认 */ });
  }, []);

  const changeStoreOrigin = (next: StoreOrigin) => {
    if (next === storeOrigin || storeOriginSaving) return;
    const prev = storeOrigin;
    setStoreOrigin(next);
    setStoreOriginSaving(true);
    api.pluginStore
      .setOrigin(next)
      .then((r) => {
        if (!r.ok) {
          setStoreOrigin(prev);
          toast.error(resText(r) || t('settings.switchSourceFailed'));
        } else {
          toast.success(t('settings.switchedTo', { name: storeOriginLabel(next, t) }));
        }
      })
      .catch((e) => {
        setStoreOrigin(prev);
        toast.error(errText(e));
      })
      .finally(() => setStoreOriginSaving(false));
  };

  return (
    <SettingsCard
      className="kk-stagger-item kk-stagger-slow-6"
      title={t('settings.storeOrigin')}
      tourId="settings-store-origin"
    >
      <div
        role="tablist"
        aria-label={t('settings.storeOrigin')}
        className="relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm"
      >
        {/* 滑动高亮指示器：在两个选项之间平滑滑动，而非瞬间切换 */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-xl bg-teal-500/90 shadow-md kk-glow transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
          style={{ transform: storeOrigin === 'github' ? 'translateX(100%)' : 'translateX(0)' }}
        />
        {(['kakake', 'github'] as StoreOrigin[]).map((key) => {
          const active = storeOrigin === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={storeOriginSaving}
              onClick={() => changeStoreOrigin(key)}
              className={cn(
                'relative z-10 flex h-10 flex-1 items-center justify-center gap-1.5 rounded-xl text-sm font-medium transition-colors duration-200 disabled:opacity-60',
                active ? 'text-white' : 'text-slate-600 hover:text-slate-800',
              )}
            >
              {storeOriginSaving && active ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : null}
              {storeOriginLabel(key, t)}
            </button>
          );
        })}
      </div>
    </SettingsCard>
  );
}

/** GitHub API Token 卡：填了提升商店限流额度，保存即校验并展示余量 */
function GithubTokenCard() {
  const t = useT();
  const [ghToken, setGhToken] = useState('');
  const [ghTokenSaved, setGhTokenSaved] = useState('');
  const [ghTokenShow, setGhTokenShow] = useState(false);
  const [ghTokenSaving, setGhTokenSaving] = useState(false);
  const [ghQuota, setGhQuota] = useState<{ remaining: number; limit: number } | null>(null);

  useEffect(() => {
    api.settings
      .githubToken()
      .then((r) => {
        if (r.ok) {
          setGhToken(r.token);
          setGhTokenSaved(r.token);
        }
      })
      .catch(() => { /* 保持空值 */ });
  }, []);

  const saveGithubToken = () => {
    if (ghTokenSaving) return;
    setGhTokenSaving(true);
    api.settings
      .saveGithubToken(ghToken.trim())
      .then((r) => {
        if (!r.ok) {
          toast.error(resText(r) || t('settings.saveFailed'));
          return;
        }
        setGhToken(r.token);
        setGhTokenSaved(r.token);
        if (!r.token) {
          setGhQuota(null);
          toast.success(t('settings.ghTokenCleared'));
          return;
        }
        const v = r.verify;
        if (v?.valid) {
          setGhQuota(
            typeof v.remaining === 'number' && typeof v.limit === 'number'
              ? { remaining: v.remaining, limit: v.limit }
              : null,
          );
          toast.success(t('settings.tokenSavedVerified'));
        } else {
          setGhQuota(null);
          toast.error(resText(v) || t('settings.tokenVerifyFailed'));
        }
      })
      .catch((e) => toast.error(errText(e)))
      .finally(() => setGhTokenSaving(false));
  };

  return (
    <SettingsCard className="kk-stagger-item kk-stagger-slow-6" title="GitHub API Token" tourId="settings-github">
      <div className="flex items-center gap-2">
        <Input
          id="github-token"
          type={ghTokenShow ? 'text' : 'password'}
          value={ghToken}
          onChange={(e) => setGhToken(e.target.value)}
          placeholder={t('settings.githubTokenPlaceholder')}
          // 用 new-password 而不是 off：Chromium 会忽略密码框上的 off，
          // 按登录密码框处理并强铺一层不透明的自动填充底色，盖掉透明与毛玻璃。
          autoComplete="new-password"
          spellCheck={false}
          // kk-field：Input 基类里的 bg-white/20 + border-white/30 + backdrop-blur-sm
          // 都是写死值，外观设置管不到它；换成受控槽后透明度 / 模糊 / 阴影一起走
          className="kk-field h-9 flex-1 font-mono text-xs"
        />
        <Button
          type="button"
          variant="outline"
          className="h-9 shrink-0 px-2.5"
          aria-label={ghTokenShow ? t('settings.hideToken') : t('settings.showToken')}
          onClick={() => setGhTokenShow((v) => !v)}
        >
          {ghTokenShow ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button
          type="button"
          className="h-9 shrink-0"
          disabled={ghTokenSaving || ghToken.trim() === ghTokenSaved}
          onClick={saveGithubToken}
        >
          {ghTokenSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {t('btn.save')}
        </Button>
      </div>
      <p className="text-xs leading-relaxed text-slate-400">
        {t('settings.ghTokenNewPrefix')}
        {' '}
        <QuietExternal
          href="https://github.com/settings/tokens"
          className="text-teal-600 underline decoration-dotted underline-offset-2 hover:text-teal-700"
        >
          github.com/settings/tokens
        </QuietExternal>
        {' '}
        {t('settings.ghTokenNewSuffix')}
      </p>
      {ghQuota ? (
        <p className="text-xs text-teal-600">
          {t('settings.ghQuotaPrefix')}
          {' '}
          {ghQuota.remaining}
          {' '}
          /
          {' '}
          {ghQuota.limit}
          {' '}
          {t('settings.ghQuotaSuffix')}
        </p>
      ) : null}
    </SettingsCard>
  );
}

/**
 * 多线程下载卡：只有名字 + 开关，无任何说明文字；开启后才出现生效范围与阈值配置，
 * 阈值输入框又只在「大文件」模式下出现——整卡高度随内容收缩，不预留占位。
 * 独占一整行挂在「环境与帮助」分区末尾，避免和对半网格互相拉伸。
 * 仅对 GitHub/URL 直链源生效，咔咔珂源后端固定单流。
 */
function MultiThreadCard() {
  const t = useT();
  const [cfg, setCfg] = useState<{
    multiThread: boolean;
    mode: 'always' | 'minSize';
    minSizeMB: number;
  } | null>(null);
  const [minSizeText, setMinSizeText] = useState('4');

  useEffect(() => {
    api.pluginStore
      .downloadConfig()
      .then((r) => {
        if (r.ok) {
          setCfg({
            multiThread: !!r.multiThread,
            mode: r.mode === 'always' ? 'always' : 'minSize',
            minSizeMB: r.minSizeMB,
          });
          setMinSizeText(String(r.minSizeMB));
        }
      })
      .catch(() => { /* 加载失败保持关闭态 */ });
  }, []);

  const save = (patch: { multiThread?: boolean; mode?: 'always' | 'minSize'; minSizeMB?: number }) => {
    if (!cfg) return;
    const prev = cfg;
    setCfg({ ...cfg, ...patch });
    api.pluginStore
      .setDownloadConfig(patch)
      .then((r) => {
        if (r.ok) {
          setCfg({
            multiThread: r.multiThread,
            mode: r.mode === 'always' ? 'always' : 'minSize',
            minSizeMB: r.minSizeMB,
          });
        } else {
          setCfg(prev);
          toast.error(resText(r) || t('settings.multiThreadSaveFailed'));
        }
      })
      .catch((e) => {
        setCfg(prev);
        toast.error(errText(e) || t('settings.multiThreadSaveFailed'));
      });
  };

  return (
    <section className="kk-glass kk-stagger-item kk-stagger-slow-6 flex flex-col rounded-[1.25rem] p-5 sm:p-6 lg:col-span-2">
      <div className="flex items-center justify-between gap-4">
        <h2 className="min-w-0 truncate text-lg font-semibold tracking-tight text-slate-800">
          {t('settings.multiThread')}
        </h2>
        <Switch
          checked={cfg?.multiThread ?? false}
          disabled={!cfg}
          onCheckedChange={(v) => save({ multiThread: v })}
          aria-label={t('settings.multiThread')}
          className="shrink-0"
        />
      </div>
      {cfg?.multiThread ? (
        <div className="mt-5 space-y-4 border-t border-white/40 pt-5">
          <FormRow label={t('settings.multiThreadScope')} htmlFor="mt-scope">
            <div
              role="tablist"
              aria-label={t('settings.multiThreadScope')}
              className="relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm"
            >
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-xl bg-teal-500/90 shadow-md kk-glow transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
                style={{ transform: cfg.mode === 'minSize' ? 'translateX(100%)' : 'translateX(0)' }}
              />
              {(['always', 'minSize'] as const).map((key) => {
                const active = cfg.mode === key;
                return (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => save({ mode: key })}
                    className={cn(
                      'relative z-10 flex h-9 flex-1 items-center justify-center rounded-xl text-sm font-medium transition-colors duration-200',
                      active ? 'text-white' : 'text-slate-600 hover:text-slate-800',
                    )}
                  >
                    {key === 'always' ? t('settings.multiThreadAll') : t('settings.multiThreadMinSize')}
                  </button>
                );
              })}
            </div>
          </FormRow>
          {cfg.mode === 'minSize' ? (
            <FormRow label={t('settings.multiThreadThreshold')} htmlFor="mt-min-size">
              <div className="flex items-center gap-2">
                <Input
                  id="mt-min-size"
                  type="number"
                  min={1}
                  max={1024}
                  value={minSizeText}
                  onChange={(e) => setMinSizeText(e.target.value)}
                  onBlur={() => {
                    const n = Math.round(Number(minSizeText.trim()));
                    if (!Number.isFinite(n)) {
                      setMinSizeText(String(cfg.minSizeMB));
                      return;
                    }
                    const clamped = Math.min(1024, Math.max(1, n));
                    setMinSizeText(String(clamped));
                    if (clamped !== cfg.minSizeMB) save({ minSizeMB: clamped });
                  }}
                  className="kk-field h-9 w-28 text-sm"
                />
                <span className="text-sm text-slate-500">MB</span>
              </div>
            </FormRow>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function StoreSection() {
  const t = useT();
  return (
    <SettingsSection id="kk-sec-store" labelKey="settings.sectionStore">
      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-6"
        title={t('settings.resourceWebsite')}
        tourId="settings-resource"
      >
        <QuietExternal
          href={PLUGIN_STORE_OFFICIAL_URL}
          className="inline-flex w-full items-center gap-2 rounded-xl border border-white/40 bg-white/20 px-3.5 py-2.5 text-sm text-teal-700 backdrop-blur-sm transition-colors hover:bg-white/30 hover:text-teal-800"
        >
          <ExternalLink className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate text-left">{PLUGIN_STORE_OFFICIAL_URL}</span>
        </QuietExternal>
      </SettingsCard>

      <StoreOriginCard />
      <GithubTokenCard />

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-6"
        title={t('settings.language')}
        tourId="settings-language"
      >
        <LanguageSwitcher />
      </SettingsCard>
    </SettingsSection>
  );
}

/* ══════════════════════ 分区四：环境与帮助 ══════════════════════ */

/**
 * 图片引擎环境卡：状态探测 + 手动安装 + 运行中 1s 轮询。
 * 自成组件：轮询 setState 只重渲染这一张卡。
 */
function SharpEnvCard() {
  const t = useT();
  const [sharpEnv, setSharpEnv] = useState<SharpEnvState | null>(null);
  const [sharpLoading, setSharpLoading] = useState(true);
  const [sharpStarting, setSharpStarting] = useState(false);
  const sharpPhaseRef = useRef<string>('');

  const refreshSharpEnv = useCallback(async (): Promise<SharpEnvState | null> => {
    try {
      const s = await api.systemSharp();
      const prev = sharpPhaseRef.current;
      const now = s.job?.phase || '';
      // 轮询期间任务收尾 → 给一次提示（失败原因在卡片里也能看到）
      if (prev === 'running' && now && now !== 'running') {
        if (now === 'done') toast.success(t('settings.sharpInstallDone'));
        else toast.error(svcText(s.job?.error) || svcText(s.job?.message) || t('settings.installFailed'));
      }
      sharpPhaseRef.current = now;
      setSharpEnv(s);
      return s;
    } catch {
      /* 网络/会话问题：保持上一次的值，不打断用户 */
      return null;
    } finally {
      setSharpLoading(false);
    }
  }, [t]);

  /** 首次进入设置页读一次环境状态 */
  useEffect(() => {
    void refreshSharpEnv();
  }, [refreshSharpEnv]);

  /** 仅在安装进行中轮询（1s），任务结束即停，不留常驻定时器 */
  useEffect(() => {
    if (sharpEnv?.job?.phase !== 'running') return;
    const timer = setInterval(() => { void refreshSharpEnv(); }, 1000);
    return () => clearInterval(timer);
  }, [sharpEnv?.job?.phase, refreshSharpEnv]);

  const installSharp = () => {
    if (sharpStarting || sharpEnv?.job?.phase === 'running') return;
    setSharpStarting(true);
    api.systemSharpInstall()
      .then((s) => {
        setSharpEnv(s);
        sharpPhaseRef.current = s.job?.phase || '';
        toast.success(t('settings.installStarted'));
      })
      .catch((e) => {
        void refreshSharpEnv();
        toast.error(errText(e) || t('settings.cannotStartInstall'));
      })
      .finally(() => setSharpStarting(false));
  };

  return (
    <SettingsCard
      className="kk-stagger-item kk-stagger-slow-6"
      title={t('settings.sharpEnv')}
      tourId="settings-sharp"
      extra={
        sharpLoading && !sharpEnv ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {t('settings.detectingEnv')}
          </span>
        ) : sharpEnv ? (
          <>
            {sharpEnv.loadable ? (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-teal-500/10 px-2.5 py-1 text-xs font-medium text-teal-700">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {t('settings.ready')}
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                {sharpEnv.packagePresent ? t('settings.depsIncomplete') : t('settings.notInstalled')}
              </span>
            )}
            {/* 版本号较长，只在 sm 以上显示，手机端只留状态徽标 */}
            {sharpEnv.loadable ? (
              <span className="hidden truncate font-mono text-[11px] text-slate-500 sm:inline">
                sharp {sharpEnv.version} · libvips {sharpEnv.vips}
              </span>
            ) : null}
          </>
        ) : null
      }
    >
      {sharpEnv ? (
        <>
          {/* 手机上三枚按钮收成 2+1：前两枚并排，重检测整行铺满，不再靠 truncate 硬挤 */}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Button
              type="button"
              className="h-9 w-full min-w-0 gap-1 px-1 text-xs sm:px-3 sm:text-sm"
              disabled={!sharpEnv.canInstall || sharpStarting}
              onClick={installSharp}
            >
              {sharpStarting || sharpEnv.job?.phase === 'running' ? (
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              ) : (
                <Wrench className="h-3.5 w-3.5 shrink-0" />
              )}
              <span className="truncate">
                {sharpEnv.job?.phase === 'running'
                  ? t('settings.installing')
                  : sharpEnv.loadable
                    ? t('settings.reinstall')
                    : t('settings.install')}
              </span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-9 w-full min-w-0 gap-1 px-1 text-xs sm:px-3 sm:text-sm"
              onClick={() => {
                // 装到共享目录（data/runtime-deps）：与 MKbot 插件共用同一份 sharp
                void copyToClipboard(
                  `cd "${sharpEnv.installDir}"\nnpm install --omit=dev --no-audit --no-fund`,
                );
                toast.success(t('settings.commandCopied'));
              }}
            >
              <Copy className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('settings.copyCommand')}</span>
            </Button>
            <Button
              type="button"
              variant="outline"
              className="col-span-2 h-9 w-full min-w-0 gap-1 px-1 text-xs sm:col-span-1 sm:px-3 sm:text-sm"
              disabled={sharpEnv.job?.phase === 'running'}
              onClick={() => { void refreshSharpEnv(); }}
            >
              <Compass className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{t('settings.redetect')}</span>
            </Button>
          </div>

          {sharpEnv.job ? (
            <div className="space-y-1.5">
              <p
                className={cn(
                  'text-xs',
                  sharpEnv.job.phase === 'error'
                    ? 'text-amber-700'
                    : sharpEnv.job.phase === 'done'
                      ? 'text-teal-700'
                      : 'text-slate-500',
                )}
              >
                {sharpEnv.job.message}
                {sharpEnv.job.error ? `：${sharpEnv.job.error}` : ''}
              </p>
              <pre className="kk-field max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg p-3 font-mono text-[11px] leading-relaxed text-slate-500">
                {sharpEnv.job.lines.join('\n')}
              </pre>
            </div>
          ) : null}
        </>
      ) : null}
    </SettingsCard>
  );
}

function SystemSection() {
  const t = useT();
  return (
    <SettingsSection id="kk-sec-system" labelKey="settings.sectionSystem">
      <SharpEnvCard />

      <SettingsCard
        className="kk-stagger-item kk-stagger-slow-6"
        title={t('settings.tour')}
        description={t('settings.tourDesc')}
        tourId="settings-tour"
      >
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start gap-2"
          onClick={startProductTour}
        >
          <Compass className="h-4 w-4 shrink-0 text-teal-600" />
          {t('settings.viewTour')}
        </Button>
      </SettingsCard>

      <MultiThreadCard />
    </SettingsSection>
  );
}

/* ══════════════════════ 页面入口 ══════════════════════ */

export default function SettingsPage() {
  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6 lg:gap-8">
      {/* 「系统设置」标题已由顶栏显示，这里直接从分区开始，不再占用顶栏下方空间 */}
      <div className="relative flex min-h-0 flex-1 flex-col gap-6 md:pb-0 lg:gap-8">
        <RuntimeSection />
        <AppearanceSection />
        <StoreSection />
        <SystemSection />
      </div>
    </div>
  );
}
