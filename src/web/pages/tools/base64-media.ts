export type MediaKind = 'image' | 'video' | 'audio';

export type MediaDetect = {
  kind: MediaKind;
  mime: string;
};

const TEXT_EXT = new Set([
  '.txt',
  '.json',
  '.md',
  '.csv',
  '.xml',
  '.html',
  '.htm',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.svg',
  '.yml',
  '.yaml',
  '.log',
  '.ini',
  '.conf',
  '.env',
]);

/** 剥掉 data URL 前缀与所有空白，得到纯 Base64 / Hex 正文 */
export function stripDataUrlBase64(s: string): string {
  const trimmed = s.trim();
  const m = /^data:[^;]+;base64,(.*)$/is.exec(trimmed);
  return (m ? m[1]! : trimmed).replace(/\s+/g, '');
}

/**
 * 归一化 Base64：兼容 URL-safe 变体（- _）与缺失的 padding（=）。
 * 非法字符 / 长度错误会抛出中文错误，便于直接提示用户。
 */
export function normalizeBase64(input: string): string {
  const cleaned = stripDataUrlBase64(input).replace(/-/g, '+').replace(/_/g, '/');
  if (!cleaned) throw new Error('没有可解码的 Base64 内容');

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
    throw new Error('Base64 含非法字符，请检查是否复制完整');
  }

  const rest = cleaned.length % 4;
  if (rest === 1) {
    throw new Error('Base64 长度不合法（可能被截断）');
  }
  return rest === 0 ? cleaned : cleaned + '='.repeat(4 - rest);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(normalizeBase64(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Base64 的 URL-safe 变体：+ / 换成 - _，并去掉尾部 =（JWT、URL 参数常用） */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 编码（RFC 4648，字母表 A-Z2-7，默认补 = 对齐到 8 字符） */
export function bytesToBase32(bytes: Uint8Array, pad = true): string {
  let value = 0;
  let bits = 0;
  let out = '';

  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  if (!pad) return out;

  while (out.length % 8 !== 0) out += '=';
  return out;
}

/** Base32 解码：忽略空白与大小写，允许省略尾部 = */
export function base32ToBytes(input: string): Uint8Array {
  const cleaned = input
    .replace(/\s+/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (!cleaned) throw new Error('没有可解码的 Base32 内容');

  let value = 0;
  let bits = 0;
  const out: number[] = [];

  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Base32 含非法字符「${ch}」`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i]!.toString(16).padStart(2, '0');
  return out;
}

/** 十六进制转字节：允许空格 / 换行 / 逗号 / 冒号 / 0x 前缀；不做静默丢弃 */
export function hexToBytes(input: string): Uint8Array {
  const cleaned = input.replace(/0x/gi, '').replace(/[\s,;:_-]/g, '');
  if (!cleaned) throw new Error('没有可解码的十六进制内容');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) {
    throw new Error('含非十六进制字符，请检查输入');
  }
  if (cleaned.length % 2 !== 0) {
    throw new Error('十六进制长度必须是偶数（两个字符表示一个字节）');
  }

  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** 粗略判断字节流更像二进制：含 NUL 或不可打印字符占比过高 */
export function looksBinary(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  if (sample.length === 0) return false;

  let suspicious = 0;
  for (const b of sample) {
    if (b === 0) return true;
    if (b < 0x09 || (b > 0x0d && b < 0x20)) suspicious += 1;
  }
  return suspicious / sample.length > 0.1;
}

function startsWith(bytes: Uint8Array, sig: number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** 取头部一段做 latin1 字符串，用于在容器内部找编码标识 */
function latin1Window(bytes: Uint8Array, offset: number, len: number): string {
  let out = '';
  const end = Math.min(bytes.length, offset + len);
  for (let i = offset; i < end; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

function isMp3FrameSync(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const b0 = bytes[0]!;
  const b1 = bytes[1]!;
  return b0 === 0xff && (b1 & 0xe0) === 0xe0;
}

/** ftyp 后紧跟的 brand 是这些时，ISO-BMFF 容器里装的是图片而不是视频 */
const FTYP_IMAGE_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'mif1',
  'msf1',
  'avif',
  'avis',
]);

/** 按文件头魔数识别图片 / 视频 / 音频；无法识别返回 null */
export function detectMediaKind(bytes: Uint8Array): MediaDetect | null {
  if (bytes.length < 4) return null;

  // PNG
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: 'image', mime: 'image/png' };
  }
  // JPEG
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { kind: 'image', mime: 'image/jpeg' };
  }
  // GIF
  if (asciiAt(bytes, 0, 'GIF87a') || asciiAt(bytes, 0, 'GIF89a')) {
    return { kind: 'image', mime: 'image/gif' };
  }
  // WEBP: RIFF....WEBP
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WEBP')) {
    return { kind: 'image', mime: 'image/webp' };
  }
  // BMP（需要完整文件头）
  if (bytes.length >= 14 && startsWith(bytes, [0x42, 0x4d])) {
    return { kind: 'image', mime: 'image/bmp' };
  }

  // WAV: RIFF....WAVE
  if (asciiAt(bytes, 0, 'RIFF') && asciiAt(bytes, 8, 'WAVE')) {
    return { kind: 'audio', mime: 'audio/wav' };
  }
  // FLAC
  if (asciiAt(bytes, 0, 'fLaC')) {
    return { kind: 'audio', mime: 'audio/flac' };
  }
  // OGG 容器：Theora 是视频，Vorbis / Opus 是音频
  if (asciiAt(bytes, 0, 'OggS')) {
    if (latin1Window(bytes, 0, 512).includes('theora')) {
      return { kind: 'video', mime: 'video/ogg' };
    }
    return { kind: 'audio', mime: 'audio/ogg' };
  }
  // MP3 ID3 or frame sync
  if (asciiAt(bytes, 0, 'ID3') || isMp3FrameSync(bytes)) {
    return { kind: 'audio', mime: 'audio/mpeg' };
  }

  // WebM / Matroska
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { kind: 'video', mime: 'video/webm' };
  }
  // MP4 / ISO-BMFF: ....ftyp；HEIC / AVIF 等图片格式同样带 ftyp，需按 brand 区分
  if (bytes.length >= 12 && asciiAt(bytes, 4, 'ftyp')) {
    const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!)
      .toLowerCase()
      .replace(/\0/g, '');
    if (FTYP_IMAGE_BRANDS.has(brand)) {
      return { kind: 'image', mime: brand.startsWith('avi') ? 'image/avif' : 'image/heic' };
    }
    return { kind: 'video', mime: 'video/mp4' };
  }

  return null;
}

export function bytesToObjectUrl(bytes: Uint8Array, mime: string): string {
  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'audio/wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'video/ogg': 'ogv',
  'video/webm': 'webm',
  'video/mp4': 'mp4',
};

/** 从视频 blob URL 截取一帧作为封面（JPEG blob URL） */
export function captureVideoPoster(videoUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = videoUrl;

    let settled = false;

    const cleanup = () => {
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      video.load();
    };

    const fail = (msg: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    };

    const finish = (url: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };

    const grabFrame = () => {
      try {
        const w = video.videoWidth;
        const h = video.videoHeight;
        if (!w || !h) {
          fail('视频无有效画面');
          return;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          fail('无法截取封面');
          return;
        }
        ctx.drawImage(video, 0, 0, w, h);
        canvas.toBlob(
          (blob) => {
            if (!blob) {
              fail('无法截取封面');
              return;
            }
            finish(URL.createObjectURL(blob));
          },
          'image/jpeg',
          0.86,
        );
      } catch (e) {
        fail(e instanceof Error ? e.message : '无法截取封面');
      }
    };

    video.onerror = () => fail('无法读取视频封面');

    video.onloadeddata = () => {
      const seekTo =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(0.25, video.duration * 0.05)
          : 0;
      video.onseeked = () => grabFrame();
      try {
        if (seekTo > 0.01) {
          video.currentTime = seekTo;
        } else {
          grabFrame();
        }
      } catch {
        grabFrame();
      }
    };
  });
}

export function isLikelyTextFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const name = file.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return TEXT_EXT.has(name.slice(dot));
}

export function localDateStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function localDateTxtName(d = new Date()): string {
  return `${localDateStamp(d)}.txt`;
}

export function downloadTextAsDateFile(text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = localDateTxtName();
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 把解码出来的字节按真实类型存成文件（扩展名依据 MIME 推断） */
export function downloadBytes(bytes: Uint8Array, mime: string, baseName = 'decoded'): void {
  const ext = EXT_BY_MIME[mime] ?? 'bin';
  const url = bytesToObjectUrl(bytes, mime || 'application/octet-stream');
  const a = document.createElement('a');
  a.href = url;
  a.download = `${baseName}-${localDateStamp()}.${ext}`;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 按魔数判断压缩类型：gzip = 1f 8b；zlib = 78 后跟合法校验字节 */
export function detectCompression(bytes: Uint8Array): 'gzip' | 'zlib' | null {
  if (bytes.length < 2) return null;
  const [b0, b1] = [bytes[0]!, bytes[1]!];
  if (b0 === 0x1f && b1 === 0x8b) return 'gzip';
  if (b0 === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(b1)) return 'zlib';
  return null;
}

type ByteTransform = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** 把字节流管道跑一遍（边读边写，避免大输入造成背压死锁） */
async function runByteTransform(bytes: Uint8Array, transform: ByteTransform): Promise<Uint8Array> {
  const drained = (async () => {
    const chunks: Uint8Array[] = [];
    const reader = transform.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return concatChunks(chunks);
  })();

  const writer = transform.writable.getWriter();
  try {
    await writer.write(bytes);
    await writer.close();
    return await drained;
  } catch (e) {
    // 出错时先把读取侧收干净，避免抛出未处理的 rejection
    await drained.catch(() => undefined);
    try {
      await writer.abort(e);
    } catch {
      /* 已经出错，忽略 */
    }
    throw e instanceof Error ? e : new Error('压缩 / 解压失败');
  }
}

/** gzip 压缩（浏览器原生 CompressionStream，不需要联网） */
export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持本地压缩，请换用较新的 Chrome / Edge / Firefox / Safari');
  }
  return runByteTransform(bytes, new CompressionStream('gzip') as ByteTransform);
}

/**
 * raw deflate 没有头部，任意数据都可能被「解」成乱码，
 * 所以只接受能当作文本解读的结果，避免静默产出垃圾。
 */
function looksLikeDecompressedText(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || looksBinary(bytes)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解压：按魔数选格式；没魔数就依次尝试 raw deflate / gzip / zlib，
 * 每次结果都要通过 accept 校验（不传则接受）。
 */
export async function gunzipBytes(
  bytes: Uint8Array,
  accept?: (out: Uint8Array) => boolean,
): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('当前浏览器不支持本地解压，请换用较新的 Chrome / Edge / Firefox / Safari');
  }

  const kind = detectCompression(bytes);
  const formats: ('gzip' | 'deflate' | 'deflate-raw')[] =
    kind === 'gzip' ? ['gzip'] : kind === 'zlib' ? ['deflate'] : ['deflate-raw', 'gzip', 'deflate'];

  for (const format of formats) {
    try {
      const out = await runByteTransform(bytes, new DecompressionStream(format) as ByteTransform);
      if (!accept || accept(out)) return out;
    } catch {
      /* 换下一种格式再试 */
    }
  }

  throw new Error(
    kind === null
      ? '解压失败：不是压缩数据（若只想解 Base64 文本，请切到 Base64 模式）'
      : '解压失败：数据不是有效的 gzip / zlib 流',
  );
}

/** 文本 → gzip → Base64（把长 JSON 压成一行时常用） */
export async function gzipTextToBase64(text: string): Promise<string> {
  return bytesToBase64(await gzipBytes(new TextEncoder().encode(text)));
}

/** Base64（gzip / zlib / raw deflate）→ 文本 */
export async function base64GzipToText(input: string): Promise<string> {
  const bytes = base64ToBytes(input);
  // 有魔数说明确实是压缩数据；没魔数就必须能解出合法文本，否则视为猜错
  const out = await gunzipBytes(
    bytes,
    detectCompression(bytes) ? undefined : looksLikeDecompressedText,
  );
  return new TextDecoder().decode(out);
}

export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsArrayBuffer(file);
  });
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsText(file);
  });
}
