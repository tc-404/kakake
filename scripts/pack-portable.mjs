#!/usr/bin/env node
/**
 * 便携版双平台打包：产出 dist/kakake-win-x64 与 dist/kakake-linux-x64（目录，自行压缩）
 * 仅开发机发版用；最终用户无需安装系统 Node。
 *
 * 用法: node scripts/pack-portable.mjs
 * 环境变量:
 *   KAKAKE_PORTABLE_NODE=v20.20.2  指定内置 Node 版本（需带 v 前缀）
 *   KAKAKE_NODE_MIRROR=https://npmmirror.com/mirrors/node  优先镜像（默认会回退国内镜像）
 */
import { spawnSync } from 'node:child_process';
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

function log(msg) {
  console.log(`[pack-portable] ${msg}`);
}

function fail(msg, code = 1) {
  console.error(`[pack-portable] ERROR: ${msg}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    stdio: 'inherit',
    shell: opts.shell ?? false,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (r.error) fail(`${cmd}: ${r.error.message}`);
  if (r.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${r.status}`, r.status ?? 1);
}

function ensureNodeVersion() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isFinite(major) || major < 20) {
    fail(`打包需要本机 Node.js 20+（当前 ${process.versions.node}）`);
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

    const cleanup = () => {
      if (idleTimer) clearTimeout(idleTimer);
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
          if (now - lastLog > 1500) {
            lastLog = now;
            const mb = (received / (1024 * 1024)).toFixed(1);
            const of = total ? ` / ${(total / (1024 * 1024)).toFixed(1)}` : '';
            log(`  … ${mb}${of} MB`);
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
    log(`cache hit ${fileName}`);
    return dest;
  }
  const tmp = `${dest}.part`;
  const urls = mirrorUrls(fileName);
  let lastErr = null;
  for (const url of urls) {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      log(`downloading ${url}`);
      await download(url, tmp);
      const size = fs.statSync(tmp).size;
      if (size < 1_000_000) throw new Error(`file too small (${size} bytes)`);
      fs.renameSync(tmp, dest);
      log(`saved ${fileName} (${(size / (1024 * 1024)).toFixed(1)} MB)`);
      return dest;
    } catch (e) {
      lastErr = e;
      log(`download failed: ${e.message || e}`);
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

function extractZip(zipPath, outDir) {
  rmrf(outDir);
  mkdirp(outDir);
  // Windows 10+ / macOS / Linux 自带 tar，可解 zip，无需 adm-zip
  const r = spawnSync('tar', ['-xf', zipPath, '-C', outDir], {
    stdio: 'inherit',
    shell: false,
  });
  if (r.error) fail(`tar (zip): ${r.error.message}`);
  if (r.status !== 0) fail(`tar extract zip failed: ${zipPath}`);
}

function extractTarGz(tgzPath, outDir) {
  rmrf(outDir);
  mkdirp(outDir);
  // Windows 10+ / 各平台自带 tar
  const r = spawnSync('tar', ['-xzf', tgzPath, '-C', outDir], {
    stdio: 'inherit',
    shell: false,
  });
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

  const list = spawnSync('tar', ['-tzf', tgzPath], {
    encoding: 'utf8',
    shell: false,
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

  const ext = spawnSync('tar', ['-xzf', tgzPath, '-C', tmp, nodeEntry], {
    stdio: 'inherit',
    shell: false,
  });
  if (ext.error) fail(`tar extract node: ${ext.error.message}`);
  if (ext.status !== 0) fail(`tar extract bin/node failed`);

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

function buildProject() {
  log('building web + server…');
  run(process.execPath, ['scripts/ensure-web.mjs', 'build', '--force']);
  run(process.execPath, ['scripts/build-server.mjs']);
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
  log('npm install --omit=dev（生产依赖）…');
  const npmArgs = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  const npmCli = resolveNpmCli();
  if (npmCli) {
    run(process.execPath, [npmCli, ...npmArgs], { cwd: prodRoot });
  } else if (isWin) {
    // 回退：cmd /c，且不把 args 交给 shell:true（避免 DEP0190）
    run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`], {
      cwd: prodRoot,
    });
  } else {
    run('npm', npmArgs, { cwd: prodRoot });
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

echo [Kakake] Portable start (bundled Node)...
"runtime\\node.exe" "packages\\server\\main.mjs"
set EXIT_CODE=%ERRORLEVEL%
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

echo "[Kakake] Portable start (bundled Node)..."
exec "$NODE_BIN" "./packages/server/main.mjs"
`;
  const shPath = path.join(destDir, '启动.sh');
  fs.writeFileSync(shPath, sh.replace(/\r\n/g, '\n'), 'utf8');
  try {
    fs.chmodSync(shPath, 0o755);
  } catch { /* Windows 上可能无效，tar 时再处理 */ }
}

function copySharedApp(destDir, prodDepsRoot) {
  // package.json
  copyFile(path.join(ROOT, 'package.json'), path.join(destDir, 'package.json'));

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

  // production node_modules
  log(`copy node_modules → ${path.relative(ROOT, destDir)}`);
  copyTree(
    path.join(prodDepsRoot, 'node_modules'),
    path.join(destDir, 'node_modules'),
  );

  // 控制台「插件开发」等教程原文
  const tutorials = path.join(ROOT, '使用教程');
  if (fs.existsSync(tutorials)) {
    log(`copy 使用教程 → ${path.relative(ROOT, destDir)}`);
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
  log(`assemble ${out}`);
  rmrf(out);
  mkdirp(out);

  const extractTo = path.join(CACHE, 'extract-win');
  extractZip(winZip, extractTo);
  const nodeRoot = findExtractedRoot(extractTo, 'node-');
  mkdirp(path.join(out, 'runtime'));
  copyFile(path.join(nodeRoot, 'node.exe'), path.join(out, 'runtime', 'node.exe'));

  copySharedApp(out, prodDepsRoot);
  writeWinStarter(out);
  writeReadme(out, 'Windows x64');

  log(`win-x64 ≈ ${dirSizeMb(out)} MB → ${out}`);
  return out;
}

async function assembleLinux(prodDepsRoot, linuxTgz) {
  const staging = path.join(DIST, 'kakake-linux-x64');
  log(`assemble ${staging}`);
  rmrf(staging);
  mkdirp(staging);

  // 只抽出 bin/node，避免 Windows tar 无法创建 Linux 符号链接
  extractLinuxNodeBinary(linuxTgz, path.join(staging, 'runtime'));

  copySharedApp(staging, prodDepsRoot);
  writeLinuxStarter(staging);
  writeReadme(staging, 'Linux x64');

  const nodeBin = path.join(staging, 'runtime', 'bin', 'node');
  try {
    fs.chmodSync(nodeBin, 0o755);
    fs.chmodSync(path.join(staging, '启动.sh'), 0o755);
  } catch { /* ignore */ }

  log(`linux-x64 ≈ ${dirSizeMb(staging)} MB → ${staging}`);
  return staging;
}

async function main() {
  ensureNodeVersion();
  if (!NODE_VER.startsWith('v')) fail('KAKAKE_PORTABLE_NODE 需形如 v20.20.2');

  mkdirp(DIST);
  buildProject();

  const prodDepsRoot = path.join(CACHE, 'prod-deps');
  await installProdDeps(prodDepsRoot);

  const winZip = await ensureCached(WIN_ZIP);
  const linuxTgz = await ensureCached(LINUX_TGZ);

  const winOut = await assembleWin(prodDepsRoot, winZip);
  const linuxOut = await assembleLinux(prodDepsRoot, linuxTgz);

  console.log('');
  log('完成。产物：');
  log(`  Windows: ${winOut}`);
  log(`  Linux:   ${linuxOut}`);
  log('最终用户请使用各目录内「启动」脚本；请勿分发 打包.bat / 源码 bootstrap。');
}

main().catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
});
