/**
 * 图片工具箱核心逻辑：声明式 EditSpec + applyEdit（canvas）执行，同一份 spec 可复用于未来服务端 sharp。
 * 已知边界：受浏览器画布上限约束（单边 16384px / 总面积 2^28），超限在加载时报错而非出空白图。
 */

export type ImageFormat = 'png' | 'jpeg' | 'webp';
/**
 * 尺寸模式：
 * - none：不缩放
 * - percent：按百分比
 * - longside：按最长边
 * - exact：自定义宽×高（两个值都显式指定，允许非等比）
 */
export type ResizeMode = 'none' | 'percent' | 'longside' | 'exact';

/** 裁剪矩形：源图像素坐标 */
export type CropRect = { x: number; y: number; w: number; h: number };

/**
 * 尺寸设置。
 *
 * 每种模式**各存各的值**，互不干扰：从「百分比」切到「最长边」再切回来，
 * 之前填的百分比还在。早期版本三种模式共用一个 `value`，
 * 切模式时上一种模式的数字会被当成新模式的输入（比如把 50% 当成「最长边 50px」），
 * 用户要的是「各记各的」。
 */
export type ResizeSpec = {
  mode: ResizeMode;
  /** 百分比模式：100 = 原尺寸 */
  percent: number;
  /** 最长边模式：像素 */
  longside: number;
  /** 自定义模式：宽（px）；0 表示按高推算 */
  width: number;
  /** 自定义模式：高（px）；0 表示按宽推算 */
  height: number;
};

export type EditSpec = {
  resize: ResizeSpec;
  crop: CropRect | null;
  round: { radius: number };
  format: ImageFormat | 'keep';
  /** JPEG/WebP 质量 0~1（PNG 无损，此项无效） */
  quality: number;
  /** 非空时用该颜色铺底（透明图转 JPEG 时避免变黑） */
  background: string | null;
  /** 目标体积（字节）。非空时按质量二分逼近，找不到就返回能达到的最小体积 */
  targetBytes: number | null;
};

export const DEFAULT_SPEC: EditSpec = {
  resize: { mode: 'none', percent: 100, longside: 0, width: 0, height: 0 },
  crop: null,
  round: { radius: 0 },
  format: 'keep',
  quality: 0.85,
  background: null,
  targetBytes: null,
};

/**
 * 切到某个尺寸模式时，若该模式自己的值还是空的，用当前图（或裁剪后区域）的尺寸补一个合理默认值。
 * 纯函数，不改原对象。
 */
export function withResizeDefaults(
  resize: ResizeSpec,
  mode: ResizeMode,
  srcW: number,
  srcH: number,
): ResizeSpec {
  const w = Math.max(1, Math.round(srcW));
  const h = Math.max(1, Math.round(srcH));
  const next: ResizeSpec = { ...resize, mode };
  if (mode === 'percent' && !(next.percent > 0)) next.percent = 100;
  if (mode === 'longside' && !(next.longside > 0)) next.longside = Math.max(w, h);
  if (mode === 'exact') {
    if (!(next.width > 0)) next.width = w;
    if (!(next.height > 0)) next.height = h;
  }
  return next;
}


/** 画布硬上限（Chrome/Edge/Firefox 桌面端） */
export const CANVAS_MAX_SIDE = 16384;
export const CANVAS_MAX_AREA = 268_435_456;

export function isImageFormat(v: string): v is ImageFormat {
  return v === 'png' || v === 'jpeg' || v === 'webp';
}

export function mimeOf(f: ImageFormat): string {
  return f === 'jpeg' ? 'image/jpeg' : f === 'webp' ? 'image/webp' : 'image/png';
}

export function extOf(f: ImageFormat): string {
  return f === 'jpeg' ? 'jpg' : f === 'webp' ? 'webp' : 'png';
}

// ===================== 纯函数（可单测） =====================

/**
 * 由源尺寸 + 尺寸设置算出目标尺寸。
 * - percent：按百分比（resize.percent）
 * - longside：锁定最长边（resize.longside）
 * - exact：自定义宽×高（resize.width / resize.height）；
 *          只填一边时按原图比例推另一边，两边都填则按填的来（可拉伸）
 * - none：原样
 * 结果至少 1px，且不超过画布上限（超出则按比例夹住）。
 */
export function computeTargetSize(srcW: number, srcH: number, resize: ResizeSpec): { w: number; h: number } {
  const { mode } = resize;
  let w = srcW;
  let h = srcH;
  if (mode === 'percent' && resize.percent > 0) {
    const k = resize.percent / 100;
    w = Math.round(srcW * k);
    h = Math.round(srcH * k);
  } else if (mode === 'longside' && resize.longside > 0) {
    const k = resize.longside / Math.max(1, Math.max(srcW, srcH));
    w = Math.round(srcW * k);
    h = Math.round(srcH * k);
  } else if (mode === 'exact') {
    const value = resize.width;
    const height = resize.height;
    // 给了宽高就按填的来（可非等比拉伸）；只给一边就按原图比例推另一边
    if (value > 0 && height > 0) {
      w = value;
      h = height;
    } else if (value > 0) {
      w = value;
      h = Math.round((srcH * w) / Math.max(1, srcW));
    } else if (height > 0) {
      h = height;
      w = Math.round((srcW * h) / Math.max(1, srcH));
    }
  }
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  // 夹到画布上限内（等比缩）
  const scale = Math.min(1, CANVAS_MAX_SIDE / w, CANVAS_MAX_SIDE / h, Math.sqrt(CANVAS_MAX_AREA / (w * h)));
  if (scale < 1) {
    w = Math.max(1, Math.round(w * scale));
    h = Math.max(1, Math.round(h * scale));
  }
  return { w, h };
}

/** 把裁剪矩形夹到图像范围内（保证至少 1px） */
export function clampCrop(c: CropRect, imgW: number, imgH: number): CropRect {
  const w = Math.min(Math.max(1, Math.round(c.w)), imgW);
  const h = Math.min(Math.max(1, Math.round(c.h)), imgH);
  const x = Math.min(Math.max(0, Math.round(c.x)), imgW - w);
  const y = Math.min(Math.max(0, Math.round(c.y)), imgH - h);
  return { x, y, w, h };
}

/**
 * 让裁剪矩形满足给定宽高比（保持中心不变，尽量小地改动）。
 * aspect 为 null 表示自由比例。
 */
export function applyAspect(c: CropRect, aspect: number | null): CropRect {
  if (!aspect || aspect <= 0) return c;
  // 以宽度为基准算高度，若超出则改为以高度为基准
  let w = c.w;
  let h = Math.round(w / aspect);
  if (h < 1) {
    h = 1;
    w = Math.max(1, Math.round(h * aspect));
  }
  return { x: c.x, y: c.y, w, h };
}

/** 按宽高比预设反查比例值 */
export const ASPECT_PRESETS: { label: string; value: number | null }[] = [
  { label: '自由', value: null },
  { label: '1:1', value: 1 },
  { label: '4:3', value: 4 / 3 },
  { label: '3:4', value: 3 / 4 },
  { label: '16:9', value: 16 / 9 },
  { label: '9:16', value: 9 / 16 },
  { label: '3:2', value: 3 / 2 },
  { label: '2:3', value: 2 / 3 },
];

/** 目标体积模式下，质量二分的可接受误差（相对值） */
const TARGET_TOLERANCE = 0.04;

// ===================== 图片加载 =====================

export type LoadedImage = {
  img: HTMLImageElement;
  url: string;
  width: number;
  height: number;
};

/** renderEdit / encodeEdit 只依赖这三个字段，便于复用已解码的图片、避免重复解码 */
export type ImageSource = { img: HTMLImageElement; width: number; height: number };

function assertWithinCanvasLimit(w: number, h: number): void {
  if (w > CANVAS_MAX_SIDE || h > CANVAS_MAX_SIDE || w * h > CANVAS_MAX_AREA) {
    throw new Error(
      `图片尺寸 ${w}×${h} 超出浏览器处理上限（单边 ${CANVAS_MAX_SIDE}px / 总面积 ${(
        CANVAS_MAX_AREA / 1_000_000
      ).toFixed(0)} 百万像素）`,
    );
  }
}

/**
 * 从对象 URL 加载图片，**不回收该 URL**（所有权交给调用方）。
 *
 * 工具页会为每个文件保留一条 URL 并长期复用同一个 <img>：
 * 之前每次改设置都调 loadImageForEdit 重新解码一次原图，大图时就是「一拖滑块就卡」的元凶。
 */
export function loadImageFromUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        reject(new Error('无法读取图片尺寸（文件可能已损坏）'));
        return;
      }
      try {
        assertWithinCanvasLimit(w, h);
      } catch (e) {
        reject(e);
        return;
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error('无法解码该图片（请确认是有效的图片文件）'));
    img.src = url;
  });
}

/**
 * 用 <img> 加载（而不是 createImageBitmap）：
 * 现代浏览器会自动应用 EXIF 方向，手机竖拍的照片不会躺倒；
 * 而且 SVG 也能加载。
 *
 * 加载完即回收临时 URL —— 只需要尺寸/一次性使用的场景用它；
 * 需要反复绘制的场景请用 loadImageFromUrl + 自管 URL。
 */
export function loadImageForEdit(bytes: Uint8Array, mime = ''): Promise<LoadedImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || undefined }));
    const img = new Image();
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      settled = true;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) {
        cleanup();
        reject(new Error('无法读取图片尺寸（文件可能已损坏）'));
        return;
      }
      try {
        assertWithinCanvasLimit(w, h);
      } catch (e) {
        cleanup();
        reject(e);
        return;
      }
      resolve({ img, url, width: w, height: h });
    };
    img.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('无法解码该图片（请确认是有效的图片文件）'));
    };
    img.src = url;
  });
}

// ===================== 编码 =====================

function canvasToBytes(canvas: HTMLCanvasElement, format: ImageFormat, quality: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('编码失败（浏览器不支持该输出格式？）'));
          return;
        }
        blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
      },
      mimeOf(format),
      format === 'png' ? undefined : quality,
    );
  });
}

/**
 * 等比缩小要「逐次减半」：一次性从 8000px 拉到 400px，浏览器用的是最近邻/双线性
 * 混合，会出严重锯齿和摩尔纹；分多步慢跑则接近高质量重采样。
 */
function drawScaled(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): void {
  let cw = srcW;
  let ch = srcH;
  let cur: CanvasImageSource = source;
  while (cw > dstW * 2 && ch > dstH * 2) {
    const nw = Math.max(dstW, Math.floor(cw / 2));
    const nh = Math.max(dstH, Math.floor(ch / 2));
    const step = document.createElement('canvas');
    step.width = nw;
    step.height = nh;
    const sctx = step.getContext('2d');
    if (!sctx) break;
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(cur, 0, 0, cw, ch, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, cw, ch, 0, 0, dstW, dstH);
}

/** 圆角路径：优先用原生 roundRect，老浏览器退回到 arcTo 手拼 */
function roundedPath(ctx: CanvasRenderingContext2D, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(0, 0, w, h, rr);
    return;
  }
  ctx.moveTo(rr, 0);
  ctx.lineTo(w - rr, 0);
  ctx.arcTo(w, 0, w, rr, rr);
  ctx.lineTo(w, h - rr);
  ctx.arcTo(w, h, w - rr, h, rr);
  ctx.lineTo(rr, h);
  ctx.arcTo(0, h, 0, h - rr, rr);
  ctx.lineTo(0, rr);
  ctx.arcTo(0, 0, rr, 0, rr);
  ctx.closePath();
}

/** 按 spec 渲染出结果画布（不含编码）。导出以便测试与将来的高级预览复用 */
export function renderEdit(
  img: HTMLImageElement,
  srcW: number,
  srcH: number,
  spec: EditSpec,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  const crop = spec.crop ? clampCrop(spec.crop, srcW, srcH) : { x: 0, y: 0, w: srcW, h: srcH };
  const { w: dw, h: dh } = computeTargetSize(crop.w, crop.h, spec.resize);
  const radius = Math.max(0, Math.min(spec.round.radius, Math.floor(Math.min(dw, dh) / 2)));

  const canvas = document.createElement('canvas');
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建画布上下文');

  // 铺底色：透明图转 JPEG 时默认会被填成黑色，这里让用户可控
  if (spec.background) {
    ctx.fillStyle = spec.background;
    ctx.fillRect(0, 0, dw, dh);
  }

  // 圆角裁剪
  if (radius > 0) {
    roundedPath(ctx, dw, dh, radius);
    ctx.clip();
  }

  // 先把裁剪区域完整搬到一张中间画布，再从中间画布缩放到目标尺寸。
  // 这样裁剪矩形和缩放才是对齐的（直接对原图缩放+取源矩形会错位）。
  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = crop.w;
  cropCanvas.height = crop.h;
  const cctx = cropCanvas.getContext('2d');
  if (!cctx) throw new Error('无法创建画布上下文');
  cctx.imageSmoothingEnabled = true;
  cctx.imageSmoothingQuality = 'high';
  cctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h);

  if (dw < crop.w || dh < crop.h) {
    drawScaled(ctx, cropCanvas, crop.w, crop.h, dw, dh);
  } else {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cropCanvas, 0, 0, crop.w, crop.h, 0, 0, dw, dh);
  }
  return { canvas, width: dw, height: dh };
}

/** 编码结果 */
export type EditOutput = {
  bytes: Uint8Array;
  mime: string;
  format: ImageFormat;
  width: number;
  height: number;
};

/**
 * 执行编辑（图已解码好）；targetBytes 非空时二分质量逼近目标体积。
 *
 * 和 applyEdit 分开是为了让调用方复用同一张已解码的图：
 * 批量处理多张图、以及「预览 + 最终导出」都只解码一次。
 */
export async function encodeEdit(src: ImageSource, spec: EditSpec): Promise<EditOutput> {
  const outFormat: ImageFormat = spec.format === 'keep' ? 'png' : spec.format;
  const render = () => renderEdit(src.img, src.width, src.height, spec);

  const first = render();
  let out = await canvasToBytes(first.canvas, outFormat, spec.quality);

  // 目标体积：只有 JPEG/WebP 能靠调质量逼近（PNG 无损，调质量无效）
  if (spec.targetBytes && spec.targetBytes > 0 && outFormat !== 'png' && out.byteLength > spec.targetBytes) {
    const target = spec.targetBytes;
    let lo = 0.05;
    let hi = Math.max(0.06, spec.quality);
    let best: Uint8Array | null = null;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const cand = await canvasToBytes(first.canvas, outFormat, mid);
      if (cand.byteLength <= target) {
        best = cand;
        lo = mid; // 达标了，试试能不能再高质量一点
      } else {
        hi = mid;
      }
    }
    // 一整轮都没达标：用最低质量兜底（这是该格式能达到的最小体积）
    if (!best) best = await canvasToBytes(first.canvas, outFormat, 0.05);
    out = best;
  }

  return { bytes: out, mime: mimeOf(outFormat), format: outFormat, width: first.width, height: first.height };
}

/** 执行编辑；targetBytes 非空时二分质量逼近目标体积 */
export async function applyEdit(bytes: Uint8Array, spec: EditSpec, mime = ''): Promise<EditOutput> {
  const loaded = await loadImageForEdit(bytes, mime);
  return encodeEdit(loaded, spec);
}

/** 预览用：渲染成对象 URL（不做体积优化，避免每次拖滑块都跑二分） */
export async function renderPreview(
  bytes: Uint8Array,
  spec: EditSpec,
  mime = '',
): Promise<{ url: string; width: number; height: number }> {
  const loaded = await loadImageForEdit(bytes, mime);
  const format: ImageFormat = spec.format === 'keep' ? 'png' : spec.format;
  const { canvas, width, height } = renderEdit(loaded.img, loaded.width, loaded.height, spec);
  const out = await canvasToBytes(canvas, format, spec.quality);
  const url = URL.createObjectURL(new Blob([out as BlobPart], { type: mimeOf(format) }));
  return { url, width, height };
}
