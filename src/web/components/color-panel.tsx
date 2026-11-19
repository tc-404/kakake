import * as React from 'react';
import { ColorPicker, ConfigProvider, theme as antdTheme } from 'antd';
import {
  COLOR_ROLES,
  DEFAULT_APPEARANCE,
  gradientFieldOf,
  gradientOf,
  hsvPatch,
  hsvToHex,
  parseColorToHsv,
  parseGradientStops,
  readHsv,
  roleEffectiveColor,
  type AppearanceState,
  type ColorRole,
  type GradientStop,
  type Hsv,
} from '@/lib/appearance';
import { useT } from '@/lib/i18n';

const ROLE_LABEL_KEY: Record<ColorRole, string> = {
  ink: 'settings.colorRoleInk',
  comp: 'settings.colorRoleComp',
  logo: 'settings.colorRoleLogo',
};

const ROLE_HINT_KEY: Record<ColorRole, string> = {
  ink: 'settings.colorHintInk',
  comp: 'settings.colorHintComp',
  logo: 'settings.colorHintLogo',
};

const stops = (from: string, to: string): GradientStop[] => [
  { color: from, percent: 0 },
  { color: to, percent: 100 },
];

const ramp = (colors: string[]): GradientStop[] =>
  colors.map((color, i) => ({
    color,
    percent: Math.round((i / (colors.length - 1)) * 100),
  }));

const GRADIENT_PRESETS: GradientStop[][] = [
  stops('#36d1dc', '#5b86e5'),
  stops('#43e97b', '#38f9d7'),
  stops('#fa709a', '#fee140'),
  stops('#30cfd0', '#8b5cf6'),
  stops('#ff9966', '#ff5e62'),
  stops('#a18cd1', '#fbc2eb'),
  stops('#f6d365', '#fda085'),
  stops('#0ba360', '#3cba92'),
  stops('#2af598', '#009efd'),
  stops('#ff0844', '#ffb199'),
  ramp(['#00e5ff', '#ff2d95', '#ffd600']),
  ramp(['#a3e635', '#00ffa3', '#00c2ff', '#ff2d95']),
  ramp(['#ffd54f', '#ff7043', '#ec407a']),
  ramp(['#ff4d6d', '#ffc300', '#00e5a0', '#4cc9f0']),
  ramp(['#00c2ff', '#a855f7', '#ff2d95', '#ffb300']),
  ramp(['#ffd166', '#ff6b6b', '#ff2d95', '#c77dff']),
  ramp(['#00e5ff', '#ff2d95']),
];

const SOLID_PRESET_COLORS = [
  '#1677ff', '#00b96b', '#13c2c2', '#722ed1',
  '#eb2f96', '#faad14', '#fa541c', '#ff4d4f',
  '#66ccff', '#52c41a', '#fadb14', '#2ceb13',
];

const PRESETS = [
  { key: 'kk-gradients', label: '渐变', colors: GRADIENT_PRESETS },
  { key: 'kk-solid', label: '单色', colors: SOLID_PRESET_COLORS },
];

function cssStringOf(value: unknown, fallback?: string): string {
  const v = value as {
    toCssString?: () => string;
    color?: { toCssString?: () => string };
  } | null;
  if (v && typeof v.toCssString === 'function') return v.toCssString();
  if (v?.color && typeof v.color.toCssString === 'function') return v.color.toCssString();
  return typeof fallback === 'string' ? fallback : '';
}

function isCleared(value: unknown): boolean {
  return Boolean((value as { cleared?: boolean } | null)?.cleared);
}

export function ColorPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceState;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceState>) => void;
}) {
  const compSolid = roleEffectiveColor(settings, 'comp');
  return (
    <ConfigProvider
      theme={{
        algorithm: antdTheme.defaultAlgorithm,
        token: { borderRadius: 10, fontSize: 13, colorPrimary: compSolid },
      }}
    >
      <div className="flex flex-col divide-y divide-white/30">
        {COLOR_ROLES.map((role) => (
          <ColorRow
            key={role}
            role={role}
            settings={settings}
            disabled={disabled}
            onChange={onChange}
          />
        ))}
      </div>
    </ConfigProvider>
  );
}

function ColorRow({
  role, settings, disabled, onChange,
}: {
  role: ColorRole;
  settings: AppearanceState;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceState>) => void;
}) {
  const t = useT();
  const gradField = gradientFieldOf(role);
  const gradient = gradientOf(settings, role);
  const pickerValue: string | GradientStop[] | undefined = gradient
    ? (parseGradientStops(gradient) ?? undefined)
    : hsvToHex(readHsv(settings, role));
  const preview = gradient || roleEffectiveColor(settings, role);

  const handleChange = (value: unknown, css?: string) => {
    if (isCleared(value)) return;
    const text = cssStringOf(value, css);
    if (!text) return;
    if (text.includes('gradient(')) {
      onChange({ [gradField]: text } as Partial<AppearanceState>);
      return;
    }
    const hsv: Hsv | null = parseColorToHsv(text);
    if (hsv) onChange({ ...hsvPatch(role, hsv), [gradField]: '' } as Partial<AppearanceState>);
  };

  const handleClear = () => {
    onChange({
      ...hsvPatch(role, readHsv(DEFAULT_APPEARANCE, role)),
      [gradField]: '',
    } as Partial<AppearanceState>);
  };

  return (
    <div className="flex items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-slate-700">{t(ROLE_LABEL_KEY[role])}</div>
        <div className="text-[11px] text-slate-400">{t(ROLE_HINT_KEY[role])}</div>
      </div>
      <ColorPicker
        mode={['single', 'gradient']}
        value={pickerValue}
        onChange={handleChange}
        onClear={handleClear}
        allowClear
        disabled={disabled}
        disabledAlpha
        presets={PRESETS}
        panelRender={(panel) => <div data-tour="color-panel">{panel}</div>}
      >
        <button
          type="button"
          disabled={disabled}
          data-tour={role === 'comp' ? 'color-swatch' : undefined}
          aria-label={t('settings.adjustColor', { role: t(ROLE_LABEL_KEY[role]) })}
          className="h-9 w-9 shrink-0 rounded-lg shadow-sm ring-1 ring-black/5 transition active:scale-95 disabled:opacity-50"
          style={{ background: preview }}
        />
      </ColorPicker>
    </div>
  );
}
