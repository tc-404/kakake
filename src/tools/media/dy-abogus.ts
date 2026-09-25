// ---------------------------------------------------------------------------
// 抖音 web 接口签名 a_bogus（SM3 + RC4 + 自定义 Base64），纯本地实现、无三方依赖。
// 说明：抖音 2024 年起把分享页数据改成前端二次请求，页面里已不再内嵌
//       videoInfoRes/item_list，必须走 /aweme/v1/web/aweme/detail/ 并带签名。
// ---------------------------------------------------------------------------

/* ============================== SM3 ============================== */

const SM3_IV = [
  0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600,
  0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e,
];

function rotl(x: number, n: number): number {
  const s = n & 31;
  return ((x << s) | (x >>> (32 - s))) >>> 0;
}

function p0(x: number): number {
  return (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
}

function p1(x: number): number {
  return (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;
}

/** 国密 SM3 摘要，返回 32 字节 */
export function sm3(input: Uint8Array): Uint8Array {
  const bitLen = input.length * 8;
  const padLen = (56 - ((input.length + 1) % 64) + 64) % 64;
  const buf = new Uint8Array(input.length + 1 + padLen + 8);
  buf.set(input, 0);
  buf[input.length] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(buf.length - 4, bitLen >>> 0, false);

  const v = SM3_IV.slice();
  const w = new Uint32Array(68);

  for (let off = 0; off < buf.length; off += 64) {
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(off + j * 4, false);
    for (let j = 16; j < 68; j++) {
      const x = (w[j - 16] ^ w[j - 9] ^ rotl(w[j - 3], 15)) >>> 0;
      w[j] = (p1(x) ^ rotl(w[j - 13], 7) ^ w[j - 6]) >>> 0;
    }

    let a = v[0], b = v[1], c = v[2], d = v[3];
    let e = v[4], f = v[5], g = v[6], h = v[7];

    for (let j = 0; j < 64; j++) {
      const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const a12 = rotl(a, 12);
      const ss1 = rotl((((a12 + e) >>> 0) + rotl(t, j)) >>> 0, 7);
      const ss2 = (ss1 ^ a12) >>> 0;
      const ff = j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
      const gg = j < 16 ? (e ^ f ^ g) >>> 0 : ((e & f) | (~e & g)) >>> 0;
      const tt1 = ((((ff + d) >>> 0) + ss2 + ((w[j] ^ w[j + 4]) >>> 0)) >>> 0) >>> 0;
      const tt2 = ((((gg + h) >>> 0) + ss1 + w[j]) >>> 0) >>> 0;
      d = c;
      c = rotl(b, 9);
      b = a;
      a = tt1;
      h = g;
      g = rotl(f, 19);
      f = e;
      e = p0(tt2);
    }

    v[0] = (v[0] ^ a) >>> 0;
    v[1] = (v[1] ^ b) >>> 0;
    v[2] = (v[2] ^ c) >>> 0;
    v[3] = (v[3] ^ d) >>> 0;
    v[4] = (v[4] ^ e) >>> 0;
    v[5] = (v[5] ^ f) >>> 0;
    v[6] = (v[6] ^ g) >>> 0;
    v[7] = (v[7] ^ h) >>> 0;
  }

  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, v[i] >>> 0, false);
  return out;
}

/* ========================= 字节 / 字符串工具 ========================= */

/** 按字符码取字节（对应 JS 里逐 charCodeAt & 0xff 的行为） */
function charCodes(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
  return out;
}

function fromCharCodes(list: number[]): string {
  let s = '';
  for (const n of list) s += String.fromCharCode(n);
  return s;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** JS 无符号右移语义 */
function jsShiftRight(val: number, n: number): number {
  return Math.floor(val % 0x100000000) >>> n;
}

const SALT = 'cus';

/** a_bogus 专用的两张自定义 Base64 字符表 */
const CHARSET = [
  'Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe',
  'ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe',
];

// 置换表：transform 过程按此表做流式异或（运行时会被打乱，故每次调用都取副本）
const BIG_ARRAY_SEED = [
  121, 243, 55, 234, 103, 36, 47, 228, 30, 231, 106, 6, 115, 95, 78, 101, 250, 207, 198, 50,
  139, 227, 220, 105, 97, 143, 34, 28, 194, 215, 18, 100, 159, 160, 43, 8, 169, 217, 180, 120,
  247, 45, 90, 11, 27, 197, 46, 3, 84, 72, 5, 68, 62, 56, 221, 75, 144, 79, 73, 161,
  178, 81, 64, 187, 134, 117, 186, 118, 16, 241, 130, 71, 89, 147, 122, 129, 65, 40, 88, 150,
  110, 219, 199, 255, 181, 254, 48, 4, 195, 248, 208, 32, 116, 167, 69, 201, 17, 124, 125, 104,
  96, 83, 80, 127, 236, 108, 154, 126, 204, 15, 20, 135, 112, 158, 13, 1, 188, 164, 210, 237,
  222, 98, 212, 77, 253, 42, 170, 202, 26, 22, 29, 182, 251, 10, 173, 152, 58, 138, 54, 141,
  185, 33, 157, 31, 252, 132, 233, 235, 102, 196, 191, 223, 240, 148, 39, 123, 92, 82, 128, 109,
  57, 24, 38, 113, 209, 245, 2, 119, 153, 229, 189, 214, 230, 174, 232, 63, 52, 205, 86, 140,
  66, 175, 111, 171, 246, 133, 238, 193, 99, 60, 74, 91, 225, 51, 76, 37, 145, 211, 166, 151,
  213, 206, 0, 200, 244, 176, 218, 44, 184, 172, 49, 216, 93, 168, 53, 21, 183, 41, 67, 85,
  224, 155, 226, 242, 87, 177, 146, 70, 190, 12, 162, 19, 137, 114, 25, 165, 163, 192, 23, 59,
  9, 94, 179, 107, 35, 7, 142, 131, 239, 203, 149, 136, 61, 249, 14, 156,
];

/* ============================ 加密工具 ============================ */

function sm3ToArray(input: string | number[]): number[] {
  const bytes = typeof input === 'string' ? utf8Bytes(input) : new Uint8Array(input);
  return Array.from(sm3(bytes));
}

/** 参数哈希：字符串入参默认加盐 */
function paramsToArray(param: string | number[], addSalt = true): number[] {
  const processed = typeof param === 'string' && addSalt ? param + SALT : param;
  return sm3ToArray(processed);
}

/** 流式异或置换：边异或边打乱置换表 */
function transformBytes(bytesList: number[]): string {
  const bigArray = BIG_ARRAY_SEED.slice();
  const size = bigArray.length;
  const bytesStr = fromCharCodes(bytesList);
  const result: number[] = [];

  let indexB = bigArray[1];
  let initialValue = 0;
  let valueE = 0;

  for (let index = 0; index < bytesStr.length; index++) {
    let sumInitial: number;
    if (index === 0) {
      initialValue = bigArray[indexB];
      sumInitial = indexB + initialValue;
      bigArray[1] = initialValue;
      bigArray[indexB] = indexB;
    } else {
      sumInitial = initialValue + valueE;
    }

    sumInitial %= size;
    result.push(bytesStr.charCodeAt(index) ^ bigArray[sumInitial]);

    valueE = bigArray[(index + 2) % size];
    sumInitial = (indexB + valueE) % size;
    initialValue = bigArray[sumInitial];
    bigArray[sumInitial] = bigArray[(index + 2) % size];
    bigArray[(index + 2) % size] = initialValue;
    indexB = sumInitial;
  }

  return fromCharCodes(result);
}

/** 自定义字符表 Base64（按位拼，末尾按补位数补 =） */
function base64Encode(input: string, alphabetIndex = 0): string {
  const table = CHARSET[alphabetIndex];
  let binary = '';
  for (let i = 0; i < input.length; i++) {
    binary += (input.charCodeAt(i) & 0xff).toString(2).padStart(8, '0');
  }
  const padding = (6 - (binary.length % 6)) % 6;
  binary += '0'.repeat(padding);

  let out = '';
  for (let i = 0; i < binary.length; i += 6) {
    out += table[parseInt(binary.slice(i, i + 6), 2)];
  }
  return out + '='.repeat(Math.floor(padding / 2));
}

/** a_bogus 末段编码：3 字节一组，尾组按剩余长度截断 */
function abogusEncode(input: string, alphabetIndex: number): string {
  const table = CHARSET[alphabetIndex];
  const masks: Array<[number, number]> = [
    [18, 0xfc0000],
    [12, 0x03f000],
    [6, 0x000fc0],
    [0, 0x00003f],
  ];
  let out = '';

  for (let i = 0; i < input.length; i += 3) {
    let n: number;
    if (i + 2 < input.length) {
      n = (input.charCodeAt(i) << 16) | (input.charCodeAt(i + 1) << 8) | input.charCodeAt(i + 2);
    } else if (i + 1 < input.length) {
      n = (input.charCodeAt(i) << 16) | (input.charCodeAt(i + 1) << 8);
    } else {
      n = input.charCodeAt(i) << 16;
    }

    for (const [shift, mask] of masks) {
      if (shift === 6 && i + 1 >= input.length) break;
      if (shift === 0 && i + 2 >= input.length) break;
      out += table[(n & mask) >>> shift];
    }
  }

  return out + '='.repeat((4 - (out.length % 4)) % 4);
}

function rc4Encrypt(key: number[], plaintext: string): number[] {
  const s: number[] = [];
  for (let i = 0; i < 256; i++) s.push(i);

  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
  }

  let i = 0;
  j = 0;
  const out: number[] = [];
  for (let k = 0; k < plaintext.length; k++) {
    i = (i + 1) % 256;
    j = (j + s[i]) % 256;
    [s[i], s[j]] = [s[j], s[i]];
    out.push(plaintext.charCodeAt(k) ^ s[(s[i] + s[j]) % 256]);
  }
  return out;
}

/** 混淆前缀：4 字节一组的伪随机串 */
function generateRandomBytes(length = 3): string {
  const out: number[] = [];
  for (let n = 0; n < length; n++) {
    const rd = Math.floor(Math.random() * 10000);
    out.push(((rd & 255) & 170) | 1);
    out.push(((rd & 255) & 85) | 2);
    out.push((jsShiftRight(rd, 8) & 170) | 5);
    out.push((jsShiftRight(rd, 8) & 85) | 40);
  }
  return fromCharCodes(out);
}

/* ========================== 浏览器环境伪造 ========================== */

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 浏览器窗口/屏幕指纹，格式与前端采集的一致 */
export function generateFingerprint(platform = 'Win32'): string {
  const innerWidth = randInt(1024, 1920);
  const innerHeight = randInt(768, 1080);
  const outerWidth = innerWidth + randInt(24, 32);
  const outerHeight = innerHeight + randInt(75, 90);
  const screenY = Math.random() < 0.5 ? 0 : 30;
  const sizeWidth = randInt(1024, 1920);
  const sizeHeight = randInt(768, 1080);
  const availWidth = randInt(1280, 1920);
  const availHeight = randInt(800, 1080);
  return (
    `${innerWidth}|${innerHeight}|${outerWidth}|${outerHeight}|0|${screenY}|0|0|` +
    `${sizeWidth}|${sizeHeight}|${availWidth}|${availHeight}|${innerWidth}|${innerHeight}|24|24|${platform}`
  );
}

const MS_TOKEN_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789=_';

/** 伪造 msToken（真实 token 由前端 SDK 下发，长度一致即可通过多数校验） */
export function generateMsToken(length = 107): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += MS_TOKEN_CHARS[Math.floor(Math.random() * MS_TOKEN_CHARS.length)];
  }
  return out;
}

/* ============================= a_bogus ============================= */

const AID = 6383;
const PAGE_ID = 0;
const UA_KEY = [0x00, 0x01, 0x0e];

const SORT_INDEX = [
  18, 20, 52, 26, 30, 34, 58, 38, 40, 53, 42, 21, 27, 54, 55, 31, 35, 57, 39, 41, 43, 22, 28,
  32, 60, 36, 23, 29, 33, 37, 44, 45, 59, 46, 47, 48, 49, 50, 24, 25, 65, 66, 70, 71,
];

const SORT_INDEX_2 = [
  18, 20, 26, 30, 34, 38, 40, 42, 21, 27, 31, 35, 39, 41, 43, 22, 28, 32, 36, 23, 29, 33, 37,
  44, 45, 46, 47, 48, 49, 50, 24, 25, 52, 53, 54, 55, 57, 58, 59, 60, 65, 66, 70, 71,
];

export interface ABogusOptions {
  /** 请求配置：GET [0,1,8]，POST [0,1,14]；14 兼容 8 */
  options?: number[];
  userAgent: string;
  fingerprint?: string;
  /** POST 请求体，GET 传空串 */
  body?: string;
}

/**
 * 生成 a_bogus 签名。
 * @param params 已排好序的 query 串（不含 `?`、不含 a_bogus 本身）
 */
export function generateABogus(params: string, opts: ABogusOptions): string {
  const options = opts.options ?? [0, 1, 14];
  const userAgent = opts.userAgent;
  const fingerprint = opts.fingerprint || generateFingerprint();
  const body = opts.body ?? '';

  const abDir: Record<number, number> = {
    8: 3,
    18: 44,
    66: 0,
    69: 0,
    70: 0,
    71: 0,
  };

  const startEncryption = Date.now();

  const array1 = paramsToArray(paramsToArray(params));
  const array2 = paramsToArray(paramsToArray(body));
  const array3 = paramsToArray(
    base64Encode(fromCharCodes(rc4Encrypt(UA_KEY, userAgent)), 1),
    false,
  );

  const endEncryption = Date.now();

  abDir[20] = (startEncryption >>> 24) & 255;
  abDir[21] = (startEncryption >>> 16) & 255;
  abDir[22] = (startEncryption >>> 8) & 255;
  abDir[23] = startEncryption & 255;
  abDir[24] = Math.floor(startEncryption / 256 / 256 / 256 / 256);
  abDir[25] = Math.floor(startEncryption / 256 / 256 / 256 / 256 / 256);

  abDir[26] = (options[0] >>> 24) & 255;
  abDir[27] = (options[0] >>> 16) & 255;
  abDir[28] = (options[0] >>> 8) & 255;
  abDir[29] = options[0] & 255;

  abDir[30] = Math.floor(options[1] / 256) & 255;
  abDir[31] = options[1] % 256 & 255;
  abDir[32] = (options[1] >>> 24) & 255;
  abDir[33] = (options[1] >>> 16) & 255;

  abDir[34] = (options[2] >>> 24) & 255;
  abDir[35] = (options[2] >>> 16) & 255;
  abDir[36] = (options[2] >>> 8) & 255;
  abDir[37] = options[2] & 255;

  abDir[38] = array1[21];
  abDir[39] = array1[22];
  abDir[40] = array2[21];
  abDir[41] = array2[22];
  abDir[42] = array3[23];
  abDir[43] = array3[24];

  abDir[44] = (endEncryption >>> 24) & 255;
  abDir[45] = (endEncryption >>> 16) & 255;
  abDir[46] = (endEncryption >>> 8) & 255;
  abDir[47] = endEncryption & 255;
  abDir[48] = abDir[8];
  abDir[49] = Math.floor(endEncryption / 256 / 256 / 256 / 256);
  abDir[50] = Math.floor(endEncryption / 256 / 256 / 256 / 256 / 256);

  abDir[51] = (PAGE_ID >>> 24) & 255;
  abDir[52] = (PAGE_ID >>> 16) & 255;
  abDir[53] = (PAGE_ID >>> 8) & 255;
  abDir[54] = PAGE_ID & 255;
  abDir[55] = PAGE_ID;
  abDir[56] = AID;
  abDir[57] = AID & 255;
  abDir[58] = (AID >>> 8) & 255;
  abDir[59] = (AID >>> 16) & 255;
  abDir[60] = (AID >>> 24) & 255;

  abDir[64] = fingerprint.length;
  abDir[65] = fingerprint.length;

  const sortedValues = SORT_INDEX.map((i) => abDir[i] ?? 0);

  let abXor = ((fingerprint.length & 255) >>> 8) & 255;
  for (let index = 0; index < SORT_INDEX_2.length - 1; index++) {
    if (index === 0) abXor = abDir[SORT_INDEX_2[index]] ?? 0;
    abXor ^= abDir[SORT_INDEX_2[index + 1]] ?? 0;
  }

  sortedValues.push(...charCodes(fingerprint));
  sortedValues.push(abXor);

  const bytesStr = generateRandomBytes() + transformBytes(sortedValues);
  return abogusEncode(bytesStr, 0);
}

/**
 * 给 query 串补 a_bogus，返回可直接拼到 URL 上的完整 query。
 */
export function signQuery(params: string, userAgent: string, fingerprint?: string): string {
  const abogus = generateABogus(params, { userAgent, fingerprint, options: [0, 1, 8] });
  return `${params}&a_bogus=${encodeURIComponent(abogus)}`;
}