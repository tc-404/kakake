import * as React from 'react';
import { ColorPicker, ConfigProvider, theme as antdTheme } from 'antd';
import {
  COLOR_ROLES,
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

/** 两端色标速写 */
const stops = (from: string, to: string): GradientStop[] => [
  { color: from, percent: 0 },
  { color: to, percent: 100 },
];

/** 内置渐变预设：面板左下角点一下即整条套用 */
const GRADIENT_PRESETS: GradientStop[][] = [
  stops('#36d1dc', '#5b86e5'),
  stops('#43e97b', '#38f9d7'),
  stops('#fa709a', '#fee140'),
  stops('#30cfd0', '#330867'),
  stops('#ff9966', '#ff5e62'),
  stops('#a18cd1', '#fbc2eb'),
  stops('#f6d365', '#fda085'),
  stops('#0ba360', '#3cba92'),
  stops('#2af598', '#009efd'),
  stops('#ff0844', '#ffb199'),
];

/** 单色预设：与渐变页签并排的常用色 */
const SOLID_PRESET_COLORS = [
  '#1677ff', '#00b96b', '#13c2c2', '#722ed1',
  '#eb2f96', '#faad14', '#fa541c', '#ff4d4f',
  '#66ccff', '#52c41a', '#fadb14', '#2ceb13',
];

const PRESETS = [
  { key: 'kk-gradients', label: '渐变', colors: GRADIENT_PRESETS },
  { key: 'kk-solid', label: '单色', colors: SOLID_PRESET_COLORS },
];

/**
 * 从 antd ColorPicker 的回调值里取 CSS 串：
 * 单色 → #hex；渐变 → linear-gradient(...)。
 * 兼容两种形态（Color 对象 / { color, type } 包装），取不到返回空串。
 */
function cssStringOf(value: unknown, fallback?: string): string {
  const v = value as {
    toCssString?: () => string;
    color?: { toCssString?: () => string };
  } | null;
  if (v && typeof v.toCssString === 'function') return v.toCssString();
  if (v?.color && typeof v.color.toCssString === 'function') return v.color.toCssString();
  return typeof fallback === 'string' ? fallback : '';
}

/**
 * 配色方案：一行一个角色，行尾一个正方形色块预览当前色（单色或渐变）。
 * 点色块弹出 Ant Design 的 ColorPicker 面板——「单色 / 渐变色」两个页签，
 * 渐变页签可以在渐变条上加减色标、拖动调位置，选完即实时生效并防抖落库。
 */
export function ColorPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceState;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceState>) => void;
}) {
  // 控制台主色随「组件及按钮」走，让 antd 面板的高亮与整站观感一致。
  // 组件色启用渐变时取渐变中点色，否则面板高亮会停在「上一次的单色」上。
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
  // 受控值：启用渐变给色标数组（面板自动落在「渐变色」页签），否则给单色 hex
  const pickerValue: string | GradientStop[] | undefined = gradient
    ? (parseGradientStops(gradient) ?? undefined)
    : hsvToHex(readHsv(settings, role));
  // 色块预览：渐变优先展示整条渐变，单色展示该角色「实际呈现」的代表色
  const preview = gradient || roleEffectiveColor(settings, role);

  const handleChange = (value: unknown, css?: string) => {
    const text = cssStringOf(value, css);
    if (!text) return;
    if (text.includes('gradient(')) {
      onChange({ [gradField]: text } as Partial<AppearanceState>);
      return;
    }
    // 单色：写回 HSV（单色是渐变的回落底色），并清掉渐变
    const hsv: Hsv | null = parseColorToHsv(text);
    if (hsv) onChange({ ...hsvPatch(role, hsv), [gradField]: '' } as Partial<AppearanceState>);
  };

  /** 面板上的「清空」：只撤掉渐变，保留当前单色底（清完仍是可用的主题色，不会变成无色） */
  const handleClear = () => {
    if (!gradient) return;
    onChange({ [gradField]: '' } as Partial<AppearanceState>);
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
        allowClear={Boolean(gradient)}
        disabled={disabled}
        disabledAlpha
        presets={PRESETS}
        /* 导览锚点：包一层拿到面板 DOM，并阻断点击冒泡（避免被卡片当作普通点击） */
        panelRender={(panel) => <div data-tour="color-panel">{panel}</div>}
      >
        <button
          type="button"
          disabled={disabled}
          data-tour={role === 'comp' ? 'color-swatch' : undefined}
          aria-label={t('settings.adjustColor', { role: t(ROLE_LABEL_KEY[role]) })}
          className="h-9 w-9 shrink-0 rounded-lg border border-white/60 shadow-sm ring-1 ring-black/5 transition active:scale-95 disabled:opacity-50"
          style={{ background: preview }}
        />
      </ColorPicker>
    </div>
  );
}
