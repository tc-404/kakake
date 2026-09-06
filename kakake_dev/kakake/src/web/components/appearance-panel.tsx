import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { BackgroundPicker } from '@/components/background-picker';
import {
  APPEARANCE_RANGES,
  formatAppearanceValue,
  type AppearanceSettings,
  type BackgroundOrientation,
} from '@/lib/appearance';

/** 只有这四项走滑动条，两组颜色交给色盘 */
type SliderKey = 'uiSpeed' | 'cardOpacity' | 'cardBlur' | 'backgroundBlur';

const ROWS: { key: SliderKey; label: string }[] = [
  { key: 'uiSpeed', label: '组件速度' },
  { key: 'cardOpacity', label: '卡片透明度' },
  { key: 'cardBlur', label: '组件模糊度' },
  { key: 'backgroundBlur', label: '背景模糊度' },
];

const VALUE_TEXT: Record<SliderKey, (v: number) => string> = {
  uiSpeed: (v) => `${v.toFixed(1)} 倍`,
  cardOpacity: (v) => `${Math.round(v * 100)} 百分比`,
  cardBlur: (v) => `${Math.round(v)} 像素`,
  backgroundBlur: (v) => `${Math.round(v)} 像素`,
};

/**
 * 界面外观面板：两张背景图卡 + 四条滑动条。
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
  previews: Record<BackgroundOrientation, string | null>;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceSettings>) => void;
  onPickBackground: (orientation: BackgroundOrientation, file: File) => void;
  onClearBackground: (orientation: BackgroundOrientation) => void;
}) {
  return (
    <div className="space-y-6">
      <BackgroundPicker
        previews={previews}
        disabled={disabled}
        onPick={onPickBackground}
        onClear={onClearBackground}
      />

      <div className="space-y-3.5">
        {ROWS.map(({ key, label }) => {
          const range = APPEARANCE_RANGES[key];
          const id = `appearance-${key}`;
          return (
            <div key={key} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
              <div className="flex items-center justify-between gap-3 sm:w-36 sm:shrink-0">
                <Label htmlFor={id} className="text-sm font-medium text-slate-600">
                  {label}
                </Label>
                <span className="font-mono text-xs tabular-nums text-slate-500">
                  {formatAppearanceValue(key, settings[key])}
                </span>
              </div>
              <Slider
                id={id}
                className="min-w-0 flex-1"
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