/**
 * 控制台外观：动效速度 / 卡片透明度 / 组件模糊 / 背景模糊 + 竖横两张自定义背景图，
 * 外加三组可调配色（全局字体、组件与按钮、品牌 Logo），每组都是标准 HSV 三值。
 *
 * 数值统一落到 documentElement 上的 CSS 变量，globals.css 与 tailwind.config.ts
 * 的时长、透明度、模糊半径与两条色阶都从这些变量派生，因此改一处即全站生效。
 */

export type BackgroundOrientation = 'portrait' | 'landscape';

export const BACKGROUND_ORIENTATIONS: readonly BackgroundOrientation[] = ['portrait', 'landscape'];

/** 单张背景图上限 10MB */
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;

/** 可收的常规图片格式（不含 SVG：可内嵌脚本） */
export const BACKGROUND_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp,image/avif';

export interface AppearanceSettings {
  uiSpeed: number;
  cardOpacity: number;
  cardBlur: number;
  backgroundBlur: number;
  /** 全局字体色（HSV） */
  inkHue: number;
  inkSat: number;
  inkVal: number;
  /** 组件与按钮色（HSV） */
  compHue: number;
  compSat: number;
  compVal: number;
  /** 品牌 Logo 色（HSV） */
  logoHue: number;
  logoSat: number;
  logoVal: number;
}

export interface BackgroundMeta {
  ext: string;
  mime: string;
  size: number;
  updatedAt: number;
}

export interface AppearanceState extends AppearanceSettings {
  backgrounds: Record<BackgroundOrientation, BackgroundMeta | null>;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiSpeed: 1,
  cardOpacity: 0.32,
  cardBlur: 22,
  backgroundBlur: 0,
  inkHue: 215,
  inkSat: 33,
  inkVal: 60,
  compHue: 173,
  compSat: 89,
  compVal: 90,
  logoHue: 173,
  logoSat: 89,
  logoVal: 90,
};

export const DEFAULT_APPEARANCE_STATE: AppearanceState = {
  ...DEFAULT_APPEARANCE,
  backgrounds: { portrait: null, landscape: null },
};

/** 滑动条区间，与后端 appearance.service.ts 的 RANGES 一致 */
export const APPEARANCE_RANGES: Record<
  keyof AppearanceSettings,
  { min: number; max: number; step: number }
> = {
  uiSpeed: { min: 0.5, max: 2.5, step: 0.1 },
  cardOpacity: { min: 0.05, max: 0.85, step: 0.01 },
  cardBlur: { min: 0, max: 40, step: 1 },
  backgroundBlur: { min: 0, max: 40, step: 1 },
  inkHue: { min: 0, max: 360, step: 1 },
  inkSat: { min: 0, max: 100, step: 1 },
  inkVal: { min: 0, max: 100, step: 1 },
  compHue: { min: 0, max: 360, step: 1 },
  compSat: { min: 0, max: 100, step: 1 },
  compVal: { min: 0, max: 100, step: 1 },
  logoHue: { min: 0, max: 360, step: 1 },
  logoSat: { min: 0, max: 100, step: 1 },
  logoVal: { min: 0, max: 100, step: 1 },
};

/** 三个可调色角色：全局字体、组件与按钮、品牌 Logo */
export type ColorRole = 'ink' | 'comp' | 'logo';

/** HSV 三值，与标准拾色器一致：色相 0–360，饱和度与明度 0–100 */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

interface RoleKeys {
  hueKey: keyof AppearanceSettings;
  satKey: keyof AppearanceSettings;
  valKey: keyof AppearanceSettings;
  /** 代表色的基准明度（%），用于卡片标题旁那颗「当前色」圆点 */
  sampleLightness: number;
}

export const COLOR_ROLE_KEYS: Record<ColorRole, RoleKeys> = {
  ink: { hueKey: 'inkHue', satKey: 'inkSat', valKey: 'inkVal', sampleLightness: 27 },
  comp: { hueKey: 'compHue', satKey: 'compSat', valKey: 'compVal', sampleLightness: 40 },
  logo: { hueKey: 'logoHue', satKey: 'logoSat', valKey: 'logoVal', sampleLightness: 38 },
};

export const COLOR_ROLES: readonly ColorRole[] = ['ink', 'comp', 'logo'];

/**
 * 一张调色卡对应的目标。桌面端字体 / 组件按钮 / Logo 各一张；
 * 手机屏窄只放两张，brand 把组件色与 Logo 色合起来调，写入时同时落到两个角色。
 */
export type DialTarget = 'brand' | ColorRole;

export const DIAL_TARGET_META: Record<DialTarget, { label: string; roles: readonly ColorRole[] }> = {
  brand: { label: '卡片及 Logo', roles: ['comp', 'logo'] },
  ink: { label: '全局字体', roles: ['ink'] },
  comp: { label: '组件及按钮', roles: ['comp'] },
  logo: { label: 'Logo', roles: ['logo'] },
};

export function readHsv(settings: AppearanceSettings, role: ColorRole): Hsv {
  const keys = COLOR_ROLE_KEYS[role];
  return { h: settings[keys.hueKey], s: settings[keys.satKey], v: settings[keys.valKey] };
}

/** 写回补丁：brand 目标会把同一个颜色同时写给组件色与 Logo 色 */
export function hsvPatch(target: DialTarget, hsv: Hsv): Partial<AppearanceSettings> {
  const patch: Partial<AppearanceSettings> = {};
  for (const role of DIAL_TARGET_META[target].roles) {
    const keys = COLOR_ROLE_KEYS[role];
    patch[keys.hueKey] = hsv.h;
    patch[keys.satKey] = hsv.s;
    patch[keys.valKey] = hsv.v;
  }
  return patch;
}

/** HSV → HSL。色阶派生与预览都换算到 HSL，两处用同一个算法才能所见即所得 */
export function hsvToHsl(hsv: Hsv): { h: number; s: number; l: number } {
  const s = Math.min(100, Math.max(0, hsv.s)) / 100;
  const v = Math.min(100, Math.max(0, hsv.v)) / 100;
  const l = v * (1 - s / 2);
  const edge = l === 0 || l === 1;
  return {
    h: ((hsv.h % 360) + 360) % 360,
    s: edge ? 0 : ((v - l) / Math.min(l, 1 - l)) * 100,
    l: l * 100,
  };
}

/** 卡片标题旁那颗圆点：该角色在全站实际呈现的代表色 */
export function roleSampleColor(settings: AppearanceSettings, role: ColorRole): string {
  const { h, s, l } = hsvToHsl(readHsv(settings, role));
  const base = COLOR_ROLE_KEYS[role].sampleLightness;
  const lightness = Math.min(96, Math.max(4, base * (l / 50)));
  return `hsl(${h} ${Math.round(s)}% ${Math.round(lightness)}%)`;
}

/** 拾色器当前选中点的纯色，标准 HSV 语义 */
export function hsvCss(hsv: Hsv): string {
  const { h, s, l } = hsvToHsl(hsv);
  return `hsl(${h} ${Math.round(s)}% ${Math.round(l)}%)`;
}

const CACHE_KEY = 'kk-appearance';

function clamp(key: keyof AppearanceSettings, value: unknown): number {
  const { min, max } = APPEARANCE_RANGES[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE[key];
  return Math.min(max, Math.max(min, n));
}

/** 兼容旧缓存：早期只有 accentHue/accentSat（HSL 语义），换算成组件色与 Logo 色的 HSV */
function migrateLegacyColors(raw: Record<string, unknown>): Partial<AppearanceSettings> {
  if (raw.compHue !== undefined || raw.accentHue === undefined) return {};
  const sat = Math.min(100, Math.max(0, Number(raw.accentSat ?? 80))) / 100;
  const v = 0.5 + sat / 2;
  const s = v === 0 ? 0 : 2 * (1 - 0.5 / v) * 100;
  const h = Number(raw.accentHue);
  return { compHue: h, compSat: s, compVal: v * 100, logoHue: h, logoSat: s, logoVal: v * 100 };
}

export function normalizeAppearance(raw?: Partial<AppearanceState> | null): AppearanceState {
  const input = raw ?? {};
  const src = { ...input, ...migrateLegacyColors(input as Record<string, unknown>) };
  const bg = input.backgrounds ?? { portrait: null, landscape: null };
  const out = {} as AppearanceState;
  // 按区间表逐项收口，日后新增字段不会漏
  for (const key of Object.keys(APPEARANCE_RANGES) as (keyof AppearanceSettings)[]) {
    out[key] = clamp(key, src[key] ?? DEFAULT_APPEARANCE[key]);
  }
  out.backgrounds = {
    portrait: bg.portrait ?? null,
    landscape: bg.landscape ?? null,
  };
  return out;
}

/** 带 mtime 版本号，换图后浏览器不会吃旧缓存 */
export function backgroundUrl(orientation: BackgroundOrientation, meta: BackgroundMeta): string {
  return `/api/appearance/public/background/${orientation}?v=${meta.updatedAt}`;
}

/** 百分比取整并夹到 [2, 98]，避免整体提亮/压暗到全白或全黑 */
function clampPct(value: number): number {
  return Math.round(Math.min(98, Math.max(2, value)));
}

/** HSL → "R G B" 通道串，供 globals.css 里的 rgb(var(--x) / α) 复用 */
function hslChannels(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.min(100, Math.max(0, s)) / 100;
  const light = Math.min(100, Math.max(0, l)) / 100;
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return rgb.map((v) => Math.round((v + m) * 255)).join(' ');
}

/** 数值类外观：动效速度、卡片透明度、组件模糊、两套配色。登录页也可安全应用 */
export function applyAppearanceTokens(settings: AppearanceSettings): void {
  if (typeof document === 'undefined') return;
  const { style } = document.documentElement;
  const speed = clamp('uiSpeed', settings.uiSpeed);
  // 速度是倍率，时长要取倒数：2× 速度 = 一半时长
  style.setProperty('--kk-motion', String(Math.round((1 / speed) * 1000) / 1000));
  style.setProperty('--kk-card-alpha', String(clamp('cardOpacity', settings.cardOpacity)));
  style.setProperty('--kk-blur', `${clamp('cardBlur', settings.cardBlur)}px`);
  style.setProperty('--kk-bg-blur', `${clamp('backgroundBlur', settings.backgroundBlur)}px`);

  // 三个角色各一组 HSV，换算到 HSL 后下发；色阶与硬编码色都由这些变量派生
  for (const role of COLOR_ROLES) {
    const { h, s, l } = hsvToHsl(readHsv(settings, role));
    style.setProperty(`--kk-${role}-h`, String(Math.round(h)));
    style.setProperty(`--kk-${role}-s`, `${Math.round(s)}%`);
    // 明度倍率以 50% 为基准：色阶各档明度乘它，整体提亮或压暗而不打乱层次
    style.setProperty(`--kk-${role}-lmul`, String(Math.round((l / 50) * 1000) / 1000));
  }

  // 组件色的 RGB 通道，供 rgb(var(--x) / α) 形式的玻璃描边与高光复用
  const comp = hsvToHsl(readHsv(settings, 'comp'));
  const compScale = comp.l / 50;
  style.setProperty('--kk-comp-rgb', hslChannels(comp.h, comp.s, 40 * compScale));
  style.setProperty('--kk-comp-soft-rgb', hslChannels(comp.h, comp.s * 0.75, 44 * compScale));
  style.setProperty('--kk-comp-alt-rgb', hslChannels(comp.h + 23, comp.s * 0.9, 55 * compScale));

  // Logo 渐变两端色
  const logo = hsvToHsl(readHsv(settings, 'logo'));
  const logoScale = logo.l / 50;
  const logoS = Math.round(logo.s);
  style.setProperty('--kk-logo-from', `hsl(${Math.round(logo.h)} ${logoS}% ${clampPct(38 * logoScale)}%)`);
  style.setProperty('--kk-logo-to', `hsl(${Math.round(logo.h + 26)} ${Math.round(logo.s * 0.92)}% ${clampPct(46 * logoScale)}%)`);
}

/** 背景图层：登录页与控制台共用，图片走公开只读接口 */
export function applyAppearanceBackground(state: AppearanceState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const { style } = root;
  let hasAny = false;
  for (const orientation of BACKGROUND_ORIENTATIONS) {
    const meta = state.backgrounds?.[orientation] ?? null;
    const varName = `--kk-bg-${orientation}`;
    if (meta) {
      style.setProperty(varName, `url("${backgroundUrl(orientation, meta)}")`);
      hasAny = true;
    } else {
      style.removeProperty(varName);
    }
  }
  if (hasAny) root.setAttribute('data-kk-bg', '1');
  else root.removeAttribute('data-kk-bg');
}

export function applyAppearance(state: AppearanceState): void {
  applyAppearanceTokens(state);
  applyAppearanceBackground(state);
}

export function cacheAppearance(state: AppearanceState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state));
  } catch { /* 隐私模式等写不进去，忽略 */ }
}

/** 首帧先用缓存渲染，避免等接口返回时外观闪一下 */
export function readCachedAppearance(): AppearanceState {
  if (typeof window === 'undefined') return DEFAULT_APPEARANCE_STATE;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return DEFAULT_APPEARANCE_STATE;
    return normalizeAppearance(JSON.parse(raw) as Partial<AppearanceState>);
  } catch {
    return DEFAULT_APPEARANCE_STATE;
  }
}

export function isSupportedBackgroundFile(file: File): boolean {
  if (file.type) return BACKGROUND_ACCEPT.split(',').includes(file.type);
  return /\.(jpe?g|png|gif|webp|bmp|avif)$/i.test(file.name);
}

export function formatAppearanceValue(key: keyof AppearanceSettings, value: number): string {
  switch (key) {
    case 'uiSpeed':
      return `${value.toFixed(1)}×`;
    case 'cardOpacity':
      return `${Math.round(value * 100)}%`;
    default:
      return `${Math.round(value)}px`;
  }
}