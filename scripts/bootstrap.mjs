#!/usr/bin/env node
/**
 * Kakake bootstrap: install backend deps, ensure Web UI + server bundle in packages/, start server.
 * packages/ 可整夹删除（web + server）；ensure-web / build-server 会自动重建。
 *
 * 同一份脚本覆盖 Windows / macOS / Linux / Termux（安卓手机）；
 * Termux 的差异集中在 ensureTermuxEnv() 与 npmInstallEnv() 两处。
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
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

/* ─────────── 启动加载动画（零依赖 · 纯 ANSI，与 pack-portable 同风格） ───────────
 * 默认（交互终端、非 verbose）：把每个构建阶段的子进程输出重定向到临时日志，只在终端
 * 显示一行转轮 + 阶段名 + 计时；成功打 ✔、失败打 ✗ 并回显日志尾部。verbose / 非 TTY
 * （日志重定向 / CI）则直通原始输出，便于排查。动画结束后按既有逻辑清屏，交给服务端日志。 */
const IS_TTY = !!process.stdout.isTTY;
const USE_COLOR = process.env.FORCE_COLOR ? true : (!process.env.NO_COLOR && IS_TTY);
// Windows Terminal / VSCode / 现代终端字体带 Braille；老 conhost 退回 ASCII 转轮
const FANCY_GLYPH = !isWin || !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.VSCODE_PID);
const wrapAnsi = (open, close) => (s) => (USE_COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : `${s}`);
const c = {
  bold: wrapAnsi(1, 22),
  dim: wrapAnsi(2, 22),
  red: wrapAnsi(31, 39),
  green: wrapAnsi(32, 39),
  yellow: wrapAnsi(33, 39),
  cyan: wrapAnsi(36, 39),
  gray: wrapAnsi(90, 39),
  white: wrapAnsi(97, 39),
  teal: (s) => (USE_COLOR ? `\x1b[38;5;44m${s}\x1b[39m` : `${s}`),
};
const SPIN_FRAMES = FANCY_GLYPH
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/'];
const CLEAR_LINE = '\x1b[2K';
let cursorHidden = false;
function hideCursor() { if (IS_TTY && !cursorHidden) { process.stdout.write('\x1b[?25l'); cursorHidden = true; } }
function showCursor() { if (IS_TTY && cursorHidden) { process.stdout.write('\x1b[?25h'); cursorHidden = false; } }
process.on('exit', showCursor);

function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

/** 顶部横幅（仅交互终端） */
function banner() {
  if (!IS_TTY) return;
  process.stdout.write('\n');
  process.stdout.write(`  ${c.teal('▌')} ${c.bold(c.white('咔咔珂'))}  ${c.gray('kakake · 插件平台框架')}\n`);
  process.stdout.write(`  ${c.teal('▌')} ${c.gray('正在准备运行环境…')}\n`);
  process.stdout.write(`  ${c.teal('─'.repeat(44))}\n`);
}

/**
 * 跑子进程并显示转轮。静默模式下捕获输出到临时日志（不整包驻留内存），成功即删日志避免残留；
 * 失败回显尾部日志并按子进程退出码退出。verbose / 非 TTY 直通原始输出。
 */
function runSpin(label, cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const cwd = opts.cwd ?? ROOT;
  const shell = opts.shell ?? false;

  if (VERBOSE || !IS_TTY) {
    process.stdout.write(`  ${c.cyan('▶')} ${label}\n`);
    const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell, env });
    if (r.error) fail(`${cmd} ${args.join(' ')}: ${r.error.message}`);
    if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited with code ${r.status}`, r.status ?? 1);
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const logFile = path.join(process.env.TMPDIR || os.tmpdir() || ROOT, 'kakake-boot.log');
    let fd = 'ignore';
    try { fd = fs.openSync(logFile, 'w'); } catch { fd = 'ignore'; }
    const closeFd = () => { if (typeof fd === 'number') { try { fs.closeSync(fd); } catch { /* ignore */ } } };
    const child = spawn(cmd, args, { cwd, env, shell, stdio: ['ignore', fd, fd] });
    const start = Date.now();
    let i = 0;
    hideCursor();
    const render = () => {
      const f = SPIN_FRAMES[i = (i + 1) % SPIN_FRAMES.length];
      process.stdout.write(`\r${CLEAR_LINE}  ${c.cyan(f)} ${label}  ${c.dim(fmtDur(Date.now() - start))}`);
    };
    render();
    const timer = setInterval(render, 90);
    child.on('error', (err) => {
      clearInterval(timer); closeFd(); showCursor();
      process.stdout.write(`\r${CLEAR_LINE}  ${c.red('✗')} ${label}\n`);
      fail(`${cmd} ${args.join(' ')}: ${err.message}`);
    });
    child.on('close', (code) => {
      clearInterval(timer); closeFd();
      if (code === 0) {
        process.stdout.write(`\r${CLEAR_LINE}  ${c.green('✔')} ${label}  ${c.dim(fmtDur(Date.now() - start))}\n`);
        showCursor();
        try { fs.unlinkSync(logFile); } catch { /* ignore */ }
        resolve();
      } else {
        process.stdout.write(`\r${CLEAR_LINE}  ${c.red('✗')} ${label}  ${c.red(`(exit ${code})`)}\n`);
        showCursor();
        try {
          const txt = fs.readFileSync(logFile, 'utf8');
          const tail = txt.split(/\r?\n/).filter(Boolean).slice(-24).join('\n');
          if (tail) process.stderr.write(`${c.gray(tail)}\n`);
        } catch { /* ignore */ }
        process.exit(code ?? 1);
      }
    });
  });
}

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

/* ─────────── 后端依赖自检 ───────────
 * node_modules 是上次安装的快照，在线更新只换源码/package.json、保留 node_modules，
 * 新版新增依赖不会自动装上（0.6.3 的 sharp 曾导致启动 ERR_MODULE_NOT_FOUND）。
 * dependencies 缺失 → 启动时补装；optionalDependencies（sharp）→ 只提示，用户手动装。
 */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** package.json 里声明的依赖名（必需 / 可选） */
function declaredDeps() {
  const pkg = readJson(path.join(ROOT, 'package.json')) || {};
  return {
    required: Object.keys(pkg.dependencies || {}),
    optional: Object.keys(pkg.optionalDependencies || {}),
  };
}

/** 这个包现在能否从项目根解析出来 */
function resolvableFromRoot(name) {
  try {
    createRequire(path.join(ROOT, 'package.json')).resolve(name);
    return true;
  } catch {
    // 有些包的 exports 只给 import 条件，require.resolve 会失败，但包其实装好了
    return fs.existsSync(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'));
  }
}

function missingDeps() {
  const declared = declaredDeps();
  return {
    declared,
    required: declared.required.filter((n) => !resolvableFromRoot(n)),
    optional: declared.optional.filter((n) => !resolvableFromRoot(n)),
  };
}

async function ensureDeps() {
  const missing = missingDeps();

  if (missing.required.length === 0) {
    if (missing.optional.length > 0) {
      log(`可选依赖未安装: ${missing.optional.join(', ')}`
        + ' —— 图片混淆的服务端处理会不可用，可在控制台「设置 → 图片引擎环境」一键安装（不影响启动）');
    } else {
      note('backend dependencies ok');
    }
    return;
  }

  didBuildWork = true;
  const firstInstall = !exists('node_modules/tsx/package.json');
  await runSpin(
    firstInstall ? '安装后端依赖 (首次较慢)' : '补齐后端依赖',
    npm,
    ['install'],
    { shell: isWin, env: npmInstallEnv() },
  );

  const after = missingDeps();
  if (after.required.length > 0) {
    fail(
      `后端依赖仍然缺失: ${after.required.join(', ')}\n`
      + '  请在项目目录手动执行 npm install 后重试；若仍失败，删除 node_modules 再启动。',
    );
  }
  if (after.optional.length > 0) {
    log(`可选依赖未安装: ${after.optional.join(', ')}（可在控制台「设置 → 图片引擎环境」安装）`);
  } else {
    note(`依赖已补齐: ${[...missing.required, ...missing.optional].join(', ') || '无'}`);
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

async function ensureWebBuild() {
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
  await runSpin('构建 Web 控制台', process.execPath, args, { env });
  if (webStamp() !== before) didBuildWork = true;
}

function ensureDirs() {
  for (const dir of ['data', 'log', 'plugins', 'plugins_two']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) fs.mkdirSync(abs, { recursive: true });
  }
}

async function ensureServerBuild() {
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
  await runSpin('打包服务端 Bundle', process.execPath, ['scripts/build-server.mjs']);
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

/**
 * 解析服务端进程的 NODE_OPTIONS，跨平台统一堆上限（Windows / macOS / Linux / Termux 一致）：
 * - 用户已显式设置 NODE_OPTIONS（含 max-old-space-size）或 KAKAKE_MAX_OLD_SPACE_SIZE 时尊重之；
 * - Termux / 总内存 < 4GB 默认 1024MB，其余默认 2048MB；
 * - 不覆盖用户已有的其它 NODE_OPTIONS 选项。
 */
function resolveServerNodeOptions() {
  const existing = process.env.NODE_OPTIONS || '';
  if (/max-old-space-size/.test(existing)) return existing;
  const forced = Number(process.env.KAKAKE_MAX_OLD_SPACE_SIZE);
  let mb;
  if (Number.isFinite(forced) && forced > 0) {
    mb = Math.floor(forced);
  } else {
    const totalGB = os.totalmem() / (1024 ** 3);
    mb = (isTermux || totalGB < 4) ? 1024 : 2048;
  }
  return existing ? `${existing} --max-old-space-size=${mb}` : `--max-old-space-size=${mb}`;
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
    // 跨平台统一堆上限：子进程（真正的服务端）继承此 NODE_OPTIONS
    env: { ...process.env, NODE_OPTIONS: resolveServerNodeOptions() },
  });
  process.exit(r.status ?? (r.error ? 1 : 0));
}

ensureNodeVersion();
ensureTermuxEnv();
banner();
await ensureDeps();
await ensureWebBuild();
await ensureServerBuild();
ensureDirs();
startServer();
