import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { acquireSharpInstallLock, releaseSharpInstallLock } from '../tools/sharp-install-lock.js';
import { syncPuppeteerBridge, removePuppeteerBridge } from '../tools/puppeteer-bridge.js';
import {
  BROWSER_DEFS,
  BROWSER_IDS,
  managedBrowserDir,
  managedBrowserExecutable,
  type BrowserId,
} from '../tools/browser-defs.js';

/** 安装任务阶段：前端据此画进度条，不展示日志 */
export type InstallPhase =
  | 'idle'
  | 'resolving'
  | 'downloading'
  | 'extracting'
  | 'deps'
  | 'verifying'
  | 'done'
  | 'error';

/**
 * 安装前置校验事实。status 每次都带上，前端按四档映射（禁止靠 reason 猜档位）：
 * - !platformSupported → 平台不支持，禁装
 * - downloadSourceOk===false → 源不可达，禁装
 * - degraded===true → 源降级/不确定，安装按钮仍可用
 * - 其余 → 正常
 */
export interface InstallBlock {
  downloadSourceOk: boolean;
  platformSupported: boolean;
  reason: string;
  degraded?: boolean;
}
export type InstallBlocks = Record<BrowserId, InstallBlock>;

export interface InstallJob {
  phase: InstallPhase;
  /** 0-100：下载阶段为已下载字节/总量的真实百分比；写入阶段固定 100（前端按阶段切不定态）；总量未知时 0 */
  percent: number;
  message: string;
  error: string;
  browserId: BrowserId | '';
  downloadedBytes: number;
  totalBytes: number;
  /** 实时下行速度（字节/秒），下载阶段按 500ms 节流更新 */
  bytesPerSec: number;
  /** 机器可读错误码：cancelled=用户取消，timeout=安装超时 */
  errorCode: string;
  startedAt: string;
  finishedAt: string;
}

/** 系统已安装浏览器的探测结果 */
export interface SystemBrowser {
  id: BrowserId;
  label: string;
  found: boolean;
  executablePath: string;
  /** 由咔咔珂安装（可卸载管理） */
  managed: boolean;
  version: string;
  archiveBytes: number;
  unpackedBytes: number;
  homepage: string;
  /** 已确认存在：路径命中或检测到运行中的进程 */
  verified: boolean;
  /** 检测到正在运行的浏览器进程（路径未命中也可能为 true） */
  runningProcess: boolean;
  /** 发现途径 */
  detectedVia: 'path' | 'path-env' | 'process' | 'none';
  /** 安装前置校验（由 status 端点合并进每条浏览器记录） */
  installBlock?: InstallBlock;
}

const MAX_TIMEOUT_MS = 15 * 60 * 1000;

let job: InstallJob = emptyJob();
let running: ChildProcess | null = null;
let currentBrowser: BrowserId | '' = '';
let timeoutTimer: NodeJS.Timeout | null = null;
let currentLockDir = '';
/** 下载阶段的真实取消句柄；非下载阶段为 null */
let activeController: AbortController | null = null;
let cancelRequested = false;

function emptyJob(): InstallJob {
  return {
    phase: 'idle', percent: 0, message: '', error: '',
    browserId: '', downloadedBytes: 0, totalBytes: 0,
    bytesPerSec: 0, errorCode: '',
    startedAt: '', finishedAt: '',
  };
}

function setJob(patch: Partial<InstallJob>): void {
  job = { ...job, ...patch };
}

export function getInstallJob(): InstallJob {
  return { ...job };
}

/* ── 浏览器探测增强：固定路径 + PATH 查找 + 运行进程检测 ── */

/** status 端点安装中每秒轮询一次，PATH / 进程探测不能每次都跑 */
const DETECT_TTL_MS = 3000;
let detectCache: { at: number; browsers: SystemBrowser[] } | null = null;

/** 进程名表：Windows 用 tasklist 镜像名，其余平台用 pgrep -x 进程名 */
const PROCESS_NAMES: Record<BrowserId, { win: string[]; posix: string[] }> = {
  chrome: { win: ['chrome.exe'], posix: ['chrome', 'google-chrome', 'google-chrome-stable'] },
  edge: { win: ['msedge.exe'], posix: ['msedge', 'microsoft-edge'] },
  chromium: { win: ['chromium.exe'], posix: ['chromium', 'chromium-browser'] },
};

/** PATH 里要找的命令名 */
const PATH_NAMES: Record<BrowserId, string[]> = {
  chrome: ['chrome', 'google-chrome', 'google-chrome-stable'],
  edge: ['msedge', 'microsoft-edge'],
  chromium: ['chromium', 'chromium-browser'],
};

/** 子进程探测统一入口：短超时、吞掉一切失败（命令不存在也算「没探测到」） */
function runProbe(file: string, args: string[]): string {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return '';
  }
}

/** 在 PATH 中找可执行文件：Windows 用 where，Linux/Mac 用 which */
function lookupInPath(id: BrowserId): string {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  for (const name of PATH_NAMES[id]) {
    const out = runProbe(cmd, [name]);
    for (const raw of out.split(/\r?\n/)) {
      const p = raw.trim().replace(/^"|"$/g, '');
      if (p && fs.existsSync(p)) return p;
    }
  }
  return '';
}

/** 一次查出所有「正在运行」的浏览器，避免每个浏览器各跑一遍 tasklist / pgrep */
function detectRunningBrowsers(): Set<BrowserId> {
  const out = new Set<BrowserId>();
  if (process.platform === 'win32') {
    const txt = runProbe('tasklist', ['/FO', 'CSV', '/NH']).toLowerCase();
    if (!txt) return out;
    for (const id of BROWSER_IDS) {
      if (PROCESS_NAMES[id].win.some((n) => txt.includes(n))) out.add(id);
    }
    return out;
  }
  for (const id of BROWSER_IDS) {
    if (PROCESS_NAMES[id].posix.some((n) => !!runProbe('pgrep', ['-x', n]))) out.add(id);
  }
  return out;
}

/** 固定安装目录之外再补一层：用户目录专属安装、/usr/local、snap 等 */
function extraSystemPaths(id: BrowserId): string[] {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const local = path.join(home, 'AppData', 'Local');
    if (id === 'chrome') return [path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')];
    if (id === 'edge') return [path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe')];
    return [path.join(local, 'Chromium', 'Application', 'chrome.exe')];
  }
  if (process.platform === 'darwin') {
    const apps = path.join(home, 'Applications');
    if (id === 'chrome') return [path.join(apps, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')];
    if (id === 'edge') return [path.join(apps, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge')];
    return [path.join(apps, 'Chromium.app', 'Contents', 'MacOS', 'Chromium')];
  }
  if (id === 'chrome') return ['/usr/local/bin/google-chrome', path.join(home, '.local', 'bin', 'google-chrome')];
  if (id === 'edge') return ['/usr/local/bin/microsoft-edge'];
  return ['/usr/local/bin/chromium', path.join(home, '.local', 'bin', 'chromium')];
}

/** 探测某个浏览器：咔咔珂安装目录 → 固定路径 → 用户目录 → PATH → 运行进程 */
function detectOne(id: BrowserId, running: Set<BrowserId>): SystemBrowser {
  const def = BROWSER_DEFS[id];
  const managedExe = managedBrowserExecutable(id);
  const managedFound = fs.existsSync(managedExe);
  // 咔咔珂安装的是宿主资产，必须优先命中才能拿到管理入口（模式配置 / 启停）；
  // 系统版只读即可。found / managed 字段语义不变：仍表示命中路径是否为托管可执行文件。
  const candidates = [
    ...(managedFound ? [managedExe] : []),
    ...(def.systemPaths[process.platform] || []),
    ...extraSystemPaths(id),
  ];
  let foundPath = '';
  let detectedVia: SystemBrowser['detectedVia'] = 'none';
  for (const p of candidates) {
    if (p && fs.existsSync(p)) { foundPath = p; detectedVia = 'path'; break; }
  }
  if (!foundPath) {
    const envPath = lookupInPath(id);
    if (envPath) { foundPath = envPath; detectedVia = 'path-env'; }
  }
  const runningProcess = running.has(id);
  if (!foundPath && runningProcess) detectedVia = 'process';
  // 路径未命中但进程在跑，也算「已验证 / 运行中」，前端据此给绿色
  const verified = !!foundPath || runningProcess;
  return {
    id,
    label: def.label,
    found: !!foundPath,
    executablePath: foundPath,
    managed: foundPath === managedExe,
    version: '',
    archiveBytes: def.download ? def.archiveBytes : 0,
    unpackedBytes: def.unpackedBytes,
    homepage: def.download.homepage,
    verified,
    runningProcess,
    detectedVia,
  };
}

/**
 * 强制重探（前端「重新检测」入口传 force=true）会绕过 3 秒缓存。
 * found / managed 的原有语义不变：只看磁盘上有没有可执行文件。
 */
export function detectBrowsers(force = false): SystemBrowser[] {
  const now = Date.now();
  if (!force && detectCache && now - detectCache.at < DETECT_TTL_MS) return detectCache.browsers;
  const running = detectRunningBrowsers();
  const browsers = (Object.keys(BROWSER_DEFS) as BrowserId[]).map((id) => detectOne(id, running));
  detectCache = { at: now, browsers };
  return browsers;
}

const CFT_API = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const EDGE_API = 'https://edgeupdates.microsoft.com/api/products?view=enterprise';

type DownloadInfo = { url: string; version: string };

/** CFT JSON 的真实 platform 值：linux-arm64 / linux64 / mac-arm64 / mac-x64 / win32 / win64 */
function cftPlatform(): string {
  if (process.platform === 'win32') return 'win64';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return process.arch === 'arm64' ? 'linux-arm64' : 'linux64';
}

/** Edge Products API 的真实平台值是 Windows / MacOS / Linux，不是 win64 / macos / linux64 */
function edgePlatform(): string {
  if (process.platform === 'win32') return 'Windows';
  if (process.platform === 'darwin') return 'MacOS';
  return 'Linux';
}
function edgeArch(): string {
  return process.arch === 'arm64' ? 'arm64' : 'x64';
}

/** Edge 各平台官方实际提供的产物名（msi / deb / rpm / pkg …），不是 zip */
const EDGE_ARTIFACT_NAMES: Record<string, string[]> = {
  win32: ['msi', 'msix'],
  darwin: ['pkg', 'dmg', 'zip'],
  linux: ['deb', 'rpm'],
};

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.json();
}

/** CFT 结构：channels.Stable.downloads[chrome|chrome-headless-shell][].platform/url */
function cftHit(data: Record<string, unknown>, key: string): { url: string } | null {
  const channels = data.channels as Record<string, unknown> | undefined;
  const stable = channels?.Stable as Record<string, unknown> | undefined;
  const downloads = stable?.downloads as Record<string, unknown> | undefined;
  const list = downloads?.[key];
  if (!Array.isArray(list)) return null;
  const plat = cftPlatform();
  const hit = (list as Array<Record<string, unknown>>).find(
    (x) => x.platform === plat && typeof x.url === 'string' && !!x.url,
  );
  return hit ? { url: String(hit.url) } : null;
}

async function resolveCftUrl(id: BrowserId): Promise<DownloadInfo | null> {
  const api = BROWSER_DEFS[id].download.versionApi || CFT_API;
  const data = await fetchJson(api) as Record<string, unknown>;
  const channels = data.channels as Record<string, unknown> | undefined;
  const stable = channels?.Stable as Record<string, unknown> | undefined;
  // CFT 没有独立 chromium 键；headless-shell 实测启动即退、无法常驻 CDP，
  // 因此 Chromium 与 Chrome 一样用完整 chrome 构建（--headless=new 常驻）。
  const key = 'chrome';
  const hit = cftHit(data, key);
  if (!hit) return null;
  return { url: hit.url, version: String(stable?.version ?? '') };
}

/**
 * Edge Products API 的真实结构：
 *   [].Product === 'Stable' → Releases[] → { Platform:'Windows'|'MacOS'|'Linux', Architecture:'x64'|'arm64', Artifacts:[] }
 *   Artifacts[].ArtifactName / Artifacts[].Location 才是产物名与下载直链。
 */
function pickEdgeRelease(data: unknown): {
  release: Record<string, unknown>;
  version: string;
  artifacts: Array<Record<string, unknown>>;
} | null {
  if (!Array.isArray(data)) return null;
  const stable = data.find((x) => x && typeof x === 'object'
    && (x as Record<string, unknown>).Product === 'Stable') as Record<string, unknown> | undefined;
  if (!stable) return null;
  const releases = stable.Releases;
  if (!Array.isArray(releases)) return null;
  const plat = edgePlatform();
  const arch = edgeArch();
  const candidates = (releases as Array<Record<string, unknown>>)
    .filter((r) => String(r.Platform ?? '') === plat)
    .filter((r) => {
      const a = String(r.Architecture ?? r.Arch ?? '').toLowerCase();
      return !a || a === arch || a === 'universal';
    });
  const release = candidates.find((r) => Array.isArray(r.Artifacts)
    && (r.Artifacts as unknown[]).some((a) => a && typeof a === 'object'
      && typeof (a as Record<string, unknown>).Location === 'string'));
  if (!release) return null;
  const artifacts = (release.Artifacts as Array<Record<string, unknown>>)
    .filter((a) => typeof a.Location === 'string' && !!a.Location);
  if (!artifacts.length) return null;
  return {
    release,
    version: String(release.ProductVersion ?? stable.ProductVersion ?? ''),
    artifacts,
  };
}

function edgeArtifactsOf(data: unknown): string[] {
  const picked = pickEdgeRelease(data);
  if (!picked) return [];
  return [...new Set(picked.artifacts.map((a) => String(a.ArtifactName ?? '').toLowerCase()).filter(Boolean))];
}

async function resolveEdgeUrl(): Promise<DownloadInfo | null> {
  const api = BROWSER_DEFS.edge.download.versionApi || EDGE_API;
  const picked = pickEdgeRelease(await fetchJson(api));
  if (!picked) return null;
  const names = EDGE_ARTIFACT_NAMES[process.platform] ?? [];
  const hit = picked.artifacts.find((a) => names.includes(String(a.ArtifactName ?? '').toLowerCase()));
  if (!hit) return null;
  return { url: String(hit.Location), version: picked.version };
}

async function resolveDownload(id: BrowserId): Promise<DownloadInfo> {
  let info: DownloadInfo | null = null;
  try {
    info = id === 'edge' ? await resolveEdgeUrl() : await resolveCftUrl(id);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${BROWSER_DEFS[id].label} 下载源探测失败：${msg}`);
  }
  if (!info?.url) {
    throw new Error(`${BROWSER_DEFS[id].label} 暂无适配 ${process.platform}/${process.arch} 的自动下载地址，请到官网手动安装`);
  }
  return info;
}

/* ── 安装前置校验：status 每次附带，60s 缓存；force 用于「重试探测」 ── */

const BLOCK_TTL_MS = 60_000;
let blockCache: { at: number; blocks: InstallBlocks } | null = null;

function blockUnsupported(reason: string, degraded = false): InstallBlock {
  return { downloadSourceOk: true, platformSupported: false, reason, degraded };
}
function blockUnreachable(reason: string, degraded = false): InstallBlock {
  return { downloadSourceOk: false, platformSupported: true, reason, degraded };
}
const BLOCK_OK: InstallBlock = { downloadSourceOk: true, platformSupported: true, reason: '', degraded: false };

async function probeInstallBlock(id: BrowserId): Promise<InstallBlock> {
  const api = BROWSER_DEFS[id].download.versionApi;
  if (!api) return blockUnsupported('未配置下载源');
  try {
    const data = await fetchJson(api);
    if (id === 'edge') {
      const names = edgeArtifactsOf(data);
      if (!names.length) return blockUnsupported('Edge 版本源未返回当前平台/架构的 Stable 构建');
      const detail = `Microsoft 官方源仅提供 ${names.join(' / ')} 系统安装包，需管理员权限，暂不支持咔咔珂免管理员托管安装`;
      return blockUnsupported(detail);
    }
    if (id === 'chromium') {
      // 用 CFT 完整 chrome 构建作为 Chromium 实现（headless-shell 无法常驻 CDP）。
      const hasChrome = !!cftHit(data as Record<string, unknown>, 'chrome');
      return hasChrome
        ? { ...BLOCK_OK }
        : blockUnsupported('Chrome for Testing 当前平台没有可用的 Chromium 构建包');
    }
    return cftHit(data as Record<string, unknown>, 'chrome') ? { ...BLOCK_OK } : blockUnsupported('Chrome for Testing 当前平台没有可用压缩包');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return blockUnreachable(`下载源探测失败：${msg}`);
  }
}

/** force=true 绕过缓存重新探测，用于 UI「重试探测」 */
export async function getInstallBlocks(force = false): Promise<InstallBlocks> {
  const now = Date.now();
  if (!force && blockCache && now - blockCache.at < BLOCK_TTL_MS) return { ...blockCache.blocks };
  const entries = await Promise.all(BROWSER_IDS.map(async (id) => [id, await probeInstallBlock(id)] as const));
  const blocks = Object.fromEntries(entries) as InstallBlocks;
  blockCache = { at: now, blocks };
  return { ...blocks };
}

/** 预检 Content-Length：流式下载 header 的次级总量来源；不支持 HEAD 时返回 0 */
async function preflightTotal(url: string, signal: AbortSignal): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
    const n = Number(res.headers.get('content-length') || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

/** total 无法从响应头 / HEAD 预检取得时为 0：percent 保持 0，前端显示不定态，不编造百分比 */
function downloadFile(url: string, dest: string, signal: AbortSignal, fallbackTotal = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const doFetch = async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
        const headerTotal = Number(res.headers.get('content-length') || 0);
        const total = Number.isFinite(headerTotal) && headerTotal > 0 ? headerTotal : fallbackTotal;
        setJob({ totalBytes: total });
        if (!res.body) throw new Error('下载响应无内容');
        reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let received = 0;
        let lastAt = Date.now();
        let lastBytes = 0;
        for (;;) {
          if (signal.aborted) throw new Error('cancelled');
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          chunks.push(value);
          received += value.length;
          // 真实进度：已接收字节 / 总字节；总量未知时保持 0（前端按 total<=0 显示「—」）
          const patch: Partial<InstallJob> = {
            percent: total > 0 ? Math.min(100, Math.round(received / total * 100)) : 0,
            downloadedBytes: received,
          };
          // 实时下行速度按 500ms 采样，避免每帧抖动
          const now = Date.now();
          if (now - lastAt >= 500) {
            patch.bytesPerSec = Math.max(0, Math.round((received - lastBytes) * 1000 / (now - lastAt)));
            lastAt = now;
            lastBytes = received;
          }
          setJob(patch);
        }
        if (signal.aborted) throw new Error('cancelled');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.concat(chunks));
        resolve();
      } catch (e) {
        try { await reader?.cancel(); } catch { /* 已中止时 cancel 可能抛错，忽略 */ }
        reject(e);
      }
    };
    void doFetch();
  });
}

/** 调用系统命令解压（zip / tar.gz），用 spawn 而非 unzip 库，避免引入依赖 */
function extract(archive: string, targetDir: string, type: 'zip' | 'tar.gz'): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(targetDir, { recursive: true });
    let file: string;
    let args: string[];
    if (process.platform === 'win32') {
      file = 'powershell';
      args = type === 'zip'
        ? ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${targetDir}' -Force`]
        : ['-NoProfile', '-Command', `tar -xzf '${archive}' -C '${targetDir}'`];
    } else if (type === 'zip') {
      file = 'unzip';
      args = ['-o', archive, '-d', targetDir];
    } else {
      file = 'tar';
      args = ['-xzf', archive, '-C', targetDir];
    }
    const child = spawn(file, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败（退出码 ${code}）`));
    });
  });
}

/** 安装系统依赖（Linux 必装；其余平台跳过）。失败只记日志不阻断 */
function installDeps(): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform !== 'linux') { resolve(); return; }
    const pkgs = ['libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2', 'libdrm2',
      'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2',
      'libgbm1', 'libasound2', 'libpango-1.0-0', 'libcairo2'];
    const child = spawn('sh', ['-c', `apt-get update -qq && apt-get install -y -qq ${pkgs.join(' ')}`], {
      stdio: 'ignore',
    });
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    child.on('error', () => finish());
    child.on('close', (code) => {
      if (code !== 0) rootLogger.warn('[渲染工具] 系统依赖自动安装未成功，请手动安装浏览器运行库');
      finish();
    });
  });
}

/** 开始安装。同步校验后立即返回，下载在后台跑；进度写入 job，日志写 rootLogger。
 *  关键：不能 await 整个下载，否则 HTTP 请求会挂到安装结束，前端拿不到响应就无法即时显示进度。 */
export async function startInstall(id: BrowserId): Promise<{ ok: boolean; message?: string }> {
  if (running || activeController || (job.phase !== 'idle' && job.phase !== 'done' && job.phase !== 'error')) {
    return { ok: false, message: '已有安装任务进行中' };
  }
  // 安装前置校验：与 status 同一份探测事实，防止绕过前端直接调接口。
  // 平台不支持 / 源不可达硬拦截；degraded（源降级）仍放行安装。
  const block = (await getInstallBlocks())[id];
  if (block && (!block.platformSupported || block.downloadSourceOk === false)) {
    return { ok: false, message: block.reason || '当前没有可用的官方自动安装包' };
  }
  const dir = managedBrowserDir(id);
  const lock = acquireSharpInstallLock(dir, 'kakake-browser');
  if (!lock.acquired) {
    return { ok: false, message: lock.reason || '无法获取安装锁' };
  }
  currentLockDir = dir;
  currentBrowser = id;
  const controller = new AbortController();
  activeController = controller;
  cancelRequested = false;

  setJob({
    phase: 'resolving', percent: 5, message: '正在解析下载地址…', error: '',
    browserId: id, downloadedBytes: 0, totalBytes: 0, bytesPerSec: 0, errorCode: '',
    startedAt: new Date().toISOString(), finishedAt: '',
  });
  rootLogger.info(`[渲染工具] 开始安装 ${BROWSER_DEFS[id].label}`);

  // 后台跑安装，函数立即返回让接口响应；前端轮询看到 resolving 就即时显示进度条。
  void runInstall(id, dir, controller);
  return { ok: true };
}

/** 后台安装主体：下载 → 解压 → 依赖 → 校验，进度写 job */
async function runInstall(id: BrowserId, dir: string, controller: AbortController): Promise<void> {
  const tmpDir = path.join(PATHS.tmp, `browser-${id}-${Date.now()}`);
  const archive = path.join(tmpDir, id === 'edge' ? 'edge.bin' : 'browser.zip');

  timeoutTimer = setTimeout(() => {
    if (cancelRequested) return;
    if (running) { try { running.kill(); } catch { /* ignore */ } }
    if (!controller.signal.aborted) controller.abort(new Error('timeout'));
    finishJob('error', '安装超时', '网络或下载源不可达', 'timeout');
  }, MAX_TIMEOUT_MS);

  try {
    const info = await resolveDownload(id);
    // 总量优先级：流式响应 content-length → HEAD 预检 Content-Length → 都拿不到则 total=0（前端 archiveBytes 仅作展示估算）
    const preflightBytes = await preflightTotal(info.url, controller.signal);
    setJob({
      phase: 'downloading', percent: 0, totalBytes: preflightBytes,
      message: `正在下载 ${BROWSER_DEFS[id].label} ${info.version || ''}…`,
    });
    rootLogger.info(`[渲染工具] ${id} 下载地址: ${info.url.slice(0, 120)}…`);
    await downloadFile(info.url, archive, controller.signal, preflightBytes);

    // 下载完成后 percent 保持 100；后续阶段由前端切成 pulse 不定态 + 阶段文字，不展示假的中间百分比。
    setJob({ phase: 'extracting', percent: 100, message: '正在解压…' });
    await extract(archive, dir, BROWSER_DEFS[id].download.archive);

    setJob({ phase: 'deps', percent: 100, message: '正在检查运行依赖…' });
    await installDeps();

    setJob({ phase: 'verifying', percent: 100, message: '正在校验…' });
    if (!fs.existsSync(managedBrowserExecutable(id))) {
      throw new Error('解压完成但未找到可执行文件，安装包结构可能已变化');
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(managedBrowserExecutable(id), 0o755);
    }

    finishJob('done', `${BROWSER_DEFS[id].label} 安装完成`, '');
    rootLogger.info(`[渲染工具] ${BROWSER_DEFS[id].label} 安装完成: ${dir}`);
    // 桥接到 Puppeteer 插件的标准检测路径，插件零改动即可检测到咔咔珂安装的浏览器
    const bridged = syncPuppeteerBridge();
    if (bridged) rootLogger.info(`[渲染工具] 已将 ${bridged} 桥接给 Puppeteer 插件`);
  } catch (e) {
    if (job.errorCode === 'cancelled' || job.errorCode === 'timeout') {
      // 取消 / 超时已由 cancelInstall / 定时器落地，这里不覆盖结局
    } else if (cancelRequested || controller.signal.aborted) {
      finishJob('error', '安装已取消', '用户主动取消安装', 'cancelled');
    } else {
      const msg = e instanceof Error ? e.message : String(e);
      finishJob('error', '安装失败', msg, 'install-failed');
      rootLogger.error(`[渲染工具] ${id} 安装失败:`, msg);
    }
  } finally {
    if (activeController === controller) activeController = null;
    cancelRequested = false;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/**
 * 取消安装：只对 resolving / downloading 阶段生效（解压、依赖、校验不可取消，避免半残安装）。
 * 真正 abort fetch 流，结局用 phase='error' + errorCode='cancelled' 表达。
 */
export function cancelInstall(): { ok: boolean; message: string } {
  if (!activeController || cancelRequested) return { ok: false, message: '当前没有可取消的安装任务' };
  if (job.phase !== 'resolving' && job.phase !== 'downloading') {
    return { ok: false, message: '当前阶段不可取消，请等待安装结束' };
  }
  cancelRequested = true;
  try { activeController.abort(new Error('cancelled')); } catch { /* ignore */ }
  if (job.errorCode !== 'cancelled') {
    finishJob('error', '安装已取消', '用户主动取消安装', 'cancelled');
  }
  rootLogger.info(`[渲染工具] ${currentBrowser || '浏览器'} 安装已取消`);
  return { ok: true, message: '安装已取消' };
}

function finishJob(phase: 'done' | 'error', message: string, error: string, errorCode = ''): void {
  if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  running = null;
  if (currentLockDir) { releaseSharpInstallLock(currentLockDir); currentLockDir = ''; }
  setJob({
    phase,
    percent: phase === 'done' ? 100 : job.percent,
    message, error, errorCode,
    finishedAt: new Date().toISOString(),
  });
  currentBrowser = '';
}

/** 卸载咔咔珂安装的浏览器（仅托管版本，不碰系统自带） */
export function uninstall(id: BrowserId): { ok: boolean; message: string } {
  const dir = managedBrowserDir(id);
  if (!fs.existsSync(dir)) return { ok: true, message: '无需卸载：咔咔珂未安装该浏览器' };
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    removePuppeteerBridge(id);
    rootLogger.info(`[渲染工具] 已卸载 ${BROWSER_DEFS[id].label}`);
    return { ok: true, message: `${BROWSER_DEFS[id].label} 已卸载` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    rootLogger.error(`[渲染工具] 卸载 ${id} 失败:`, msg);
    return { ok: false, message: msg };
  }
}
