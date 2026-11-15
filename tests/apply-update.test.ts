/**
 * apply-update.mjs 端到端测试：在临时目录构造「假旧版本 + 假更新包」，spawn 子进程跑真实流程。
 * 覆盖：无 pending 直通、正常 zip 应用（文件替换 + 保护目录不动 + 多余项清理）、
 * sha256 不符拒绝、含路径穿越条目的恶意包拒绝。
 * 手工构造原始 zip（stored 无压缩）是为了让 adm-zip 原样读出 `../evil.txt` 条目名——
 * adm-zip 的 addFile 在**写入端**就会把 `../` 规范化掉，造不出恶意样本。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY_UPDATE_SRC = path.join(PROJECT_ROOT, 'scripts', 'apply-update.mjs');

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ -1) >>> 0;
}

/** 最小原始 zip（stored）：条目名原样保留，不做任何规范化 */
function buildRawZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0x21, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(e.data.length, 18);
    lfh.writeUInt32LE(e.data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    chunks.push(lfh, nameBuf, e.data);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(0x21, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(e.data.length, 20);
    cdh.writeUInt32LE(e.data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt32LE(offset, 42);
    central.push(cdh, nameBuf);
    offset += 30 + nameBuf.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

/** 假旧版本安装：结构对齐源码版（scripts/bootstrap.mjs + package.json + 用户数据目录） */
function buildFakeInstall(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-apply-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  // 把真实脚本复制进假根，脚本内 ROOT = 其所在目录的上一级 → 指向假根
  fs.copyFileSync(APPLY_UPDATE_SRC, path.join(root, 'scripts', 'apply-update.mjs'));
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'kakake-fake', version: '0.0.1' }, null, 2),
  );
  fs.writeFileSync(path.join(root, 'scripts', 'bootstrap.mjs'), '// old bootstrap\n');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'console.log("old");\n');
  for (const d of ['data', 'log', 'plugins', 'plugins_two']) fs.mkdirSync(path.join(root, d));
  fs.writeFileSync(path.join(root, 'data', 'user.json'), '{"keep":true}\n');
  fs.writeFileSync(path.join(root, 'log', 'app.log'), 'old log\n');
  fs.writeFileSync(path.join(root, 'plugins', 'marker.txt'), 'p\n');
  fs.writeFileSync(path.join(root, 'plugins_two', 'marker.txt'), 'p2\n');
  // 新版不再包含的顶层多余项（源码版会被精确镜像清理）
  fs.mkdirSync(path.join(root, 'stale-feature'));
  fs.writeFileSync(path.join(root, 'stale-feature', 'x.js'), 'old\n');
  // 子进程 import('adm-zip') 需要依赖：junction/软链到真实项目 node_modules
  const nmType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(root, 'node_modules'), nmType);
  return root;
}

/** 组一个合法的源码版更新 zip（单一顶层目录 pkg-0.0.2/），写入假根的暂存位置 */
function buildUpdateArchive(root: string, opts?: { malicious?: boolean; badSha?: boolean }): void {
  const stagingDir = path.join(root, 'data', 'update-staging');
  fs.mkdirSync(stagingDir, { recursive: true });
  const archivePath = path.join(stagingDir, 'update.zip');
  let buf: Buffer;
  if (opts?.malicious) {
    buf = buildRawZip([
      { name: 'pkg-0.0.2/package.json', data: Buffer.from(JSON.stringify({ version: '0.0.2' })) },
      { name: '../evil.txt', data: Buffer.from('pwned') },
    ]);
  } else {
    const zip = new AdmZip();
    zip.addFile('pkg-0.0.2/package.json', Buffer.from(JSON.stringify({ name: 'kakake-fake', version: '0.0.2' }, null, 2)));
    zip.addFile('pkg-0.0.2/scripts/bootstrap.mjs', Buffer.from('// new bootstrap\n'));
    zip.addFile('pkg-0.0.2/src/main.ts', Buffer.from('console.log("new");\n'));
    zip.addFile('pkg-0.0.2/README.md', Buffer.from('new readme\n'));
    // data/ 是保护目录：负载里带了也绝不能落进用户数据
    zip.addFile('pkg-0.0.2/data/intruder.txt', Buffer.from('should not land\n'));
    buf = zip.toBuffer();
  }
  fs.writeFileSync(archivePath, buf);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  fs.writeFileSync(
    path.join(root, 'data', 'update-pending.json'),
    JSON.stringify({
      version: '0.0.2',
      tag: 'v0.0.2',
      edition: 'source',
      format: 'zip',
      archiveRel: 'data/update-staging/update.zip',
      sha256: opts?.badSha ? '0'.repeat(64) : sha256,
    }),
  );
}

function runApply(root: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'apply-update.mjs')], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function readRootPackageVersion(root: string): string {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

function cleanupFakeInstall(root: string): void {
  // rmSync 对符号链接只删链接本身，不会递归进真实 node_modules
  fs.rmSync(root, { recursive: true, force: true });
}

test('apply-update：无 pending 时无事可做，退出码 0', () => {
  const root = buildFakeInstall();
  try {
    const r = runApply(root);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.equal(readRootPackageVersion(root), '0.0.1');
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-pending.json')), false);
  } finally {
    cleanupFakeInstall(root);
  }
});

test('apply-update：正常包应用成功——文件被替换、data/log/plugins/plugins_two 未被动、多余项被清', () => {
  const root = buildFakeInstall();
  try {
    buildUpdateArchive(root);
    const r = runApply(root);
    assert.equal(r.status, 0, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);

    // 代码/产物被替换为新版
    assert.equal(readRootPackageVersion(root), '0.0.2');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8'), 'console.log("new");\n');
    assert.equal(fs.readFileSync(path.join(root, 'scripts', 'bootstrap.mjs'), 'utf8'), '// new bootstrap\n');
    assert.equal(fs.readFileSync(path.join(root, 'README.md'), 'utf8'), 'new readme\n');

    // 用户数据目录一个字节都没动，且负载里的 data/intruder.txt 没有落进来
    assert.equal(fs.readFileSync(path.join(root, 'data', 'user.json'), 'utf8'), '{"keep":true}\n');
    assert.equal(fs.readFileSync(path.join(root, 'log', 'app.log'), 'utf8'), 'old log\n');
    assert.equal(fs.readFileSync(path.join(root, 'plugins', 'marker.txt'), 'utf8'), 'p\n');
    assert.equal(fs.readFileSync(path.join(root, 'plugins_two', 'marker.txt'), 'utf8'), 'p2\n');
    assert.equal(fs.existsSync(path.join(root, 'data', 'intruder.txt')), false);

    // 源码版精确镜像：新版不再包含的顶层多余项被清
    assert.equal(fs.existsSync(path.join(root, 'stale-feature')), false);

    // 收尾：pending / 暂存 / 归档全部清掉，安装版本已记录
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-pending.json')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-staging')), false);
    const installed = JSON.parse(fs.readFileSync(path.join(root, 'data', 'installed-build.json'), 'utf8'));
    assert.equal(installed.version, '0.0.2');
    assert.equal(installed.tag, 'v0.0.2');
    // node_modules（KEEP_LOCAL）未被动
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), true);
  } finally {
    cleanupFakeInstall(root);
  }
});

test('apply-update：sha256 校验不通过 → 退出码 1，旧安装原样保留', () => {
  const root = buildFakeInstall();
  try {
    buildUpdateArchive(root, { badSha: true });
    const r = runApply(root);
    assert.equal(r.status, 1);
    assert.equal(readRootPackageVersion(root), '0.0.1');
    assert.equal(fs.readFileSync(path.join(root, 'src', 'main.ts'), 'utf8'), 'console.log("old");\n');
    // 无论成败都清 pending，杜绝启动器反复重试
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-pending.json')), false);
  } finally {
    cleanupFakeInstall(root);
  }
});

test('apply-update：路径穿越恶意包被拒 → 退出码 1，无越权落盘', () => {
  const root = buildFakeInstall();
  try {
    buildUpdateArchive(root, { malicious: true });
    const r = runApply(root);
    assert.equal(r.status, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`);
    // 旧安装原样
    assert.equal(readRootPackageVersion(root), '0.0.1');
    // 穿越条目相对解压目录会落到暂存层、甚至假根外——都不允许存在
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-staging', 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'evil.txt')), false);
    assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);
    assert.equal(fs.readdirSync(root).includes('evil.txt'), false);
    assert.equal(fs.existsSync(path.join(root, 'data', 'update-pending.json')), false);
  } finally {
    cleanupFakeInstall(root);
  }
});
