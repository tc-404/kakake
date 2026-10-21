/**
 * 图片混淆核心逻辑：纯函数、不依赖 DOM，浏览器与 Node 服务端共用；
 * 两种路线统一打包成 KKOBF 容器（可逆、与图片格式无关）。
 *
 * 容器结构（字节序大端）：
 *   'KKOBF'   5 字节魔数
 *   version   u8  = 1
 *   route     u8  = 1(AES) 2(像素置乱) 3(像素异或) 4(通道洗牌) 5(位平面) 6(混沌 Arnold)
 *   algo      u8  = AES:1=GCM 2=CBC 3=CTR / 2:1=逐像素 2=分块 3=行乱序
 *                     / 3:1=逐流 2=逐行 3=单字节 / 4:1=红蓝互换 2=循环 3=逆循环
 *                     / 5:1=位平面 2=字节内比特 / 6:1=Arnold
 *   flags     u8  = AES: bit0 KDF(0=PBKDF2,1=HKDF) / 像素系: bit0 保留透明通道(仅 route2)
 *   saltLen   u8  + salt[]
 *   ivLen     u8  + iv[]            （像素路线为 0 长度）
 *   metaLen   u16  + meta[]         （UTF-8 JSON，含原始文件名等）
 *   payloadLen u32  + payload[]
 */

const MAGIC = [0x4b, 0x4b, 0x4f, 0x42, 0x46]; // 'KKOBF'
const VERSION = 1;

export type RouteId = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type AesCipher = 'AES-GCM' | 'AES-CBC' | 'AES-CTR';
export type PixelMode = 'perPixel' | 'block' | 'row';
export type AesKdf = 'pbkdf2' | 'hkdf';

export type ObfMeta = {
  /** 原始文件名（还原时用于下载名） */
  name: string;
  /** AES 路线：KDF 类型（还原时读取，无需用户重选） */
  kdf?: AesKdf;
  /** AES 路线：PBKDF2 迭代次数 */
  iterations?: number;
  /** 像素路线：原始尺寸与模式，用于重建置换 */
  seed?: number;
  width?: number;
  height?: number;
  pixelMode?: PixelMode;
  preserveAlpha?: boolean;
  /** 分片模式下的原始明文长度（各分组密码的填充规则不同，必须记录才能正确切分密文） */
  plainLen?: number;
  /** 分块置乱的块边长（真值以容器 algo 字节为准，这里只是冗余便于排查） */
  blockSize?: number;
};

export type ParsedContainer = {
  route: RouteId;
  algo: number;
  flags: number;
  salt: Uint8Array;
  iv: Uint8Array;
  meta: ObfMeta;
  payload: Uint8Array;
};

// ===================== 容器编解码 =====================

export function isContainer(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  return MAGIC.every((b, i) => bytes[i] === b);
}

export function encodeContainer(p: {
  route: RouteId;
  algo: number;
  flags: number;
  salt: Uint8Array;
  iv: Uint8Array;
  meta: ObfMeta;
  payload: Uint8Array;
}): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(p.meta));
  const head: number[] = [
    ...MAGIC,
    VERSION,
    p.route,
    p.algo,
    p.flags,
    p.salt.length,
    ...p.salt,
    p.iv.length,
    ...p.iv,
    (metaBytes.length >> 8) & 0xff,
    metaBytes.length & 0xff,
    ...metaBytes,
  ];
  const out = new Uint8Array(head.length + 4 + p.payload.length);
  out.set(head, 0);
  let o = head.length;
  out[o++] = (p.payload.length >>> 24) & 0xff;
  out[o++] = (p.payload.length >>> 16) & 0xff;
  out[o++] = (p.payload.length >>> 8) & 0xff;
  out[o++] = p.payload.length & 0xff;
  out.set(p.payload, o);
  return out;
}

export function decodeContainer(buf: Uint8Array): ParsedContainer {
  let o = 0;
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[o++] !== MAGIC[i]) throw new Error('不是有效的混淆文件（文件头不符）');
  }
  const version = buf[o++];
  if (version !== VERSION) throw new Error(`混淆文件版本不兼容（v${version}）`);
  const route = buf[o++] as RouteId;
  const algo = buf[o++];
  const flags = buf[o++];
  const saltLen = buf[o++];
  const salt = buf.slice(o, o + saltLen);
  o += saltLen;
  const ivLen = buf[o++];
  const iv = buf.slice(o, o + ivLen);
  o += ivLen;
  const metaLen = (buf[o++] << 8) | buf[o++];
  const meta = JSON.parse(new TextDecoder().decode(buf.slice(o, o + metaLen))) as ObfMeta;
  o += metaLen;
  const payloadLen = (buf[o++] << 24) | (buf[o++] << 16) | (buf[o++] << 8) | buf[o++];
  const payload = buf.slice(o, o + payloadLen);
  o += payloadLen;
  return { route, algo, flags, salt, iv, meta, payload };
}

// ===================== 通用工具 =====================

/**
 * WebCrypto 结构类型。浏览器侧这些类型来自 DOM lib，Node 侧来自 @types/node 的
 * webcrypto，两者结构兼容；这里统一用本地结构类型描述，避免为了服务端编译通过
 * 而把整个 DOM lib 引进后端 tsconfig。
 */
type ObfBufferSource = ArrayBufferView | ArrayBuffer;
type ObfCipherParams =
  | { name: 'AES-GCM'; iv: ObfBufferSource }
  | { name: 'AES-CBC'; iv: ObfBufferSource }
  | { name: 'AES-CTR'; counter: ObfBufferSource; length: number };
type ObfCryptoKey = {
  readonly type: string;
  readonly algorithm: { name: string };
  readonly usages: readonly string[];
};

interface ObfSubtle {
  encrypt(algorithm: ObfCipherParams, key: ObfCryptoKey, data: ObfBufferSource): Promise<ArrayBuffer>;
  decrypt(algorithm: ObfCipherParams, key: ObfCryptoKey, data: ObfBufferSource): Promise<ArrayBuffer>;
  importKey(
    format: string,
    keyData: ObfBufferSource,
    algorithm: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<ObfCryptoKey>;
  deriveKey(
    algorithm: unknown,
    baseKey: ObfCryptoKey,
    derivedKeyAlgorithm: unknown,
    extractable: boolean,
    usages: readonly string[],
  ): Promise<ObfCryptoKey>;
}

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function requireSubtle(): ObfSubtle {
  if (!crypto || !crypto.subtle) {
    throw new Error('当前环境不是安全上下文（需 https 或 localhost），无法使用加密；可改用「像素置乱」路线');
  }
  return crypto.subtle as unknown as ObfSubtle;
}

// ===================== AES 对称字节加密 =====================

function algoNameFor(algo: number): AesCipher {
  return algo === 2 ? 'AES-CBC' : algo === 3 ? 'AES-CTR' : 'AES-GCM';
}

function algoByteFor(c: AesCipher): number {
  return c === 'AES-GCM' ? 1 : c === 'AES-CBC' ? 2 : 3;
}

function encParams(cipher: AesCipher, iv: Uint8Array): ObfCipherParams {
  const ivBuf = iv as ObfBufferSource;
  if (cipher === 'AES-GCM') return { name: 'AES-GCM', iv: ivBuf };
  if (cipher === 'AES-CBC') return { name: 'AES-CBC', iv: ivBuf };
  return { name: 'AES-CTR', counter: ivBuf, length: 128 };
}

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  cipher: AesCipher,
  kdf: AesKdf,
  iterations: number,
): Promise<ObfCryptoKey> {
  const enc = new TextEncoder();
  const subtle = requireSubtle();
  if (kdf === 'hkdf') {
    const hkdfKey = await subtle.importKey('raw', enc.encode(password) as ObfBufferSource, 'HKDF', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'HKDF', salt: salt as ObfBufferSource, info: enc.encode('kakake-image-obf') as ObfBufferSource, hash: 'SHA-256' },
      hkdfKey,
      { name: cipher, length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }
  const pbkdfKey = await subtle.importKey('raw', enc.encode(password) as ObfBufferSource, 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as ObfBufferSource, iterations, hash: 'SHA-256' },
    pbkdfKey,
    { name: cipher, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ===================== 进度 / 取消 =====================

export type ObfProgress = { done: number; total: number };

export type ObfOptions = {
  /** 每个分片处理完后回调（done/total 单位由调用方定义，用于画进度条） */
  onProgress?: (p: ObfProgress) => void;
  /** 每片开始前检查，返回 true 立即中断（抛 ObfCancelled） */
  shouldCancel?: () => boolean;
};

export class ObfCancelled extends Error {
  constructor() {
    super('已取消');
    this.name = 'ObfCancelled';
  }
}

/** 让出主线程，让进度条 / 取消按钮能响应（否则长循环会把 UI 冻住） */
export function yieldUi(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** 按分片推进 total 个单位；每片前检查取消，每片后上报进度并让出主线程 */
async function runChunks(
  total: number,
  chunk: number,
  fn: (start: number, end: number) => void,
  opts?: ObfOptions,
): Promise<void> {
  let done = 0;
  while (done < total) {
    if (opts?.shouldCancel?.()) throw new ObfCancelled();
    const end = Math.min(total, done + chunk);
    fn(done, end);
    done = end;
    opts?.onProgress?.({ done, total });
    if (done < total) await yieldUi();
  }
}

// ===================== AES（对称字节加密） =====================

/** AES 分片大小：必须是 16 字节整数倍，CTR 的计数器偏移才好算 */
const AES_CHUNK = 4 * 1024 * 1024;
/** 容器 flags 位：bit0 = 像素路线保留透明通道（AES 路线复用为 hkdf 标记），bit1 = AES 分片模式 */
const FLAG_AES_CHUNKED = 2;

/** 分片 nonce/IV：把计数器按大端 XOR 进尾字节（基数随机，故每片唯一且不可预测） */
function chunkIv(iv: Uint8Array, index: number): Uint8Array {
  const out = iv.slice();
  for (let k = 0; k < 4; k++) {
    const pos = out.length - 1 - k;
    if (pos < 0) break;
    out[pos] = (out[pos]! ^ ((index >>> (8 * k)) & 0xff)) & 0xff;
  }
  return out;
}

/** CTR 专用：把 16 字节计数器块整体加上 blockOffset（大端进位） */
function ctrIvAdd(iv: Uint8Array, blockOffset: number): Uint8Array {
  const out = iv.slice();
  let carry = blockOffset;
  for (let i = out.length - 1; i >= 0 && carry > 0; i--) {
    const sum = out[i]! + (carry & 0xff);
    out[i] = sum & 0xff;
    carry = (carry >>> 8) + (sum >>> 8);
  }
  return out;
}

export async function aesEncrypt(
  plain: Uint8Array,
  password: string,
  cipher: AesCipher,
  kdf: AesKdf,
  iterations: number,
  name: string,
  opts?: ObfOptions,
): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const salt = randomBytes(16);
  const ivLen = cipher === 'AES-GCM' ? 12 : 16;
  const iv = randomBytes(ivLen);
  const key = await deriveAesKey(password, salt, cipher, kdf, iterations);

  // 小文件单次加密即可；大文件分片，才能报进度、才能中途取消
  const chunked = plain.byteLength > AES_CHUNK;
  let ct: Uint8Array;
  if (!chunked) {
    if (opts?.shouldCancel?.()) throw new ObfCancelled();
    ct = new Uint8Array(await subtle.encrypt(encParams(cipher, iv), key, plain as ObfBufferSource));
    opts?.onProgress?.({ done: plain.byteLength, total: plain.byteLength });
  } else {
    const parts: Uint8Array[] = [];
    let done = 0;
    let idx = 0;
    while (done < plain.byteLength) {
      if (opts?.shouldCancel?.()) throw new ObfCancelled();
      const end = Math.min(plain.byteLength, done + AES_CHUNK);
      const slice = plain.subarray(done, end);
      const segIv =
        cipher === 'AES-CTR' ? ctrIvAdd(iv, idx * (AES_CHUNK / 16)) : chunkIv(iv, idx);
      const seg = new Uint8Array(await subtle.encrypt(encParams(cipher, segIv), key, slice as ObfBufferSource));
      parts.push(seg);
      done = end;
      idx++;
      opts?.onProgress?.({ done, total: plain.byteLength });
      await yieldUi();
    }
    const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
    ct = new Uint8Array(totalLen);
    let o = 0;
    for (const p of parts) {
      ct.set(p, o);
      o += p.byteLength;
    }
  }

  const flags = (kdf === 'hkdf' ? 1 : 0) | (chunked ? FLAG_AES_CHUNKED : 0);
  const meta: ObfMeta = { name, kdf, iterations };
  if (chunked) meta.plainLen = plain.byteLength;
  return encodeContainer({ route: 1, algo: algoByteFor(cipher), flags, salt, iv, meta, payload: ct });
}

export async function aesDecrypt(
  container: ParsedContainer,
  password: string,
  opts?: ObfOptions,
): Promise<Uint8Array> {
  const subtle = requireSubtle();
  const cipher = algoNameFor(container.algo);
  const kdf = container.meta.kdf ?? 'pbkdf2';
  const iterations = container.meta.iterations ?? 250000;
  const key = await deriveAesKey(password, container.salt, cipher, kdf, iterations);
  const chunked = (container.flags & FLAG_AES_CHUNKED) !== 0;

  if (!chunked) {
    try {
      return new Uint8Array(
        await subtle.decrypt(encParams(cipher, container.iv), key, container.payload as ObfBufferSource),
      );
    } catch {
      throw new Error('解密失败：密码不正确或文件已损坏');
    }
  }

  // 分片模式：逐片还原。GCM 每片密文 = 明文长度 + 16 字节 tag；
  // CBC 每片补齐到 16 的倍数；CTR 每片等长。
  const ct = container.payload;
  const plainLen = container.meta.plainLen;
  const parts: Uint8Array[] = [];
  let done = 0;
  let plainDone = 0;
  let idx = 0;
  while (done < ct.byteLength) {
    if (opts?.shouldCancel?.()) throw new ObfCancelled();
    // 本片明文长度 L 与密文长度 segLen：
    // GCM = L + 16(tag)；CBC = (floor(L/16)+1)*16（PKCS#7 满块时额外补一整块）；CTR = L（流模式）
    let l: number;
    let segLen: number;
    if (typeof plainLen === 'number') {
      l = Math.min(AES_CHUNK, plainLen - plainDone);
      if (l <= 0) throw new Error('解密失败：文件已损坏（分片长度异常）');
      segLen = cipher === 'AES-GCM' ? l + 16 : cipher === 'AES-CBC' ? (Math.floor(l / 16) + 1) * 16 : l;
    } else {
      const remain = ct.byteLength - done;
      if (cipher === 'AES-GCM') {
        l = Math.min(AES_CHUNK, remain - 16);
        segLen = l + 16;
      } else if (cipher === 'AES-CBC') {
        segLen = Math.min(AES_CHUNK + 16, remain);
        l = segLen - 16;
      } else {
        segLen = Math.min(AES_CHUNK, remain);
        l = segLen;
      }
      if (l <= 0) throw new Error('解密失败：文件已损坏（分片长度异常）');
    }
    const segIv = cipher === 'AES-CTR' ? ctrIvAdd(container.iv, idx * (AES_CHUNK / 16)) : chunkIv(container.iv, idx);
    try {
      const seg = new Uint8Array(
        await subtle.decrypt(encParams(cipher, segIv), key, ct.subarray(done, done + segLen) as ObfBufferSource),
      );
      parts.push(seg);
    } catch {
      throw new Error('解密失败：密码不正确或文件已损坏');
    }
    done += segLen;
    plainDone += l;
    idx++;
    opts?.onProgress?.({ done, total: ct.byteLength });
    await yieldUi();
  }
  const totalLen = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(totalLen);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

// ===================== 像素置乱（视觉混淆，仍是图片） =====================

export function seedFromPassword(pw: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < pw.length; i++) {
    h ^= pw.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledOrder(n: number, rng: () => number): Int32Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

function buildOrder(w: number, h: number, mode: PixelMode, rng: () => number, blockSize = 16): Int32Array {
  if (mode === 'perPixel') return shuffledOrder(w * h, rng);
  if (mode === 'row') return shuffledOrder(h, rng);
  const cols = Math.ceil(w / blockSize);
  const rows = Math.ceil(h / blockSize);
  return shuffledOrder(cols * rows, rng);
}

function copyRegion(
  src: Uint8ClampedArray,
  dst: Uint8ClampedArray,
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  w: number,
  h: number,
  blockSize = 16,
): void {
  const bw = Math.min(blockSize, w - sx);
  const bh = Math.min(blockSize, h - sy);
  if (bw <= 0 || bh <= 0) return;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const s = ((sy + y) * w + (sx + x)) * 4;
      const d = ((dy + y) * w + (dx + x)) * 4;
      dst[d] = src[s]!;
      dst[d + 1] = src[s + 1]!;
      dst[d + 2] = src[s + 2]!;
      dst[d + 3] = src[s + 3]!;
    }
  }
}

function pixelScramble(
  src: Uint8ClampedArray,
  order: Int32Array,
  w: number,
  h: number,
  mode: PixelMode,
  preserveAlpha: boolean,
  blockSize = 16,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (mode === 'perPixel') {
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const s = order[i]! * 4;
      const d = i * 4;
      out[d] = src[s]!;
      out[d + 1] = src[s + 1]!;
      out[d + 2] = src[s + 2]!;
      out[d + 3] = preserveAlpha ? src[d + 3]! : src[s + 3]!;
    }
  } else if (mode === 'row') {
    for (let r = 0; r < h; r++) {
      const srcRow = order[r]!;
      out.set(src.subarray(srcRow * w * 4, srcRow * w * 4 + w * 4), r * w * 4);
    }
  } else {
    const cols = Math.ceil(w / blockSize);
    const rows = Math.ceil(h / blockSize);
    for (let tb = 0; tb < cols * rows; tb++) {
      const sb = order[tb]!;
      const tx = (tb % cols) * blockSize;
      const ty = Math.floor(tb / cols) * blockSize;
      const sx = (sb % cols) * blockSize;
      const sy = Math.floor(sb / cols) * blockSize;
      copyRegion(src, out, sx, sy, tx, ty, w, h, blockSize);
    }
  }
  return out;
}

function pixelUnscramble(
  src: Uint8ClampedArray,
  order: Int32Array,
  w: number,
  h: number,
  mode: PixelMode,
  preserveAlpha: boolean,
  blockSize = 16,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length);
  if (mode === 'perPixel') {
    const n = w * h;
    for (let i = 0; i < n; i++) {
      const d = order[i]! * 4;
      const s = i * 4;
      out[d] = src[s]!;
      out[d + 1] = src[s + 1]!;
      out[d + 2] = src[s + 2]!;
      out[d + 3] = preserveAlpha ? src[d + 3]! : src[s + 3]!;
    }
  } else if (mode === 'row') {
    // 逆运算：scrambled 的第 r 行来自原图第 order[r] 行，
    // 还原时要写回 out[order[r]]（以前这里写的是 out[r]，等于又置乱一次，永远还原不回来）
    for (let r = 0; r < h; r++) {
      out.set(src.subarray(r * w * 4, r * w * 4 + w * 4), order[r]! * w * 4);
    }
  } else {
    const cols = Math.ceil(w / blockSize);
    const rows = Math.ceil(h / blockSize);
    for (let tb = 0; tb < cols * rows; tb++) {
      const sb = order[tb]!;
      const tx = (tb % cols) * blockSize;
      const ty = Math.floor(tb / cols) * blockSize;
      const sx = (sb % cols) * blockSize;
      const sy = Math.floor(sb / cols) * blockSize;
      // 还原：scrambled[tb] -> recovered[sb]
      copyRegion(src, out, tx, ty, sx, sy, w, h, blockSize);
    }
  }
  return out;
}

/**
 * 分块置乱可选块边长。编码进容器的 algo 字节，旧档（algo=2）仍按 16 解，
 * 所以新档和以前导出的 .kkobf 都能正常还原。
 */
export const BLOCK_SIZES = [8, 16, 32, 64] as const;

function modeByteFor(m: PixelMode, blockSize = 16): number {
  if (m === 'perPixel') return 1;
  if (m === 'row') return 3;
  // block：2=16（旧格式默认值，保持兼容），4=8，5=32，6=64
  if (blockSize === 8) return 4;
  if (blockSize === 32) return 5;
  if (blockSize === 64) return 6;
  return 2;
}

function decodePixelAlgo(byte: number): { mode: PixelMode; blockSize: number } {
  if (byte === 3) return { mode: 'row', blockSize: 16 };
  if (byte === 4) return { mode: 'block', blockSize: 8 };
  if (byte === 5) return { mode: 'block', blockSize: 32 };
  if (byte === 6) return { mode: 'block', blockSize: 64 };
  if (byte === 2) return { mode: 'block', blockSize: 16 };
  return { mode: 'perPixel', blockSize: 16 };
}

/** 浏览器画布硬上限（Chrome / Edge / Firefox 桌面端）：单边 16384px，总面积 2^28 = 268,435,456 像素 */
export const CANVAS_MAX_DIM = 16384;
const CANVAS_MAX_AREA = 268_435_456;
/**
 * 像素路线实际采用的面积上限：解码后 RGBA 每像素 4 字节，置乱还要一份等大副本，
 * 40MP ≈ 两个 160MB 缓冲，是浏览器里能稳跑的量级。超过会自动等比缩小，不再报错拒绝。
 */
export const PIXEL_MAX_AREA = 40_000_000;

export type DecodeResult = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 发生等比缩小时记录原尺寸；未缩小时为 null */
  scaledFrom: { w: number; h: number } | null;
};

/** 简单魔数嗅探：给 Blob 一个正确 MIME（<img> 解码 SVG 必须有 image/svg+xml，位图无类型也能靠浏览器嗅探） */
export function sniffImageMime(b: Uint8Array): string {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  const head = new TextDecoder().decode(b.subarray(0, Math.min(1024, b.length))).toLowerCase();
  if (head.includes('<svg')) return 'image/svg+xml';
  return '';
}

// ===================== 通用像素变换工具 =====================

/** 把输出像素的 alpha 通道还原为原图值（多数变换只动 RGB，保持透明度不变） */
function restoreAlpha(out: Uint8ClampedArray, src: Uint8ClampedArray): void {
  for (let i = 0; i < out.length; i += 4) out[i + 3] = src[i + 3]!;
}

/** 把 w×h 图像补成 n×n 方阵（边缘复制），n = max(w, h) */
function padToSquare(data: Uint8ClampedArray, w: number, h: number, n: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < n; x++) {
      const sx = Math.min(x, w - 1);
      const so = (sy * w + sx) * 4;
      const dO = (y * n + x) * 4;
      out[dO] = data[so]!;
      out[dO + 1] = data[so + 1]!;
      out[dO + 2] = data[so + 2]!;
      out[dO + 3] = data[so + 3]!;
    }
  }
  return out;
}

/** 从 n×n 方阵裁出 w×h（还原补边前的原尺寸） */
function cropFromSquare(data: Uint8ClampedArray, n: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(y * n * 4, y * n * 4 + w * 4), y * w * 4);
  return out;
}

/**
 * 把 w×h 补成 blockSize 的整数倍（边缘复制）。
 * 分块置乱必须补：否则最右列/最下行的块比别的块小，置乱与还原时 copyRegion
 * 的裁剪宽度不一致，会读写越界、画面错乱（以前就是踩这个坑）。
 */
function padToMultiple(data: Uint8ClampedArray, w: number, h: number, W: number, H: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < W; x++) {
      const sx = Math.min(x, w - 1);
      const so = (sy * w + sx) * 4;
      const dO = (y * W + x) * 4;
      out[dO] = data[so]!;
      out[dO + 1] = data[so + 1]!;
      out[dO + 2] = data[so + 2]!;
      out[dO + 3] = data[so + 3]!;
    }
  }
  return out;
}

/** 从 W×H 裁回 w×h（分块置乱还原时裁掉补边） */
function cropFromPadded(data: Uint8ClampedArray, W: number, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(y * W * 4, y * W * 4 + w * 4), y * w * 4);
  return out;
}

// ===================== 路线 3：像素异或 =====================
// 密钥流来自密码派生 PRNG；XOR 自身可逆。保留 alpha。

type XorScheme = 'stream' | 'row' | 'byte';

function xorTransform(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  rng: () => number,
  scheme: XorScheme,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  let kr = 0;
  let kg = 0;
  let kb = 0;
  const next = () => {
    kr = Math.floor(rng() * 256);
    kg = Math.floor(rng() * 256);
    kb = Math.floor(rng() * 256);
  };
  if (scheme === 'byte') next();
  for (let y = 0; y < h; y++) {
    if (scheme === 'row') next();
    for (let x = 0; x < w; x++) {
      if (scheme === 'stream') next();
      const o = (y * w + x) * 4;
      out[o] = data[o]! ^ kr;
      out[o + 1] = data[o + 1]! ^ kg;
      out[o + 2] = data[o + 2]! ^ kb;
    }
  }
  restoreAlpha(out, data);
  return out;
}

// ===================== 路线 4：通道洗牌 =====================
// perm = [newR, newG, newB] 的源通道下标；保留 alpha。

function channelTransform(data: Uint8ClampedArray, perm: number[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  for (let i = 0; i < data.length; i += 4) {
    out[i] = data[i + perm[0]!]!;
    out[i + 1] = data[i + perm[1]!]!;
    out[i + 2] = data[i + perm[2]!]!;
  }
  restoreAlpha(out, data);
  return out;
}

function invertPerm(perm: number[]): number[] {
  const inv = new Array(perm.length).fill(0);
  for (let i = 0; i < perm.length; i++) inv[perm[i]!] = i;
  return inv;
}

// ===================== 路线 5：位平面置乱 =====================
// 8 比特置换。注：旧版分「字节内比特 / 全局位平面」两支，但算式等价，已合并（见函数内注释）。保留 alpha。

function bitPlaneTransform(
  data: Uint8ClampedArray,
  perm: number[],
  inverse: boolean,
): Uint8ClampedArray {
  const map = inverse ? invertPerm(perm) : perm;
  const out = new Uint8Array(data.length);
  // 说明：原来这里分「字节内比特置换」和「全局位平面重排」两个分支，
  // 但两条分支的算式其实是同一个（都是 out bit b = v bit map[b]）——
  // 而「全局位平面」要先建 8 个和图等大的临时缓冲，40MP 的图就是 8×160MB≈1.3GB，
  // 大图直接有 OOM 风险。既然数学等价，统一走这条，省掉 8 倍内存。
  // 容器 algo 字节仍按旧规则编码（1=位平面 / 2=字节内比特），老档照常兼容。
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    let r = 0;
    for (let b = 0; b < 8; b++) if ((v >> map[b]!) & 1) r |= 1 << b;
    out[i] = r;
  }
  const res = new Uint8ClampedArray(out);
  restoreAlpha(res, data);
  return res;
}

// ===================== 路线 6：混沌置乱（Arnold 猫映射） =====================
// 作用于 n×n 方阵；逆矩阵可逆。迭代轮数由密码决定，存于 meta。

function arnoldStep(src: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const xn = (((x + y) % n) + n) % n;
      const yn = (((x + 2 * y) % n) + n) % n;
      const so = (y * n + x) * 4;
      const dO = (yn * n + xn) * 4;
      dst[dO] = src[so]!;
      dst[dO + 1] = src[so + 1]!;
      dst[dO + 2] = src[so + 2]!;
      dst[dO + 3] = src[so + 3]!;
    }
  }
  return dst;
}

function arnoldInvStep(src: Uint8ClampedArray, n: number): Uint8ClampedArray {
  const dst = new Uint8ClampedArray(n * n * 4);
  for (let yn = 0; yn < n; yn++) {
    for (let xn = 0; xn < n; xn++) {
      const x = (((2 * xn - yn) % n) + n) % n;
      const y = (((yn - xn) % n) + n) % n;
      const so = (yn * n + xn) * 4;
      const dO = (y * n + x) * 4;
      dst[dO] = src[so]!;
      dst[dO + 1] = src[so + 1]!;
      dst[dO + 2] = src[so + 2]!;
      dst[dO + 3] = src[so + 3]!;
    }
  }
  return dst;
}

function buildPerm(rng: () => number): number[] {
  const a = [0, 1, 2, 3, 4, 5, 6, 7];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
  return a;
}

// ===================== 字节流混淆（route 7） =====================
// 不解码、不重编码：直接对原始文件字节做可逆变换。
// 特点：输出与输入字节数完全一致、任意大小/任意格式都行、速度快；
// 代价是结果不再是合法图片（所以前端只显示文件图标，没有预览）。
// 还原后得到的是与原始文件逐字节相同的字节流。

export type ByteScheme = 'xor' | 'shuffle' | 'bitperm';

/** 读文件头拿分辨率（不解码，只读几十字节，超大图也能秒出） */
export function peekImageSize(bytes: Uint8Array): { w: number; h: number } | null {
  const u32 = (o: number) =>
    ((bytes[o]! << 24) | (bytes[o + 1]! << 16) | (bytes[o + 2]! << 8) | bytes[o + 3]!) >>> 0;
  const u16le = (o: number) => bytes[o]! | (bytes[o + 1]! << 8);
  const u32le = (o: number) =>
    (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;

  // PNG（读 IHDR 的宽高，正好需要 24 字节）
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { w: u32(16), h: u32(20) };
  }
  // GIF
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { w: u16le(6), h: u16le(8) };
  }
  // BMP
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { w: Math.abs(u32le(18)), h: Math.abs(u32le(22)) };
  }
  // WebP：VP8 / VP8X（VP8L 位域解析略过，返回 null 不影响使用）
  if (bytes.length > 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    const fmt = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (fmt === 'VP8 ') return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (fmt === 'VP8X') return { w: (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)) + 1, h: (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) + 1 };
  }
  // JPEG：扫 SOF 标记
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) { o++; continue; }
      const m = bytes[o + 1]!;
      if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { o += 2; continue; }
      const len = (bytes[o + 2]! << 8) | bytes[o + 3]!;
      const isSof = (m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf);
      if (isSof) return { h: (bytes[o + 5]! << 8) | bytes[o + 6]!, w: (bytes[o + 7]! << 8) | bytes[o + 8]! };
      if (len <= 0) break;
      o += 2 + len;
    }
  }
  return null;
}

/** 8 比特置换的逆置换 */
function invertBytePerm(perm: number[]): number[] {
  const inv = new Array<number>(8).fill(0);
  for (let i = 0; i < 8; i++) inv[perm[i]!] = i;
  return inv;
}

function applyBytePerm(byte: number, perm: number[]): number {
  let out = 0;
  for (let i = 0; i < 8; i++) {
    if ((byte >> i) & 1) out |= 1 << perm[i]!;
  }
  return out & 0xff;
}

/** 字节置换块大小：块内重排，块间独立，避免为整个文件建一个巨型排列 */
const BYTE_BLOCK = 4096;

function byteBlockTransform(
  src: Uint8Array,
  dst: Uint8Array,
  rng: () => number,
  inverse: boolean,
): void {
  const n = src.byteLength;
  for (let base = 0; base < n; base += BYTE_BLOCK) {
    const len = Math.min(BYTE_BLOCK, n - base);
    const order = shuffledOrder(len, rng);
    if (!inverse) {
      for (let i = 0; i < len; i++) dst[base + i] = src[base + order[i]!]!;
    } else {
      for (let i = 0; i < len; i++) dst[base + order[i]!] = src[base + i]!;
    }
  }
}

export async function byteStreamObfuscate(
  plain: Uint8Array,
  password: string,
  scheme: ByteScheme,
  name: string,
  opts?: ObfOptions,
): Promise<PixelFamilyResult> {
  const rng = mulberry32(seedFromPassword(password));
  const total = plain.byteLength;
  const out = new Uint8Array(total);
  const bitPerm = buildPerm(rng);

  if (scheme === 'xor') {
    await runChunks(
      total,
      AES_CHUNK,
      (s, e) => {
        for (let i = s; i < e; i++) out[i] = plain[i]! ^ ((rng() * 256) | 0) & 0xff;
      },
      opts,
    );
  } else if (scheme === 'bitperm') {
    const p = bitPerm;
    await runChunks(
      total,
      AES_CHUNK,
      (s, e) => {
        for (let i = s; i < e; i++) out[i] = applyBytePerm(plain[i]!, p);
      },
      opts,
    );
  } else {
    // 字节块置换按块处理（块内重排），分片推进以报进度/可取消
    const blocks = Math.ceil(total / BYTE_BLOCK);
    let done = 0;
    const chunkBlocks = Math.max(1, Math.ceil(AES_CHUNK / BYTE_BLOCK));
    while (done < blocks) {
      if (opts?.shouldCancel?.()) throw new ObfCancelled();
      const end = Math.min(blocks, done + chunkBlocks);
      const s = done * BYTE_BLOCK;
      const e = Math.min(total, end * BYTE_BLOCK);
      byteBlockTransform(plain.subarray(s, e), out.subarray(s, e), rng, false);
      done = end;
      opts?.onProgress?.({ done: e, total });
      if (done < blocks) await yieldUi();
    }
  }

  const peek = peekImageSize(plain);
  const meta: ObfMeta = { name };
  if (peek) {
    meta.width = peek.w;
    meta.height = peek.h;
  }
  const container = encodeContainer({
    route: 7,
    algo: scheme === 'xor' ? 1 : scheme === 'bitperm' ? 3 : 2,
    flags: 0,
    salt: new Uint8Array(0),
    iv: new Uint8Array(0),
    meta,
    payload: out,
  });
  return { container, preview: new Uint8Array(0), width: 0, height: 0, scaledFrom: null };
}

export async function byteStreamDeobfuscate(
  container: ParsedContainer,
  password: string,
  opts?: ObfOptions,
): Promise<Uint8Array> {
  const scheme: ByteScheme = container.algo === 2 ? 'shuffle' : container.algo === 3 ? 'bitperm' : 'xor';
  const src = container.payload;
  const rng = mulberry32(seedFromPassword(password));
  const bitPerm = buildPerm(rng);
  const total = src.byteLength;
  const out = new Uint8Array(total);

  if (scheme === 'xor') {
    await runChunks(
      total,
      AES_CHUNK,
      (s, e) => {
        for (let i = s; i < e; i++) out[i] = src[i]! ^ ((rng() * 256) | 0) & 0xff;
      },
      opts,
    );
  } else if (scheme === 'bitperm') {
    const inv = invertBytePerm(bitPerm);
    await runChunks(
      total,
      AES_CHUNK,
      (s, e) => {
        for (let i = s; i < e; i++) out[i] = applyBytePerm(src[i]!, inv);
      },
      opts,
    );
  } else {
    const blocks = Math.ceil(total / BYTE_BLOCK);
    let done = 0;
    const chunkBlocks = Math.max(1, Math.ceil(AES_CHUNK / BYTE_BLOCK));
    while (done < blocks) {
      if (opts?.shouldCancel?.()) throw new ObfCancelled();
      const end = Math.min(blocks, done + chunkBlocks);
      const s = done * BYTE_BLOCK;
      const e = Math.min(total, end * BYTE_BLOCK);
      byteBlockTransform(src.subarray(s, e), out.subarray(s, e), rng, true);
      done = end;
      opts?.onProgress?.({ done: e, total });
      if (done < blocks) await yieldUi();
    }
  }
  return out;
}

// ===================== 像素族混淆 / 还原（route 2~6） =====================
// 统一产出 KKOBF 容器，payload 为仍可被打开的 PNG（视觉已混乱）。

export type PixelFamilyResult = {
  container: Uint8Array;
  preview: Uint8Array;
  /** 混淆结果（payload）的尺寸 */
  width: number;
  height: number;
  /** 原图超出处理上限被等比缩小时，记录原尺寸；未缩小时为 null */
  scaledFrom: { w: number; h: number } | null;
};

// ===================== 像素族变换（纯逻辑，浏览器与服务端共用） =====================
// 这里只做「已解码的 RGBA → 变换后的 RGBA」，不碰解码/编码，
// 所以浏览器（canvas）和服务端（sharp）可以复用同一套数学，结果逐字节一致。

export type PixelPlan = {
  route: 2 | 3 | 4 | 5 | 6;
  /** 各路线子方案编码（见文件头注释） */
  scheme: number;
  blockSize: number;
  preserveAlpha: boolean;
  /** 由密码派生的随机种子——服务端只收种子，密码始终不离开浏览器 */
  seed: number;
  name: string;
};

export type PixelTransformResult = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  meta: ObfMeta;
  /** 容器 algo 字节 */
  algo: number;
};

export function pixelFamilyTransform(
  plan: PixelPlan,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  opts?: ObfOptions,
): PixelTransformResult {
  const rng = mulberry32(plan.seed);
  let outData: Uint8ClampedArray = data;
  let outW = width;
  let outH = height;
  const meta: ObfMeta = { name: plan.name };

  if (plan.route === 2) {
    const mode: PixelMode = plan.scheme === 2 ? 'block' : plan.scheme === 3 ? 'row' : 'perPixel';
    if (mode === 'block') {
      // 先补成块边长整数倍，保证所有块一样大，置乱/还原才严格互逆
      const bs = Math.max(1, plan.blockSize);
      const W = Math.ceil(width / bs) * bs;
      const H = Math.ceil(height / bs) * bs;
      const src = W === width && H === height ? data : padToMultiple(data, width, height, W, H);
      const order = buildOrder(W, H, mode, rng, bs);
      outData = pixelScramble(src, order, W, H, mode, plan.preserveAlpha, bs);
      outW = W;
      outH = H;
    } else {
      const order = buildOrder(width, height, mode, rng, plan.blockSize);
      outData = pixelScramble(data, order, width, height, mode, plan.preserveAlpha, plan.blockSize);
    }
    meta.pixelMode = mode;
    meta.seed = plan.seed;
    if (mode === 'block') meta.blockSize = plan.blockSize;
    // 必须把 preserveAlpha 写进 meta：还原时读的是 meta，
    // 以前只写了 flags 字节，导致「保留透明通道」在还原时被当成 false，
    // alpha 通道按"被打乱"的方式解，透明区域像素全错。
    meta.preserveAlpha = plan.preserveAlpha;
  } else if (plan.route === 3) {
    const s: XorScheme = plan.scheme === 2 ? 'row' : plan.scheme === 3 ? 'byte' : 'stream';
    outData = xorTransform(data, width, height, rng, s);
  } else if (plan.route === 4) {
    const perm = plan.scheme === 2 ? [1, 2, 0] : plan.scheme === 3 ? [2, 0, 1] : [2, 1, 0];
    outData = channelTransform(data, perm);
  } else if (plan.route === 5) {
    const perm = buildPerm(rng);
    outData = bitPlaneTransform(data, perm, false);
  } else {
    const iter = 5 + (plan.seed % 20);
    const n = Math.max(width, height);
    let cur = padToSquare(data, width, height, n);
    for (let k = 0; k < iter; k++) cur = arnoldStep(cur, n);
    outData = cur;
    outW = n;
    outH = n;
    meta.iterations = iter;
  }

  const algo = plan.route === 2 ? modeByteFor(meta.pixelMode ?? 'perPixel', plan.blockSize) : plan.scheme;
  // 输出尺寸和原图不一致时（分块补边 / Arnold 补方阵），必须记下原尺寸，
  // 否则还原时按 payload 尺寸裁，非正方形图会被撑成方阵、边缘全是补边垃圾像素。
  if (outW !== width || outH !== height) {
    meta.width = width;
    meta.height = height;
  }
  return { data: outData, width: outW, height: outH, meta, algo };
}

export type PixelUntransformResult = {
  data: Uint8ClampedArray;
  width: number;
  height: number;
};

/** 逆向：把容器里的 payload 像素还原。seed 由调用方给出（浏览器用密码派生，服务端用客户端传来的种子） */
export function pixelFamilyUntransform(
  container: ParsedContainer,
  data: Uint8ClampedArray,
  width: number,
  height: number,
  seed: number,
  opts?: ObfOptions,
): PixelUntransformResult {
  const { meta, route, algo } = container;
  const rng = mulberry32(seed);
  // preserveAlpha 以 meta 为准；旧容器只写了 flags 位，退回读 flags 保持兼容
  const preserveAlpha = meta.preserveAlpha ?? (container.flags & 1) === 1;
  let outData: Uint8ClampedArray = data;
  let outW = width;
  let outH = height;

  if (route === 2) {
    const { mode, blockSize } = decodePixelAlgo(algo);
    if (mode === 'block') {
      // payload 是补齐后的尺寸；先用同一套块网格还原，再裁回原尺寸
      const order = buildOrder(width, height, mode, rng, blockSize);
      const cur = pixelUnscramble(data, order, width, height, mode, preserveAlpha, blockSize);
      const ow = meta.width ?? width;
      const oh = meta.height ?? height;
      outData = ow === width && oh === height ? cur : cropFromPadded(cur, width, ow, oh);
      outW = ow;
      outH = oh;
    } else {
      const order = buildOrder(width, height, mode, rng, blockSize);
      outData = pixelUnscramble(data, order, width, height, mode, preserveAlpha, blockSize);
    }
  } else if (route === 3) {
    const s: XorScheme = algo === 2 ? 'row' : algo === 3 ? 'byte' : 'stream';
    outData = xorTransform(data, width, height, rng, s);
  } else if (route === 4) {
    const fwd = algo === 2 ? [1, 2, 0] : algo === 3 ? [2, 0, 1] : [2, 1, 0];
    outData = channelTransform(data, invertPerm(fwd));
  } else if (route === 5) {
    const perm = buildPerm(rng);
    outData = bitPlaneTransform(data, perm, true);
  } else {
    const iter = meta.iterations ?? 5;
    const n = Math.max(width, height);
    let cur = data;
    for (let k = 0; k < iter; k++) cur = arnoldInvStep(cur, n);
    outData = cropFromSquare(cur, n, meta.width ?? width, meta.height ?? height);
    outW = meta.width ?? width;
    outH = meta.height ?? height;
  }
  return { data: outData, width: outW, height: outH };
}
