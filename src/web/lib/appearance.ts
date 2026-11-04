/**
 * 控制台外观设置（动效/透明度/模糊/背景/配色），数值统一写到 documentElement 的 CSS 变量，
 * 由 globals.css 与 tailwind.config.ts 派生，故改一处即全站生效。
 */
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';
import {
  gradientHslSampler,
  gradientSampler,
  gradientShadeHues,
  parseCssColor,
  rgbToHsl,
  SHADES,
  type Rgb,
} from '@/lib/color-ramp';

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
  /**
   * 卡片边缘扩散阴影的浓度（阴影自身的不透明度，0–CARD_SHADOW_MAX）。
   * 设置里按百分比显示：0% = 关闭，100% = CARD_SHADOW_MAX（0.2）。
   */
  cardShadow: number;
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
  /** 侧边栏宽度：电脑端像素值 */
  sidebarWidthPc: number;
  /** 侧边栏宽度：手机端占屏宽百分比 */
  sidebarWidthMobile: number;
  /** 页面水印倾斜角度（度）：负值左倾、正值右倾，0 = 水平 */
  watermarkAngle: number;
  /** 页面水印密集度（0–100）：越大格子越密 */
  watermarkDensity: number;
  /** 页面水印字号（px） */
  watermarkSize: number;
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
  /** 背景适配方式：铺满裁切 / 拉伸铺满 / 完整显示 */
  bgFit: BackgroundFit;
  /** 背景预设：default 出厂氛围底 / waves 波浪；有自定义背景时不生效 */
  bgPreset: BackgroundPreset;
  /**
   * 三个可调色角色的渐变色（CSS linear-gradient 串），空串 = 未启用、回落到单色 HSV。
   * 与后端同名字段一一对应，由 normalizeGradientCss 收口。
   */
  inkGradient: string;
  compGradient: string;
  logoGradient: string;
  /**
   * 页面水印文字（设置页「页面水印」）：非空即开启，平铺在 8787 端口下**全部界面**
   * 的最上层（含所有子路径，高于弹窗 / 导览 / 安装浮层）；空串 = 关闭。
   * 颜色不由这里决定 —— 水印属于「全局字体」角色，跟着 ink 色走。
   */
  watermarkText: string;
}

/**
 * 背景预设：在没有自定义背景时，用来替换整片氛围底的程序化背景。
 * - default 出厂默认：沿用 CSS 渐变氛围底（历来就是这个样子）
 * - waves   波浪：WebGL 波浪线，鼠标经过会拖出起伏；只在「完整特效」档渲染
 */
export type BackgroundPreset = 'default' | 'waves';

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = ['default', 'waves'];

export const DEFAULT_BACKGROUND_PRESET: BackgroundPreset = 'default';

export function normalizeBackgroundPreset(value: unknown): BackgroundPreset {
  return value === 'waves' ? 'waves' : DEFAULT_BACKGROUND_PRESET;
}

/** 背景预设的显示名与说明（设置页卡片直接用这张表渲染，加预设只改一处） */
export const BACKGROUND_PRESET_META: readonly {
  value: BackgroundPreset;
  label: string;
  hint: string;
}[] = [
  { value: 'default', label: '默认', hint: '出厂的渐变氛围底，不额外占用显卡' },
  { value: 'waves', label: '波浪', hint: '波浪线会随鼠标起伏；只在完整特效下显示' },
];

/**
 * 背景与屏幕比例不匹配时的铺法（设置页可选）：
 * - cover   铺满裁切（默认）：填满整个屏幕，多出来的部分裁掉，不变形；
 * - stretch 拉伸铺满：一律拉到 100%×100%，一定填满，但比例不符时会变形；
 * - contain 完整显示：整张图都看得到，四周用同一张图的模糊副本垫底（不留空、不变形）。
 */
export type BackgroundFit = 'cover' | 'stretch' | 'contain';

export const BACKGROUND_FIT_OPTIONS: readonly { value: BackgroundFit; label: string; hint: string }[] = [
  { value: 'cover', label: '铺满裁切', hint: '填满屏幕，多出的部分裁掉，不变形（默认）' },
  { value: 'stretch', label: '拉伸铺满', hint: '强制拉满整屏，比例不符时会变形' },
  { value: 'contain', label: '完整显示', hint: '整张图都可见，四周用同一张图的模糊副本垫底' },
];

export const DEFAULT_BACKGROUND_FIT: BackgroundFit = 'cover';

export function normalizeBackgroundFit(value: unknown): BackgroundFit {
  return BACKGROUND_FIT_OPTIONS.some((o) => o.value === value) ? (value as BackgroundFit) : DEFAULT_BACKGROUND_FIT;
}

/** 自定义标题名上限：20 个字符（按码点计，与后端一致） */
export const CUSTOM_TITLE_MAX_LEN = 20;

/**
 * 阴影透明度的满格墨色：滑块 100% 对应的实际不透明度。
 * 与后端 RANGES.cardShadow 的上限必须一致，改一处要改两处。
 * 0.35 是上下两版的折中：0.4 太浓（糊成一圈黑边），0.2 又淡到肉眼几乎看不出，
 * 取 0.35 再配小半径（最外一层也只有 16px），拉满明显但不糊。
 */
export const CARD_SHADOW_MAX = 0.35;

/** 墨色 → 设置里显示的百分比（0–100） */
export function cardShadowPercent(value: number): number {
  return Math.round((value / CARD_SHADOW_MAX) * 100);
}

/** 收口自定义标题：去首尾空白，按码点截到上限 */
export function normalizeCustomTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return Array.from(trimmed).slice(0, CUSTOM_TITLE_MAX_LEN).join('');
}

/** 页面水印文字上限：40 个字符（按码点计，与后端 WATERMARK_MAX_LEN 一致） */
export const WATERMARK_MAX_LEN = 40;

/** 打开「页面水印」开关时填入的默认文字 */
export const DEFAULT_WATERMARK_TEXT = 'Kakake水印';

/** 页面水印默认倾斜角：与 antd Watermark 出厂值一致（-22°） */
export const DEFAULT_WATERMARK_ANGLE = -22;

/**
 * 密集度 → 格子额外间距（px，旋转包围盒之外再加这么多）。
 *
 * 0 = 最疏（260px 横距）、100 = 最密（40px 横距）；纵向按 0.8 倍取，
 * 让铺出来的水印略扁于正方格。下限 40 仍大于任何旋转后的文字高度，
 * 所以即使拉满也不会出现两枚水印叠字。
 */
export function watermarkGap(density: number): { x: number; y: number } {
  const d = Math.min(100, Math.max(0, density));
  const x = Math.round(260 - d * 2.2);
  return { x, y: Math.round(x * 0.8) };
}

/**
 * 收口页面水印文字：去首尾空白、多行压成一行、去控制字符，按码点截到上限。
 * 空串 = 关闭（前端据此决定画不画水印），所以只有空格也算空。
 */
export function normalizeWatermark(value: unknown): string {
  if (typeof value !== 'string') return '';
  // 换行 / 制表 / 控制字符压成一个空格（水印只能是单行），普通空格按用户输入原样保留
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return '';
  return Array.from(flat).slice(0, WATERMARK_MAX_LEN).join('');
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiSpeed: 1,
  cardOpacity: 0.32,
  cardBlur: 22,
  card2Opacity: 0.2,
  card2Blur: 24,
  cardShadow: 0.14,
  backgroundBlur: 0,
  // 全局字体色：石板色
  inkHue: 215,
  inkSat: 33,
  inkVal: 60,
  // 组件与按钮出厂色 = #2ceb13（HSV 113,92,92）
  compHue: 113,
  compSat: 92,
  compVal: 92,
  // 品牌 Logo 出厂色 = #f1ff2e（HSV 64,82,100）
  logoHue: 64,
  logoSat: 82,
  logoVal: 100,
  // 手机 67%（≈ 屏宽三分之二）、电脑 204px（比原 144px 宽 60px）——
  // 两个默认值都正好是各自区间的中点，滑块初始化落在正中间，往两边调宽调窄都有余量
  sidebarWidthPc: 204,
  sidebarWidthMobile: 67,
  // 页面水印：默认角度与 antd Watermark 一致；密集度 60 ≈ 原来的 120px 横距；字号 16px
  watermarkAngle: DEFAULT_WATERMARK_ANGLE,
  watermarkDensity: 60,
  watermarkSize: 16,
};

export const DEFAULT_APPEARANCE_STATE: AppearanceState = {
  ...DEFAULT_APPEARANCE,
  backgrounds: { portrait: null, landscape: null },
  customTitle: '',
  // 出厂不显示水印：空串 = 关闭。用户打开开关时才填入 DEFAULT_WATERMARK_TEXT
  watermarkText: '',
  bgFit: DEFAULT_BACKGROUND_FIT,
  bgPreset: DEFAULT_BACKGROUND_PRESET,
  inkGradient: '',
  compGradient: '',
  logoGradient: '',
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
  // 阴影：0–CARD_SHADOW_MAX，步长取满格的 1/100，滑块正好是 0–100% 一百档
  cardShadow: { min: 0, max: CARD_SHADOW_MAX, step: CARD_SHADOW_MAX / 100 },
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
  /*
   * 下限 50：允许把侧栏压成一条只摆得下图标的窄条。
   * 上限 264，默认 204 落在偏宽一侧（四条导航项带图标 + 四字全称刚好不挤）。
   *
   * 三个自适应断点都在这段区间里（见 console-shell 的常量）：
   * - < 140px：导航项改用两字短名（概览 / 连接 / 插件 …）
   * - < 105px：带文字的按钮把图标收掉、只留文字（纯图标按钮不受影响）
   * - <  80px：连两字短名都放不下，只留图标
   * 必须与后端 appearance.service.ts 的 RANGES.sidebarWidthPc 保持一致，
   * 否则前端拖到下限的值存回去会被后端夹回来、滑块自己跳走。
   */
  sidebarWidthPc: { min: 50, max: 264, step: 2 },
  /*
   * 手机侧栏是覆盖式抽屉，宽度按屏宽百分比走：
   * 上限 90%（再宽就快盖满整屏、失去「抽屉」的意义），下限 20%
   * （比这更窄只剩一条缝，连图标都摆不下，没有实用价值）。
   * 默认 67% ≈ 屏宽三分之二。
   * 两个自适应断点同样按百分比算（见 console-shell 的 NAV_COMPACT_VW / NAV_NO_TEXT_VW）。
   */
  sidebarWidthMobile: { min: 20, max: 90, step: 1 },
  /*
   * 页面水印三项：倾斜度允许左右各 60°（再斜字就接近竖排，失去可读性）；
   * 密集度 0–100 由 watermarkGap() 映射成实际间距；字号 8–48px。
   * 区间必须与后端 appearance.service.ts 的 RANGES 一致。
   */
  watermarkAngle: { min: -60, max: 60, step: 1 },
  watermarkDensity: { min: 0, max: 100, step: 1 },
  watermarkSize: { min: 8, max: 48, step: 1 },
};

/** 三个可调色角色：全局字体、组件与按钮、品牌 Logo */
export type ColorRole = 'ink' | 'comp' | 'logo';

/** 角色对应的渐变色字段名（存在 AppearanceState 上） */
export function gradientFieldOf(role: ColorRole): 'inkGradient' | 'compGradient' | 'logoGradient' {
  return role === 'ink' ? 'inkGradient' : role === 'comp' ? 'compGradient' : 'logoGradient';
}

/** 某角色当前的渐变 CSS 串（'' = 未启用，走单色 HSV） */
export function gradientOf(state: AppearanceState, role: ColorRole): string {
  return state[gradientFieldOf(role)] || '';
}

export interface GradientStop {
  color: string;
  percent: number;
}

/**
 * 颜色记号白名单：hex / rgb() / rgba() / hsl() / hsla()，逗号与空格两种写法都收
 * （与后端收口规则一致）。
 *
 * 为什么两种都要收：拾色器不同版本 / 不同浏览器回传的串格式不一样
 * （`rgb(255, 8, 68)`、`rgb(255 8 68)`、`rgb(255 8 68 / 0.5)`、`hsl(64 100% 45%)`），
 * 只认逗号写法时，空格写法会被整条判非法 → 渐变被静默丢弃，表现为
 * 「拖完色标一松手就还原」。函数名 / url() 之类仍然一律拒收。
 */
function isSafeColorToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(t)) return true;
  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(t);
  if (!fn) return false;
  const kind = fn[1].startsWith('rgb') ? 'rgb' : 'hsl';
  const parts = fn[2].replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return false;
  const num = /^[-+]?\d*\.?\d+$/;
  const pct = /^[-+]?\d*\.?\d+%$/;
  const alpha = /^[-+]?\d*\.?\d+%?$/;
  if (kind === 'rgb') {
    if (!parts.slice(0, 3).every((p) => num.test(p) || pct.test(p))) return false;
  } else {
    if (!/^[-+]?\d*\.?\d+(deg|turn|rad)?$/.test(parts[0])) return false;
    if (!pct.test(parts[1]) || !pct.test(parts[2])) return false;
  }
  if (parts[3] !== undefined && !alpha.test(parts[3])) return false;
  return true;
}

/** 按顶层逗号切分（括号内的逗号不切） */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 解析 linear-gradient CSS 串为色标数组；不合法返回 null。
 * 与后端同一套白名单，只认 linear-gradient + 安全色标。
 * 注意：**保持色标原顺序与小数精度**，不做排序/取整——
 * 结果会原样回喂给受控的 ColorPicker，一旦在这里动过手脚，
 * 面板拖动中的色标就会跟内部状态打架（表现为拖动跳变、看起来像被重置）。
 */
export function parseGradientStops(value: unknown): GradientStop[] | null {
  if (typeof value !== 'string') return null;
  const str = value.trim();
  if (!str || str.length > 512) return null;
  const match = /^linear-gradient\((.+)\)$/is.exec(str);
  if (!match) return null;
  const args = splitTopLevel(match[1]);
  if (args.length < 2) return null;
  let stopArgs = args;
  const first = args[0].toLowerCase().replace(/\s+/g, ' ');
  if (/^(to (right|left|top|bottom)|-?[\d.]+deg)$/.test(first)) stopArgs = args.slice(1);
  if (stopArgs.length < 2) return null;
  const stops: GradientStop[] = [];
  for (const arg of stopArgs) {
    const m = /^(.+?)\s+([\d.]+)%$/.exec(arg);
    if (!m || !isSafeColorToken(m[1])) return null;
    const percent = Number(m[2]);
    if (!Number.isFinite(percent)) return null;
    stops.push({ color: m[1].trim().toLowerCase(), percent: Math.min(100, Math.max(0, percent)) });
  }
  if (stops.length < 2 || stops.length > 12) return null;
  return stops;
}

/** 色标数组 → 规范化 linear-gradient 串（统一 90deg、按位置升序） */
export function gradientStopsToCss(stops: GradientStop[]): string {
  const list = [...stops].sort((a, b) => a.percent - b.percent);
  return `linear-gradient(90deg, ${list.map((s) => `${s.color} ${s.percent}%`).join(', ')})`;
}

/**
 * 收口渐变色：'' = 未启用。**只校验、不重建**——
 * 拾色器回传的串要原样回喂给受控 value，重建（排序/取整）会让拖动中的
 * 色标与面板内部状态错位；安全性与后端一致（同一套白名单逐段校验过）。
 */
export function normalizeGradientCss(value: unknown): string {
  if (typeof value !== 'string') return '';
  const str = value.trim();
  if (!str) return '';
  return parseGradientStops(str) ? str : '';
}

/**
 * 合并服务端外观与本地基准：数值字段以 incoming 为准；
 * 渐变字段仅在 incoming **完全没带**（undefined，旧版后端不下发）时才用 base 兜底，
 * 显式的空串（用户确实清掉了渐变）不会被缓存里的旧值复活。
 */
export function mergeAppearance(base: AppearanceState, incoming: Partial<AppearanceState>): AppearanceState {
  return normalizeAppearance({
    ...base,
    ...incoming,
    inkGradient: incoming.inkGradient ?? base.inkGradient,
    compGradient: incoming.compGradient ?? base.compGradient,
    logoGradient: incoming.logoGradient ?? base.logoGradient,
  });
}

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

/**
 * 某角色"当前真正生效的代表色"：启用渐变时取渐变中点色，否则取单色 HSV 派生色。
 *
 * 面板里那颗色块、antd 面板的主色都得用它 —— 直接用 readHsv 会在渐变启用后
 * 继续显示「上一次的单色」，看起来像没生效。
 * 中点取 HSL 插值（与色阶派生同一套算法），避免两端互补色在 sRGB 里对穿出灰。
 */
export function roleEffectiveColor(state: AppearanceState, role: ColorRole): string {
  const gradient = gradientOf(state, role);
  if (gradient) {
    const stops = parseGradientStops(gradient);
    const sample = stops ? gradientHslSampler(stops) : null;
    if (sample) {
      const { h, s, l } = sample(0.5);
      return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
    }
  }
  return roleSampleColor(state, role);
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
  out.watermarkText = normalizeWatermark(input.watermarkText);
  out.bgFit = normalizeBackgroundFit((input as { bgFit?: unknown }).bgFit);
  out.bgPreset = normalizeBackgroundPreset((input as { bgPreset?: unknown }).bgPreset);
  out.inkGradient = normalizeGradientCss(src.inkGradient);
  out.compGradient = normalizeGradientCss(src.compGradient);
  out.logoGradient = normalizeGradientCss(src.logoGradient);
  return out;
}

/** 是否已设置自定义背景（竖屏 / 横屏任一有资源就算） */
export function hasCustomBackground(state: AppearanceState): boolean {
  return Boolean(state.backgrounds.portrait || state.backgrounds.landscape);
}

/**
 * 当前真正生效的背景预设：只有「没设自定义背景 + 完整特效档」两个条件都满足时，
 * 波浪才真的画出来；其余一律退回出厂氛围底。设置页与实际渲染共用这一个判定，
 * 免得界面显示「波浪」但背后没画、或反过来。
 */
export function effectiveBackgroundPreset(state: AppearanceState, tier: 'low' | 'normal'): BackgroundPreset {
  if (state.bgPreset !== 'waves') return DEFAULT_BACKGROUND_PRESET;
  if (hasCustomBackground(state)) return DEFAULT_BACKGROUND_PRESET;
  if (tier === 'low') return DEFAULT_BACKGROUND_PRESET;
  return 'waves';
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

/** 当前是否处于暗色预设（波浪）：派生明度整体上移一档，深底上才读得出层次 */
function isDarkPreset(state: AppearanceState): boolean {
  return effectiveBackgroundPreset(state, getDeviceTier()) === 'waves';
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 字体（ink）明度倍率的收口区间：只允许 ±20%。
 *
 * ink 色阶同时承担正文、图标、弱化文字和浅色底，明度必须保住原有层次。
 * 早先这里直接用 `明度 / 50`：挑一条浅色字体渐变（平均明度 ~78%）会得到 1.56，
 * slate-400 被推到 98% —— 插件卡片底部那些 `text-slate-400` 的图标按钮
 * 在浅玻璃上直接看不见，必须悬停换成 slate-700 才显形。
 * 反过来挑深色字体时，暗色预设下反相后的字也会沉进背景。
 *
 * 色相与饱和度仍完整跟随所选颜色/渐变，只有「整体提亮/压暗」被限制在
 * 默认观感附近，保证任何配色下弱化文字都可读。
 */
const INK_LMUL_MIN = 0.8;
const INK_LMUL_MAX = 1.2;

function inkLmul(lightness: number): number {
  return round3(Math.min(INK_LMUL_MAX, Math.max(INK_LMUL_MIN, lightness / 50)));
}

/**
 * 某个角色启用渐变后，把每个色阶档位的 [色相 饱和度] 逐档写到 <html>：
 * `--kk-comp-50-hs` … `--kk-comp-950-hs`。
 *
 * tailwind.config.ts 的色阶优先读这些变量，读不到才回落到单色公式，
 * 所以「组件色选渐变」时受影响的不是一两处代表色，而是**整条色阶** ——
 * 浅底、描边、深字、悬停、图标全都按渐变走。
 */
function writeShadeHues(role: ColorRole, stops: GradientStop[]): void {
  const { style } = document.documentElement;
  for (const { shade, h, s } of gradientShadeHues(stops, SHADES)) {
    style.setProperty(`--kk-${role}-${shade}-hs`, `${h} ${s}%`);
  }
}

/** 关掉渐变时清干净，否则色阶会留在上一次的渐变取色上 */
function clearShadeHues(role: ColorRole): void {
  const { style } = document.documentElement;
  for (const shade of SHADES) style.removeProperty(`--kk-${role}-${shade}-hs`);
}

/**
 * 渐变代表色：色相/饱和度取中点，明度倍率取**五点均值**。
 *
 * 为什么明度不能只用中点：渐变里常有一个很亮的色标（比如粉→浅桃→青绿），
 * 中点正好落在最亮那一档，lmul 会飙到 1.6 —— 整条色阶跟着提亮，
 * 深字变成中灰，正文直接糊在浅玻璃上。取五点均值能反映"这条渐变整体有多亮"，
 * 观感稳定得多；色相仍按中点取，保证单色消费方与渐变中段一致。
 */
function gradientMidHsl(stops: GradientStop[]): {
  h: number;
  s: number;
  l: number;
  avgL: number;
  first: Rgb | null;
  last: Rgb | null;
} | null {
  const sample = gradientSampler(stops);
  const hslSample = gradientHslSampler(stops);
  if (!sample || !hslSample) return null;
  const mid = hslSample(0.5);
  const avgL = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => hslSample(t).l)
    .reduce((a, b) => a + b, 0) / 5;
  return { ...mid, avgL, first: sample(0), last: sample(1) };
}

/**
 * 把一条渐变按比例压成半透明版：每个色标转成 rgba()，位置原样保留。
 *
 * 用途：玻璃态表面（导航液态条 / 滑块轨道 / 移动端指示条）既要显示**完整的**
 * 多色标渐变，又要能透出背后的毛玻璃。直接引用 --kk-comp-gradient 是不透明的，
 * 会把液态条变成一块实色；所以由这里按不同浓度生成两条"薄纱版"。
 */
function gradientWithAlpha(stops: readonly GradientStop[], alpha: number): string {
  const parts = stops
    .map((stop) => {
      const rgb = parseCssColor(stop.color);
      if (!rgb) return null;
      const a = Math.round(Math.min(1, Math.max(0, alpha * rgb.a)) * 1000) / 1000;
      return `rgba(${Math.round(rgb.r)}, ${Math.round(rgb.g)}, ${Math.round(rgb.b)}, ${a}) ${stop.percent}%`;
    })
    .filter((part): part is string => Boolean(part));
  return parts.length >= 2 ? `linear-gradient(90deg, ${parts.join(', ')})` : '';
}

/** 数值类外观：动效速度、卡片透明度、组件模糊、两套配色。登录页也可安全应用 */
export function applyAppearanceTokens(state: AppearanceState): void {
  if (typeof document === 'undefined') return;
  const { style } = document.documentElement;
  const settings = state;
  const dark = isDarkPreset(state);
  const speed = clamp('uiSpeed', settings.uiSpeed);
  // 速度是倍率，时长要取倒数：2× 速度 = 一半时长
  style.setProperty('--kk-motion', String(Math.round((1 / speed) * 1000) / 1000));
  style.setProperty('--kk-card-alpha', String(clamp('cardOpacity', settings.cardOpacity)));
  style.setProperty('--kk-blur', `${clamp('cardBlur', settings.cardBlur)}px`);
  style.setProperty('--kk-card2-alpha', String(clamp('card2Opacity', settings.card2Opacity)));
  style.setProperty('--kk-blur2', `${clamp('card2Blur', settings.card2Blur)}px`);
  style.setProperty('--kk-shadow-alpha', String(clamp('cardShadow', settings.cardShadow)));
  style.setProperty('--kk-bg-blur', `${clamp('backgroundBlur', settings.backgroundBlur)}px`);

  // 三个角色各一组 HSV，换算到 HSL 后下发；色阶与硬编码色都由这些变量派生
  for (const role of COLOR_ROLES) {
    const { h, s, l } = hsvToHsl(readHsv(settings, role));
    style.setProperty(`--kk-${role}-h`, String(Math.round(h)));
    style.setProperty(`--kk-${role}-s`, `${Math.round(s)}%`);
    // 明度倍率以 50% 为基准：色阶各档明度乘它，整体提亮或压暗而不打乱层次。
    // ink 单独收口到 ±20%（见 inkLmul），否则浅色字体会把弱化文字洗成 98% 近白。
    const lmul = role === 'ink' ? inkLmul(l) : round3(l / 50);
    style.setProperty(`--kk-${role}-lmul`, String(lmul));
  }

  /*
   * 组件色的 RGB 通道，供 rgb(var(--x) / α) 形式的描边、高光、光晕、滑块条复用。
   * 明度基准分亮/暗两套：暗色预设下沿用亮色那套（40%）会让强调色沉进深底里，
   * 与 :root 里 --primary 的 34%→56% 同步上移一档。
   */
  const comp = hsvToHsl(readHsv(settings, 'comp'));
  const compScale = comp.l / 50;
  const compBase = dark ? 56 : 40;
  const compSoft = dark ? 60 : 44;
  const compAlt = dark ? 68 : 55;
  style.setProperty('--kk-comp-rgb', hslChannels(comp.h, comp.s, compBase * compScale));
  style.setProperty('--kk-comp-soft-rgb', hslChannels(comp.h, comp.s * 0.75, compSoft * compScale));
  style.setProperty('--kk-comp-alt-rgb', hslChannels(comp.h + 23, comp.s * 0.9, compAlt * compScale));

  // 侧边栏宽度：手机按屏宽百分比、电脑按像素，两条调节线各管一端
  style.setProperty('--kk-sidebar-w-mobile', `${clamp('sidebarWidthMobile', settings.sidebarWidthMobile)}vw`);
  style.setProperty('--kk-sidebar-w-pc', `${clamp('sidebarWidthPc', settings.sidebarWidthPc)}px`);

  /*
   * Logo 角色：渐变两端色 + 一对 RGB 通道。
   * 通道给 brand-400/500 用，于是「Logo」这张调色卡不只管顶部那几个字，
   * 还能管到统计卡、系统信息图标这类第二强调面。
   */
  const logo = hsvToHsl(readHsv(settings, 'logo'));
  const logoScale = logo.l / 50;
  const logoS = Math.round(logo.s);
  const logoFrom = dark ? 56 : 38;
  const logoTo = dark ? 64 : 46;
  style.setProperty('--kk-logo-from', `hsl(${Math.round(logo.h)} ${logoS}% ${clampPct(logoFrom * logoScale)}%)`);
  style.setProperty('--kk-logo-to', `hsl(${Math.round(logo.h + 26)} ${Math.round(logo.s * 0.92)}% ${clampPct(logoTo * logoScale)}%)`);
  style.setProperty('--kk-logo-rgb', hslChannels(logo.h, logo.s, logoFrom * logoScale));
  style.setProperty('--kk-logo-alt-rgb', hslChannels(logo.h + 26, logo.s * 0.92, logoTo * logoScale));

  applyGradientTokens(state, dark);
}

/**
 * 渐变派生：三个角色启用渐变时，把整站色阶切成渐变切面（逐档写入 --kk-<role>-<档>-hs）。
 * comp 额外接管 --kk-comp-rgb / --kk-comp-alt-rgb 与 --primary-from/to；
 * logo / ink 分别打 data-kk-*-gradient 供 CSS 染色。未启用渐变的角色回落到单色。
 */
function applyGradientTokens(state: AppearanceState, dark: boolean): void {
  if (typeof document === 'undefined') return;
  const { style } = document.documentElement;

  // —— 组件色 ——
  const compStops = parseGradientStops(gradientOf(state, 'comp'));
  const compGrad = gradientMidHsl(compStops ?? []);
  if (compStops && compGrad) {
    writeShadeHues('comp', compStops);
    const lmul = Math.min(1.6, Math.max(0.35, compGrad.avgL / 50));
    style.setProperty('--kk-comp-h', String(Math.round(compGrad.h)));
    style.setProperty('--kk-comp-s', `${Math.round(compGrad.s)}%`);
    style.setProperty('--kk-comp-lmul', String(round3(lmul)));

    const first = compGrad.first ? rgbToHsl(compGrad.first) : null;
    const last = compGrad.last ? rgbToHsl(compGrad.last) : null;
    if (first) {
      style.setProperty('--kk-comp-rgb', hslChannels(first.h, first.s, (dark ? 58 : 40) * lmul));
      style.setProperty('--kk-comp-soft-rgb', hslChannels(first.h, first.s * 0.75, (dark ? 62 : 44) * lmul));
      // 主按钮渐变面：保留色相与饱和，明度走主题公式，白字对比度不塌
      style.setProperty('--primary-from', `${Math.round(first.h)} ${Math.round(first.s)}% ${clampPct((dark ? 60 : 38) * lmul)}%`);
    }
    if (last) {
      style.setProperty('--kk-comp-alt-rgb', hslChannels(last.h, last.s, (dark ? 70 : 55) * lmul));
      style.setProperty('--primary-to', `${Math.round(last.h)} ${Math.round(last.s)}% ${clampPct((dark ? 64 : 42) * lmul)}%`);
    }
    style.setProperty('--kk-comp-gradient', normalizeGradientCss(gradientOf(state, 'comp')));
    // 玻璃态表面用的半透明版本：液态导航条 / 移动端指示条（薄）/ 滑块轨道（浓）。
    // 生成失败（色标全不可解析）时也要显式清掉，否则会留着上一次渐变的残影。
    const veil = gradientWithAlpha(compStops, 0.3);
    const strong = gradientWithAlpha(compStops, 0.9);
    if (veil) style.setProperty('--kk-comp-gradient-veil', veil);
    else style.removeProperty('--kk-comp-gradient-veil');
    if (strong) style.setProperty('--kk-comp-gradient-strong', strong);
    else style.removeProperty('--kk-comp-gradient-strong');
    document.documentElement.setAttribute('data-kk-comp-gradient', '1');
  } else {
    // 回落：删掉内联覆盖，让 :root 里的 calc 公式接管
    style.removeProperty('--primary-from');
    style.removeProperty('--primary-to');
    style.removeProperty('--kk-comp-gradient');
    style.removeProperty('--kk-comp-gradient-veil');
    style.removeProperty('--kk-comp-gradient-strong');
    clearShadeHues('comp');
    document.documentElement.removeAttribute('data-kk-comp-gradient');
  }

  // —— 品牌 Logo ——
  const logoStops = parseGradientStops(gradientOf(state, 'logo'));
  const logoGrad = gradientMidHsl(logoStops ?? []);
  if (logoStops && logoGrad) {
    writeShadeHues('logo', logoStops);
    const lmul = Math.min(1.6, Math.max(0.35, logoGrad.avgL / 50));
    style.setProperty('--kk-logo-h', String(Math.round(logoGrad.h)));
    style.setProperty('--kk-logo-s', `${Math.round(logoGrad.s)}%`);
    style.setProperty('--kk-logo-lmul', String(round3(lmul)));

    const first = logoGrad.first ? rgbToHsl(logoGrad.first) : null;
    const last = logoGrad.last ? rgbToHsl(logoGrad.last) : null;
    const fromL = dark ? 56 : 38;
    const toL = dark ? 64 : 46;
    if (first) {
      style.setProperty('--kk-logo-from', `hsl(${Math.round(first.h)} ${Math.round(first.s)}% ${clampPct(fromL * lmul)}%)`);
      style.setProperty('--kk-logo-rgb', hslChannels(first.h, first.s, fromL * lmul));
    }
    if (last) {
      style.setProperty('--kk-logo-to', `hsl(${Math.round(last.h)} ${Math.round(last.s)}% ${clampPct(toL * lmul)}%)`);
      style.setProperty('--kk-logo-alt-rgb', hslChannels(last.h, last.s, toL * lmul));
    }
    style.setProperty('--kk-logo-gradient', normalizeGradientCss(gradientOf(state, 'logo')));
  } else {
    style.removeProperty('--kk-logo-gradient');
    clearShadeHues('logo');
  }

  // —— 全局字体 ——
  const inkGradient = normalizeGradientCss(gradientOf(state, 'ink'));
  const inkStops = inkGradient ? parseGradientStops(inkGradient) : null;
  const inkGrad = gradientMidHsl(inkStops ?? []);
  if (inkGradient && inkStops && inkGrad) {
    writeShadeHues('ink', inkStops);
    // 与单色 ink 同一套收口：渐变的平均明度只作轻微提亮/压暗，
    // 不能让一条浅色渐变把 slate-400 推到 98%（插件操作按钮会整排消失）。
    const lmul = inkLmul(inkGrad.avgL);
    style.setProperty('--kk-ink-h', String(Math.round(inkGrad.h)));
    style.setProperty('--kk-ink-s', `${Math.round(inkGrad.s)}%`);
    style.setProperty('--kk-ink-lmul', String(lmul));
    style.setProperty('--kk-ink-gradient', inkGradient);
    document.documentElement.setAttribute('data-kk-ink-gradient', '1');
  } else {
    style.removeProperty('--kk-ink-gradient');
    clearShadeHues('ink');
    document.documentElement.removeAttribute('data-kk-ink-gradient');
  }
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
  /*
   * 背景适配方式（铺满裁切 / 拉伸铺满 / 完整显示）由设置决定，这里只写成 html 上的属性，
   * 具体铺法全在 globals.css；没有背景图时把属性一并清掉。
   */
  if (hasAny) root.setAttribute('data-kk-bg-fit', state.bgFit);
  else root.removeAttribute('data-kk-bg-fit');
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
  applyBackgroundPresetFlag(state);
  for (const listener of appearanceListeners) listener();
}

/*
 * 性能档反转会改变「波浪预设是否生效」→ 是否走暗色主题。
 * 暗色下有一批令牌（组件色通道、Logo 两端、主按钮渐变）是 JS 按亮/暗两套基准
 * 算出来的**内联**值，CSS 里那条 html[data-kk-bg-preset='waves'] 覆盖不到它们，
 * 所以档位一变就要按当前外观重算一遍，否则会出现「切到低配后强调色仍按暗色取值」。
 */
subscribeDeviceTier(() => applyAppearance(currentAppearanceState));

/**
 * 把「背景预设是否处于波浪」写到 <html data-kk-bg-preset> 上。
 *
 * 波浪预设要求全站切暗色主题（波浪线是亮色，只有在深底上才读得清，
 * 鼠标划过的高亮也是亮色才看得见），暗色样式全部挂在 html 的这个属性上，
 * 所以这里要跟外观一起同步 —— 设置页切预设、切自定义背景、改性能档都会走 applyAppearance。
 * 性能档运行时变化（device-tier 动态校准）由 background-preset-layer 兜底补写。
 */
function applyBackgroundPresetFlag(state: AppearanceState): void {
  if (typeof document === 'undefined') return;
  const tier = getDeviceTier();
  const waves = effectiveBackgroundPreset(state, tier) === 'waves';
  const root = document.documentElement;
  if (waves) root.setAttribute('data-kk-bg-preset', 'waves');
  else root.removeAttribute('data-kk-bg-preset');
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
    case 'cardShadow':
      return `${cardShadowPercent(value)}%`;
    case 'sidebarWidthMobile':
      return `${Math.round(value)}%`;
    case 'watermarkAngle':
      return `${Math.round(value)}°`;
    case 'watermarkDensity':
      return `${Math.round(value)}%`;
    case 'watermarkSize':
      return `${Math.round(value)}px`;
    default:
      return `${Math.round(value)}px`;
  }
}