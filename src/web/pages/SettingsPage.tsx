import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ExternalLink, Loader2, Compass } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
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
  normalizeAppearance,
  normalizeCustomTitle,
  type AppearanceSettings,
  type AppearanceState,
  type BackgroundOrientation,
} from '@/lib/appearance';
import {
  PLUGIN_STORE_OFFICIAL_URL,
  PLUGIN_STORE_GITHUB_URL,
  STORE_ORIGIN_LABEL,
} from '@/lib/plugin-store-origin';
import type { StoreOrigin } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { AppearancePanel } from '@/components/appearance-panel';
import type { BackgroundPreview } from '@/components/background-picker';
import { ColorPanel } from '@/components/color-panel';
import { startProductTour } from '@/components/product-tour';
import { QuietExternal } from '@/components/quiet-link';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select-menu';

const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'Debug · 调试',
  info: 'Info · 信息',
  warn: 'Warn · 警告',
  error: 'Error · 错误',
};

function SettingsCard({
  title,
  description,
  children,
  className,
  tourId,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  tourId?: string;
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
        <h2 className="text-lg font-semibold tracking-tight text-slate-800">{title}</h2>
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
  /** 服务端已保存的外观（含背景图元信息） */
  const [appearance, setAppearance] = useState<AppearanceState>(DEFAULT_APPEARANCE_STATE);
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

  useEffect(() => {
    api.settings
      .get()
      .then((r) => {
        setConfig(r.config);
        setPortText(String(r.config.port ?? 8787));
        setTimeoutText(String(Math.round((r.config.apiTimeoutMs ?? 120000) / 1000)));
        setConfigReady(true);
      })
      .catch((e) => toast.error(String(e)))
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
          toast.error(r.message || '切换资源来源失败');
        } else {
          toast.success(`已切换到${STORE_ORIGIN_LABEL[next]}`);
        }
      })
      .catch((e) => {
        setStoreOrigin(prev);
        toast.error(String(e));
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
    const portOk = /^\d+$/.test(portText.trim()) && Number(portText) >= 1 && Number(portText) <= 65535;
    const timeoutOk =
      /^\d+$/.test(timeoutText.trim()) && Number(timeoutText) >= 5 && Number(timeoutText) <= 600;
    if (!portOk || !timeoutOk) return; // 非法值不保存，行内错误已提示
    if (configSaveTimer.current) clearTimeout(configSaveTimer.current);
    configSaveTimer.current = setTimeout(() => {
      api.settings
        .save({
          ...config,
          host: config.host?.trim() || '0.0.0.0',
          token: '',
          port: Number(portText),
          apiTimeoutMs: Number(timeoutText) * 1000,
        })
        .catch(() => toast.error('设置自动保存失败'));
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
        toast.error(e instanceof Error ? e.message : '背景图上传失败');
        setBgDrafts(emptyBackgroundDrafts);
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
        toast.error(e instanceof Error ? e.message : '背景图移除失败');
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
        api.appearance.save(next).catch(() => toast.error('外观自动保存失败'));
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
      api.appearance.saveTitle(title).catch(() => toast.error('标题自动保存失败'));
    }, 500);
  };

  const portError = useMemo(() => {
    if (!portTouched) return '';
    if (!/^\d+$/.test(portText.trim())) return '请输入有效数字';
    const n = Number(portText);
    if (n < 1 || n > 65535) return '端口须在 1–65535 之间';
    return '';
  }, [portText, portTouched]);

  const timeoutError = useMemo(() => {
    if (!timeoutTouched) return '';
    if (!/^\d+$/.test(timeoutText.trim())) return '请输入有效数字';
    const n = Number(timeoutText);
    if (n < 5 || n > 600) return '超时时间需在 5–600 秒范围内';
    return '';
  }, [timeoutText, timeoutTouched]);

  if (loading) {
    return (
      <div className="flex w-full items-center gap-2 py-16 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6 lg:gap-8">
      <div className="kk-stagger-item kk-stagger-slow-1 hidden shrink-0 md:block">
        <h1 className="kk-page-title">系统设置</h1>
      </div>

      <div
        className="relative flex min-h-0 flex-1 flex-col gap-6 md:pb-0 lg:gap-8"
      >
        <div className="grid flex-1 grid-cols-1 content-start gap-6 lg:grid-cols-2 lg:gap-8">
          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-2"
            title="监听地址"
            tourId="settings-listen"
          >
            <div className="space-y-4">
              <FormRow
                label="监听地址"
                htmlFor="host"
                tourId="row-host"
                hint="0.0.0.0 表示允许所有网卡访问；重启后生效"
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
                label="后台端口"
                htmlFor="port"
                tourId="row-port"
                hint={!portError ? '范围 1–65535' : undefined}
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
            title="运行参数"
            tourId="settings-runtime"
          >
            <div className="space-y-4">
              <FormRow label="日志级别" htmlFor="logLevel" tourId="row-loglevel">
                <Select
                  value={config.logLevel}
                  onValueChange={(v) => setConfig((c) => ({ ...c, logLevel: v as LogLevel }))}
                >
                  <SelectTrigger id="logLevel" aria-label="日志级别">
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
                label="API 超时"
                htmlFor="timeout"
                tourId="row-timeout"
                hint={!timeoutError ? '单位：秒，修改后立即生效' : undefined}
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
            title="自定义标题"
            tourId="settings-title"
          >
            <FormRow label="自定义标题名字" htmlFor="customTitle" tourId="row-title">
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
              <h2 className="text-lg font-semibold tracking-tight text-slate-800">外放 API</h2>
            </div>
            <Switch
              id="publicApi"
              checked={config.publicApiEnabled}
              onCheckedChange={(v) => setConfig((c) => ({ ...c, publicApiEnabled: v }))}
              aria-label="外放 API"
              className="shrink-0"
            />
          </section>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-4 lg:col-span-2"
            title="界面外观"
            tourId="settings-appearance"
          >
            <AppearancePanel
              settings={appearanceDraft}
              previews={previews}
              disabled={false}
              onChange={pushAppearance}
              onPickBackground={pickBackground}
              onClearBackground={clearBackground}
            />
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-5 lg:col-span-2"
            title="配色方案"
            tourId="settings-color"
          >
            <ColorPanel
              settings={appearanceDraft}
              disabled={false}
              onChange={pushAppearance}
            />
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title="资源官网"
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
            title="资源来源"
            description="选择「资源」页从哪里拉取插件：咔咔珂官方源，或 GitHub 社区源"
            tourId="settings-store-origin"
          >
            <div
              role="tablist"
              aria-label="资源来源"
              className="relative flex w-full items-center rounded-2xl border border-white/40 bg-white/20 p-1 backdrop-blur-sm"
            >
              {/* 滑动高亮指示器：在两个选项之间平滑滑动，而非瞬间切换 */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-xl bg-teal-500/90 shadow-md shadow-teal-500/30 transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
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
                    {STORE_ORIGIN_LABEL[key]}
                  </button>
                );
              })}
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-400">
              {storeOrigin === 'github' ? (
                <>
                  当前为 GitHub 社区源，来自
                  {' '}
                  <QuietExternal
                    href={PLUGIN_STORE_GITHUB_URL}
                    className="text-teal-600 underline decoration-dotted underline-offset-2 hover:text-teal-700"
                  >
                    kakake-plugin-main
                  </QuietExternal>
                  。第三方插件请自行甄别风险。
                </>
              ) : (
                '当前为咔咔珂官方源。'
              )}
            </p>
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-6 lg:col-span-2"
            title="新手引导"
            description="再看一遍控制台的功能导览，逐步高亮每个入口与用法"
            tourId="settings-tour"
          >
            <Button
              type="button"
              variant="outline"
              className="w-full justify-start gap-2"
              onClick={startProductTour}
            >
              <Compass className="h-4 w-4 shrink-0 text-teal-600" />
              重新查看产品导览
            </Button>
          </SettingsCard>
        </div>
      </div>
    </div>
  );
}
