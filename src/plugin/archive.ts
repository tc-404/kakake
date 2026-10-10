import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import AdmZip from 'adm-zip';

/**
 * 统一解压入口：把各类常见压缩包解到目标目录。
 * 支持 zip / tar / tar.gz(tgz) / gz / rar / 7z / xz / bz2。
 * zip 走 adm-zip 的**只读解析** + 自有逐条目安全解压（extractZipSafe，拒绝路径穿越与符号链接）；
 * tar 系走 tar；rar 走 node-unrar-js（wasm）；
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
      extractZipSafe(filePath, destDir);
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

/** 条目数上限：防「海量小文件」拖慢解压并制造海量 inode */
const MAX_ZIP_ENTRIES = 20000;
/** 单条目解压上限 */
const MAX_ZIP_ENTRY_BYTES = 512 * 1024 * 1024;
/** 整包解压总量上限 */
const MAX_ZIP_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * zip 解压：自己逐条目写盘，不用 adm-zip 的 extractAllTo。
 *
 * 原因：adm-zip 的 extractAllTo 在解压时会**跟随目标位置的符号链接**写文件
 *（= 任意文件覆盖，GHSA-vwc7-r8mq-g2x9），且条目重名、声明未压缩大小为 0
 * 等场景曾有防护绕过。自己遍历可以做精确拒绝：绝对路径、`..` 段、符号链接
 * 与设备/FIFO 等非普通文件条目，并对条目数、单条目体积、总解压体积设上限。
 */
function extractZipSafe(filePath: string, destDir: string): void {
  const zip = new AdmZip(filePath);
  const entries = zip.getEntries();
  if (entries.length > MAX_ZIP_ENTRIES) {
    throw new Error(`压缩包条目过多（${entries.length} 个），已拒绝解压`);
  }

  let total = 0;
  for (const entry of entries) {
    // ZIP 规范要求条目名以 `/` 分隔；部分 Windows 打包工具（如 .NET Compress-Archive）
    // 会写出 `\` 分隔的条目名。`/` 之外的 `\` 必须归一化：Linux/Mac 上 `\` 只是
    // 普通文件名字符，不归一会导致整包解成「名字带反斜杠的怪文件」而找不到插件根
    //（Windows 因 path.resolve 认 `\` 而侥幸正常）。
    const rawName = String(entry.entryName ?? '').replace(/\\/g, '/');
    if (!rawName || rawName === '.' || rawName.includes('\0')) {
      throw new Error('压缩包内存在非法条目名，已拒绝解压');
    }
    // 绝对路径条目：显式拒绝（不靠「剥掉前导斜杠」悄悄塞进解压目录）
    if (/^[/\\]/.test(rawName) || /^[a-zA-Z]:[/\\]/.test(rawName)) {
      throw new Error(`压缩包内含绝对路径条目，已拒绝解压：${rawName}`);
    }

    // 非「普通文件 / 目录」一律拒绝：符号链接是逃逸解压目录的主要通道
    const mode = (Number(entry.attr) >>> 16) & 0xffff;
    const kind = mode & 0xf000;
    const isDirEntry = entry.isDirectory || rawName.endsWith('/') || kind === 0x4000;
    const isRegular = kind === 0x8000 || kind === 0;
    if (!isDirEntry && !isRegular) {
      throw new Error(`压缩包内含符号链接或特殊文件条目，已拒绝解压：${rawName}`);
    }

    const target = safeJoin(destDir, rawName);

    if (isDirEntry) {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }

    const data = entry.getData();
    total += data.length;
    if (data.length > MAX_ZIP_ENTRY_BYTES || total > MAX_ZIP_TOTAL_BYTES) {
      throw new Error('压缩包解压体积超限，已中止解压');
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  }
}

/** 防目录穿越：拼接后必须仍在 base 内 */
function safeJoin(base: string, name: string): string {
  const cleaned = name.replace(/^([/\\])+/, '');
  const target = path.resolve(base, cleaned);
  const baseResolved = path.resolve(base);
  if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) {
    throw new Error(`压缩包内非法路径：${name}`);
  }
  return target;
}
