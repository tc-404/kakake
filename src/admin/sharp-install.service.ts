import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { currentPlatformToken, detectEdition, type Edition } from './launch-mode.js';
import {
  hasSharpPackage,
  installedSharpDir,
  installedSharpVersion,
  probeSharp,
  resetSharpCache,
  sharedSharpDepsDir,
  SHARP_DEPENDENCY_RANGE,
} from '../tools/sharp-loader.js';
import { acquireSharpInstallLock, releaseSharpInstallLock } from '../tools/sharp-install-lock.js';

/**
 * 设置页「图片引擎环境」后端：状态探测 + 手动安装 sharp。
 * 装到 data/runtime-deps（与 MKbot 共用）；不自动跑 npm install，由用户决定何时执行。
 * 单飞、限时、环形日志，安装前清理半残的 sharp/@img；失败只报错，由用户重试。
 */

/** 安装日志保留的最大行数（前端只看尾部） */
const MAX_LOG_LINES = 200;
/** 单次安装的总时长上限 */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
/** npm 版本探测超时 */
const NPM_PROBE_TIMEOUT_MS = 8000;

export type SharpInstallPhase = 'idle' | 'running' | 'done' | 'error';

export type SharpInstallJob = {
  phase: SharpInstallPhase;
  message: string;
  error: string;
  exitCode: number | null;
  command: string;
  /** 安装目标目录（共享依赖目录） */
  installDir: string;
  startedAt: string;
  finishedAt: string;
  /** 尾部日志（最多 MAX_LOG_LINES 行） */
  lines: string[];
};

type NpmRunner = {
  label: string;
  /** 构造一次调用（sub 是 npm 子命令，如 ['install']） */
  build(sub: string[]): { file: string; args: string[] };
};

let job: SharpInstallJob | null = null;
let running: ChildProcess | null = null;
let timeoutTimer: NodeJS.Timeout | null = null;
/** 当前正在安装的目标目录（用于 finishJob 释放跨进程锁） */
let currentInstallDir = '';

/* ─────────── npm 定位 ─────────── */

/**
 * 找可用的 npm。优先用与当前 node 同目录的 npm-cli.js（Windows 安装版 / Linux 安装版都在
 * 固定位置，与 MKbot 的 findNpmCliJs 同一套猜测路径），这样不依赖 PATH、也不受 PowerShell
 * 执行策略影响；找不到再退回 PATH 上的 npm。
 * 便携版自带 runtime 里没有 npm，通常两者都找不到 —— 界面据此给出相应说明。
 */
function npmRunnerCandidates(): NpmRunner[] {
  const nodeDir = path.dirname(process.execPath);
  const clis = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'libexec', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const runners: NpmRunner[] = [];
  for (const cli of clis) {
    if (!fs.existsSync(cli)) continue;
    runners.push({
      label: `node ${cli}`,
      build: (sub) => ({ file: process.execPath, args: [cli, ...sub] }),
    });
  }
  if (process.platform === 'win32') {
    const comspec = process.env.ComSpec || 'cmd.exe';
    runners.push({
      label: 'npm.cmd (PATH)',
      // 显式走 cmd，避免 spawn 对 .cmd 用 shell:true 时的注入告警与转义问题
      build: (sub) => ({ file: comspec, args: ['/d', '/s', '/c', ['npm', ...sub].join(' ')] }),
    });
  } else {
    runners.push({ label: 'npm (PATH)', build: (sub) => ({ file: 'npm', args: sub }) });
  }
  return runners;
}

/**
 * npm 环境变量：与 scripts/bootstrap.mjs 同款地修掉「Node 二进制镜像被当成 npm registry」，
 * 并按 MKbot 的经验放大 fetch 超时（sharp 的 @img 预编译包体积大，弱网下容易超时误判）。
 */
function npmEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_fetch_timeout: '600000',
  };
  const cur = String(env.npm_config_registry || '').trim();
  const looksWrong = !cur
    || /nodejs-release/i.test(cur)
    || /nodejs\.org/i.test(cur)
    || (/\/dist\//i.test(cur) && /node/i.test(cur));
  if (looksWrong) {
    env.npm_config_registry = process.env.KAKAKE_NPM_REGISTRY || 'https://registry.npmmirror.com';
  }
  return env;
}

/** 跑一次短命令并收集输出（只用于 npm --version 这类探测） */
function runOnce(file: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: PATHS.root, env: npmEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, out: e instanceof Error ? e.message : String(e) });
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, out: 'timeout' });
    }, timeoutMs);
    child.stdout?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { out += b.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out: out.trim() });
    });
  });
}

type NpmInfo = { available: boolean; label: string; version: string | null };

let npmCache: Promise<NpmInfo> | null = null;

/** 探测 npm（结果进程内缓存；安装结束会清缓存，避免用户中途装了 node 却看不到） */
function probeNpm(force = false): Promise<NpmInfo> {
  if (force) npmCache = null;
  if (!npmCache) {
    npmCache = (async () => {
      for (const runner of npmRunnerCandidates()) {
        const { file, args } = runner.build(['--version']);
        const r = await runOnce(file, args, NPM_PROBE_TIMEOUT_MS);
        // npm --version 输出形如 10.9.2；命令不存在时 code 非 0 或只有报错文本
        const version = r.ok ? r.out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || '' : '';
        if (r.ok && /^\d+\.\d+\.\d+/.test(version)) {
          return { available: true, label: runner.label, version };
        }
      }
      return { available: false, label: '', version: null };
    })();
  }
  return npmCache;
}

/* ─────────── 依赖缺失清单（与 bootstrap 的判据一致） ─────────── */

function declaredDeps(): { required: string[]; optional: string[] } {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PATHS.root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return {
      required: Object.keys(pkg.dependencies || {}),
      optional: Object.keys(pkg.optionalDependencies || {}),
    };
  } catch {
    return { required: [], optional: [] };
  }
}

function resolvable(name: string): boolean {
  try {
    createRequire(path.join(PATHS.root, 'package.json')).resolve(name);
    return true;
  } catch {
    return fs.existsSync(path.join(PATHS.root, 'node_modules', ...name.split('/'), 'package.json'));
  }
}

/** 当前缺失的依赖（必需在前，可选在后）；sharp 不在主 package.json 里，不参与这里 */
export function missingDeps(): string[] {
  const { required, optional } = declaredDeps();
  return [...required, ...optional].filter((n) => !resolvable(n));
}

/* ─────────── 共享依赖目录准备 ─────────── */

/**
 * 确保 `data/runtime-deps/package.json` 存在并声明 sharp（与 MKbot 的
 * ensureSharpRuntimePackage 同一套做法：共享目录只放一个最小 package.json，
 * 里面只声明 sharp，npm install 就在这个目录里跑）。
 */
function ensureSharedPackageJson(installDir: string): void {
  fs.mkdirSync(installDir, { recursive: true });
  const pkgPath = path.join(installDir, 'package.json');
  let sharpRange = SHARP_DEPENDENCY_RANGE;
  if (fs.existsSync(pkgPath)) {
    try {
      const cur = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      const existing = cur?.dependencies?.sharp;
      if (typeof existing === 'string' && existing.trim()) {
        // 已有声明就沿用（可能是 MKbot 写进去的），避免两边互相改版本
        sharpRange = existing.trim();
        return;
      }
    } catch { /* 损坏就当没有，下面重写 */ }
  }
  fs.writeFileSync(pkgPath, JSON.stringify({
    name: 'kakake-runtime-deps',
    private: true,
    type: 'module',
    dependencies: { sharp: sharpRange },
  }, null, 2), 'utf8');
}

/** 清掉半残的安装产物：装一半最容易出现「包在但 native 加载失败」 */
function cleanBrokenArtifacts(installDir: string): number {
  const nm = path.join(installDir, 'node_modules');
  let removed = 0;
  for (const name of ['sharp', '@img']) {
    const target = path.join(nm, name);
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch { /* 被占用等：交给 npm 自己处理 */ }
  }
  return removed;
}

/* ─────────── 状态视图 ─────────── */

export type SharpEnvView = {
  ok: true;
  root: string;
  /** 一键安装的目标目录（共享依赖目录 data/runtime-deps） */
  installDir: string;
  /** 当前实际用的是哪一份（共享目录 / 项目内置副本 / null） */
  loadedDir: string | null;
  edition: Edition;
  platform: string;
  arch: string;
  nodeVersion: string;
  /** 任一位置有 sharp 包（不代表能用） */
  packagePresent: boolean;
  packageVersion: string | null;
  /** 真的 import 成功了吗（界面以这个为准） */
  loadable: boolean;
  version: string | null;
  vips: string | null;
  error: string | null;
  npm: NpmInfo;
  missingDeps: string[];
  canInstall: boolean;
  /** 无法一键安装时的原因说明 */
  note: string;
  /** 手动安装命令（界面上可复制） */
  command: string;
  job: SharpInstallJob | null;
  updatedAt: string;
};

export async function getSharpEnvView(): Promise<SharpEnvView> {
  const edition = detectEdition();
  const installDir = sharedSharpDepsDir();
  const [probe, npm] = await Promise.all([probeSharp(), probeNpm()]);
  const missing = missingDeps();

  const canInstall = npm.available && job?.phase !== 'running';
  let note = '';
  if (!npm.available) {
    note = edition === 'portable'
      ? '便携版内置的 Node 不带 npm，无法在控制台安装；请改用带 npm 的 Node 环境执行 npm install。'
      : '未找到可用的 npm（Node 可能只装了运行时）。请在项目目录手动执行 npm install。';
  }

  return {
    ok: true,
    root: PATHS.root,
    installDir,
    loadedDir: probe.ok ? probe.from : installedSharpDir(),
    edition,
    platform: currentPlatformToken(),
    arch: process.arch,
    nodeVersion: process.version,
    packagePresent: hasSharpPackage(),
    packageVersion: installedSharpVersion(),
    loadable: probe.ok,
    version: probe.ok ? probe.version : null,
    vips: probe.ok ? probe.vips : null,
    error: probe.ok ? null : probe.error,
    npm,
    missingDeps: missing,
    canInstall,
    note,
    command: `npm install --prefix "${installDir}"`,
    job,
    updatedAt: new Date().toISOString(),
  };
}

/* ─────────── 安装任务 ─────────── */

function pushLine(text: string): void {
  if (!job) return;
  for (const raw of text.split(/\r?\n/)) {
    // npm 在非 TTY 下一般不带色；这里再兜一层，保证日志页/界面不会出现转义乱码
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '').trimEnd();
    if (!line) continue;
    job.lines.push(line);
    if (job.lines.length > MAX_LOG_LINES) job.lines.splice(0, job.lines.length - MAX_LOG_LINES);
  }
}

function finishJob(phase: 'done' | 'error', message: string, error = '', exitCode: number | null = null): void {
  // 释放 sharp 安装跨进程锁（仅当 holder 是本进程时才删，不会误删别人的锁）
  releaseSharpInstallLock(currentInstallDir);
  if (timeoutTimer) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
  running = null;
  if (job) {
    job.phase = phase;
    job.message = message;
    job.error = error;
    job.exitCode = exitCode;
    job.finishedAt = new Date().toISOString();
  }
  // 装完（或装失败）都让 sharp 缓存失效：界面下一次刷新就是真实结果
  resetSharpCache();
  npmCache = null;
}

/** 开始安装（单飞）。返回 false 时 message 说明原因（界面直接提示）。 */
export async function startSharpInstall(): Promise<{ ok: boolean; message?: string }> {
  if (job?.phase === 'running' || running) return { ok: false, message: '已有安装任务进行中' };

  const npm = await probeNpm();
  if (!npm.available) {
    return { ok: false, message: '未找到可用的 npm，无法在控制台安装；请在项目目录手动执行 npm install。' };
  }

  const installDir = sharedSharpDepsDir();
  try {
    ensureSharedPackageJson(installDir);
  } catch (e) {
    return { ok: false, message: `无法准备安装目录 ${installDir}：${e instanceof Error ? e.message : String(e)}` };
  }

  // 跨进程排他锁：拦住宿主与插件两个进程同时往 data/runtime-deps 跑 npm install。
  // 抢不到说明另一进程正在装（或陈旧死锁）——放弃本次，提示用户等待/到对应界面查看。
  const lock = acquireSharpInstallLock(installDir, 'kakake');
  if (!lock.acquired) {
    return {
      ok: false,
      message: `${lock.reason ?? '无法获取 sharp 安装锁'}；请等待其完成，或到对应界面（咔咔珂 设置 → 图片引擎环境 / 插件后台）查看进度。`,
    };
  }
  currentInstallDir = installDir;

  const sub = ['install', '--omit=dev', '--no-audit', '--no-fund'];
  const runners = npmRunnerCandidates();
  const runner = runners.find((r) => r.label === npm.label)
    // 探测与执行的候选表是同一份；理论上必然命中，兜底取最后一个（PATH 上的 npm）
    ?? runners[runners.length - 1];
  const { file, args } = runner.build(sub);
  const command = [file === process.execPath ? 'node' : file, ...args].join(' ');

  job = {
    phase: 'running',
    message: '正在执行 npm install…',
    error: '',
    exitCode: null,
    command,
    installDir,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    lines: [],
  };
  pushLine(`# 安装目录：${installDir}`);
  const cleaned = cleanBrokenArtifacts(installDir);
  if (cleaned > 0) pushLine(`# 已清理半残产物 ${cleaned} 处（node_modules/sharp、node_modules/@img）`);
  pushLine(`$ ${command}`);

  try {
    running = spawn(file, args, {
      cwd: installDir,
      env: npmEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    finishJob('error', '无法启动 npm', e instanceof Error ? e.message : String(e), null);
    return { ok: true };
  }

  const child = running;
  child.stdout?.on('data', (b: Buffer) => pushLine(b.toString('utf8')));
  child.stderr?.on('data', (b: Buffer) => pushLine(b.toString('utf8')));
  child.on('error', (e) => {
    finishJob('error', 'npm 启动失败', e.message, null);
  });
  child.on('close', (code) => {
    if (job?.phase !== 'running') {
      // 已被超时分支收尾（或用户取消），这里只清理进程引用
      running = null;
      return;
    }
    if (code === 0) {
      finishJob('done', '安装完成，图片混淆服务端引擎已可用（无需重启）', '', 0);
      rootLogger.info(`[sharp] 安装完成（npm install → ${installDir}）`);
    } else {
      finishJob('error', `安装失败（npm 退出码 ${code}）`, '请查看下方日志，或手动执行 npm install', code);
      rootLogger.warn(`[sharp] 安装失败，npm 退出码 ${code}`);
    }
  });

  timeoutTimer = setTimeout(() => {
    if (job?.phase !== 'running') return;
    pushLine(`[超时] 超过 ${Math.round(INSTALL_TIMEOUT_MS / 60000)} 分钟仍未结束，已终止`);
    try { child.kill(); } catch { /* ignore */ }
    finishJob('error', '安装超时已终止', '网络或 npm registry 可能不可达，请检查后重试', null);
  }, INSTALL_TIMEOUT_MS);

  return { ok: true };
}
