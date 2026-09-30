#!/usr/bin/env node
/**
 * 确保 packages/web 下有依赖与 Vite 构建产物。
 * packages/ 整夹可删（含 web + server）；本脚本会按 src/web/package.json 重新生成 web。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = path.join(ROOT, 'src', 'web');
const WEB_PKG = path.join(ROOT, 'packages', 'web');
const WEB_MODULES = path.join(WEB_PKG, 'node_modules');
const WEB_DIST = path.join(WEB_PKG, 'dist');
const DIST_INDEX = path.join(WEB_DIST, 'index.html');
const isWin = process.platform === 'win32';
/** Termux（安卓）：Node 为安卓构建，platform 是 'android' */
const isTermux = process.platform === 'android'
  || Boolean(process.env.TERMUX_VERSION)
  || String(process.env.PREFIX || '').includes('com.termux');
const force = process.env.KAKAKE_FORCE_WEB_BUILD === '1'
  || process.argv.includes('--force')
  || process.argv.includes('force');
/** KAKAKE_VERBOSE_BOOT=1：连“没事可做”的过程信息也打印 */
const VERBOSE = process.env.KAKAKE_VERBOSE_BOOT === '1';

function log(msg) {
  console.log(`[ensure-web] ${msg}`);
}

/** 无事可做时的过程信息：默认静默 */
function note(msg) {
  if (VERBOSE) log(msg);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: 'inherit',
    shell: opts.shell ?? false,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function newestMtime(dir) {
  let newest = 0;
  if (!fs.existsSync(dir)) return 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.next' || ent.name === 'scripts') continue;
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else {
        try {
          newest = Math.max(newest, fs.statSync(p).mtimeMs);
        } catch { /* ignore */ }
      }
    }
  }
  return newest;
}

function ensurePkgDir() {
  fs.mkdirSync(WEB_PKG, { recursive: true });
  const srcPkg = path.join(WEB_SRC, 'package.json');
  if (!fs.existsSync(srcPkg)) {
    console.error('[ensure-web] 缺少 src/web/package.json');
    process.exit(1);
  }
  fs.copyFileSync(srcPkg, path.join(WEB_PKG, 'package.json'));
}

function linkModulesIntoSrc() {
  const link = path.join(WEB_SRC, 'node_modules');
  const target = WEB_MODULES;
  try {
    const st = fs.lstatSync(link);
    if (st.isSymbolicLink() || st.isDirectory()) {
      let same = false;
      try {
        same = path.resolve(fs.realpathSync(link)) === path.resolve(target);
      } catch { /* recreate */ }
      if (same) return;
      fs.rmSync(link, { recursive: true, force: true });
    }
  } catch {
    // missing
  }
  fs.mkdirSync(path.dirname(link), { recursive: true });
  try {
    fs.symlinkSync(target, link, isWin ? 'junction' : 'dir');
    note('linked src/web/node_modules → packages/web/node_modules');
    return;
  } catch (err) {
    log(`创建 src/web/node_modules 链接失败: ${err.message || err}`);
  }

  // 安卓共享存储（/sdcard 等）不支持符号链接；退一步整目录复制，能跑就行
  log('改用复制方式准备 src/web/node_modules（较慢，仅在不支持符号链接的文件系统上发生）');
  try {
    fs.cpSync(target, link, { recursive: true, dereference: true, force: true });
    log('copied src/web/node_modules ← packages/web/node_modules');
  } catch (err) {
    console.error('[ensure-web] 无法准备 src/web/node_modules:', err.message || err);
    if (isTermux) {
      console.error('[ensure-web] Termux 提示：把项目从 /sdcard 移到 Termux 家目录（~/kakake）再重试');
    }
    process.exit(1);
  }
}

/** 低内存机型（手机为主）给 Vite 一个明确的堆上限，避免构建中途被系统杀掉 */
function viteNodeOptions() {
  const existing = (process.env.NODE_OPTIONS || '').trim();
  if (/max-old-space-size/.test(existing)) return existing;
  const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
  if (!Number.isFinite(totalMb) || totalMb <= 0) return existing;
  if (!isTermux && totalMb > 4096) return existing;
  const capMb = Math.max(512, Math.min(2048, Math.floor(totalMb * 0.6)));
  return `${existing ? `${existing} ` : ''}--max-old-space-size=${capMb}`.trim();
}

function ensureDeps() {
  const marker = path.join(WEB_MODULES, 'vite', 'package.json');
  if (fs.existsSync(marker)) {
    note('dependencies ok');
  } else {
    log('installing dependencies → packages/web/node_modules');
    const env = {};
    if (isTermux) {
      // 手机上关掉 audit/fund 并降并发，移动网络下更容易一次装完
      env.npm_config_audit = 'false';
      env.npm_config_fund = 'false';
      env.npm_config_maxsockets = '8';
    }
    run(isWin ? 'npm.cmd' : 'npm', ['install', '--registry', 'https://registry.npmmirror.com'], {
      cwd: WEB_PKG,
      shell: isWin,
      env,
    });
  }
  linkModulesIntoSrc();
}

function needsBuild() {
  if (force) return true;
  if (!fs.existsSync(DIST_INDEX)) return true;
  let buildAt = 0;
  try {
    buildAt = fs.statSync(DIST_INDEX).mtimeMs;
  } catch {
    return true;
  }
  return newestMtime(WEB_SRC) > buildAt + 500;
}

function runVite(args) {
  const viteBin = path.join(WEB_MODULES, 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBin)) {
    console.error('[ensure-web] vite 未安装，请检查 packages/web');
    process.exit(1);
  }
  const env = {
    ...process.env,
    NODE_PATH: [WEB_MODULES, process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
  };
  const nodeOptions = viteNodeOptions();
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  run(process.execPath, [viteBin, ...args], {
    cwd: WEB_SRC,
    env,
  });
}

function ensureBuild() {
  if (!needsBuild()) {
    note('build up to date (packages/web/dist)');
    return;
  }
  if (force) log('force rebuild…');
  else log('building → packages/web/dist');
  if (fs.existsSync(WEB_DIST)) {
    fs.rmSync(WEB_DIST, { recursive: true, force: true });
  }
  runVite(['build']);
  if (!fs.existsSync(DIST_INDEX)) {
    console.error('[ensure-web] build finished but dist/index.html missing');
    process.exit(1);
  }
  log('build ok → packages/web/dist');
}

const mode = process.argv[2] || 'ensure';
ensurePkgDir();
ensureDeps();

if (mode === 'dev') {
  runVite(['--port', '5173']);
} else if (mode === 'build' || mode === 'ensure' || mode === '--force' || mode === 'force') {
  ensureBuild();
} else if (mode === 'start') {
  ensureBuild();
  log('SPA is served by kakake main process; use pnpm start / start.bat');
} else {
  ensureBuild();
}
