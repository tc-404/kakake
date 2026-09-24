#!/usr/bin/env node
/**
 * Kakake bootstrap: install backend deps, ensure Web UI + server bundle in packages/, start server.
 * packages/ 可整夹删除（web + server）；ensure-web / build-server 会自动重建。
 *
 * 同一份脚本覆盖 Windows / macOS / Linux / Termux（安卓手机）；
 * Termux 的差异集中在 ensureTermuxEnv() 与 npmInstallEnv() 两处。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 20;
const isWin = process.platform === 'win32';
/** Termux 的 Node 是安卓构建，process.platform 返回 'android' */
const isAndroid = process.platform === 'android';
const termuxPrefix = (() => {
  const env = (process.env.PREFIX || '').trim();
  if (env && env.includes('com.termux')) return env;
  const fallback = '/data/data/com.termux/files/usr';
  return fs.existsSync(fallback) ? fallback : '';
})();
const isTermux = isAndroid || Boolean(termuxPrefix) || Boolean(process.env.TERMUX_VERSION);
/** 安卓共享存储：无可执行位、不支持符号链接，npm 与 Vite 一定失败 */
const SHARED_STORAGE = ['/sdcard', '/storage/emulated', '/storage/self', '/mnt/media_rw'];
const npm = isWin ? 'npm.cmd' : 'npm';
/** KAKAKE_VERBOSE_BOOT=1：保留全部启动过程输出，且启动前不清屏 */
const VERBOSE = process.env.KAKAKE_VERBOSE_BOOT === '1';
/** 是否真的做过安装/构建；只有做过才需要在启动前清掉这些输出 */
let didBuildWork = false;

function log(msg) {
  console.log(`[Kakake] ${msg}`);
}

/** 过程信息：默认不打印，仅 KAKAKE_VERBOSE_BOOT=1 时输出 */
function note(msg) {
  if (VERBOSE) log(msg);
}

function fail(msg, code = 1) {
  console.error(`[ERROR] ${msg}`);
  process.exit(code);
}

function exists(p) {
  return fs.existsSync(path.join(ROOT, p));
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: 'inherit',
    // Windows: npm.cmd 可用 shell；node.exe 在 Program Files 下必须 shell:false，
    // 否则路径空格会被拆成 'C:\Program' 导致失败。
    shell: opts.shell ?? false,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.error) fail(`${cmd} ${args.join(' ')}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with code ${r.status}`, r.status ?? 1);
}

function ensureNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < MIN_NODE_MAJOR) {
    const how = isTermux
      ? 'Termux 里执行: pkg update && pkg install nodejs-lts'
      : 'Install from https://nodejs.org/';
    fail(`Node.js ${MIN_NODE_MAJOR}+ is required (current: ${process.versions.node}). ${how}`);
  }
}

/** 路径是否落在安卓共享存储 */
function onSharedStorage(target) {
  const p = target.replace(/\\/g, '/');
  return SHARED_STORAGE.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

/**
 * Termux 专属前置检查。手机上最常见的两类失败都在这里挡掉：
 * 1) 项目放在 /sdcard：没有可执行位、不能建符号链接，npm 与 Vite 必挂；
 * 2) 没有 TMPDIR 且 /tmp 不存在：npm 解包、esbuild 落临时文件时报 ENOENT。
 */
function ensureTermuxEnv() {
  if (!isTermux) return;

  log(`Termux 环境${termuxPrefix ? ` · PREFIX=${termuxPrefix}` : ''}`);

  if (onSharedStorage(ROOT)) {
    fail(
      `项目在安卓共享存储里: ${ROOT}\n`
      + '  共享存储没有可执行位、也不支持符号链接，npm 安装与前端构建一定失败。\n'
      + '  请先搬到 Termux 家目录再启动，例如:\n'
      + `    cp -r "${ROOT}" ~/kakake && cd ~/kakake && bash start.sh`,
    );
  }

  const tmp = (process.env.TMPDIR || '').trim();
  if (!tmp || !fs.existsSync(tmp)) {
    const wanted = termuxPrefix ? path.join(termuxPrefix, 'tmp') : path.join(ROOT, '.tmp');
    try {
      fs.mkdirSync(wanted, { recursive: true });
      process.env.TMPDIR = wanted;
      note(`TMPDIR → ${wanted}`);
    } catch (err) {
      log(`无法准备临时目录 ${wanted}: ${err.message || err}`);
    }
  }
}

/**
 * 低内存机型（多数手机）给 Node 一个明确的堆上限。
 * Vite/Rollup 构建前端时内存占用峰值不低，安卓上更容易被系统直接杀掉；
 * 显式限制堆能让 V8 提前 GC，用「构建慢一点」换「不会被杀」。
 */
function lowMemoryNodeOptions() {
  const totalMb = Math.floor(os.totalmem() / (1024 * 1024));
  if (!Number.isFinite(totalMb) || totalMb <= 0) return null;
  if (!isTermux && totalMb > 4096) return null;
  const capMb = Math.max(512, Math.min(2048, Math.floor(totalMb * 0.6)));
  const existing = (process.env.NODE_OPTIONS || '').trim();
  if (/max-old-space-size/.test(existing)) return null;
  return `${existing ? `${existing} ` : ''}--max-old-space-size=${capMb}`.trim();
}

function npmInstallEnv() {
  const env = { ...process.env };
  const cur = String(env.npm_config_registry || '').trim();
  // 宝塔等常把 registry 配成 Node 二进制镜像（nodejs-release），npm 包会 404
  if (
    !cur
    || /nodejs-release/i.test(cur)
    || /nodejs\.org/i.test(cur)
    || (/\/dist\//i.test(cur) && /node/i.test(cur))
  ) {
    env.npm_config_registry =
      process.env.KAKAKE_NPM_REGISTRY || 'https://registry.npmmirror.com';
    log(`npm registry → ${env.npm_config_registry}`);
  } else if (process.env.KAKAKE_NPM_REGISTRY) {
    env.npm_config_registry = process.env.KAKAKE_NPM_REGISTRY;
  }
  if (isTermux) {
    // 手机上 audit/fund 只会拖慢安装；并发太高容易被移动网络掐断
    env.npm_config_audit = env.npm_config_audit || 'false';
    env.npm_config_fund = env.npm_config_fund || 'false';
    env.npm_config_maxsockets = env.npm_config_maxsockets || '8';
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  }
  return env;
}

function ensureDeps() {
  if (exists('node_modules/tsx/package.json')) return;
  didBuildWork = true;
  log('Installing backend dependencies (npm install)...');
  run(npm, ['install'], { shell: isWin, env: npmInstallEnv() });
  if (!exists('node_modules/tsx/package.json')) {
    fail('tsx not found after npm install. Delete node_modules and retry.');
  }
}

/** packages/web 的“已完成状态”指纹：依赖是否装好 + dist/index.html 的构建时间 */
function webStamp() {
  const deps = exists('packages/web/node_modules/vite/package.json') ? '1' : '0';
  let dist = '0';
  try {
    dist = String(fs.statSync(path.join(ROOT, 'packages', 'web', 'dist', 'index.html')).mtimeMs);
  } catch { /* 尚未构建 */ }
  return `${deps}:${dist}`;
}

function ensureWebBuild() {
  const force = process.env.KAKAKE_FORCE_WEB_BUILD === '1';
  const args = force ? ['scripts/ensure-web.mjs', 'build', '--force'] : ['scripts/ensure-web.mjs'];
  note(force ? 'Ensuring Web UI (force)…' : 'Ensuring Web UI → packages/web …');
  const before = webStamp();
  const env = { ...npmInstallEnv() };
  const memOpts = lowMemoryNodeOptions();
  if (memOpts) {
    env.NODE_OPTIONS = memOpts;
    note(`NODE_OPTIONS → ${memOpts}（低内存机型限堆，避免构建被系统杀掉）`);
  }
  // process.execPath 可能含空格（Program Files），勿开 shell
  run(process.execPath, args, { env });
  if (webStamp() !== before) didBuildWork = true;
}

function ensureDirs() {
  for (const dir of ['data', 'log', 'plugins', 'plugins_two']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  }
}

function ensureServerBuild() {
  const force = process.env.KAKAKE_FORCE_SERVER_BUILD === '1'
    || process.env.KAKAKE_FORCE_WEB_BUILD === '1';
  const outFile = path.join(ROOT, 'packages', 'server', 'main.mjs');
  const entry = path.join(ROOT, 'src', 'main.ts');
  let need = force || !fs.existsSync(outFile);
  if (!need) {
    try {
      need = fs.statSync(entry).mtimeMs > fs.statSync(outFile).mtimeMs;
    } catch {
      need = true;
    }
  }
  if (!need) {
    // 粗略：任一 src/*.ts 新于产物则重建（排除 web）
    const stack = [path.join(ROOT, 'src')];
    const outM = fs.statSync(outFile).mtimeMs;
    while (stack.length && !need) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
      for (const ent of ents) {
        if (ent.name === 'web' && cur === path.join(ROOT, 'src')) continue;
        const p = path.join(cur, ent.name);
        if (ent.isDirectory()) stack.push(p);
        else if (/\.(ts|js|mjs|cjs|json)$/.test(ent.name)) {
          try {
            if (fs.statSync(p).mtimeMs > outM) { need = true; break; }
          } catch { /* ignore */ }
        }
      }
    }
  }
  if (!need) {
    note('Server bundle up to date → packages/server/main.mjs');
    return;
  }
  didBuildWork = true;
  log('Building server bundle → packages/server …');
  run(process.execPath, ['scripts/build-server.mjs']);
}

/**
 * 构建输出只在构建当时有意义：真的装过依赖 / 构建过产物时，
 * 启动服务前把这些内容清掉，控制台从框架自己的启动日志开始。
 * 仅在交互式终端生效；构建失败会直接退出，不会走到这里，所以不会吞掉错误信息。
 */
function clearBuildOutput() {
  if (VERBOSE || !didBuildWork) return;
  if (!process.stdout.isTTY) return;
  console.clear();
  // 顺带清掉回滚缓冲（Windows 下仅 Windows Terminal 确定支持）
  if (!isWin || process.env.WT_SESSION) process.stdout.write('\x1b[3J');
}

function startServer() {
  const outFile = path.join(ROOT, 'packages', 'server', 'main.mjs');
  if (!fs.existsSync(outFile)) {
    fail('packages/server/main.mjs missing; server build failed');
  }
  // KAKAKE_BOOTSTRAP_DRY_RUN=1：只做依赖/构建检查，不真的起服务（排查启动问题时用）
  if (process.env.KAKAKE_BOOTSTRAP_DRY_RUN === '1') {
    log(`dry-run: 检查完成（本次${didBuildWork ? '有' : '无'}安装/构建），未启动服务`);
    return;
  }
  note('Starting server (node packages/server/main.mjs)…');
  clearBuildOutput();
  const r = spawnSync(process.execPath, [outFile], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  process.exit(r.status ?? (r.error ? 1 : 0));
}

ensureNodeVersion();
ensureTermuxEnv();
ensureDeps();
ensureWebBuild();
ensureServerBuild();
ensureDirs();
startServer();
