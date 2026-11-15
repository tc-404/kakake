/**
 * 页面水印 · 字符串版（给「插件自带的 WebUI」用）。
 *
 * 控制台是 React 应用，水印由 components/watermark-layer.tsx 渲染；
 * 但插件 WebUI 是插件目录下的**独立 HTML**（由 plugin-http.handler 直接吐出），
 * 根本不在 React 树里。要做到「8787 下全部界面都显示」，这里按同一份设置
 * 往那份 HTML 里注入一段等价的水印 DOM。
 *
 * 与 React 版的差异（刻意为之，都是为了不给第三方页面添麻烦）：
 * - 颜色用 `currentColor` + 整层 15% 不透明度：插件页有自己的深浅配色，
 *   继承它自己的文字色最稳妥，也就不需要把主题色算好再塞进来；
 * - 不依赖任何 CSS 类 / 自定义属性，整段是内联样式 + 内联 SVG，
 *   页面只加载自己的样式表也不会漏样式；
 * - 文字宽度按字符类型估算（服务端没有 canvas）。宁可格子算大一点，
 *   也不能算小 —— 算小了相邻两枚水印会叠字。
 */

/** 与前端组件共用同一套字号 / 字体族 */
const FONT_FAMILY = "'DM Sans','PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif";

/** 水印渲染参数：设置页的三根滑动条 + 文字 */
export interface WatermarkRenderOptions {
  text: string;
  /** 倾斜角度（度），负值左倾 */
  angle: number;
  /** 密集度 0–100：越大格子越密 */
  density: number;
  /** 字号（px） */
  size: number;
}

/** HTML 文本转义：水印文字来自设置项，必须当成纯文本插进去 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 密集度 → 格子额外间距（px）。
 * 公式与前端 lib/appearance.ts 的 watermarkGap() 必须完全一致，
 * 否则同一条设置下控制台与插件页的水印疏密会不一样。
 */
function gapOf(density: number): { x: number; y: number } {
  const d = Math.min(100, Math.max(0, density));
  const x = Math.round(260 - d * 2.2);
  return { x, y: Math.round(x * 0.8) };
}

/** 估算文字宽度：CJK / 全角按 1em，其余按比例；只用于决定格子大小 */
function estimateWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80) width += fontSize; // CJK、假名、全角标点
    else if (ch === ' ') width += fontSize * 0.3;
    else if (/[MW@#%&]/.test(ch)) width += fontSize * 0.85;
    else width += fontSize * 0.56;
  }
  return Math.ceil(width);
}

/** 生成整段水印 DOM（含内联样式），插进 </body> 之前 */
export function buildWatermarkSnippet(options: WatermarkRenderOptions): string {
  const { text, angle, density, size } = options;
  const textW = estimateWidth(text, size);
  const textH = Math.ceil(size * 1.25);
  // 外接矩形按绝对角度算，左右倾斜的格子一样大
  const rad = (Math.abs(angle) * Math.PI) / 180;
  const boxW = textW * Math.cos(rad) + textH * Math.sin(rad);
  const boxH = textW * Math.sin(rad) + textH * Math.cos(rad);
  const gap = gapOf(density);
  const tileW = Math.ceil(boxW + gap.x);
  const tileH = Math.ceil(boxH + gap.y);
  const cx = Math.round(tileW / 2);
  const cy = Math.round(tileH / 2);
  const id = `kk-wm-${Math.random().toString(36).slice(2, 10)}`;

  return (
    '<div aria-hidden="true" data-kk-watermark="1" style="position:fixed;top:0;right:0;bottom:0;left:0;'
    + 'z-index:2147483000;pointer-events:none;user-select:none;-webkit-user-select:none;'
    + 'color:inherit;opacity:.15">'
    + `<svg width="100%" height="100%" style="display:block;width:100%;height:100%">`
    + '<defs>'
    + `<pattern id="${id}" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse">`
    + `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle"`
    + ` transform="rotate(${angle} ${cx} ${cy})" fill="currentColor"`
    + ` style="font-family:${FONT_FAMILY};font-size:${size}px;font-weight:600;letter-spacing:.04em"`
    + `>${escapeHtml(text)}</text>`
    + '</pattern>'
    + '</defs>'
    + `<rect width="100%" height="100%" fill="url(#${id})"/>`
    + '</svg></div>'
  );
}

/**
 * 把水印注入一份 HTML。
 * 找不到 </body> 时追加到末尾（浏览器照样会渲染这段 fixed 层）。
 */
export function injectWatermark(html: string, options: WatermarkRenderOptions): string {
  if (!options.text) return html;
  const snippet = buildWatermarkSnippet(options);
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx >= 0) return `${html.slice(0, idx)}${snippet}${html.slice(idx)}`;
  return html + snippet;
}
