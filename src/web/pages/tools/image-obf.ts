/**
 * 图片混淆的浏览器端薄壳：纯逻辑（编解码/AES/变换/取消基建）在 image-obf-core.ts（浏览器与服务端共用），
 * 本文件只负责 <img>+canvas 解码编码及「解码→变换→编码」编排。
 */

import {
  CANVAS_MAX_DIM,
  PIXEL_MAX_AREA,
  encodeContainer,
  pixelFamilyTransform,
  pixelFamilyUntransform,
  seedFromPassword,
  sniffImageMime,
  yieldUi,
  ObfCancelled,
  type DecodeResult,
  type ObfOptions,
  type ParsedContainer,
  type PixelFamilyResult,
  type PixelPlan,
} from '../../../tools/image-obf-core.js';

export * from '../../../tools/image-obf-core.js';

// 超大图自动缩小的上限（真值在核心里，这里只是注释提醒：两处必须一致）
// CANVAS_MAX_DIM = 16384 / PIXEL_MAX_AREA = 40_000_000

function getImageDataBytes(blobBytes: Uint8Array): Promise<DecodeResult> {
  return new Promise((resolve, reject) => {
    // 用 <img> 解码而不是 createImageBitmap：后者不支持 SVG 源，且大图常驻解码缓冲；
    // <img> 由浏览器按需解码/回收，配合下面的等比缩小，超大图也能走通。
    const url = URL.createObjectURL(new Blob([blobBytes as BlobPart], { type: sniffImageMime(blobBytes) }));
    const img = new Image();
    let settled = false;
    const cleanup = () => {
      URL.revokeObjectURL(url);
      img.onload = null;
      img.onerror = null;
    };
    img.onload = () => {
      settled = true;
      const w0 = img.naturalWidth;
      const h0 = img.naturalHeight;
      if (!w0 || !h0) {
        cleanup();
        reject(new Error('无法读取图片尺寸（图片可能已损坏）'));
        return;
      }
      // 画布超限不会报错、只会画出空白图，所以这里统一等比缩到安全尺寸再处理。
      const scale = Math.min(
        1,
        CANVAS_MAX_DIM / w0,
        CANVAS_MAX_DIM / h0,
        Math.sqrt(PIXEL_MAX_AREA / (w0 * h0)),
      );
      const w = Math.max(1, Math.round(w0 * scale));
      const h = Math.max(1, Math.round(h0 * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        cleanup();
        reject(new Error('无法创建 2D 画布上下文'));
        return;
      }
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (scale < 1) ctx.drawImage(img, 0, 0, w0, h0, 0, 0, w, h);
      else ctx.drawImage(img, 0, 0);
      cleanup();
      resolve({
        data: ctx.getImageData(0, 0, w, h).data,
        width: w,
        height: h,
        scaledFrom: scale < 1 ? { w: w0, h: h0 } : null,
      });
    };
    img.onerror = () => {
      if (settled) return;
      cleanup();
      reject(new Error('当前浏览器无法解码该图片格式（像素置乱仅支持 PNG/JPEG/WebP/BMP/GIF 等光栅图）'));
    };
    img.src = url;
  });
}

function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('无法生成图片'));
        return;
      }
      blob.arrayBuffer().then((ab) => resolve(new Uint8Array(ab))).catch(reject);
    }, 'image/png');
  });
}

export async function pixelFamilyObfuscate(
  plain: Uint8Array,
  password: string,
  route: 2 | 3 | 4 | 5 | 6,
  scheme: number,
  preserveAlpha: boolean,
  name: string,
  blockSize = 16,
  opts?: ObfOptions,
): Promise<PixelFamilyResult> {
  opts?.onProgress?.({ done: 0, total: 100 });
  const { data, width, height, scaledFrom } = await getImageDataBytes(plain);
  opts?.onProgress?.({ done: 15, total: 100 });
  if (opts?.shouldCancel?.()) throw new ObfCancelled();

  const plan: PixelPlan = { route, scheme, blockSize, preserveAlpha, seed: seedFromPassword(password), name };
  const res = pixelFamilyTransform(plan, data, width, height, opts);

  if (opts?.shouldCancel?.()) throw new ObfCancelled();
  opts?.onProgress?.({ done: 60, total: 100 });
  await yieldUi();

  const canvas = document.createElement('canvas');
  canvas.width = res.width;
  canvas.height = res.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.putImageData(new ImageData(res.data as Uint8ClampedArray<ArrayBuffer>, res.width, res.height), 0, 0);
  const payload = await canvasToPngBytes(canvas);
  opts?.onProgress?.({ done: 90, total: 100 });

  const container = encodeContainer({
    route,
    algo: res.algo,
    flags: preserveAlpha ? 1 : 0,
    salt: new Uint8Array(0),
    iv: new Uint8Array(0),
    meta: res.meta,
    payload,
  });
  return { container, preview: payload, width: res.width, height: res.height, scaledFrom };
}

export async function pixelFamilyDeobfuscate(
  container: ParsedContainer,
  password: string,
  opts?: ObfOptions,
): Promise<Uint8Array> {
  const { payload } = container;
  opts?.onProgress?.({ done: 0, total: 100 });
  const { data, width, height } = await getImageDataBytes(payload);
  opts?.onProgress?.({ done: 15, total: 100 });
  if (opts?.shouldCancel?.()) throw new ObfCancelled();

  const res = pixelFamilyUntransform(container, data, width, height, seedFromPassword(password), opts);

  if (opts?.shouldCancel?.()) throw new ObfCancelled();
  opts?.onProgress?.({ done: 60, total: 100 });
  await yieldUi();

  const canvas = document.createElement('canvas');
  canvas.width = res.width;
  canvas.height = res.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 画布上下文');
  ctx.putImageData(new ImageData(res.data as Uint8ClampedArray<ArrayBuffer>, res.width, res.height), 0, 0);
  return canvasToPngBytes(canvas);
}
