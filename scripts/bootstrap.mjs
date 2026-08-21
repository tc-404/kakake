#!/usr/bin/env node
/**
 * Kakake bootstrap: install backend deps, ensure Web UI + server bundle in packages/, start server.
 * packages/ 可整夹删除（web + server）；ensure-web / build-server 会自动重建。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE_MAJOR = 20;
const isWin = process.platform === 'win32';
const npm = isWin ? 'npm.cmd' : 'npm';

function log(msg) {
  console.log(`[Kakake] ${msg}`);
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
    fail(
      `Node.js ${MIN_NODE_MAJOR}+ is required (current: ${process.versions.node}). `
      + 'Install from https://nodejs.org/',
    );
  }
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
  return env;
}

function ensureDeps() {
  if (exists('node_modules/tsx/package.json')) return;
  log('Installing backend dependencies (npm install)...');
  run(npm, ['install'], { shell: isWin, env: npmInstallEnv() });
  if (!exists('node_modules/tsx/package.json')) {
    fail('tsx not found after npm install. Delete node_modules and retry.');
  }
}

function ensureWebBuild() {
  const force = process.env.KAKAKE_FORCE_WEB_BUILD === '1';
  const args = force ? ['scripts/ensure-web.mjs', 'build', '--force'] : ['scripts/ensure-web.mjs'];
  log(force ? 'Ensuring Web UI (force)…' : 'Ensuring Web UI → packages/web …');
  // process.execPath 可能含空格（Program Files），勿开 shell
  run(process.execPath, args);
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
    log('Server bundle up to date → packages/server/main.mjs');
    return;
  }
  log('Building server bundle → packages/server …');
  run(process.execPath, ['scripts/build-server.mjs']);
}

function startServer() {
  const outFile = path.join(ROOT, 'packages', 'server', 'main.mjs');
  if (!fs.existsSync(outFile)) {
    fail('packages/server/main.mjs missing; server build failed');
  }
  log('Starting server (node packages/server/main.mjs)…');
  const r = spawnSync(process.execPath, [outFile], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  process.exit(r.status ?? (r.error ? 1 : 0));
}

ensureNodeVersion();
ensureDeps();
ensureWebBuild();
ensureServerBuild();
ensureDirs();
startServer();
