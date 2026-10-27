#!/usr/bin/env node
/**
 * 确保 packages/web 下有依赖与 Vite 构建产物。
 * packages/ 整夹可删（含 web + server）；本脚本会按 src/web/package.json 重新生成 web。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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
  if (r.status !== 0) {
    if (typeof opts.onFail === 'function') opts.onFail(r.status ?? 1);
    process.exit(r.status ?? 1);
  }
}

/*
 * esbuild 临时目录兜底（Windows 上最容易踩到）。
 *
 * esbuild 的 JS 端要把内容交给 Go 二进制时，会先在 os.tmpdir() 下写一个临时文件
 * （名字形如 esbuild-<64 位随机>），Go 端处理完负责 os.Remove 掉。Windows 上
 * os.tmpdir() 就是 %TEMP%（C:\Users\<你>\AppData\Local\Temp），一旦这个目录被
 * 「受控文件夹访问」、杀软实时扫描或同步盘占用，Go 端删除就会拿到 ERROR_ACCESS_DENIED，
 * 错误原文是：
 *   remove C:\Users\<你>\AppData\Local\Temp\esbuild-xxxx: Access is denied
 * vite 构建随即 exit 1 —— 控制台起不来，但项目代码其实一个错都没有。
 *
 * 这是系统临时目录的策略问题，改不动 esbuild；能让它的临时文件换个地方落盘即可：
 * Node 的 os.tmpdir() 在 Windows 上走 GetTempPath，读的就是 TMP/TEMP/TMPDIR，
 * spawn vite 前把这三个变量指到项目内的目录就能绕开。默认位置 packages/web/.build-tmp，
 * 也可以用 KAKAKE_BUILD_TMP=<目录> 指定（比如放到另一个盘的目录）。
 */
function buildTempDirPath() {
  const custom = (process.env.KAKAKE_BUILD_TMP || '').trim();
  const dir = custom ? path.resolve(custom) : path.join(WEB_PKG, '.build-tmp');
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    // 目录建不出来就退回系统默认，让构建照原样跑（失败信息也照原样，便于排查）
    return null;
  }
}

/**
 * 构建结束后只扫 esbuild 自己的残留（esbuild-*）；
 * 同一个目录里还会有 Node 的编译缓存（node-compile-cache）之类的东西，
 * 留着能让下次构建更快，不要一起清掉。删不掉就算了，不影响下次构建。
 */
function sweepBuildTemp(dir) {
  if (!dir) return;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith('esbuild-')) continue;
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true, maxRetries: 1 });
      } catch { /* 被占用等，忽略 */ }
    }
  } catch { /* 目录已被删等，忽略 */ }
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

/**
 * packages/web 的依赖是否真的装齐了。
 *
 * 与 scripts/bootstrap.mjs 的后端依赖自检同一个原因：在线更新只替换源码与 package.json
 * （apply-update.mjs 保留 node_modules），新版新增的前端依赖不会自动装上；旧逻辑只看
 * vite 在不在，于是构建时报 “Failed to resolve import …”——启动同样失败。
 * 这里按 packages/web/package.json 逐个确认能否解析（dependencies + devDependencies，
 * vite/tailwind/typescript 都在 devDependencies 里，构建少一个都不行）。
 */
function declaredWebDeps() {
  let pkg = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(WEB_PKG, 'package.json'), 'utf8'));
  } catch { /* 读不到就当作没有依赖声明，交给下面的 vite 检查 */ }
  return [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})];
}

function resolvableFromWeb(name) {
  try {
    createRequire(path.join(WEB_PKG, 'package.json')).resolve(name);
    return true;
  } catch {
    // 有些包的 exports 只给 import 条件，require.resolve 会失败，但包其实装好了
    return fs.existsSync(path.join(WEB_MODULES, ...name.split('/'), 'package.json'));
  }
}

function missingWebDeps() {
  return declaredWebDeps().filter((n) => !resolvableFromWeb(n));
}

function ensureDeps() {
  const marker = path.join(WEB_MODULES, 'vite', 'package.json');
  const missing = missingWebDeps();

  if (fs.existsSync(marker) && missing.length === 0) {
    note('dependencies ok');
  } else {
    log(missing.length
      ? `补齐 Web 依赖 → packages/web/node_modules（缺 ${missing.join(', ')}）`
      : 'installing dependencies → packages/web/node_modules');
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
    const still = missingWebDeps();
    if (!fs.existsSync(marker) || still.length > 0) {
      console.error(`[ensure-web] Web 依赖仍然缺失: ${still.join(', ') || 'vite'}`);
      console.error(`[ensure-web] 请在 ${WEB_PKG} 下手动执行 npm install 后重试（删掉该目录的 node_modules 可强制重装）`);
      process.exit(1);
    }
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
  // esbuild 的临时文件改落在项目内，绕开可能禁删的 %TEMP%（见 buildTempDirPath 的说明）
  const buildTmp = buildTempDirPath();
  if (buildTmp) {
    env.TMP = buildTmp;
    env.TEMP = buildTmp;
    env.TMPDIR = buildTmp;
    note(`临时目录 → ${buildTmp}`);
  }
  const nodeOptions = viteNodeOptions();
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  run(process.execPath, [viteBin, ...args], {
    cwd: WEB_SRC,
    env,
    onFail: () => {
      console.error('[ensure-web] 构建失败。若上面出现 "esbuild-…: Access is denied"，'
        + '说明系统临时目录不让 esbuild 删自己的临时文件；本项目已把临时目录改到 '
        + `${buildTmp || '（创建失败，仍在使用系统临时目录）'}，`
        + '仍失败可用 KAKAKE_BUILD_TMP=<别的目录> 指定，或手动清理 %TEMP% 下的 esbuild-* 文件。');
    },
  });
  sweepBuildTemp(buildTmp);
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
