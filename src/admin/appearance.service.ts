import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

/** 背景资源分两套：竖屏与横屏是各自独立的资源，互不覆盖 */
export type BackgroundOrientation = 'portrait' | 'landscape';

export const BACKGROUND_ORIENTATIONS: readonly BackgroundOrientation[] = ['portrait', 'landscape'];

/**
 * 背景资源分两类：图片走 CSS background-image（动图 GIF 也会自动播），
 * 视频走 <video> 静音循环播放；实况图取其导出的 .mov 视频轨，按视频处理。
 */
export type BackgroundKind = 'image' | 'video';

/** 单张背景图上限 10MB、单个背景视频上限 100MB，前后端都拦一次 */
export const BACKGROUND_MAX_BYTES = 10 * 1024 * 1024;
export const BACKGROUND_VIDEO_MAX_BYTES = 100 * 1024 * 1024;

export interface AppearanceSettings {
  /** 动效速度倍率：1 = 默认，越大越快 */
  uiSpeed: number;
  /** 组件卡片底色不透明度（0–1） */
  cardOpacity: number;
  /** 组件毛玻璃模糊半径（px） */
  cardBlur: number;
  /** 组件2（悬浮窗 / 插件与资源界面等次级表面）底色不透明度（0–1） */
  card2Opacity: number;
  /** 组件2 毛玻璃模糊半径（px） */
  card2Blur: number;
  /** 卡片边缘扩散阴影的浓度（阴影自身不透明度，0–0.2 = 设置里的 0–100%）；性能模式下不生效 */
  cardShadow: number;
  /** 背景图模糊半径（px） */
  backgroundBlur: number;
  /**
   * 三个可调色角色，各自一组 HSV：
   * ink = 全局字体、comp = 组件与按钮、logo = 品牌标识。
   * 色相 0–360，饱和度与明度 0–100，与标准拾色器的取值一致。
   */
  inkHue: number;
  inkSat: number;
  inkVal: number;
  compHue: number;
  compSat: number;
  compVal: number;
  logoHue: number;
  logoSat: number;
  logoVal: number;
  /** 侧边栏宽度：电脑端像素值 */
  sidebarWidthPc: number;
  /** 侧边栏宽度：手机端占屏宽百分比 */
  sidebarWidthMobile: number;
  /** 页面水印倾斜角度（度） */
  watermarkAngle: number;
  /** 页面水印密集度（0–100）：越大越密 */
  watermarkDensity: number;
  /** 页面水印字号（px） */
  watermarkSize: number;
}

export interface BackgroundMeta {
  ext: string;
  mime: string;
  kind: BackgroundKind;
  size: number;
  /** 文件 mtime，前端用它做资源 URL 的缓存刷新参数 */
  updatedAt: number;
}

export interface AppearanceState extends AppearanceSettings {
  backgrounds: Record<BackgroundOrientation, BackgroundMeta | null>;
  /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部的品牌字），空串表示用默认「咔咔珂」 */
  customTitle: string;
  /**
   * 页面水印文字：非空即开启，平铺在 8787 端口下的全部界面最上层；
   * 空串 = 关闭。颜色跟随「全局字体」角色，不单独配色。
   */
  watermarkText: string;
  /** 背景适配方式：铺满裁切 / 拉伸铺满 / 完整显示 */
  bgFit: BackgroundFit;
  /** 背景预设：default = 出厂氛围底，waves = 波浪线背景。有自定义背景时不生效 */
  bgPreset: BackgroundPreset;
  /**
   * 三个可调色角色的渐变色（CSS linear-gradient 串），空串 = 未启用渐变、回落到单色 HSV。
   * ink = 全局字体（染标题文字）、comp = 组件与按钮（主按钮渐变面）、logo = 品牌标识。
   * 由 normalizeGradientCss 收口重建，杜绝把任意 CSS 串写进公开接口。
   */
  inkGradient: string;
  compGradient: string;
  logoGradient: string;
}

/**
 * 背景预设：在无自定义背景时替换整片氛围底的程序化背景。
 * - default 出厂默认：CSS 渐变氛围底（也是历来的样子）
 * - waves   波浪：WebGL 波浪线，随鼠标拖拽起伏；只在「完整特效」档渲染
 */
export type BackgroundPreset = 'default' | 'waves';

export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = ['default', 'waves'];

export const DEFAULT_BACKGROUND_PRESET: BackgroundPreset = 'default';

export function isBackgroundPreset(value: unknown): value is BackgroundPreset {
  return typeof value === 'string' && (BACKGROUND_PRESETS as readonly string[]).includes(value);
}

/** 收口背景预设：非枚举值一律退回出厂默认 */
export function normalizeBackgroundPreset(value: unknown): BackgroundPreset {
  return isBackgroundPreset(value) ? value : DEFAULT_BACKGROUND_PRESET;
}

/**
 * 背景与屏幕比例不匹配时的铺法：
 * - cover   铺满裁切（默认）：填满整个屏幕，多出来的部分裁掉，不变形；
 * - stretch 拉伸铺满：一律拉到 100%×100%，一定填满，但比例不对会变形；
 * - contain 完整显示：整张图都看得到，四周由同一张图的模糊副本垫底。
 */
export type BackgroundFit = 'cover' | 'stretch' | 'contain';

export const BACKGROUND_FITS: readonly BackgroundFit[] = ['cover', 'stretch', 'contain'];

export const DEFAULT_BACKGROUND_FIT: BackgroundFit = 'cover';

export function isBackgroundFit(value: unknown): value is BackgroundFit {
  return typeof value === 'string' && (BACKGROUND_FITS as readonly string[]).includes(value);
}

/** 收口背景适配方式：非枚举值一律退回默认（铺满裁切） */
export function normalizeBackgroundFit(value: unknown): BackgroundFit {
  return isBackgroundFit(value) ? value : DEFAULT_BACKGROUND_FIT;
}

/** 自定义标题名上限：20 个字符（按码点计，避免把 emoji 截断） */
export const CUSTOM_TITLE_MAX_LEN = 20;

/** 收口自定义标题：去首尾空白，按码点截到上限；非字符串或空 → 空串 */
export function normalizeCustomTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  return Array.from(trimmed).slice(0, CUSTOM_TITLE_MAX_LEN).join('');
}

/** 页面水印文字上限：40 个字符（按码点计，与前端 lib/appearance.ts 一致） */
export const WATERMARK_MAX_LEN = 40;

/** 打开水印开关时填入的默认文字 */
export const DEFAULT_WATERMARK_TEXT = 'Kakake水印';

/**
 * 收口页面水印文字：去首尾空白、多行压成一行、去掉控制字符，按码点截到上限。
 * 空串就是「关闭」——前端据此决定要不要画水印，所以这里必须收干净，
 * 只敲了几个空格也算关闭。
 */
export function normalizeWatermark(value: unknown): string {
  if (typeof value !== 'string') return '';
  // 换行 / 制表 / 控制字符压成一个空格（水印只能是单行），普通空格按用户输入原样保留
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return '';
  return Array.from(flat).slice(0, WATERMARK_MAX_LEN).join('');
}

/* —— 渐变色收口 —— */

export interface GradientStop {
  color: string;
  percent: number;
}

/** 渐变串上限：ant ColorPicker 生成的串远用不了这么长，超长直接拒 */
const GRADIENT_MAX_LEN = 512;
/** 色标数量上限：太多无意义还拖累渲染 */
const GRADIENT_MAX_STOPS = 12;

/**
 * 颜色记号白名单：hex / rgb() / rgba() / hsl() / hsla()，逗号与空格两种写法都收
 * （与前端 lib/appearance.ts 完全一致）。
 *
 * 为什么两种都要收：拾色器不同版本回传的串格式不一样
 * （`rgb(255, 8, 68)`、`rgb(255 8 68)`、`rgb(255 8 68 / 0.5)`、`hsl(64 100% 45%)`），
 * 只认逗号写法时，空格写法会被整条判非法 → 前端存上来的自定义渐变被静默清空。
 * 函数名 / url() 之类仍然一律拒收，且整串必须先通过 ^linear-gradient\(...\)$。
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

/** 按顶层逗号切分（括号内的逗号不切），供解析 linear-gradient 参数用 */
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

const GRADIENT_DIRECTIONS = new Set(['to right', 'to left', 'to top', 'to bottom', '90deg', '180deg', '0deg', '270deg']);

/**
 * 解析一份 linear-gradient CSS 串为色标数组；不合法返回 null。
 * 只接受 `linear-gradient(...)`，方向记号限定白名单，色标逐个过颜色白名单。
 */
export function parseGradientCss(value: unknown): GradientStop[] | null {
  if (typeof value !== 'string') return null;
  const str = value.trim();
  if (!str || str.length > GRADIENT_MAX_LEN) return null;
  const match = /^linear-gradient\((.+)\)$/is.exec(str);
  if (!match) return null;

  const args = splitTopLevel(match[1]);
  if (args.length < 2) return null;

  // 首参可能是方向记号（to right / 90deg），也可能直接是第一个色标
  let direction = '90deg';
  let stopArgs = args;
  const first = args[0].toLowerCase().replace(/\s+/g, ' ');
  if (GRADIENT_DIRECTIONS.has(first)) {
    direction = first === 'to right' ? '90deg' : first;
    stopArgs = args.slice(1);
  }
  if (stopArgs.length < 2) return null;

  const stops: GradientStop[] = [];
  for (const arg of stopArgs) {
    // 色标形如 "<color> <percent>%"；percent 省略的记号不收（拾色器总会带）
    const m = /^(.+?)\s+([\d.]+)%$/.exec(arg);
    if (!m) return null;
    if (!isSafeColorToken(m[1])) return null;
    const percent = Math.min(100, Math.max(0, Number(m[2])));
    if (!Number.isFinite(percent)) return null;
    stops.push({ color: m[1].trim().toLowerCase(), percent });
  }
  if (stops.length < 2 || stops.length > GRADIENT_MAX_STOPS) return null;
  stops.sort((a, b) => a.percent - b.percent);
  return stops;
}

/** 色标数组 → 规范化 linear-gradient 串（统一 90deg、色标按位置升序、保留小数精度） */
export function gradientStopsToCss(stops: GradientStop[]): string {
  const list = [...stops].sort((a, b) => a.percent - b.percent);
  return `linear-gradient(${directionCss(list)}, ${list.map((s) => `${s.color} ${s.percent}%`).join(', ')})`;
}

/** 相邻色标重叠（同位置）时浏览器仍可渲染，无需特殊处理；方向统一 to right 语义 */
function directionCss(_stops: GradientStop[]): string {
  return '90deg';
}

/** 收口渐变色：'' = 未启用；合法串重建为规范化形式；不合法一律退回空串 */
export function normalizeGradientCss(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value === '') return '';
  const stops = parseGradientCss(value);
  return stops ? gradientStopsToCss(stops) : '';
}

interface GradientFields {
  inkGradient?: unknown;
  compGradient?: unknown;
  logoGradient?: unknown;
}

/** 非数值外观字段的"按需覆盖"包：字段缺省 = 这次不改，保持磁盘原值 */
interface AppearanceMetaPatch {
  customTitle?: string;
  watermarkText?: string;
  bgFit?: BackgroundFit;
  bgPreset?: BackgroundPreset;
  gradients?: { inkGradient: string; compGradient: string; logoGradient: string };
}

/**
 * 保存外观的请求体：数值字段 + 可选的非常规字段。
 * 非常规字段一律按 unknown 收（请求体来自 JSON），进 saveSettings 后再逐个收口，
 * 这样前端可以直接把整份草稿 PUT 过来，不必为每个字段开接口。
 */
export type AppearanceSaveInput = Partial<AppearanceSettings> & GradientFields & {
  customTitle?: unknown;
  watermarkText?: unknown;
  bgFit?: unknown;
  bgPreset?: unknown;
};

/** 从原始对象里收口三个渐变字段 */
export function normalizeGradients(raw: GradientFields | null | undefined): {
  inkGradient: string;
  compGradient: string;
  logoGradient: string;
} {
  return {
    inkGradient: normalizeGradientCss(raw?.inkGradient),
    compGradient: normalizeGradientCss(raw?.compGradient),
    logoGradient: normalizeGradientCss(raw?.logoGradient),
  };
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  uiSpeed: 1,
  cardOpacity: 0.32,
  cardBlur: 22,
  card2Opacity: 0.2,
  card2Blur: 24,
  cardShadow: 0.14,
  backgroundBlur: 0,
  // 组件与按钮出厂色 = #2ceb13（HSV 113,92,92）；品牌 Logo 出厂色 = #f1ff2e（HSV 64,82,100）。
  // 全局字体色沿用石板色 HSV(215,33,60) ≈ HSL(215,20%,50%)。
  // 仅出厂默认值：一旦用户调过色并落盘，appearance.json 里的值优先，不受这里影响。
  inkHue: 215,
  inkSat: 33,
  inkVal: 60,
  compHue: 113,
  compSat: 92,
  compVal: 92,
  logoHue: 64,
  logoSat: 82,
  logoVal: 100,
  // 侧边栏宽度：默认值取各自区间正中间（电脑 204px、手机 66% ≈ 屏宽三分之二）
  sidebarWidthPc: 204,
  sidebarWidthMobile: 67,
  // 页面水印：角度与 antd Watermark 出厂值一致；密集度 60 ≈ 120px 横距；字号 16px
  watermarkAngle: -22,
  watermarkDensity: 60,
  watermarkSize: 16,
};

/** [最小值, 最大值, 保留小数位]，与前端滑动条区间保持一致 */
const RANGES: Record<keyof AppearanceSettings, [number, number, number]> = {
  uiSpeed: [0.5, 2.5, 2],
  cardOpacity: [0.05, 0.85, 2],
  cardBlur: [0, 40, 0],
  card2Opacity: [0.05, 0.85, 2],
  card2Blur: [0, 40, 0],
  // 上限 0.35 = 前端 CARD_SHADOW_MAX（设置里的 100%）：0.4 太浓、0.2 太淡，折中
  cardShadow: [0, 0.35, 3],
  backgroundBlur: [0, 40, 0],
  inkHue: [0, 360, 0],
  inkSat: [0, 100, 0],
  inkVal: [0, 100, 0],
  compHue: [0, 360, 0],
  compSat: [0, 100, 0],
  compVal: [0, 100, 0],
  logoHue: [0, 360, 0],
  logoSat: [0, 100, 0],
  logoVal: [0, 100, 0],
  // 下限 50（与前端 APPEARANCE_RANGES.sidebarWidthPc 必须一致）：
  // 以前这里是 144，前端却允许拖到 50，于是「拖窄 → 保存 → 被后端夹回 144」，
  // 表现为滑块自己跳回去。现在两边都按 50 起；< 80px 那一档前端会自动收成只留图标。
  sidebarWidthPc: [50, 264, 0],
  // 下限 20%（与前端 APPEARANCE_RANGES.sidebarWidthMobile 一致）：
  // 手机上侧栏是抽屉，可以比电脑端压得更窄，但再窄下去连图标都摆不下。
  sidebarWidthMobile: [20, 90, 0],
  // 页面水印三项（与前端 APPEARANCE_RANGES 一致）：角度 ±60°、密集度 0–100、字号 8–48px
  watermarkAngle: [-60, 60, 0],
  watermarkDensity: [0, 100, 0],
  watermarkSize: [8, 48, 0],
};

function clampSetting(key: keyof AppearanceSettings, value: unknown): number {
  const [min, max, digits] = RANGES[key];
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_APPEARANCE[key];
  const clamped = Math.min(max, Math.max(min, n));
  const factor = 10 ** digits;
  return Math.round(clamped * factor) / factor;
}

/** 0.4.13 之前颜色只有 accentHue/accentSat（HSL 语义，明度固定 50%），迁移成 HSV 并分给组件色与 Logo 色 */
interface LegacyColorFields {
  accentHue?: unknown;
  accentSat?: unknown;
}

function hslMidToHsv(sat: number): { s: number; v: number } {
  // 由 HSL(h, sat%, 50%) 反推 HSV：V = 0.5 + sat/2，S = 2 * (1 - 0.5 / V)
  const s = Math.min(1, Math.max(0, sat / 100));
  const v = 0.5 + s / 2;
  return { s: v === 0 ? 0 : 2 * (1 - 0.5 / v) * 100, v: v * 100 };
}

function migrateLegacy(src: Partial<AppearanceSettings> & LegacyColorFields): Partial<AppearanceSettings> {
  const out: Partial<AppearanceSettings> = { ...src };
  if (src.compHue !== undefined || src.accentHue === undefined) return out;
  const hue = Number(src.accentHue);
  const { s, v } = hslMidToHsv(Number(src.accentSat ?? 80));
  out.compHue = hue;
  out.compSat = s;
  out.compVal = v;
  out.logoHue = hue;
  out.logoSat = s;
  out.logoVal = v;
  return out;
}

export function normalizeAppearance(
  raw: (Partial<AppearanceSettings> & LegacyColorFields) | null | undefined,
): AppearanceSettings {
  const src = migrateLegacy(raw ?? {});
  const out = {} as AppearanceSettings;
  // 按 RANGES 逐项收口：只认已知字段，越界与非数字都退回默认值
  for (const key of Object.keys(RANGES) as (keyof AppearanceSettings)[]) {
    out[key] = clampSetting(key, src[key] ?? DEFAULT_APPEARANCE[key]);
  }
  return out;
}

export function isBackgroundOrientation(value: unknown): value is BackgroundOrientation {
  return value === 'portrait' || value === 'landscape';
}

type Sniffed = { ext: string; mime: string; kind: BackgroundKind };

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

const VIDEO_EXTS = new Set(['mp4', 'mov']);

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 已知「只可能是图片」的 ftyp brand（HEIC 系等）。视频判定用排除法：
 * 其余 ftyp 容器一律按 MP4 收，避免厂商 brand（go00、MSNV…）被误拒。
 */
const IMAGE_ONLY_FTYP_BRANDS = new Set([
  'heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'crx ',
]);

/**
 * 按文件头判定资源类型，不信任上传时声明的 Content-Type / 扩展名。
 * 只放常见位图与 MP4 / MOV 视频；SVG 可内嵌脚本，同源直开有 XSS 风险，故不收。
 */
export function sniffBackgroundMedia(head: Buffer): Sniffed | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { ext: 'jpg', mime: MIME_BY_EXT.jpg, kind: 'image' };
  }
  if (head.length >= 8 && head.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ext: 'png', mime: MIME_BY_EXT.png, kind: 'image' };
  }
  if (head.length >= 6 && head.subarray(0, 4).toString('latin1') === 'GIF8') {
    return { ext: 'gif', mime: MIME_BY_EXT.gif, kind: 'image' };
  }
  if (
    head.length >= 12
    && head.subarray(0, 4).toString('latin1') === 'RIFF'
    && head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return { ext: 'webp', mime: MIME_BY_EXT.webp, kind: 'image' };
  }
  if (head.length >= 2 && head[0] === 0x42 && head[1] === 0x4d) {
    return { ext: 'bmp', mime: MIME_BY_EXT.bmp, kind: 'image' };
  }
  if (head.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return { ext: 'avif', mime: MIME_BY_EXT.avif, kind: 'image' };
    if (brand === 'qt  ' || brand.startsWith('qt')) {
      // QuickTime 容器：iPhone 实况图导出的视频轨就是它，主流浏览器可直接播
      return { ext: 'mov', mime: MIME_BY_EXT.mov, kind: 'video' };
    }
    if (!IMAGE_ONLY_FTYP_BRANDS.has(brand)) return { ext: 'mp4', mime: MIME_BY_EXT.mp4, kind: 'video' };
  }
  return null;
}

function readHead(filePath: string, length = 16): Buffer {
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(filePath, 'r');
  try {
    const read = fs.readSync(fd, buf, 0, length, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export class AppearanceService {
  private get dir(): string {
    return PATHS.appearanceDir;
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
  }

  getSettings(): AppearanceSettings {
    const raw = readJsonSafe<(Partial<AppearanceSettings> & LegacyColorFields) | null>(
      PATHS.appearance,
      null,
      { label: 'appearance.json' },
    );
    if (!raw) return { ...DEFAULT_APPEARANCE };
    return normalizeAppearance(raw);
  }

  /** 读磁盘原始 JSON（含数值外观与 customTitle 等非数值字段），解析失败返回空对象 */
  private readRawFile(): Record<string, unknown> {
    const raw = readJsonSafe<unknown>(PATHS.appearance, {}, { label: 'appearance.json' });
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  }

  getCustomTitle(): string {
    return normalizeCustomTitle(this.readRawFile().customTitle);
  }

  /** 背景适配方式（非数值字段，与 customTitle 一样读写原始 JSON） */
  getBackgroundFit(): BackgroundFit {
    return normalizeBackgroundFit(this.readRawFile().bgFit);
  }

  /** 背景预设（非数值字段，与 customTitle 一样读写原始 JSON） */
  getBackgroundPreset(): BackgroundPreset {
    return normalizeBackgroundPreset(this.readRawFile().bgPreset);
  }

  /** 三个角色的渐变色（非数值字段，与 customTitle 一样读写原始 JSON） */
  getGradients(): { inkGradient: string; compGradient: string; logoGradient: string } {
    const raw = this.readRawFile();
    return normalizeGradients(raw);
  }

  /** 页面水印文字（空串 = 关闭） */
  getWatermark(): string {
    return normalizeWatermark(this.readRawFile().watermarkText);
  }

  /** 水印完整渲染参数：文字 + 倾斜度 / 密集度 / 字号（插件 WebUI 注入用） */
  getWatermarkConfig(): { text: string; angle: number; density: number; size: number } {
    const settings = this.getSettings();
    return {
      text: this.getWatermark(),
      angle: settings.watermarkAngle,
      density: settings.watermarkDensity,
      size: settings.watermarkSize,
    };
  }

  /**
   * 落盘：数值外观 + 非数值字段。
   *
   * 非数值字段改成**按需覆盖**（patch）：以前所有字段都当位置参数传一遍，
   * 每加一个字段就得改全部调用点，漏传一个就会被下一次保存静默清掉
   * （典型症状：动一下透明度滑块，页面水印就没了）。现在没传的字段保持磁盘原值，
   * 空串的标题 / 水印直接从 JSON 里删掉，文件保持干净。
   */
  private writeFile(
    settings: AppearanceSettings,
    patch: AppearanceMetaPatch = {},
    opts: { replace?: boolean } = {},
  ): void {
    const payload: Record<string, unknown> = { ...(opts.replace ? {} : this.readRawFile()), ...settings };
    if (patch.customTitle !== undefined) {
      if (patch.customTitle) payload.customTitle = patch.customTitle;
      else delete payload.customTitle;
    }
    if (patch.watermarkText !== undefined) {
      if (patch.watermarkText) payload.watermarkText = patch.watermarkText;
      else delete payload.watermarkText;
    }
    if (patch.bgFit !== undefined) payload.bgFit = patch.bgFit;
    if (patch.bgPreset !== undefined) payload.bgPreset = patch.bgPreset;
    if (patch.gradients) {
      payload.inkGradient = patch.gradients.inkGradient;
      payload.compGradient = patch.gradients.compGradient;
      payload.logoGradient = patch.gradients.logoGradient;
    }
    writeJsonAtomic(PATHS.appearance, payload, { trailingNewline: true });
  }

  /**
   * 保存外观。数值字段走 RANGES 收口；渐变色 / 自定义标题 / 背景适配 / 背景预设 /
   * 页面水印这些非数值字段**带上才覆盖**（undefined = 本次请求没提，保持原值）。
   * 于是设置页可以把整份草稿一次 PUT 过来，不用为每个字段各开一个接口。
   */
  saveSettings(
    raw: AppearanceSaveInput | null | undefined,
  ): AppearanceSettings {
    const {
      inkGradient, compGradient, logoGradient,
      customTitle, bgFit, bgPreset, watermarkText,
      ...numeric
    } = raw ?? {};
    const next = normalizeAppearance({ ...this.getSettings(), ...(numeric as Partial<AppearanceSettings>) });
    const current = this.getGradients();
    const incoming = normalizeGradients({ inkGradient, compGradient, logoGradient });
    // 未携带的字段保持原值（undefined 表示这次请求没提）；显式传串（含空串）才覆盖
    const merged = {
      inkGradient: inkGradient === undefined ? current.inkGradient : incoming.inkGradient,
      compGradient: compGradient === undefined ? current.compGradient : incoming.compGradient,
      logoGradient: logoGradient === undefined ? current.logoGradient : incoming.logoGradient,
    };
    this.writeFile(next, {
      gradients: merged,
      customTitle: customTitle === undefined ? undefined : normalizeCustomTitle(customTitle),
      bgFit: bgFit === undefined ? undefined : normalizeBackgroundFit(bgFit),
      bgPreset: bgPreset === undefined ? undefined : normalizeBackgroundPreset(bgPreset),
      watermarkText: watermarkText === undefined ? undefined : normalizeWatermark(watermarkText),
    });
    return next;
  }

  /** 单独保存自定义标题；返回收口后的结果（空串即恢复默认标题） */
  saveCustomTitle(raw: unknown): string {
    const title = normalizeCustomTitle(raw);
    this.writeFile(this.getSettings(), { customTitle: title });
    return title;
  }

  /** 单独保存页面水印文字；返回收口后的结果（空串即关闭水印） */
  saveWatermark(raw: unknown): string {
    const text = normalizeWatermark(raw);
    this.writeFile(this.getSettings(), { watermarkText: text });
    return text;
  }

  /** 单独保存背景适配方式；返回收口后的结果 */
  saveBackgroundFit(raw: unknown): BackgroundFit {
    const fit = normalizeBackgroundFit(raw);
    this.writeFile(this.getSettings(), { bgFit: fit });
    return fit;
  }

  /** 单独保存背景预设；返回收口后的结果 */
  saveBackgroundPreset(raw: unknown): BackgroundPreset {
    const preset = normalizeBackgroundPreset(raw);
    this.writeFile(this.getSettings(), { bgPreset: preset });
    return preset;
  }

  /**
   * 背景文件探测缓存：记住上次命中的具体文件与指纹，命中时只 stat 这一个文件
   * （原先每次要对 4-5 种扩展名逐个 existsSync+statSync，登录页 / 设置页每个请求都扫一遍）。
   * 写路径（adoptBackground / removeBackground）会主动失效；文件被替换时 mtime+size
   * 变化也会触发重扫，保证元信息以磁盘为准。
   */
  private bgCache = new Map<BackgroundOrientation, { abs: string; mtimeMs: number; size: number; meta: BackgroundMeta }>();

  private invalidateBgCache(orientation?: BackgroundOrientation): void {
    if (orientation) this.bgCache.delete(orientation);
    else this.bgCache.clear();
  }

  /** 背景资源实际落盘文件；类型未知时返回 null，元信息一律以磁盘为准 */
  findBackgroundFile(orientation: BackgroundOrientation): { path: string; meta: BackgroundMeta } | null {
    const cached = this.bgCache.get(orientation);
    if (cached) {
      try {
        const st = fs.statSync(cached.abs);
        if (st.mtimeMs === cached.mtimeMs && st.size === cached.size) {
          return { path: cached.abs, meta: cached.meta };
        }
      } catch { /* 文件已消失：走重扫 */ }
      this.bgCache.delete(orientation);
    }
    if (!fs.existsSync(this.dir)) return null;
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const abs = path.join(this.dir, `background-${orientation}.${ext}`);
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      const meta: BackgroundMeta = {
        ext,
        mime: MIME_BY_EXT[ext],
        kind: VIDEO_EXTS.has(ext) ? 'video' : 'image',
        size: st.size,
        updatedAt: Math.floor(st.mtimeMs),
      };
      this.bgCache.set(orientation, { abs, mtimeMs: st.mtimeMs, size: st.size, meta });
      return { path: abs, meta };
    }
    return null;
  }

  getState(): AppearanceState {
    return {
      ...this.getSettings(),
      backgrounds: {
        portrait: this.findBackgroundFile('portrait')?.meta ?? null,
        landscape: this.findBackgroundFile('landscape')?.meta ?? null,
      },
      customTitle: this.getCustomTitle(),
      watermarkText: this.getWatermark(),
      bgFit: this.getBackgroundFit(),
      bgPreset: this.getBackgroundPreset(),
      ...this.getGradients(),
    };
  }

  /**
   * 收下一份临时文件作为背景：按嗅探出的类型校验大小后原子替换。
   * 无论成败都会清掉临时文件。
   */
  adoptBackground(
    orientation: BackgroundOrientation,
    tempPath: string,
  ): { ok: true; meta: BackgroundMeta } | { ok: false; message: string } {
    try {
      const st = fs.statSync(tempPath);
      if (st.size === 0) return { ok: false, message: '文件为空' };
      const kind = sniffBackgroundMedia(readHead(tempPath));
      if (!kind) return { ok: false, message: '不支持该文件格式' };
      const maxBytes = kind.kind === 'video' ? BACKGROUND_VIDEO_MAX_BYTES : BACKGROUND_MAX_BYTES;
      const limitLabel = kind.kind === 'video' ? '视频超过 100MB' : '图片超过 10MB';
      if (st.size > maxBytes) return { ok: false, message: limitLabel };

      this.ensureDir();
      this.removeBackground(orientation);
      const dest = path.join(this.dir, `background-${orientation}.${kind.ext}`);
      fs.renameSync(tempPath, dest);
      const saved = fs.statSync(dest);
      return {
        ok: true,
        meta: {
          ext: kind.ext,
          mime: kind.mime,
          kind: kind.kind,
          size: saved.size,
          updatedAt: Math.floor(saved.mtimeMs),
        },
      };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch { /* 已被 rename 掉或占用，忽略 */ }
      }
    }
  }

  removeBackground(orientation: BackgroundOrientation): boolean {
    let removed = false;
    this.invalidateBgCache(orientation);
    if (!fs.existsSync(this.dir)) return removed;
    for (const ext of Object.keys(MIME_BY_EXT)) {
      const abs = path.join(this.dir, `background-${orientation}.${ext}`);
      if (!fs.existsSync(abs)) continue;
      try {
        fs.unlinkSync(abs);
        removed = true;
      } catch { /* 忽略删除失败，交由上层返回当前状态 */ }
    }
    return removed;
  }

  /** 恢复默认：参数回默认值 + 清空两张背景图 + 清空自定义标题 + 适配方式与背景预设回出厂值 */
  reset(): AppearanceState {
    for (const orientation of BACKGROUND_ORIENTATIONS) this.removeBackground(orientation);
    this.writeFile(
      { ...DEFAULT_APPEARANCE },
      {
        customTitle: '',
        watermarkText: '',
        bgFit: DEFAULT_BACKGROUND_FIT,
        bgPreset: DEFAULT_BACKGROUND_PRESET,
        gradients: { inkGradient: '', compGradient: '', logoGradient: '' },
      },
      // 重置要回到「出厂文件」：不能把磁盘上的旧键（未知字段）继续带下去
      { replace: true },
    );
    return this.getState();
  }
}

export const appearanceService = new AppearanceService();