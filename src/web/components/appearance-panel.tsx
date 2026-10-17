import { useSyncExternalStore } from 'react';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { WakeSlider } from '@/components/wake-slider';
import { BackgroundPicker, type BackgroundPreview } from '@/components/background-picker';
import {
  APPEARANCE_RANGES,
  BACKGROUND_FIT_OPTIONS,
  cardShadowPercent,
  effectiveBackgroundPreset,
  formatAppearanceValue,
  getAppearanceSnapshot,
  subscribeAppearance,
  type AppearanceSettings,
  type BackgroundFit,
  type BackgroundOrientation,
} from '@/lib/appearance';
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';

/**
 * 波浪预设下滑动条的尾迹外观。
 * 高度取 44（= CSS 的 min-height，保证触摸目标够大），静止 12 → 抬起后有明显落差。
 *
 * 竖条根数不写死：由轨道实测宽度按「每根 6px」反推（16–160 根），
 * 所以电脑和手机上每一格都是同样尺寸的竖向小长方形——写死 30 根的话，
 * 桌面端一根会被拉到 10px 宽、12px 高，成了小方块。静止高度不足时组件会
 * 自动按 cellRatio 抬起来补，形态一致性由组件兜住。
 */
const WAKE = {
  bars: 30,
  cellWidth: 6,
  minBars: 16,
  maxBars: 160,
  cellRatio: 2.2,
  height: 44,
  restHeight: 12,
  gap: 3,
  fillColor: 'rgb(var(--kk-comp-rgb))',
  trackColor: 'rgba(100,116,139,0.22)',
  crestColor: 'rgb(var(--kk-comp-soft-rgb))',
  reach: 5.5,
  sensitivity: 1.25,
} as const;

/** 只有这几项走滑动条，两组颜色交给色盘 */
type SliderKey =
  | 'uiSpeed' | 'cardOpacity' | 'cardBlur' | 'card2Opacity' | 'card2Blur' | 'cardShadow'
  | 'backgroundBlur'
  | 'sidebarWidthPc' | 'sidebarWidthMobile';

/**
 * 滑动条按用途分组，组与组之间一条横线分隔，
 * 免得九根条连成一片、分不清哪根管什么。
 * 组名按用户要求不渲染（title 字段保留以便日后恢复）。
 */
const GROUPS: { title: string; rows: { key: SliderKey; label: string }[] }[] = [
  {
    title: '动效',
    rows: [
      { key: 'uiSpeed', label: '动效速度' },
    ],
  },
  {
    /*
     * 卡片透明度与卡片模糊度是同一张卡片（.kk-glass / .kk-card）的两个参数，
     * 必须相邻、且用同一个前缀。此前模糊那条叫「组件模糊度」、又被分组线隔到别的组里，
     * 读起来就像「只有卡片透明度、缺了卡片模糊度」——这里的命名是对齐过的，别再拆开。
     */
    title: '卡片',
    rows: [
      { key: 'cardOpacity', label: '卡片透明度' },
      { key: 'cardBlur', label: '卡片模糊度' },
    ],
  },
  {
    // 悬浮窗 / 资源与插件界面等次级表面（.kk-glass-2）
    title: '悬浮层',
    rows: [
      { key: 'card2Opacity', label: '悬浮层透明度' },
      { key: 'card2Blur', label: '悬浮层模糊度' },
    ],
  },
  {
    title: '阴影与背景',
    rows: [
      { key: 'cardShadow', label: '阴影透明度' },
      { key: 'backgroundBlur', label: '背景模糊度' },
    ],
  },
  {
    title: '侧边栏',
    rows: [
      { key: 'sidebarWidthPc', label: '侧边栏宽度 · 电脑' },
      { key: 'sidebarWidthMobile', label: '侧边栏宽度 · 手机' },
    ],
  },
];

const VALUE_TEXT: Record<SliderKey, (v: number) => string> = {
  uiSpeed: (v) => `${v.toFixed(1)} 倍`,
  cardOpacity: (v) => `${Math.round(v * 100)} 百分比`,
  cardBlur: (v) => `${Math.round(v)} 像素`,
  card2Opacity: (v) => `${Math.round(v * 100)} 百分比`,
  card2Blur: (v) => `${Math.round(v)} 像素`,
  cardShadow: (v) => `${cardShadowPercent(v)}%`,
  backgroundBlur: (v) => `${Math.round(v)} 像素`,
  sidebarWidthPc: (v) => `${Math.round(v)} 像素`,
  sidebarWidthMobile: (v) => `${Math.round(v)} 百分比`,
};

/**
 * 界面外观面板：两张背景图卡 + 一排滑动条（数值项走这里，两组颜色交给色盘）。
 * 纯受控组件，改动只写回上层 state，点保存后才真正应用到全站。
 */
export function AppearancePanel({
  settings,
  previews,
  disabled,
  onChange,
  onPickBackground,
  onClearBackground,
  bgFit,
  onChangeBgFit,
}: {
  settings: AppearanceSettings;
  previews: Record<BackgroundOrientation, BackgroundPreview | null>;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceSettings>) => void;
  onPickBackground: (orientation: BackgroundOrientation, file: File) => void;
  onClearBackground: (orientation: BackgroundOrientation) => void;
  /** 背景适配方式（非数值字段，单独保存，不走滑动条草稿） */
  bgFit: BackgroundFit;
  onChangeBgFit: (fit: BackgroundFit) => void;
}) {
  // 波浪预设下换用 WakeSlider。判定与背景渲染层、设置页的背景预设卡片共用同一个函数：
  // 自定义背景 / 低配档都会退回出厂，滑动条也跟着退回原生那根。
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const tier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  const waves = effectiveBackgroundPreset(appearance, tier) === 'waves';

  return (
    <div className="space-y-6">
      <div data-tour="ap-bg">
        <BackgroundPicker
          previews={previews}
          disabled={disabled}
          onPick={onPickBackground}
          onClear={onClearBackground}
        />
      </div>

      {/*
       * 背景适配方式：背景图比例和屏幕对不上时怎么铺。
       * 单独做成三选一（不跟滑动条草稿走，点了即存即生效），默认「铺满裁切」——
       * 也就是不管访问者什么分辨率，背景都把整屏铺满。
       */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Label className="text-sm font-medium text-slate-600 sm:w-36 sm:shrink-0">背景适配</Label>
        <div className="kk-field inline-flex items-center gap-1 rounded-xl p-1">
          {BACKGROUND_FIT_OPTIONS.map((opt) => {
            const active = bgFit === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                disabled={disabled}
                title={opt.hint}
                aria-pressed={active}
                onClick={() => onChangeBgFit(opt.value)}
                className={[
                  'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                  active
                    ? 'bg-teal-500/85 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-white/40',
                ].join(' ')}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-3.5">
        {GROUPS.map((group, gi) => (
          <div key={group.title} className="space-y-3.5">
            {/* 分界线：组与组之间的视觉分隔。线色取全局字体色（--foreground），
             * 粗细 2px——1px 太细，在毛玻璃底上基本看不出来。组名按用户要求不渲染。 */}
            {gi > 0 ? (
              <div
                aria-hidden
                className="h-0.5 w-full rounded-full bg-[hsl(var(--foreground)/0.4)]"
              />
            ) : null}
            {group.rows.map(({ key, label }) => {
              const range = APPEARANCE_RANGES[key];
              const id = `appearance-${key}`;
              return (
                /*
                 * 手机：标签在左、数值贴行尾（同一行右侧），滑动条整行落在下面。
                 * 电脑：标签 | 滑动条 | 数值（数值排到整行最右，和手机观感一致）。
                 * 靠 order 切换两者顺序，避免把数值渲染两遍；滑动条在手机上给 w-full
                 * 是为了在 wrap 容器里强制换行到第二行。
                 */
                <div
                  key={key}
                  data-tour={`ap-row-${key}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:flex-nowrap sm:gap-4"
                >
                  {/* 电脑端固定列宽，保证几根滑动条左端对齐 */}
                  <Label htmlFor={id} className="order-1 text-sm font-medium text-slate-600 sm:w-36 sm:shrink-0">
                    {label}
                  </Label>
                  {/*
                   * 电脑端给数值固定宽度并右对齐：否则「22 像素」和「204 像素」长短不一，
                   * 会把左边滑动条的宽度带得来回跳。
                   */}
                  <span className="order-2 ml-auto font-mono text-xs tabular-nums text-slate-500 sm:order-3 sm:ml-0 sm:w-20 sm:shrink-0 sm:text-right">
                    {formatAppearanceValue(key, settings[key])}
                  </span>
                  {waves ? (
                    <WakeSlider
                      id={id}
                      className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1"
                      min={range.min}
                      max={range.max}
                      step={range.step}
                      value={settings[key]}
                      disabled={disabled}
                      ariaLabel={label}
                      formatValue={VALUE_TEXT[key]}
                      bars={WAKE.bars}
                      cellWidth={WAKE.cellWidth}
                      minBars={WAKE.minBars}
                      maxBars={WAKE.maxBars}
                      cellRatio={WAKE.cellRatio}
                      height={WAKE.height}
                      restHeight={WAKE.restHeight}
                      gap={WAKE.gap}
                      fillColor={WAKE.fillColor}
                      trackColor={WAKE.trackColor}
                      crestColor={WAKE.crestColor}
                      reach={WAKE.reach}
                      sensitivity={WAKE.sensitivity}
                      onChange={(v) => onChange({ [key]: v } as Partial<AppearanceSettings>)}
                    />
                  ) : (
                    <Slider
                      id={id}
                      className="order-3 w-full min-w-0 sm:order-2 sm:w-auto sm:flex-1"
                      min={range.min}
                      max={range.max}
                      step={range.step}
                      value={settings[key]}
                      disabled={disabled}
                      valueText={VALUE_TEXT[key](settings[key])}
                      onValueChange={(v) => onChange({ [key]: v } as Partial<AppearanceSettings>)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}