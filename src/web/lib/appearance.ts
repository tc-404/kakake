/**
 * 控制台外观：动效速度 / 卡片透明度 / 组件模糊 / 背景模糊 + 竖横两份自定义背景
 * （图片，或 mp4 / 实况图视频轨这类自动循环的视频），外加三组可调配色
 * （全局字体、组件与按钮、品牌 Logo），每组都是标准 HSV 三值。
 *
 * 数值统一落到 documentElement 上的 CSS 变量，globals.css 与 tailwind.config.ts
 * 的时长、透明度、模糊半径与两条色阶都从这些变量派生，因此改一处即全站生效。
 */

export type BackgroundOrientation = 'portrait' | 'landscape';

export const BACKGROUND_ORIENTATIONS: readonly BackgroundOrientation[] = ['portrait', 'landscape'];

/** 背景资源两类：图片走 CSS background-image（动图 GIF 自动播），视频走 <video> 循环 */
export type BackgroundKind = 'image' | 'video';

/** 单张背景图上限 10MB、单个背景视频上限 100MB（与后端一致） */
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;
export const BACKGROUND_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

/** 可收的格式（不含 SVG：可内嵌脚本） */
export const BACKGROUND_ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,image/bmp,image/avif,video/mp4,video/quicktime';

export interface AppearanceSettings {
  uiSpeed: number;
  cardOpacity: number;
  cardBlur: number;
  /** 组件2（悬浮窗 / 插件与资源界面等次级表面）透明度 */
  card2Opacity: number;
  /** 组件2 模糊度 */
  card2Blur: number;
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
  kind: BackgroundKind;
  size: number;
  updatedAt: number;
}

export interface AppearanceState extends AppearanceSettings {
  backgrounds: Record<BackgroundOrientation, BackgroundMeta | null>;
  /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部品牌字），空串用默认「咔咔珂」 */
  customTitle: string;
}

/** 自定义标题名上限：20 个字符（按码点计，与后端一致） */
export const CUSTOM_TITLE_MAX_LEN = 20;

/** 收口自定义标题：去首尾空白，按码点截到上限 */
export function normalizeCustomTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return Array.from(trimmed).slice(0, CUSTOM_TITLE_MAX_LEN).join('');
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiSpeed: 1,
  cardOpacity: 0.32,
  cardBlur: 22,
  card2Opacity: 0.2,
  card2Blur: 24,
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
  customTitle: '',
};

/** 滑动条区间，与后端 appearance.service.ts 的 RANGES 一致 */
export const APPEARANCE_RANGES: Record<
  keyof AppearanceSettings,
  { min: number; max: number; step: number }
> = {
  uiSpeed: { min: 0.5, max: 2.5, step: 0.1 },
  cardOpacity: { min: 0.05, max: 0.85, step: 0.01 },
  cardBlur: { min: 0, max: 40, step: 1 },
  card2Opacity: { min: 0.05, max: 0.85, step: 0.01 },
  card2Blur: { min: 0, max: 40, step: 1 },
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

/** HSV → #RRGGBB 十六进制 */
export function hsvToHex(hsv: Hsv): string {
  const h = ((hsv.h % 360) + 360) % 360;
  const s = Math.min(100, Math.max(0, hsv.s)) / 100;
  const v = Math.min(100, Math.max(0, hsv.v)) / 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const rgb = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  const hex = rgb.map((n) => Math.round((n + m) * 255).toString(16).padStart(2, '0')).join('');
  return `#${hex}`;
}

/**
 * 解析颜色代码为 HSV。支持 #rgb / #rrggbb / rgb(...) / hsl(...)。
 * 无法解析返回 null。
 */
export function parseColorToHsv(input: string): Hsv | null {
  const str = input.trim().toLowerCase();
  if (!str) return null;

  // #rgb / #rrggbb
  const hexMatch = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(str);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return rgbToHsv(r, g, b);
  }

  // rgb(r,g,b) / rgba(r,g,b,a)
  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(str);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((p) => Number(p.trim()));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return rgbToHsv(parts[0], parts[1], parts[2]);
    }
    return null;
  }

  // hsl(h,s%,l%) / hsl(h s% l%)
  const hslMatch = /^hsla?\(([^)]+)\)$/.exec(str);
  if (hslMatch) {
    const parts = hslMatch[1].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length >= 3) {
      const h = Number(parts[0].replace('deg', ''));
      const s = Number(parts[1].replace('%', ''));
      const l = Number(parts[2].replace('%', ''));
      if ([h, s, l].every((n) => Number.isFinite(n))) return hslToHsv(h, s, l);
    }
    return null;
  }

  return null;
}

function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rr = Math.min(255, Math.max(0, r)) / 255;
  const gg = Math.min(255, Math.max(0, g)) / 255;
  const bb = Math.min(255, Math.max(0, b)) / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : (d / max) * 100;
  return { h: Math.round(h), s: Math.round(s), v: Math.round(max * 100) };
}

function hslToHsv(h: number, s: number, l: number): Hsv {
  const ss = Math.min(100, Math.max(0, s)) / 100;
  const ll = Math.min(100, Math.max(0, l)) / 100;
  const v = ll + ss * Math.min(ll, 1 - ll);
  const sv = v === 0 ? 0 : 2 * (1 - ll / v);
  return { h: ((Math.round(h) % 360) + 360) % 360, s: Math.round(sv * 100), v: Math.round(v * 100) };
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

const VIDEO_EXTS = ['mp4', 'mov'];

/** 旧缓存 / 旧接口返回的 meta 没有 kind，按扩展名补齐 */
export function backgroundKindOf(meta: BackgroundMeta): BackgroundKind {
  if (meta.kind === 'video' || meta.kind === 'image') return meta.kind;
  return VIDEO_EXTS.includes(meta.ext) ? 'video' : 'image';
}

function normalizeBackgroundMeta(meta: BackgroundMeta | null | undefined): BackgroundMeta | null {
  if (!meta || typeof meta !== 'object') return null;
  return { ...meta, kind: backgroundKindOf(meta) };
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
    portrait: normalizeBackgroundMeta(bg.portrait),
    landscape: normalizeBackgroundMeta(bg.landscape),
  };
  out.customTitle = normalizeCustomTitle(input.customTitle);
  return out;
}

/** 带 mtime 版本号，换资源后浏览器不会吃旧缓存 */
export function backgroundUrl(orientation: BackgroundOrientation, meta: BackgroundMeta): string {
  return `/api/appearance/public/background/${orientation}?v=${meta.updatedAt}`;
}

/** 某一屏幕方向最终要显示的那份背景，以及它实际存放的方向（URL 按它拼） */
export interface BackgroundSlot {
  kind: BackgroundKind;
  orientation: BackgroundOrientation;
  meta: BackgroundMeta;
}

/**
 * 方向取用规则：本方向有资源（不论图片视频）优先，没有才借另一方向的；
 * 指定 kind 时只在同类里借，且本方向被另一类占住时不再外借——
 * 否则图片层（::after 在视频之上）会压住视频，反之视频也会盖掉图片。
 */
export function resolveBackgroundSlot(
  state: AppearanceState,
  orientation: BackgroundOrientation,
  kind?: BackgroundKind,
): BackgroundSlot | null {
  const otherOrientation: BackgroundOrientation = orientation === 'portrait' ? 'landscape' : 'portrait';
  const candidates: readonly [BackgroundMeta | null, BackgroundOrientation][] = [
    [state.backgrounds[orientation], orientation],
    [state.backgrounds[otherOrientation], otherOrientation],
  ];
  for (const [meta, slotOrientation] of candidates) {
    if (!meta) continue;
    const resolved = backgroundKindOf(meta);
    if (kind && resolved !== kind) {
      if (slotOrientation === orientation) return null;
      continue;
    }
    return { kind: resolved, orientation: slotOrientation, meta };
  }
  return null;
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
  style.setProperty('--kk-card2-alpha', String(clamp('card2Opacity', settings.card2Opacity)));
  style.setProperty('--kk-blur2', `${clamp('card2Blur', settings.card2Blur)}px`);
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

/**
 * 背景图层：登录页与控制台共用，图片走公开只读接口的 CSS 变量；
 * 视频另有 <AmbientVideo /> 组件渲染（CSS 变量装不下视频元素）。
 * 跨方向兜底在这里解析好，CSS 侧只管取自己方向的变量。
 */
export function applyAppearanceBackground(state: AppearanceState): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  const { style } = root;
  let hasAny = false;
  for (const orientation of BACKGROUND_ORIENTATIONS) {
    if (state.backgrounds[orientation]) hasAny = true;
    const varName = `--kk-bg-${orientation}`;
    const slot = resolveBackgroundSlot(state, orientation, 'image');
    if (slot) {
      style.setProperty(varName, `url("${backgroundUrl(slot.orientation, slot.meta)}")`);
      hasAny = true;
    } else {
      style.removeProperty(varName);
    }
  }
  if (hasAny) root.setAttribute('data-kk-bg', '1');
  else root.removeAttribute('data-kk-bg');
}

let currentAppearanceState = DEFAULT_APPEARANCE_STATE;
const appearanceListeners = new Set<() => void>();

/** 供 AmbientVideo 等需要响应外观变化的组件订阅 */
export function subscribeAppearance(listener: () => void): () => void {
  appearanceListeners.add(listener);
  return () => appearanceListeners.delete(listener);
}

export function getAppearanceSnapshot(): AppearanceState {
  return currentAppearanceState;
}

export function applyAppearance(state: AppearanceState): void {
  currentAppearanceState = state;
  applyAppearanceTokens(state);
  applyAppearanceBackground(state);
  for (const listener of appearanceListeners) listener();
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
  return /\.(jpe?g|png|gif|webp|bmp|avif|mp4|mov|m4v)$/i.test(file.name);
}

/** 本地文件按 MIME / 扩展名先判个类：选择器预览与限额提示用 */
export function backgroundKindFromFile(file: File): BackgroundKind {
  if (file.type) return file.type.startsWith('video/') ? 'video' : 'image';
  return /\.(mp4|mov|m4v)$/i.test(file.name) ? 'video' : 'image';
}

export function backgroundMaxBytesOf(kind: BackgroundKind): number {
  return kind === 'video' ? BACKGROUND_VIDEO_MAX_BYTES : BACKGROUND_MAX_BYTES;
}

export function formatAppearanceValue(key: keyof AppearanceSettings, value: number): string {
  switch (key) {
    case 'uiSpeed':
      return `${value.toFixed(1)}×`;
    case 'cardOpacity':
      return `${Math.round(value * 100)}%`;
    case 'card2Opacity':
      return `${Math.round(value * 100)}%`;
    default:
      return `${Math.round(value)}px`;
  }
}