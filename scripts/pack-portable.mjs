#!/usr/bin/env node
/**
 * 便携版双平台打包：产出 dist/kakake-win-x64 与 dist/kakake-linux-x64（目录），
 * 并各自压成同名 zip（dist/kakake-win-x64.zip / dist/kakake-linux-x64.zip），可直接分发。
 * 仅开发机发版用；最终用户无需安装系统 Node。
 *
 * 用法: node scripts/pack-portable.mjs
 * 环境变量:
 *   KAKAKE_PORTABLE_NODE=v20.20.2  指定内置 Node 版本（需带 v 前缀）
 *   KAKAKE_NODE_MIRROR=https://npmmirror.com/mirrors/node  优先镜像（默认会回退国内镜像）
 *   KAKAKE_PACK_VERBOSE=1  直通子进程原始输出（不用转轮，便于排查构建/安装报错）
 *   KAKAKE_PACK_PLAIN=1 / NO_COLOR=1  关闭颜色与动画（纯文本，适合日志重定向 / CI）
 */
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache', 'node-dist');
const isWin = process.platform === 'win32';

/** 用 node 直接跑 npm-cli，避免 Windows 上 shell:true 触发 DEP0190 */
function resolveNpmCli() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/** 与 engines.node >=20 对齐的 LTS；可用环境变量覆盖 */
const NODE_VER = String(process.env.KAKAKE_PORTABLE_NODE || 'v20.20.2').trim();

const WIN_NAME = `node-${NODE_VER}-win-x64`;
const LINUX_NAME = `node-${NODE_VER}-linux-x64`;
const WIN_ZIP = `${WIN_NAME}.zip`;
const LINUX_TGZ = `${LINUX_NAME}.tar.gz`;

/* ───────────────────────── 终端 UI（零依赖，纯 ANSI） ───────────────────────── */

const PLAIN = process.env.KAKAKE_PACK_PLAIN === '1';
const VERBOSE = process.env.KAKAKE_PACK_VERBOSE === '1';
const IS_TTY = !!process.stdout.isTTY && !PLAIN;
const USE_COLOR = process.env.FORCE_COLOR
  ? true
  : (!process.env.NO_COLOR && !PLAIN && IS_TTY);
// Windows Terminal / VSCode / 现代终端字体带 Braille；老 conhost 退回 ASCII 转轮
const FANCY_GLYPH = !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.VSCODE_PID);

const wrap = (open, close) => (s) => (USE_COLOR ? `\x1b[${open}m${s}\x1b[${close}m` : `${s}`);
const c = {
  reset: (s) => s,
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  teal: (s) => (USE_COLOR ? `\x1b[38;5;44m${s}\x1b[39m` : `${s}`),
};

/** 显示宽度：CJK/全角算 2 列，用于横线与对齐 */
function dispWidth(str) {
  // eslint-disable-next-line no-control-regex
  const clean = str.replace(/\x1b\[[0-9;]*m/g, '');
  let w = 0;
  for (const ch of clean) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115f
      || (cp >= 0x2e80 && cp <= 0xa4cf)
      || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff)
      || (cp >= 0xfe30 && cp <= 0xfe4f)
      || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0xffe0 && cp <= 0xffe6)
    )) ? 2 : 1;
  }
  return w;
}

const CURSOR_HIDE = '\x1b[?25l';
const CURSOR_SHOW = '\x1b[?25h';
const CLEAR_LINE = '\x1b[2K';
let cursorHidden = false;
function hideCursor() { if (IS_TTY && !cursorHidden) { process.stdout.write(CURSOR_HIDE); cursorHidden = true; } }
function showCursor() { if (IS_TTY && cursorHidden) { process.stdout.write(CURSOR_SHOW); cursorHidden = false; } }
process.on('exit', showCursor);

const T0 = Date.now();
function fmtDur(ms) {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

/** 顶部横幅 */
function banner() {
  const width = 52;
  const rule = c.teal('─'.repeat(width));
  console.log('');
  console.log(rule);
  console.log(`  ${c.bold(c.teal('咔咔珂'))} ${c.bold('· 便携版双平台打包')}   ${c.dim('Kakake Portable Packer')}`);
  console.log(`  ${c.dim(`内置 Node ${NODE_VER}   ·   Windows x64  +  Linux x64`)}`);
  console.log(rule);
}

let phaseNo = 0;
const PHASE_TOTAL = 6;
/** 阶段标题 */
function phase(title) {
  phaseNo += 1;
  console.log('');
  console.log(`${c.bold(c.cyan(`[${phaseNo}/${PHASE_TOTAL}]`))} ${c.bold(title)}`);
}

/** 次级信息行（缩进 · 灰） */
function log(msg) {
  console.log(`   ${c.gray('·')} ${c.gray(String(msg))}`);
}
function okLine(msg, extra) {
  console.log(`   ${c.green('✓')} ${msg}${extra ? `  ${c.dim(extra)}` : ''}`);
}
function warnLine(msg) {
  console.log(`   ${c.yellow('!')} ${c.yellow(String(msg))}`);
}

function fail(msg, code = 1) {
  showCursor();
  console.error(`\n${c.red('✗')} ${c.bold(c.red('打包失败'))} ${c.dim('· ' + fmtDur(Date.now() - T0))}`);
  console.error(`  ${c.red(String(msg))}`);
  process.exit(code);
}

const SPIN_FRAMES = FANCY_GLYPH
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/'];

/** 转轮：仅在 TTY 下动画；非 TTY 打一行静态提示 */
function spinner(label) {
  const start = Date.now();
  if (!IS_TTY) {
    process.stdout.write(`   ${c.gray('·')} ${label}…\n`);
    let text = label;
    return {
      text: (t) => { text = t; },
      succeed: (extra) => okLine(text, extra || fmtDur(Date.now() - start)),
      fail: () => {},
      stop: () => {},
    };
  }
  let i = 0;
  let text = label;
  hideCursor();
  const render = () => {
    const f = SPIN_FRAMES[i = (i + 1) % SPIN_FRAMES.length];
    process.stdout.write(`\r${CLEAR_LINE}   ${c.cyan(f)} ${text}  ${c.dim(fmtDur(Date.now() - start))}`);
  };
  const timer = setInterval(render, 90);
  render();
  const finish = (mark, extra) => {
    clearInterval(timer);
    process.stdout.write(`\r${CLEAR_LINE}   ${mark} ${text}  ${c.dim(extra ?? fmtDur(Date.now() - start))}\n`);
    showCursor();
  };
  return {
    text: (t) => { text = t; },
    succeed: (extra) => finish(c.green('✓'), extra),
    fail: () => finish(c.red('✗')),
    stop: () => { clearInterval(timer); process.stdout.write(`\r${CLEAR_LINE}`); showCursor(); },
  };
}

/**
 * 跑子进程并显示转轮（TTY）或直通输出（非 TTY / VERBOSE）。
 * 静默模式下捕获输出，失败时打印尾部日志便于排查。
 */
function run(label, cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(opts.env || {}) };
    const cwd = opts.cwd ?? ROOT;

    if (VERBOSE || !IS_TTY) {
      console.log(`   ${c.cyan('▶')} ${label}`);
      const child = spawn(cmd, args, { cwd, stdio: 'inherit', env });
      child.on('error', (e) => reject(e));
      child.on('close', (code) => (code === 0
        ? resolve()
        : reject(new Error(`${label} 失败（exit ${code}）`))));
      return;
    }

    const sp = spinner(label);
    let tail = '';
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    const onData = (d) => { tail = (tail + d.toString()).slice(-6000); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => { sp.fail(); reject(e); });
    child.on('close', (code) => {
      if (code === 0) { sp.succeed(); resolve(); return; }
      sp.fail();
      const lines = tail.trim().split(/\r?\n/).slice(-12);
      if (lines.length) {
        console.log(c.dim('     ── 子进程输出末尾 ──'));
        for (const ln of lines) console.log(c.dim(`     ${ln}`));
      }
      reject(new Error(`${label} 失败（exit ${code}）`));
    });
  });
}

/** 同步跑子进程（仅内部短命令用，如 tar 列表/解压），失败即退出 */
function runSyncQuiet(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: opts.stdio ?? 'ignore',
    encoding: opts.encoding,
    shell: false,
    maxBuffer: opts.maxBuffer,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return r;
}

function ensureNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    fail(`打包需要本机 Node.js 20+（当前 ${process.versions.node}）`);
  }
}

/** 下载进度条（TTY 单行原地刷新） */
function renderDownloadBar(received, total, elapsedMs) {
  const rMb = (received / 1048576).toFixed(1);
  const speed = elapsedMs > 0 ? received / 1048576 / (elapsedMs / 1000) : 0;
  const spd = `${speed.toFixed(1)} MB/s`;
  if (total > 0) {
    const width = 22;
    const ratio = Math.min(1, received / total);
    const filled = Math.round(ratio * width);
    const bar = c.teal('█'.repeat(filled)) + c.dim('░'.repeat(width - filled));
    const pct = String(Math.floor(ratio * 100)).padStart(3, ' ');
    process.stdout.write(`\r${CLEAR_LINE}   ${c.cyan('↓')} ${bar} ${pct}%  ${rMb}/${(total / 1048576).toFixed(1)} MB  ${c.dim(spd)}`);
  } else {
    process.stdout.write(`\r${CLEAR_LINE}   ${c.cyan('↓')} ${rMb} MB  ${c.dim(spd)}`);
  }
}

function download(url, dest, { idleMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    let settled = false;
    let idleTimer = null;
    let received = 0;
    let total = 0;
    let lastLog = 0;
    const dlStart = Date.now();
    hideCursor();

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (IS_TTY) { process.stdout.write(`\r${CLEAR_LINE}`); showCursor(); }
    };
    const failDownload = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      file.destroy();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        failDownload(new Error(`download stalled (no data for ${Math.round(idleMs / 1000)}s): ${url}`));
      }, idleMs);
    };

    const get = (u, redirects = 0) => {
      if (redirects > 8) {
        failDownload(new Error('too many redirects'));
        return;
      }
      const lib = u.startsWith('https') ? https : http;
      const req = lib.get(u, { timeout: 30_000 }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          get(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          failDownload(new Error(`HTTP ${res.statusCode} for ${u}`));
          return;
        }
        total = Number(res.headers['content-length']) || 0;
        bumpIdle();
        res.on('data', (chunk) => {
          received += chunk.length;
          bumpIdle();
          const now = Date.now();
          const interval = IS_TTY ? 90 : 1500;
          if (now - lastLog > interval) {
            lastLog = now;
            if (IS_TTY) {
              renderDownloadBar(received, total, now - dlStart);
            } else {
              const mb = (received / (1024 * 1024)).toFixed(1);
              const of = total ? ` / ${(total / (1024 * 1024)).toFixed(1)}` : '';
              log(`  … ${mb}${of} MB`);
            }
          }
        });
        pipeline(res, file).then(ok).catch(failDownload);
      });
      req.on('timeout', () => {
        req.destroy();
        failDownload(new Error(`connect timeout: ${u}`));
      });
      req.on('error', failDownload);
    };
    get(url);
  });
}

function mirrorUrls(fileName) {
  const custom = String(process.env.KAKAKE_NODE_MIRROR || '').trim().replace(/\/$/, '');
  const urls = [];
  if (custom) urls.push(`${custom}/${NODE_VER}/${fileName}`);
  // 国内常用镜像优先，避免 nodejs.org 长时间 0 字节卡住
  urls.push(`https://cdn.npmmirror.com/binaries/node/${NODE_VER}/${fileName}`);
  urls.push(`https://npmmirror.com/mirrors/node/${NODE_VER}/${fileName}`);
  urls.push(`https://nodejs.org/dist/${NODE_VER}/${fileName}`);
  return [...new Set(urls)];
}

async function ensureCached(fileName) {
  fs.mkdirSync(CACHE, { recursive: true });
  const dest = path.join(CACHE, fileName);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) {
    okLine(`${fileName}`, `缓存命中 · ${(fs.statSync(dest).size / 1048576).toFixed(1)} MB`);
    return dest;
  }
  const tmp = `${dest}.part`;
  const urls = mirrorUrls(fileName);
  let lastErr = null;
  for (const url of urls) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      let host = url;
      try { host = new URL(url).host; } catch { /* keep raw */ }
      log(`下载 ${fileName} ← ${host}`);
      await download(url, tmp);
      const size = fs.statSync(tmp).size;
      if (size < 1_000_000) throw new Error(`文件过小（${size} bytes）`);
      fs.renameSync(tmp, dest);
      okLine(`${fileName}`, `${(size / 1048576).toFixed(1)} MB`);
      return dest;
    } catch (e) {
      lastErr = e;
      warnLine(`源失败：${e.message || e}`);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
  throw lastErr || new Error(`failed to download ${fileName}`);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dest) {
  mkdirp(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/** 递归复制，可跳过目录名 */
function copyTree(src, dest, { skipDirNames = [] } = {}) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isFile()) {
    copyFile(src, dest);
    return;
  }
  mkdirp(dest);
  for (const name of fs.readdirSync(src)) {
    if (skipDirNames.includes(name)) continue;
    copyTree(path.join(src, name), path.join(dest, name), { skipDirNames });
  }
}

/**
 * 异步递归复制：每复制若干文件就让出事件循环，
 * 让转轮能实时转动并回报已复制文件数。返回文件总数。
 */
async function copyTreeCounted(src, dest, { skipDirNames = [], onTick } = {}) {
  if (!fs.existsSync(src)) return 0;
  let count = 0;
  const stack = [[src, dest]];
  while (stack.length) {
    const [s, d] = stack.pop();
    const st = fs.statSync(s);
    if (st.isFile()) {
      copyFile(s, d);
      count += 1;
      if (count % 250 === 0) {
        onTick?.(count);
        await new Promise((r) => setImmediate(r));
      }
      continue;
    }
    mkdirp(d);
    for (const name of fs.readdirSync(s)) {
      if (skipDirNames.includes(name)) continue;
      stack.push([path.join(s, name), path.join(d, name)]);
    }
  }
  onTick?.(count);
  return count;
}

function extractZip(zipPath, outDir) {
  rmrf(outDir);
  mkdirp(outDir);
  // Windows 10+ / macOS / Linux 自带 tar，可解 zip，无需 adm-zip
  const r = runSyncQuiet('tar', ['-xf', zipPath, '-C', outDir]);
  if (r.error) fail(`tar (zip): ${r.error.message}`);
  if (r.status !== 0) fail(`tar extract zip failed: ${zipPath}`);
}

function extractTarGz(tgzPath, outDir) {
  rmrf(outDir);
  mkdirp(outDir);
  // Windows 10+ / 各平台自带 tar
  const r = runSyncQuiet('tar', ['-xzf', tgzPath, '-C', outDir]);
  if (r.error) fail(`tar: ${r.error.message}（请确认系统有 tar）`);
  if (r.status !== 0) fail(`tar extract failed: ${tgzPath}`);
}

/**
 * 在 Windows 上解压完整 Linux Node 会因 npm/npx 符号链接失败。
 * 便携运行只需 bin/node，单独抽出该文件。
 */
function extractLinuxNodeBinary(tgzPath, runtimeDest) {
  const tmp = path.join(CACHE, 'extract-linux-node');
  rmrf(tmp);
  mkdirp(tmp);

  const list = runSyncQuiet('tar', ['-tzf', tgzPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 32 * 1024 * 1024,
  });
  if (list.error) fail(`tar -tzf: ${list.error.message}`);
  if (list.status !== 0) fail(`tar list failed: ${tgzPath}`);

  const entries = String(list.stdout || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const nodeEntry = entries.find(
    (e) => /(^|\/)bin\/node$/.test(e) && !e.includes('node_modules'),
  );
  if (!nodeEntry) fail(`在 ${path.basename(tgzPath)} 中未找到 bin/node`);

  const ext = runSyncQuiet('tar', ['-xzf', tgzPath, '-C', tmp, nodeEntry]);
  if (ext.error) fail(`tar extract node: ${ext.error.message}`);
  if (ext.status !== 0) fail('tar extract bin/node failed');

  const extracted = path.join(tmp, ...nodeEntry.split('/'));
  if (!fs.existsSync(extracted)) fail(`解压后缺少 ${extracted}`);

  rmrf(runtimeDest);
  mkdirp(path.join(runtimeDest, 'bin'));
  const destNode = path.join(runtimeDest, 'bin', 'node');
  fs.copyFileSync(extracted, destNode);
  try {
    fs.chmodSync(destNode, 0o755);
  } catch { /* Windows 上 chmod 可能无效 */ }
  rmrf(tmp);
}

function findExtractedRoot(parent, expectPrefix) {
  const ents = fs.readdirSync(parent, { withFileTypes: true });
  const dir = ents.find((e) => e.isDirectory() && e.name.startsWith(expectPrefix));
  if (dir) return path.join(parent, dir.name);
  // 有的解压直接就是一层
  if (ents.length === 1 && ents[0].isDirectory()) {
    return path.join(parent, ents[0].name);
  }
  fail(`解压后未找到 ${expectPrefix}* 目录于 ${parent}`);
}

async function buildProject() {
  await run('构建 Web 控制台（Vite）', process.execPath, ['scripts/ensure-web.mjs', 'build', '--force']);
  await run('打包服务端 Bundle', process.execPath, ['scripts/build-server.mjs']);
  const serverMain = path.join(ROOT, 'packages', 'server', 'main.mjs');
  const webIndex = path.join(ROOT, 'packages', 'web', 'dist', 'index.html');
  if (!fs.existsSync(serverMain)) fail('缺少 packages/server/main.mjs');
  if (!fs.existsSync(webIndex)) fail('缺少 packages/web/dist/index.html');
}

async function installProdDeps(prodRoot) {
  rmrf(prodRoot);
  mkdirp(prodRoot);
  copyFile(path.join(ROOT, 'package.json'), path.join(prodRoot, 'package.json'));
  const lock = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) copyFile(lock, path.join(prodRoot, 'package-lock.json'));
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  const npmCli = resolveNpmCli();
  const label = 'npm install 生产依赖（--omit=dev）';
  if (npmCli) {
    await run(label, process.execPath, [npmCli, ...npmArgs], { cwd: prodRoot });
  } else if (isWin) {
    // 回退：cmd /c，且不把 args 交给 shell:true（避免 DEP0190）
    await run(label, process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`], {
      cwd: prodRoot,
    });
  } else {
    await run(label, 'npm', npmArgs, { cwd: prodRoot });
  }
  if (!fs.existsSync(path.join(prodRoot, 'node_modules'))) {
    fail('生产 node_modules 安装失败');
  }
}

function writeReadme(destDir, platform) {
  const text = `咔咔珂（Kakake）便携版 — ${platform}

无需安装系统 Node.js。

启动:
  Windows: 双击 启动.bat
  Linux:   chmod +x 启动.sh && ./启动.sh

默认控制台: http://127.0.0.1:8787

说明:
  - 内置 Node ${NODE_VER}
  - 数据目录 data/、log/、plugins/ 会在首次运行时自动创建
  - 请勿删除 runtime/ 与 node_modules/
  - 本包不含开发用 bootstrap；与源码版 start.bat 相互独立

版本见 package.json
`;
  fs.writeFileSync(path.join(destDir, 'README.txt'), text, 'utf8');
}

function writeWinStarter(destDir) {
  const bat = `@echo off
setlocal EnableExtensions
cd /d "%~dp0"

if not exist "runtime\\node.exe" (
  echo [ERROR] Missing runtime\\node.exe
  pause
  exit /b 1
)
if not exist "packages\\server\\main.mjs" (
  echo [ERROR] Missing packages\\server\\main.mjs
  pause
  exit /b 1
)

if not exist "data" mkdir data
if not exist "log" mkdir log
if not exist "plugins" mkdir plugins
if not exist "plugins_two" mkdir plugins_two

echo.
echo   ==============================================
echo     kakake  .  portable        bundled Node
echo     starting runtime, please wait...
echo   ==============================================
echo.

set KAKAKE_MANAGED_RELAUNCH=1

:run_loop
echo [Kakake] Portable start (bundled Node)...
"runtime\\node.exe" "packages\\server\\main.mjs"
set EXIT_CODE=%ERRORLEVEL%
if "%EXIT_CODE%"=="86" (
  echo [Kakake] Applying update / restarting...
  if exist "scripts\\apply-update.mjs" "runtime\\node.exe" "scripts\\apply-update.mjs"
  if exist "runtime\\node.exe.new" move /y "runtime\\node.exe.new" "runtime\\node.exe" >nul 2>&1
  goto run_loop
)
if not "%EXIT_CODE%"=="0" pause
exit /b %EXIT_CODE%
`;
  const out = path.join(destDir, '启动.bat');
  // ASCII + CRLF, NO BOM — UTF-8 BOM becomes 锘緻echo on Chinese Windows cmd
  fs.writeFileSync(out, bat.replace(/\r?\n/g, '\r\n'), 'utf8');
}

function writeLinuxStarter(destDir) {
  // UTF-8 without BOM; shebang must be first bytes (BOM would break Linux)
  const sh = `#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

NODE_BIN="./runtime/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  if [[ -f "$NODE_BIN" ]]; then
    chmod +x "$NODE_BIN" || true
  else
    echo "[ERROR] Missing $NODE_BIN"
    exit 1
  fi
fi
if [[ ! -f "./packages/server/main.mjs" ]]; then
  echo "[ERROR] Missing packages/server/main.mjs"
  exit 1
fi

mkdir -p data log plugins plugins_two

# 顶部横幅（仅交互终端上色；tput 取色，规避 JS 模板里的转义坑）
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  CY="$(tput setaf 6 2>/dev/null || true)"
  GY="$(tput setaf 8 2>/dev/null || tput setaf 7 2>/dev/null || true)"
  WT="$(tput bold 2>/dev/null || true)"
  RS="$(tput sgr0 2>/dev/null || true)"
else
  CY=""; GY=""; WT=""; RS=""
fi
echo ""
echo "  $CY▌$RS $WT咔咔珂$RS  $GY便携版 · kakake$RS"
echo "  $CY▌$RS $GY内置 Node 运行时启动中…$RS"
echo "  $CY————————————————————————————————————————$RS"
echo ""

# 受管重启：后端以退出码 86 请求「应用暂存更新并重启」；本启动器据此循环。
export KAKAKE_MANAGED_RELAUNCH=1
while :; do
  echo "[Kakake] Portable start (bundled Node)..."
  set +e
  "$NODE_BIN" "./packages/server/main.mjs"
  status=$?
  set -e
  if [ "$status" = "86" ]; then
    echo "[Kakake] Applying update / restarting..."
    if [ -f "./scripts/apply-update.mjs" ]; then
      "$NODE_BIN" "./scripts/apply-update.mjs" || true
    fi
    continue
  fi
  exit "$status"
done
`;
  const shPath = path.join(destDir, '启动.sh');
  fs.writeFileSync(shPath, sh.replace(/\r\n/g, '\n'), 'utf8');
  try {
    fs.chmodSync(shPath, 0o755);
  } catch { /* Windows 上可能无效，tar 时再处理 */ }
}

async function copySharedApp(destDir, prodDepsRoot) {
  // package.json
  copyFile(path.join(ROOT, 'package.json'), path.join(destDir, 'package.json'));

  // 在线更新应用器：便携版 启动 脚本在退出码 86 后调用它应用暂存更新
  mkdirp(path.join(destDir, 'scripts'));
  copyFile(
    path.join(ROOT, 'scripts', 'apply-update.mjs'),
    path.join(destDir, 'scripts', 'apply-update.mjs'),
  );

  // server bundle
  copyTree(
    path.join(ROOT, 'packages', 'server'),
    path.join(destDir, 'packages', 'server'),
  );

  // web SPA only (skip web node_modules)
  mkdirp(path.join(destDir, 'packages', 'web'));
  copyTree(
    path.join(ROOT, 'packages', 'web', 'dist'),
    path.join(destDir, 'packages', 'web', 'dist'),
  );
  const webPkg = path.join(ROOT, 'packages', 'web', 'package.json');
  if (fs.existsSync(webPkg)) {
    copyFile(webPkg, path.join(destDir, 'packages', 'web', 'package.json'));
  }

  // production node_modules（最耗时，带实时文件计数的转轮）
  const sp = spinner('复制生产依赖 node_modules');
  const n = await copyTreeCounted(
    path.join(prodDepsRoot, 'node_modules'),
    path.join(destDir, 'node_modules'),
    { onTick: (cnt) => sp.text(`复制生产依赖 node_modules  ${c.dim(`${cnt} 个文件`)}`) },
  );
  sp.succeed(`${n} 个文件`);

  // 控制台「插件开发」等教程原文
  const tutorials = path.join(ROOT, '使用教程');
  if (fs.existsSync(tutorials)) {
    copyTree(tutorials, path.join(destDir, '使用教程'), {
      skipDirNames: ['node_modules'],
    });
  }

  // empty data placeholders
  for (const d of ['data', 'log', 'plugins', 'plugins_two']) {
    mkdirp(path.join(destDir, d));
    fs.writeFileSync(path.join(destDir, d, '.gitkeep'), '', 'utf8');
  }
}

function dirSizeMb(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else {
        try {
          total += fs.statSync(p).size;
        } catch { /* ignore */ }
      }
    }
  }
  return (total / (1024 * 1024)).toFixed(1);
}

async function assembleWin(prodDepsRoot, winZip) {
  const out = path.join(DIST, 'kakake-win-x64');
  rmrf(out);
  mkdirp(out);

  log('解压 Windows Node 运行时');
  const extractTo = path.join(CACHE, 'extract-win');
  extractZip(winZip, extractTo);
  const nodeRoot = findExtractedRoot(extractTo, 'node-');
  mkdirp(path.join(out, 'runtime'));
  copyFile(path.join(nodeRoot, 'node.exe'), path.join(out, 'runtime', 'node.exe'));

  await copySharedApp(out, prodDepsRoot);
  writeWinStarter(out);
  writeReadme(out, 'Windows x64');

  okLine(`kakake-win-x64/`, `≈ ${dirSizeMb(out)} MB`);
  return out;
}

async function assembleLinux(prodDepsRoot, linuxTgz) {
  const staging = path.join(DIST, 'kakake-linux-x64');
  rmrf(staging);
  mkdirp(staging);

  log('抽取 Linux Node 二进制（bin/node）');
  // 只抽出 bin/node，避免 Windows tar 无法创建 Linux 符号链接
  extractLinuxNodeBinary(linuxTgz, path.join(staging, 'runtime'));

  await copySharedApp(staging, prodDepsRoot);
  writeLinuxStarter(staging);
  writeReadme(staging, 'Linux x64');

  const nodeBin = path.join(staging, 'runtime', 'bin', 'node');
  try {
    fs.chmodSync(nodeBin, 0o755);
    fs.chmodSync(path.join(staging, '启动.sh'), 0o755);
  } catch { /* ignore */ }

  okLine(`kakake-linux-x64/`, `≈ ${dirSizeMb(staging)} MB`);
  return staging;
}

/**
 * 把成品目录压成同名 zip（省得手动压缩），带转轮动画。
 * 依次尝试：bsdtar（Windows 10+/macOS 自带，`tar -a` 按扩展名产出 zip）→ 系统 zip 命令（多数 Linux/macOS）。
 * 都不可用时告警并返回 null，不影响已生成的目录，可事后自行压缩。
 */
async function zipFolder(distDir, folderName) {
  const zipName = `${folderName}.zip`;
  const zipPath = path.join(distDir, zipName);
  rmrf(zipPath);

  const trySpawn = (cmd, args, cwd) => new Promise((res) => {
    const child = spawn(cmd, args, { cwd, stdio: 'ignore' });
    child.on('error', () => res(false));
    child.on('close', (code) => res(code === 0));
  });
  const good = () => fs.existsSync(zipPath) && fs.statSync(zipPath).size > 0;

  const sp = spinner(`压缩 ${zipName}`);
  // 1) bsdtar：-a 依据 .zip 扩展名选 zip 格式；-C 切到 dist 再收 folderName，使 zip 内含顶层目录
  let ok = await trySpawn('tar', ['-a', '-c', '-f', zipPath, '-C', distDir, folderName], ROOT);
  if (!(ok && good())) {
    rmrf(zipPath);
    // 2) 系统 zip 命令（GNU tar 不会做 zip，Linux 走这条）
    ok = await trySpawn('zip', ['-r', '-q', zipName, folderName], distDir);
  }
  if (ok && good()) {
    sp.succeed(`${dirFileSizeMb(zipPath)} MB`);
    return zipPath;
  }
  rmrf(zipPath);
  sp.fail();
  warnLine(`未能自动压缩 ${folderName}（本机缺少可创建 zip 的 tar/zip）；目录已生成，可自行压缩`);
  return null;
}

/** 单个文件大小（MB，一位小数） */
function dirFileSizeMb(file) {
  try {
    return (fs.statSync(file).size / (1024 * 1024)).toFixed(1);
  } catch {
    return '?';
  }
}

async function main() {
  ensureNodeVersion();
  if (!NODE_VER.startsWith('v')) fail('KAKAKE_PORTABLE_NODE 需形如 v20.20.2');

  banner();
  mkdirp(DIST);

  phase('构建项目');
  await buildProject();

  phase('准备生产依赖');
  const prodDepsRoot = path.join(CACHE, 'prod-deps');
  await installProdDeps(prodDepsRoot);

  phase('获取内置 Node 运行时');
  const winZip = await ensureCached(WIN_ZIP);
  const linuxTgz = await ensureCached(LINUX_TGZ);

  phase('组装 Windows x64');
  const winOut = await assembleWin(prodDepsRoot, winZip);

  phase('组装 Linux x64');
  const linuxOut = await assembleLinux(prodDepsRoot, linuxTgz);

  phase('压缩成品');
  const winZipOut = await zipFolder(DIST, path.basename(winOut));
  const linuxZipOut = await zipFolder(DIST, path.basename(linuxOut));

  // 收尾汇总
  const width = 52;
  const rule = c.teal('─'.repeat(width));
  console.log('');
  console.log(rule);
  console.log(`  ${c.green('✓')} ${c.bold('打包完成')}   ${c.dim(`总耗时 ${fmtDur(Date.now() - T0)}`)}`);
  console.log('');
  const rel = (p) => (p ? path.relative(ROOT, p).replace(/\\/g, '/') : null);
  console.log(`  ${c.cyan('Windows')}  ${rel(winOut)}${c.dim('/')}`);
  if (winZipOut) console.log(`           ${c.dim(rel(winZipOut))}`);
  console.log(`  ${c.cyan('Linux')}    ${rel(linuxOut)}${c.dim('/')}`);
  if (linuxZipOut) console.log(`           ${c.dim(rel(linuxZipOut))}`);
  console.log('');
  console.log(`  ${c.dim('最终用户请使用各目录内「启动」脚本；请勿分发 打包.bat / 源码 bootstrap。')}`);
  console.log(rule);
  console.log('');
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
