/**
 * 色阶与颜色数学的**唯一真源**。
 *
 * 这里刻意不 import 任何东西：`tailwind.config.ts` 在构建期用 jiti 直接加载本文件，
 * 运行时的 `lib/appearance.ts` 也 import 它。两边共用同一张表，
 * 才不会出现「Tailwind 生成的色阶」与「JS 写的令牌」漂移。
 *
 * 色阶写法沿用 Tailwind 原色阶的相对明度，每档是 [明度%, 浓度倍率]：
 * 换色时色相整体替换，档位间的对比层次保持不变。
 */

export type RampSpec = Record<number, readonly [number, number]>;

/** 组件 / 品牌强调色阶：以 500（40% 明度）为基准，出厂 #2ceb13 落在 500 档 */
export const ACCENT_RAMP: RampSpec = {
  50: [97, 0.95], 100: [89, 1.06], 200: [78, 1.05], 300: [64, 0.96],
  400: [50, 0.83], 500: [40, 1], 600: [32, 1.05], 700: [26, 0.96],
  800: [22, 0.86], 900: [19, 0.76], 950: [10, 1.05],
};

/**
 * 字体色阶：明度跨度比强调色大得多（98% → 5%），
 * 因为正文 / 副标题 / 提示全靠它拉开层次。
 */
export const INK_RAMP: RampSpec = {
  50: [98, 2], 100: [96, 2], 200: [91, 1.6], 300: [84, 1.35],
  400: [65, 1], 500: [47, 0.8], 600: [35, 0.95], 700: [27, 1.25],
  800: [17, 1.65], 900: [11, 2.35], 950: [5, 4.2],
};

/** 档位顺序（由浅到深）。渐变采样按这个顺序等分取色，档位越多过渡越细 */
export const SHADES: readonly number[] = Object.keys(ACCENT_RAMP).map(Number).sort((a, b) => a - b);

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0–1；色板派生不看它，只给需要保留半透明的地方用 */
  a: number;
}

export interface Hsl {
  h: number;
  s: number;
  l: number;
}

/** 渐变两端/中间任意位置的取色回调 */
export type GradientSampler = (t: number) => Rgb;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? clamp(n, 0, 1) : 0;
}

/** "#rgb" / "#rrggbb" / "#rrggbbaa" → Rgb，认不出返回 null */
function parseHex(input: string): Rgb | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(input);
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return null;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r, g, b, a };
}

/** "rgb(r,g,b)" / "rgba(r,g,b,a)"（数值或百分比）→ Rgb */
function parseRgbFn(body: string): Rgb | null {
  const parts = body.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const channel = (raw: string): number => {
    const isPct = raw.endsWith('%');
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return NaN;
    return isPct ? (n / 100) * 255 : n;
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
  if (![r, g, b].every(Number.isFinite)) return null;
  return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: Number.isFinite(a) ? clamp01(a) : 1 };
}

/** "hsl(h,s%,l%)" / "hsl(h s% l% / a)" → Rgb */
function parseHslFn(body: string): Rgb | null {
  const parts = body.replace(/\//g, ' ').split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const h = parseFloat(parts[0].replace('deg', ''));
  const s = parseFloat(parts[1].replace('%', ''));
  const l = parseFloat(parts[2].replace('%', ''));
  const a = parts[3] !== undefined ? parseFloat(parts[3]) : 1;
  if (![h, s, l].every(Number.isFinite)) return null;
  const rgb = hslToRgb(h, s, l);
  return { ...rgb, a: Number.isFinite(a) ? clamp01(a) : 1 };
}

/**
 * 解析 CSS 颜色串为 Rgb。白名单与后端 normalizeGradientCss 一致：
 * hex / rgb() / rgba() / hsl() / hsla()，其余一律返回 null。
 */
export function parseCssColor(value: unknown): Rgb | null {
  if (typeof value !== 'string') return null;
  const str = value.trim();
  if (!str) return null;
  if (str.startsWith('#')) return parseHex(str);
  const rgbMatch = /^rgba?\(([^)]+)\)$/i.exec(str);
  if (rgbMatch) return parseRgbFn(rgbMatch[1]);
  const hslMatch = /^hsla?\(([^)]+)\)$/i.exec(str);
  if (hslMatch) return parseHslFn(hslMatch[1]);
  return null;
}

/** Rgb → Hsl（h 0–360，s/l 0–100） */
export function rgbToHsl(rgb: Rgb): Hsl {
  const r = clamp(rgb.r, 0, 255) / 255;
  const g = clamp(rgb.g, 0, 255) / 255;
  const b = clamp(rgb.b, 0, 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

/** Hsl → Rgb（h 任意，s/l 0–100） */
export function hslToRgb(h: number, s: number, l: number): Omit<Rgb, 'a'> {
  const hue = ((h % 360) + 360) % 360;
  const sat = clamp01(s / 100);
  const light = clamp01(l / 100);
  const c = (1 - Math.abs(2 * light - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const table: readonly (readonly [number, number, number])[] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ];
  const [r, g, b] = table[seg];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

/**
 * 把色标数组变成"任意位置取色"的函数。
 * 只在**同一条**渐变内插值：先按位置排序、夹到 0–100，位置重合的色标按后写的赢，
 * 与浏览器渲染 linear-gradient 的规则一致。
 */
export function gradientSampler(stops: readonly { color: string; percent: number }[]): GradientSampler | null {
  const list = stops
    .map((s) => ({ rgb: parseCssColor(s.color), percent: clamp(Number(s.percent) || 0, 0, 100) }))
    .filter((s): s is { rgb: Rgb; percent: number } => Boolean(s.rgb))
    .sort((a, b) => a.percent - b.percent);
  if (list.length === 0) return null;
  if (list.length === 1) return () => list[0].rgb;

  return (t: number): Rgb => {
    const pos = clamp01(t) * 100;
    if (pos <= list[0].percent) return list[0].rgb;
    const last = list[list.length - 1];
    if (pos >= last.percent) return last.rgb;
    for (let i = 1; i < list.length; i += 1) {
      const hi = list[i];
      if (pos > hi.percent) continue;
      const lo = list[i - 1];
      const span = hi.percent - lo.percent;
      const k = span <= 0 ? 1 : (pos - lo.percent) / span;
      return {
        r: lo.rgb.r + (hi.rgb.r - lo.rgb.r) * k,
        g: lo.rgb.g + (hi.rgb.g - lo.rgb.g) * k,
        b: lo.rgb.b + (hi.rgb.b - lo.rgb.b) * k,
        a: lo.rgb.a + (hi.rgb.a - lo.rgb.a) * k,
      };
    }
    return last.rgb;
  };
}

/**
 * 一条渐变 → 每个档位的 [色相, 饱和度]。
 * 取色位置按档位均匀铺在 0–100% 上：浅档吃渐变前段、深档吃后端，
 * 于是「组件色选了渐变」时整条 teal / brand 色阶都跟着走，而不是只有一个代表色。
 */
export function gradientShadeHues(
  stops: readonly { color: string; percent: number }[],
  shades: readonly number[] = SHADES,
): { shade: number; h: number; s: number }[] {
  const sample = gradientHslSampler(stops);
  if (!sample) return [];
  const n = shades.length;
  return shades.map((shade, i) => {
    const { h, s } = sample(n > 1 ? i / (n - 1) : 0);
    return { shade, h: Math.round(h), s: Math.round(s) };
  });
}

/**
 * 渐变取色（HSL 空间，色相走最短弧）。
 *
 * 为什么色板不用 RGB 插值：`#fa709a → #30cfd0` 在 sRGB 里会对穿灰色中点，
 * 中段饱和度掉到 15%，整条色阶就变成「粉 → 灰 → 青」，用在描边和文字上像坏了。
 * 沿色相最短弧插值能保住鲜艳度（粉 → 紫 → 蓝 → 青），色板读起来仍然是那条渐变。
 * 真正的渐变面（按钮、液态条）依旧用原串渲染，两端色也依旧取精确端值，
 * 所以只有"中间档"是插值出来的，端点和用户选的颜色完全一致。
 */
export function gradientHslSampler(
  stops: readonly { color: string; percent: number }[],
): ((t: number) => Hsl) | null {
  const list = stops
    .map((s) => ({ hsl: toHslOrNull(s.color), percent: clamp(Number(s.percent) || 0, 0, 100) }))
    .filter((s): s is { hsl: Hsl; percent: number } => Boolean(s.hsl))
    .sort((a, b) => a.percent - b.percent);
  if (list.length === 0) return null;
  if (list.length === 1) return () => list[0].hsl;

  return (t: number): Hsl => {
    const pos = clamp01(t) * 100;
    if (pos <= list[0].percent) return list[0].hsl;
    const last = list[list.length - 1];
    if (pos >= last.percent) return last.hsl;
    for (let i = 1; i < list.length; i += 1) {
      const hi = list[i];
      if (pos > hi.percent) continue;
      const lo = list[i - 1];
      const span = hi.percent - lo.percent;
      const k = span <= 0 ? 1 : (pos - lo.percent) / span;
      return mixHsl(lo.hsl, hi.hsl, k);
    }
    return last.hsl;
  };
}

function toHslOrNull(color: string): Hsl | null {
  const rgb = parseCssColor(color);
  return rgb ? rgbToHsl(rgb) : null;
}

/** 两个 HSL 之间插值：色相走最短弧；一端无彩度（灰）时沿用另一端的色相，避免"灰带着 0° 红"乱跳 */
function mixHsl(a: Hsl, b: Hsl, k: number): Hsl {
  const aGray = a.s < 1;
  const bGray = b.s < 1;
  const h1 = aGray && !bGray ? b.h : a.h;
  const h2 = bGray && !aGray ? a.h : b.h;
  const dh = ((h2 - h1 + 540) % 360) - 180;
  return {
    h: ((h1 + dh * k) % 360 + 360) % 360,
    s: a.s + (b.s - a.s) * k,
    l: a.l + (b.l - a.l) * k,
  };
}

/** h/s/l → "h s% l%"，即 hsl() 的通道串；供 rgb(var()) / hsl(var()) 复用 */
export function hslTriple(h: number, s: number, l: number): string {
  const hue = ((Math.round(h) % 360) + 360) % 360;
  return `${hue} ${Math.round(clamp(s, 0, 100))}% ${Math.round(clamp(l, 0, 100))}%`;
}

/** 明度夹到 [2, 98]：避免整体提亮/压暗到纯白或纯黑 */
export function clampLightness(value: number): number {
  return Math.round(clamp(value, 2, 98));
}
