#!/usr/bin/env node
/**
 * 将后端源码打包为可直接 node 运行的 ESM。
 * 产物落在可整删的 packages/server/（与 packages/web 同级）。
 *
 * 注意：esbuild 的 bin 在 Linux/macOS 上常是原生 ELF，不可用 `node bin/esbuild` 调用。
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'packages', 'server');
const OUT_FILE = path.join(OUT_DIR, 'main.mjs');
const ENTRY = path.join(ROOT, 'src', 'main.ts');
const isWin = process.platform === 'win32';
/** Termux（安卓）：Node 为安卓构建，platform 是 'android' */
const isTermux = process.platform === 'android'
  || Boolean(process.env.TERMUX_VERSION)
  || String(process.env.PREFIX || '').includes('com.termux');

function log(msg) {
  console.log(`[build-server] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[build-server] ${msg}`);
  process.exit(code);
}

/** 文件头是否像原生可执行文件（ELF / PE） */
function isNativeBinary(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    // ELF
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) return true;
    // PE (MZ)
    if (buf[0] === 0x4d && buf[1] === 0x5a) return true;
    // Mach-O (fat / 64)
    if (buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) return true;
    if (buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe) return true;
    return false;
  } catch {
    return false;
  }
}

function resolveEsbuildCli() {
  const candidates = [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(ROOT, 'packages', 'web', 'node_modules', 'esbuild', 'bin', 'esbuild'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 优先用 JS API（不依赖 bin 是脚本还是原生） */
function loadEsbuildApi() {
  const bases = [ROOT, path.join(ROOT, 'packages', 'web')];
  for (const base of bases) {
    const pkg = path.join(base, 'package.json');
    if (!fs.existsSync(pkg) && base !== ROOT) continue;
    try {
      const require = createRequire(path.join(base, 'package.json'));
      return require('esbuild');
    } catch {
      /* try next */
    }
  }
  // 无 package.json 时仍尝试从 ROOT 解析
  try {
    const require = createRequire(path.join(ROOT, 'scripts', 'build-server.mjs'));
    return require('esbuild');
  } catch {
    return null;
  }
}

function runCli(esbuildCli, args) {
  // 原生二进制：直接执行；JS 包装脚本：用 node 跑
  if (isNativeBinary(esbuildCli)) {
    try {
      fs.chmodSync(esbuildCli, 0o755);
    } catch { /* ignore */ }
    const r = spawnSync(esbuildCli, args, {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false,
    });
    if (r.error) fail(`${esbuildCli}: ${r.error.message}`);
    if (r.status !== 0) process.exit(r.status ?? 1);
    return;
  }
  const r = spawnSync(process.execPath, [esbuildCli, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (r.error) fail(`node ${esbuildCli}: ${r.error.message}`);
  if (r.status !== 0) process.exit(r.status ?? 1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
log(`esbuild → ${path.relative(ROOT, OUT_FILE)}`);

const buildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  outfile: OUT_FILE,
};

const api = loadEsbuildApi();
if (api && typeof api.buildSync === 'function') {
  try {
    api.buildSync(buildOptions);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Termux 上最常见的原因是 @esbuild/android-arm64 这个可选依赖没装上
    const hint = isTermux
      ? '\n  Termux 提示：如果报的是找不到 esbuild 二进制，执行 rm -rf node_modules && npm install 重装'
      : '';
    fail(`${msg}${hint}`);
  }
} else {
  const esbuildCli = resolveEsbuildCli();
  const commonArgs = [
    ENTRY,
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--packages=external',
    `--outfile=${OUT_FILE}`,
  ];
  if (esbuildCli) {
    runCli(esbuildCli, commonArgs);
  } else {
    const npm = isWin ? 'npm.cmd' : 'npm';
    const r = spawnSync(npm, ['exec', '--yes', '--', 'esbuild', ...commonArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWin,
    });
    if (r.error) fail(`npm exec esbuild: ${r.error.message}`);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
}

if (!fs.existsSync(OUT_FILE)) {
  fail('output missing');
}
log('ok');
