import { ConfigProvider, ColorPicker, theme as antdTheme } from 'antd';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import {
  APPEARANCE_RANGES,
  formatAppearanceValue,
  hsvToHex,
  parseColorToHsv,
  roleEffectiveColor,
  type AppearanceSettings,
  type AppearanceState,
} from '@/lib/appearance';
import { useT } from '@/lib/i18n';

/** 六根滑动条：顺序、i18n 与 settings 字段一一对应 */
const CURSOR_SLIDERS = [
  { key: 'cursorSpin', label: 'settings.cursorSpin' },
  { key: 'cursorHover', label: 'settings.cursorHover' },
  { key: 'cursorSize', label: 'settings.cursorSize' },
  { key: 'cursorCorner', label: 'settings.cursorCorner' },
  { key: 'cursorThickness', label: 'settings.cursorThickness' },
  { key: 'cursorDot', label: 'settings.cursorDot' },
] as const satisfies readonly { key: keyof AppearanceSettings; label: string }[];

/** 单色预设：与「配色方案」的单色页签同一组常用色 */
const SOLID_PRESET_COLORS = [
  '#1677ff', '#00b96b', '#13c2c2', '#722ed1',
  '#eb2f96', '#faad14', '#fa541c', '#ff4d4f',
  '#66ccff', '#52c41a', '#fadb14', '#2ceb13',
];

/**
 * 从 antd ColorPicker 的回调值里取 CSS 串（单色场景），取不到返回空串。
 */
function cssStringOf(value: unknown): string {
  const v = value as {
    toCssString?: () => string;
    color?: { toCssString?: () => string };
  } | null;
  if (v && typeof v.toCssString === 'function') return v.toCssString();
  if (v?.color && typeof v.color.toCssString === 'function') return v.color.toCssString();
  return '';
}

/** 滑动条与颜色行共用同一列宽，左端对齐（与页面水印面板同一套版式） */
const LABEL_COL = 'w-24 shrink-0 whitespace-nowrap sm:w-28';

/** 单行颜色配置：左侧标签 + 说明，右侧单色拾色器（清空 = 跟随品牌 Logo） */
function CursorColorRow({
  id,
  label,
  hint,
  value,
  fallbackColor,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  /** 当前自定义色（#hex），空串 = 跟随品牌 Logo（预览展示 fallbackColor） */
  value: string;
  /** 「跟随」状态下色块与拾色器展示的回落色（品牌 Logo 代表色） */
  fallbackColor: string;
  disabled?: boolean;
  onChange: (hex: string) => void;
}) {
  const t = useT();
  // 色块预览：自定义色优先，没设就展示当前跟随的 Logo 色
  const preview = value || fallbackColor;
  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        <div className="text-[11px] text-slate-400">{hint}</div>
      </div>
      <ColorPicker
        mode={['single']}
        value={value || preview}
        onChange={(v) => {
          const text = cssStringOf(v);
          if (!text) return;
          // 统一转成 #hex 落库（后端也只收十六进制），rgb() 形态不直接存
          const hsv = parseColorToHsv(text);
          if (hsv) onChange(hsvToHex(hsv));
        }}
        onClear={() => onChange('')}
        allowClear={Boolean(value)}
        disabled={disabled}
        disabledAlpha
        presets={[{ key: 'kk-solid', label: '单色', colors: SOLID_PRESET_COLORS }]}
      >
        <button
          type="button"
          disabled={disabled}
          aria-label={label}
          className="h-9 w-9 shrink-0 rounded-lg shadow-sm ring-1 ring-black/5 transition active:scale-95 disabled:opacity-50"
          style={{ background: preview }}
        />
      </ColorPicker>
    </div>
  );
}

/**
 * 设置页 · 前端鼠标调整（准星光标）。
 *
 * 仅在「测试功能」开关打开时渲染（见 SettingsPage）。
 * 前两行是准星颜色与选中时颜色——与「配色方案」的角色色同一套拾色器 UI，
 * 但只有单色、不支持渐变；清空（allowClear）= 跟随「品牌 Logo」配色。
 * 下面六根滑动条调准星的运动与外观参数，改动即时生效并随外观防抖落库。
 */
export function CursorPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceState;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceState>) => void;
}) {
  const t = useT();
  // 控制台主色随「组件及按钮」走，让 antd 面板的高亮与整站观感一致
  const compSolid = roleEffectiveColor(settings, 'comp');
  // 「跟随品牌 Logo」时的回落色：两行颜色共用 Logo 代表色做色块预览
  const logoFallback = roleEffectiveColor(settings, 'logo');

  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { borderRadius: 10, fontSize: 13, colorPrimary: compSolid },
      }}
    >
      <div className="flex flex-col divide-y divide-white/30">
        {/* 第一行：准星颜色（仅单色，无渐变页签）；清空 = 跟随品牌 Logo */}
        <CursorColorRow
          id="cursor-color"
          label={t('settings.cursorColorLabel')}
          hint={t('settings.cursorColorHint')}
          value={settings.cursorColor}
          fallbackColor={logoFallback}
          disabled={disabled}
          onChange={(hex) => onChange({ cursorColor: hex })}
        />
        {/* 第二行：选中时颜色——悬停到可点目标上时准星的颜色；清空 = 跟随品牌 Logo */}
        <CursorColorRow
          id="cursor-target-color"
          label={t('settings.cursorTargetColorLabel')}
          hint={t('settings.cursorTargetColorHint')}
          value={settings.cursorTargetColor}
          fallbackColor={logoFallback}
          disabled={disabled}
          onChange={(hex) => onChange({ cursorTargetColor: hex })}
        />

        {/* 自转 / 吸附 / 大小 / 四角 / 边框 / 圆点：与「页面水印」一致的滑动条 */}
        {CURSOR_SLIDERS.map(({ key, label }) => {
          const range = APPEARANCE_RANGES[key];
          const id = `cursor-${key}`;
          return (
            <div key={key} className="flex items-center gap-3 py-3">
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
    </ConfigProvider>
  );
}
