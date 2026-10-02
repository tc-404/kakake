import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { BackgroundPicker, type BackgroundPreview } from '@/components/background-picker';
import {
  APPEARANCE_RANGES,
  formatAppearanceValue,
  type AppearanceSettings,
  type BackgroundOrientation,
} from '@/lib/appearance';

/** 只有这几项走滑动条，两组颜色交给色盘 */
type SliderKey =
  | 'uiSpeed' | 'cardOpacity' | 'cardBlur' | 'card2Opacity' | 'card2Blur' | 'backgroundBlur'
  | 'sidebarWidthPc' | 'sidebarWidthMobile';

const ROWS: { key: SliderKey; label: string }[] = [
  { key: 'uiSpeed', label: '组件速度' },
  { key: 'cardOpacity', label: '卡片透明度' },
  { key: 'cardBlur', label: '组件模糊度' },
  { key: 'card2Opacity', label: '组件2透明度' },
  { key: 'card2Blur', label: '组件2模糊度' },
  { key: 'backgroundBlur', label: '背景模糊度' },
  { key: 'sidebarWidthPc', label: '侧边栏宽度 · 电脑' },
  { key: 'sidebarWidthMobile', label: '侧边栏宽度 · 手机' },
];

const VALUE_TEXT: Record<SliderKey, (v: number) => string> = {
  uiSpeed: (v) => `${v.toFixed(1)} 倍`,
  cardOpacity: (v) => `${Math.round(v * 100)} 百分比`,
  cardBlur: (v) => `${Math.round(v)} 像素`,
  card2Opacity: (v) => `${Math.round(v * 100)} 百分比`,
  card2Blur: (v) => `${Math.round(v)} 像素`,
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
}: {
  settings: AppearanceSettings;
  previews: Record<BackgroundOrientation, BackgroundPreview | null>;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceSettings>) => void;
  onPickBackground: (orientation: BackgroundOrientation, file: File) => void;
  onClearBackground: (orientation: BackgroundOrientation) => void;
}) {
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

      <div className="space-y-3.5">
        {ROWS.map(({ key, label }) => {
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
            </div>
          );
        })}
      </div>
    </div>
  );
}