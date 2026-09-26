import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';

/**
 * 统一解压入口：把各类常见压缩包解到目标目录。
 * 支持 zip / tar / tar.gz(tgz) / gz / rar / 7z / xz / bz2。
 * zip 走 adm-zip；tar 系走 tar；rar 走 node-unrar-js（wasm）；
 * 7z / xz / bzip2 走 7z-wasm（内置 7-Zip，能吃绝大多数格式，也兜底 rar/zip）。
 */

const require = createRequire(import.meta.url);

export type ArchiveType = 'zip' | 'tar' | 'targz' | 'gz' | 'rar' | '7z' | 'xz' | 'bz2' | 'unknown';

/** 读文件头几个字节，用魔数判类型；辅以扩展名兜底 */
export function detectArchiveType(filePath: string): ArchiveType {
  let head = Buffer.alloc(0);
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(512);
      const n = fs.readSync(fd, buf, 0, 512, 0);
      head = buf.subarray(0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* 读不到就只靠扩展名 */ }

  const startsWith = (sig: number[], off = 0) =>
    head.length >= off + sig.length && sig.every((b, i) => head[off + i] === b);

  // ZIP: PK\x03\x04 / PK\x05\x06(空) / PK\x07\x08
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06]) || startsWith([0x50, 0x4b, 0x07, 0x08])) {
    return 'zip';
  }
  // RAR: "Rar!\x1a\x07"
  if (startsWith([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return 'rar';
  // 7z: "7z\xbc\xaf\x27\x1c"
  if (startsWith([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  // XZ: \xfd 7zXZ\x00
  if (startsWith([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'xz';
  // BZ2: "BZh"
  if (startsWith([0x42, 0x5a, 0x68])) return 'bz2';
  // GZIP: \x1f\x8b —— 可能是 .tar.gz 也可能是单纯 .gz
  if (startsWith([0x1f, 0x8b])) {
    return /\.tar\.gz$|\.tgz$/i.test(filePath) ? 'targz' : 'gz';
  }
  // TAR: 偏移 257 处 "ustar"
  if (head.length >= 262 && head.subarray(257, 262).toString('latin1') === 'ustar') {
    return 'tar';
  }

  // 魔数没命中，退回扩展名判断
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'targz';
  if (lower.endsWith('.tar')) return 'tar';
  if (lower.endsWith('.gz')) return 'gz';
  if (lower.endsWith('.rar')) return 'rar';
  if (lower.endsWith('.7z')) return '7z';
  if (lower.endsWith('.xz')) return 'xz';
  if (lower.endsWith('.bz2')) return 'bz2';
  return 'unknown';
}

/** 人类可读的支持列表，用于错误提示 */
export const SUPPORTED_ARCHIVE_LABEL = 'zip、tar、tar.gz/tgz、rar、7z、xz、bz2';

/** 把压缩包解到 destDir（destDir 必须已存在或可创建）。失败抛错。 */
export async function extractArchive(filePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true });
  const type = detectArchiveType(filePath);

  switch (type) {
    case 'zip':
      new AdmZip(filePath).extractAllTo(destDir, true);
      return;

    case 'tar':
    case 'targz': {
      const tar = await import('tar');
      // tar 会自动识别 gzip，无需显式解压
      await tar.x({ file: filePath, cwd: destDir });
      return;
    }

    case 'gz': {
      // 单文件 gzip：解成去掉 .gz 后缀的同名文件
      const zlib = await import('node:zlib');
      const { pipeline } = await import('node:stream/promises');
      const base = path.basename(filePath).replace(/\.gz$/i, '') || 'extracted.bin';
      const out = path.join(destDir, base);
      await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), fs.createWriteStream(out));
      return;
    }

    case 'rar':
      await extractRar(filePath, destDir);
      return;

    case '7z':
    case 'xz':
    case 'bz2':
      await extractWith7z(filePath, destDir);
      return;

    default:
      throw new Error(`无法识别的压缩包格式，仅支持 ${SUPPORTED_ARCHIVE_LABEL}`);
  }
}

/** RAR：node-unrar-js（wasm），把文件写盘 */
async function extractRar(filePath: string, destDir: string): Promise<void> {
  const mod = await import('node-unrar-js');
  const wasmBinary = fs.readFileSync(
    require.resolve('node-unrar-js/dist/js/unrar.wasm'),
  );
  const extractor = await mod.createExtractorFromData({
    data: toArrayBuffer(fs.readFileSync(filePath)),
    wasmBinary: toArrayBuffer(wasmBinary),
  });
  const extracted = extractor.extract();
  // 迭代 files 生成器才会真正解压
  for (const file of extracted.files) {
    const header = file.fileHeader;
    const rel = safeJoin(destDir, header.name);
    if (header.flags.directory) {
      fs.mkdirSync(rel, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    if (file.extraction) fs.writeFileSync(rel, Buffer.from(file.extraction));
  }
}

/** 7z / xz / bz2：7z-wasm，NODEFS 挂载真实目录后调用内置 7-Zip 解压 */
async function extractWith7z(filePath: string, destDir: string): Promise<void> {
  const factoryMod = await import('7z-wasm');
  const factory = (factoryMod as unknown as { default: (opts?: unknown) => Promise<SevenZip> }).default;
  const wasmBinary = fs.readFileSync(require.resolve('7z-wasm/7zz.wasm'));

  const sevenZip = await factory({
    wasmBinary,
    print: () => {},
    printErr: () => {},
  });

  const srcDir = path.dirname(path.resolve(filePath));
  const srcName = path.basename(filePath);
  const outAbs = path.resolve(destDir);

  // 把宿主目录挂进 wasm 文件系统
  sevenZip.FS.mkdir('/src');
  sevenZip.FS.mount(sevenZip.NODEFS, { root: srcDir }, '/src');
  sevenZip.FS.mkdir('/out');
  sevenZip.FS.mount(sevenZip.NODEFS, { root: outAbs }, '/out');

  try {
    // x=保留目录结构，-y=全部确认，-o=输出目录
    sevenZip.callMain(['x', `/src/${srcName}`, `-o/out`, '-y']);
  } catch (e) {
    // emscripten 正常退出也会以异常形式抛 ExitStatus；靠产物是否存在来判定
    const status = (e as { status?: number })?.status;
    if (status && status !== 0) throw new Error(`7z 解压失败（code ${status}）`);
  } finally {
    try { sevenZip.FS.unmount('/src'); } catch { /* ignore */ }
    try { sevenZip.FS.unmount('/out'); } catch { /* ignore */ }
  }

  // 校验确实解出了东西
  if (fs.readdirSync(outAbs).length === 0) {
    throw new Error('7z 解压未产生任何文件');
  }
}

interface SevenZip {
  FS: {
    mkdir(p: string): void;
    mount(type: unknown, opts: { root: string }, mountpoint: string): void;
    unmount(mountpoint: string): void;
  };
  NODEFS: unknown;
  callMain(args: string[]): void;
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 防目录穿越：拼接后必须仍在 base 内 */
function safeJoin(base: string, name: string): string {
  const target = path.resolve(base, name.replace(/^([/\\])+/, ''));
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    throw new Error(`压缩包内非法路径：${name}`);
  }
  return target;
}
