import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ExternalLink, Loader2, Compass, Eye, EyeOff, Wrench, Copy, CheckCircle2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { api, type SharpEnvState } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { copyToClipboard } from '@/lib/clipboard';
import type { KakakeConfig, LogLevel } from '@/lib/types';
import { DEFAULT_KAKAKE_CONFIG } from '@/lib/types';
import {
  APPEARANCE_RANGES,
  BACKGROUND_ORIENTATIONS,
  CUSTOM_TITLE_MAX_LEN,
  DEFAULT_APPEARANCE,
  DEFAULT_APPEARANCE_STATE,
  applyAppearance,
  applyAppearanceTokens,
  backgroundKindFromFile,
  backgroundKindOf,
  backgroundUrl,
  cacheAppearance,
  hasCustomBackground,
  normalizeAppearance,
  normalizeCustomTitle,
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
import { AppearancePanel } from '@/components/appearance-panel';
import { BackgroundPresetPanel } from '@/components/background-preset-panel';
import type { BackgroundPreview } from '@/components/background-picker';
import { ColorPanel } from '@/components/color-panel';
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
  /** 显示在标题右侧的附加信息（如状态徽标），与标题同一行 */
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

/** 背景图暂存：选好 / 标记移除都只记在本地，点保存才落到服务端 */
type BackgroundDraft = {
  file: File | null;
  remove: boolean;
  /** 本地预览用的 objectURL，需在替换与卸载时回收 */
  url: string | null;
};

/**
 * 禁用端口（>1023 的部分）：常见服务默认端口 + 连号/重复数字这类弱端口。
 * 这些端口扫描器必扫、也最容易被人猜出来，控制台暴露在上面风险太大，一律不允许保存。
 * 1–1023 是系统特权端口，另在 portIssue() 里单独拦。
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

const EMPTY_BACKGROUND_DRAFT: BackgroundDraft = { file: null, remove: false, url: null };

function emptyBackgroundDrafts(): Record<BackgroundOrientation, BackgroundDraft> {
  return {
    portrait: { ...EMPTY_BACKGROUND_DRAFT },
    landscape: { ...EMPTY_BACKGROUND_DRAFT },
  };
}

function pickSettings(state: AppearanceState): AppearanceSettings {
  const out = {} as AppearanceSettings;
  // 按区间表取键，新增外观字段不用改这里
  for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceSettings)[]) {
    out[key] = state[key];
  }
  return out;
}

export default function SettingsPage() {
  const t = useT();
  const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
    debug: t('settings.logLevelDebug'),
    info: t('settings.logLevelInfo'),
    warn: t('settings.logLevelWarn'),
    error: t('settings.logLevelError'),
  };

  const [config, setConfig] = useState<KakakeConfig>(DEFAULT_KAKAKE_CONFIG);
  const [portText, setPortText] = useState('8787');
  const [timeoutText, setTimeoutText] = useState('120');
  const [loading, setLoading] = useState(true);
  const [portTouched, setPortTouched] = useState(false);
  const [timeoutTouched, setTimeoutTouched] = useState(false);
  /** 拉到服务端配置后才允许自动保存，避免把加载值又原样写回 */
  const [configReady, setConfigReady] = useState(false);
  /** 资源商店来源（咔咔珂 / GitHub），服务端持久化 */
  const [storeOrigin, setStoreOrigin] = useState<StoreOrigin>('kakake');
  const [storeOriginSaving, setStoreOriginSaving] = useState(false);
  /** GitHub API Token（可选）：填了就在直连官方接口时附带，提升限流额度 */
  const [ghToken, setGhToken] = useState('');
  const [ghTokenSaved, setGhTokenSaved] = useState('');
  const [ghTokenShow, setGhTokenShow] = useState(false);
  const [ghTokenSaving, setGhTokenSaving] = useState(false);
  const [ghQuota, setGhQuota] = useState<{ remaining: number; limit: number } | null>(null);
  /**
   * 图片引擎环境（sharp）：服务端按需加载的图片混淆引擎，缺依赖时只有该功能不可用。
   * 安装是手动的（服务器上跑 npm install 属于重操作），安装中按 1s 轮询看日志。
   */
  const [sharpEnv, setSharpEnv] = useState<SharpEnvState | null>(null);
  const [sharpLoading, setSharpLoading] = useState(true);
  const [sharpStarting, setSharpStarting] = useState(false);
  const sharpPhaseRef = useRef<string>('');
  /** 服务端已保存的外观（含背景图元信息） */
  const [appearance, setAppearance] = useState<AppearanceState>(DEFAULT_APPEARANCE_STATE);
  /** 设备档位：背景预设只在「完整特效」档露面（性能模式下波浪压根不会画） */
  const deviceTier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部品牌字）；输入即存，刷新后生效 */
  const [titleText, setTitleText] = useState('');
  const titleSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 表单里正在调的外观数值 */
  const [appearanceDraft, setAppearanceDraft] = useState<AppearanceSettings>(DEFAULT_APPEARANCE);
  const [bgDrafts, setBgDrafts] = useState(emptyBackgroundDrafts);
  const bgDraftsRef = useRef(bgDrafts);
  bgDraftsRef.current = bgDrafts;
  /** 拉到服务端外观之前不做预览，否则会把已保存的配色闪成默认值 */
  const [appearanceReady, setAppearanceReady] = useState(false);
  /** 已保存的外观，离开页面时用它回滚未保存的预览 */
  const savedAppearanceRef = useRef(appearance);
  savedAppearanceRef.current = appearance;

  /**
   * 实时预览：草稿一变就写进 CSS 变量，调色盘与滑动条当场看到效果。
   * 外观改动即时生效并自动落库（见 pushAppearance），不再依赖保存按钮。
   */
  useEffect(() => {
    if (!appearanceReady) return;
    applyAppearanceTokens(appearanceDraft);
  }, [appearanceDraft, appearanceReady]);

  /** 外观数值自动保存的防抖计时器 */
  const appearanceSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * 最近一次「成功保存」的端口。端口填了不合法的值时用它顶上——
   * 新端口不保存、服务端继续用原端口，其余运行参数照常保存。
   */
  const lastGoodPort = useRef<number>(8787);

  useEffect(() => {
    api.settings
      .get()
      .then((r) => {
        setConfig(r.config);
        const port = r.config.port ?? 8787;
        lastGoodPort.current = port;
        setPortText(String(port));
        setTimeoutText(String(Math.round((r.config.apiTimeoutMs ?? 120000) / 1000)));
        setConfigReady(true);
      })
      .catch((e) => toast.error(errText(e)))
      .finally(() => setLoading(false));
  }, []);

  /** 资源来源：加载服务端已保存的来源 */
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

  /** GitHub Token：加载服务端已保存的值 */
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

  /* ─────────── 图片引擎环境（sharp）：状态探测 + 手动安装 ─────────── */

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
  }, []);

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

  const changeStoreOrigin = (next: StoreOrigin) => {    if (next === storeOrigin || storeOriginSaving) return;
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
    // 端口不合法（含特权端口 / 易被猜的常见端口）时坚决不保存新端口：
    // 沿用上一次成功保存的端口，服务端照旧用原值；其余运行参数不受影响，照常保存。
    const portValid = portIssue(portText) === '';
    const portToSave = portValid ? Number(portText) : lastGoodPort.current;
    const timeoutOk =
      /^\d+$/.test(timeoutText.trim()) && Number(timeoutText) >= 5 && Number(timeoutText) <= 600;
    if (!timeoutOk) return; // 非法值不保存，行内错误已提示
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    configSaveTimer.current = setTimeout(() => {
      api.settings
        .save({
          ...config,
          host: config.host?.trim() || '0.0.0.0',
          token: '',
          port: portToSave,
          apiTimeoutMs: Number(timeoutText) * 1000,
        })
        .then(() => {
          if (portValid) lastGoodPort.current = portToSave;
        })
        .catch(() => toast.error(t('settings.autoSaveFailed')));
    }, 500);
  }, [config, portText, timeoutText, configReady]);

  // 卸载时清掉未触发的自动保存计时器
  useEffect(
    () => () => {
      if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    },
    [],
  );

  useEffect(() => {
    api.appearance
      .get()
      .then((r) => {
        const state = normalizeAppearance(r.appearance);
        setAppearance(state);
        setAppearanceDraft(pickSettings(state));
        setTitleText(state.customTitle);
        setAppearanceReady(true);
      })
      .catch(() => { /* 外观拉不到就沿用默认值，不打断设置页 */ });
  }, []);

  // 卸载时回收所有本地预览 URL
  useEffect(() => () => {
    for (const draft of Object.values(bgDraftsRef.current)) {
      if (draft.url) URL.revokeObjectURL(draft.url);
    }
  }, []);

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
    // 先给一个本地预览，接口返回后再切成正式地址
    setBgDrafts((prev) => {
      if (prev[orientation].url) URL.revokeObjectURL(prev[orientation].url!);
      return { ...prev, [orientation]: { file, remove: false, url: URL.createObjectURL(file) } };
    });
    void (async () => {
      try {
        const r = await api.appearance.uploadBackground(orientation, file);
        if (!r.ok) throw new Error(r.message || '背景图上传失败');
        if (r.appearance) commitAppearance(r.appearance);
      } catch (e) {
        toast.error(errText(e) || t('settings.bgUploadFailed'));
        setBgDrafts(emptyBackgroundDrafts);
      }
    })();
  };

  /** 背景适配方式：点了即存即生效（与背景图一样，不走保存按钮） */
  const changeBackgroundFit = (fit: BackgroundFit) => {
    if (appearance.bgFit === fit) return;
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

  /** 移除背景图：立即删除并全局应用 */
  const clearBackground = (orientation: BackgroundOrientation) => {
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
  };

  const commitAppearance = (state: AppearanceState) => {
    const normalized = normalizeAppearance(state);
    setAppearance(normalized);
    setAppearanceDraft(pickSettings(normalized));
    setBgDrafts((prev) => {
      for (const draft of Object.values(prev)) {
        if (draft.url) URL.revokeObjectURL(draft.url);
      }
      return emptyBackgroundDrafts();
    });
    applyAppearance(normalized);
    cacheAppearance(normalized);
  };

  /**
   * 外观数值（速度 / 透明度 / 模糊 / 配色）调整：即时生效，防抖后自动落库。
   * 全局马上应用 + 写本地缓存，避免离开页面预览回退；接口失败只提示不回滚草稿。
   */
  const pushAppearance = (patch: Partial<AppearanceSettings>) => {
    setAppearanceDraft((prev) => {
      const next = { ...prev, ...patch };
      const nextState = normalizeAppearance({ ...savedAppearanceRef.current, ...next });
      applyAppearance(nextState);
      cacheAppearance(nextState);
      setAppearance(nextState);
      if (appearanceSaveTimer.current) clearTimeout(appearanceSaveTimer.current);
      appearanceSaveTimer.current = setTimeout(() => {
        api.appearance.save(next).catch(() => toast.error(t('settings.appearanceAutoSaveFailed')));
      }, 400);
      return next;
    });
  };

  // 卸载时把未落库的最后一次外观改动补存
  useEffect(() => () => {
    if (appearanceSaveTimer.current) clearTimeout(appearanceSaveTimer.current);
  }, []);

  // 卸载时清掉未触发的标题自动保存计时器
  useEffect(() => () => {
    if (titleSaveTimer.current) clearTimeout(titleSaveTimer.current);
  }, []);

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

  if (loading) {
    return (
      <div className="flex w-full items-center gap-2 py-16 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t('label.loading')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6 lg:gap-8">
      {/* 「系统设置」标题已由顶栏显示，这里直接从卡片开始 */}
      <div
        className="relative flex min-h-0 flex-1 flex-col gap-6 md:pb-0 lg:gap-8"
      >
        <div className="grid flex-1 grid-cols-1 content-start gap-6 lg:grid-cols-2 lg:gap-8">
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
              >
                <Input
                  id="host"
                  value={config.host}
                  onChange={(e) => setConfig((c) => ({ ...c, host: e.target.value }))}
                  placeholder="0.0.0.0"
                  autoComplete="off"
                />
              </FormRow>
              <FormRow
                label={t('settings.backendPort')}
                htmlFor="port"
                tourId="row-port"
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
            </div>
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-4 lg:col-span-2"
            title={t('settings.customTitle')}
            tourId="settings-title"
          >
            <FormRow label={t('settings.customTitleName')} htmlFor="customTitle" tourId="row-title">
              <Input
                id="customTitle"
                value={titleText}
                onChange={(e) => changeTitle(e.target.value)}
                maxLength={CUSTOM_TITLE_MAX_LEN}
                placeholder="咔咔珂"
                autoComplete="off"
              />
            </FormRow>
          </SettingsCard>

          <section className="kk-glass kk-stagger-item kk-stagger-slow-4 flex items-center justify-between gap-4 rounded-[1.25rem] p-5 sm:p-6 lg:col-span-2">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-800">{t('settings.publicApi')}</h2>
            </div>
            <Switch
              id="publicApi"
              checked={config.publicApiEnabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, publicApiEnabled: v }))}
              aria-label={t('settings.publicApi')}
              className="shrink-0"
            />
          </section>

          <section className="kk-glass kk-stagger-item kk-stagger-slow-4 flex items-center justify-between gap-4 rounded-[1.25rem] p-5 sm:p-6 lg:col-span-2">
            <div className="min-w-0">
              <h2 className="text-lg font-semibold tracking-tight text-slate-800">{t('settings.proxyApi')}</h2>
            </div>
            <Switch
              id="proxyApi"
              checked={config.proxyApiEnabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, proxyApiEnabled: v }))}
              aria-label={t('settings.proxyApi')}
              className="shrink-0"
            />
          </section>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-4 lg:col-span-2"
            title={t('settings.appearance')}
            tourId="settings-appearance"
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

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-5 lg:col-span-2"
            title={t('settings.performanceMode')}
            description={t('settings.performanceModeDesc')}
            tourId="settings-performance"
          >
            <PerformanceModePanel />
          </SettingsCard>

          {deviceTier === 'normal' ? (
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
              />
            </SettingsCard>
          ) : null}

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title={t('settings.resourceWebsite')}
          >
            <QuietExternal
              href={PLUGIN_STORE_OFFICIAL_URL}
              className="inline-flex w-full items-center gap-2 rounded-xl border border-white/40 bg-white/20 px-3.5 py-2.5 text-sm text-teal-700 backdrop-blur-sm transition-colors hover:bg-white/30 hover:text-teal-800"
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{PLUGIN_STORE_OFFICIAL_URL}</span>
            </QuietExternal>
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
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

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title="GitHub API Token"
          >
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

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title={t('settings.language')}
          >
            <LanguageSwitcher />
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title={t('settings.sharpEnv')}
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
                {/* 三个按钮固定一行、等宽铺满：手机上也完整显示，不换行、不居左堆叠 */}
                <div className="grid grid-cols-3 gap-2">
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
                    className="h-9 w-full min-w-0 gap-1 px-1 text-xs sm:px-3 sm:text-sm"
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

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
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
        </div>
      </div>
    </div>
  );
}
