import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  APPEARANCE_RANGES,
  DEFAULT_WATERMARK_TEXT,
  formatAppearanceValue,
  normalizeWatermark,
  WATERMARK_MAX_LEN,
  type AppearanceSettings,
  type AppearanceState,
} from '@/lib/appearance';
import { useT } from '@/lib/i18n';

/**
 * 设置页 · 页面水印。
 *
 * 布局是一条紧凑的标题行：`页面水印 [输入框] [开关]`，下面三根滑动条分别管
 * 倾斜度 / 密集度 / 字号 —— 与「界面外观」的滑动条同一套 UI（.kk-slider），
 * 不写说明文字、不折行。
 *
 * 开关与输入框是同一件事的两种表达：**文字非空即开启**，清空即关闭。
 * 所以开关只负责「填默认文字 / 清空」，真正的状态永远由文字决定 ——
 * 不会出现「开关开着但没字」这种空转状态。
 */

/** 三根滑动条：顺序、i18n 与 settings 字段一一对应 */
const WATERMARK_SLIDERS = [
  { key: 'watermarkAngle', label: 'settings.watermarkAngle' },
  { key: 'watermarkDensity', label: 'settings.watermarkDensity' },
  { key: 'watermarkSize', label: 'settings.watermarkSize' },
] as const satisfies readonly { key: keyof AppearanceSettings; label: string }[];

/** 标题与滑动条共用同一列宽，输入框与三根滑条左端对齐 */
const LABEL_COL = 'w-20 shrink-0 whitespace-nowrap sm:w-24';

export function WatermarkPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceState;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceState>) => void;
}) {
  const t = useT();
  const text = settings.watermarkText;
  const enabled = normalizeWatermark(text) !== '';

  return (
    <div className="space-y-3 sm:space-y-3.5">
      {/* 标题行：标题 + 输入框 + 开关，始终同一行，不换行、不加子标题 */}
      <div className="flex items-center gap-3 sm:gap-4">
        <Label
          htmlFor="watermark-text"
          className={`${LABEL_COL} text-base font-semibold tracking-tight text-slate-800 sm:text-lg`}
        >
          {t('settings.watermark')}
        </Label>
        <Input
          id="watermark-text"
          className="min-w-0 flex-1"
          value={text}
          disabled={disabled}
          maxLength={WATERMARK_MAX_LEN}
          placeholder={DEFAULT_WATERMARK_TEXT}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => onChange({ watermarkText: e.target.value })}
        />
        <Switch
          id="watermark-enabled"
          checked={enabled}
          disabled={disabled}
          aria-label={t('settings.watermark')}
          onCheckedChange={(next) => {
            if (!next) {
              onChange({ watermarkText: '' });
              return;
            }
            // 打开时若输入框被清空过，自动填回默认文字，开关不会“开了却没水印”
            onChange({ watermarkText: normalizeWatermark(text) || DEFAULT_WATERMARK_TEXT });
          }}
          className="shrink-0"
        />
      </div>

      {/* 倾斜度 / 密集度 / 字号：与「界面外观」一致的滑动条 */}
      {WATERMARK_SLIDERS.map(({ key, label }) => {
        const range = APPEARANCE_RANGES[key];
        const id = `watermark-${key}`;
        return (
          <div key={key} className="flex items-center gap-3 sm:gap-4">
            <Label htmlFor={id} className={`${LABEL_COL} text-sm font-medium text-slate-600`}>
              {t(label)}
            </Label>
            <Slider
              id={id}
              className="min-w-0 flex-1"
              min={range.min}
              max={range.max}
              step={range.step}
              value={settings[key]}
              disabled={disabled}
              valueText={formatAppearanceValue(key, settings[key])}
              onValueChange={(v) => onChange({ [key]: v } as Partial<AppearanceState>)}
            />
            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-slate-500 sm:w-16">
              {formatAppearanceValue(key, settings[key])}
            </span>
          </div>
        );
      })}
    </div>
  );
}
