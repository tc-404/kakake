import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import {
  BROWSER_DEFS,
  BROWSER_IDS,
  DEFAULT_BROWSER_PORTS,
  managedBrowserExecutable,
  type BrowserId,
  type BrowserMode,
} from '../tools/browser-defs.js';

/** 单个浏览器的运行配置（持久化） */
export interface BrowserSetting {
  mode: BrowserMode;
  port: number;
  /** idle 模式：拉起后无操作的超时（秒） */
  idleGraceSec: number;
  /** idle 模式：有过操作后的空闲超时（秒） */
  idleActiveSec: number;
  headless: boolean;
  extraArgs: string;
}

export type BrowserSettings = Record<BrowserId, BrowserSetting>;

const DEFAULT_SETTING: Omit<BrowserSetting, 'port'> = {
  mode: 'idle',
  idleGraceSec: 180,
  idleActiveSec: 30,
  headless: true,
  extraArgs: '',
};

function defaultSettings(): BrowserSettings {
  const out = {} as BrowserSettings;
  for (const id of BROWSER_IDS) {
    out[id] = {
      ...DEFAULT_SETTING,
      port: DEFAULT_BROWSER_PORTS[id],
    };
  }
  return out;
}

function normalizeSettings(raw: unknown): BrowserSettings {
  const out = defaultSettings();
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const id of BROWSER_IDS) {
    const item = obj[id];
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const s = out[id];
    if (r.mode === 'always' || r.mode === 'plugin' || r.mode === 'idle') s.mode = r.mode;
    const port = Number(r.port);
    if (Number.isInteger(port) && port > 1024 && port < 65535) s.port = port;
    const grace = Number(r.idleGraceSec);
    if (Number.isFinite(grace) && grace >= 5 && grace <= 86400) s.idleGraceSec = grace;
    const active = Number(r.idleActiveSec);
    if (Number.isFinite(active) && active >= 3 && active <= 86400) s.idleActiveSec = active;
    if (typeof r.headless === 'boolean') s.headless = r.headless;
    if (typeof r.extraArgs === 'string') s.extraArgs = r.extraArgs.slice(0, 2000);
  }
  return out;
}

/**
 * watchdog 守护脚本（内联，跨 win32/linux/darwin 通用，无需原生模块）。
 *
 * 原理：主进程 spawn 一个 watchdog 子进程并持有它的 stdin 写端；watchdog 再 spawn
 * 真正的浏览器。主进程无论「正常退出 / 崩溃 / 被 SIGKILL / 断电」，OS 都会关闭它
 * 持有的所有 fd，watchdog 的 stdin 随即收到 EOF → 立即回收浏览器进程组。
 * 这是操作系统级保证，比平台专有的 Job Object 更通用。
 *
 * - POSIX：浏览器以 detached 独立进程组启动，watchdog 用 process.kill(-pid) 杀整组
 * - Windows：用 taskkill /T /F 杀进程树
 * - watchdog 通过 stdout 第一行回报浏览器 PID；浏览器退出后 watchdog 自行退出
 */
const WATCHDOG_SCRIPT = `
const { spawn } = require('node:child_process');
let cfg;
// node -e 模式下第一个用户参数在 argv[1]（argv[0] 是 node 可执行文件路径）
try { cfg = JSON.parse(process.argv[1]); } catch { process.exit(1); }
const { exe, args, cwd, platform } = cfg;
let browser;
try {
  browser = spawn(exe, args, {
    cwd,
    detached: platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  });
} catch { process.exit(1); }
try { process.stdout.write(String(browser.pid) + String.fromCharCode(10)); } catch {}
let killed = false;
function killBrowser() {
  if (killed || !browser || !browser.pid) return;
  killed = true;
  try {
    if (platform === 'win32') {
      const t = spawn('taskkill', ['/pid', String(browser.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      t.on('exit', () => process.exit(0));
      setTimeout(() => process.exit(0), 4000).unref?.();
    } else {
      try { process.kill(-browser.pid, 'SIGTERM'); } catch {}
      const t = setTimeout(() => { try { process.kill(-browser.pid, 'SIGKILL'); } catch {} process.exit(0); }, 2000);
      t.unref?.();
    }
  } catch { process.exit(0); }
}
// 主进程 stdin 关闭 = 主进程已死（或被要求停止）
process.stdin.resume();
process.stdin.on('end', killBrowser);
process.stdin.on('close', killBrowser);
// 浏览器自行退出 → watchdog 也退出
browser.on('exit', () => process.exit(0));
browser.on('error', () => process.exit(0));
`;

/** 运行时状态（内存，不持久化） */
interface Runtime {
  /** watchdog 进程句柄（不是浏览器本体） */
  child: ChildProcess | null;
  /** 真实浏览器 PID（由 watchdog 回报） */
  browserPid: number;
  starting: boolean;
  startedAt: number;
  lastActiveAt: number;
  /** plugin 模式：持有者集合 pluginId -> 令牌；引用计数即集合大小 */
  holders: Map<string, number>;
  /** idle 模式的自动关闭计时器 */
  idleTimer: NodeJS.Timeout | null;
  /** 是否曾有过操作（决定用 graceSec 还是 activeSec） */
  everActive: boolean;
}

function newRuntime(): Runtime {
  return {
    child: null,
    browserPid: 0,
    starting: false,
    startedAt: 0,
    lastActiveAt: 0,
    holders: new Map(),
    idleTimer: null,
    everActive: false,
  };
}

/** 对外展示的单个浏览器状态 */
export interface BrowserStatus {
  id: BrowserId;
  label: string;
  setting: BrowserSetting;
  running: boolean;
  pid: number | null;
  cdpUrl: string;
  /** plugin 模式下的持有插件列表 */
  holders: string[];
  startedAt: number;
  idleRemainSec: number;
}

export type StartResult =
  | { ok: true; id: BrowserId; cdpUrl: string; pid: number; mode: BrowserMode }
  | { ok: false; message: string };

class BrowserService {
  private settings: BrowserSettings | null = null;
  private runtimes = new Map<BrowserId, Runtime>();
  private initTried = false;

  private rt(id: BrowserId): Runtime {
    let r = this.runtimes.get(id);
    if (!r) {
      r = newRuntime();
      this.runtimes.set(id, r);
    }
    return r;
  }

  getSettings(): BrowserSettings {
    if (this.settings) return this.settings;
    const raw = readJsonSafe<unknown>(PATHS.browsers, null, { label: 'browsers.json' });
    this.settings = normalizeSettings(raw);
    return this.settings;
  }

  saveSettings(raw: unknown): BrowserSettings {
    const next = normalizeSettings(raw);
    writeJsonAtomic(PATHS.browsers, next, { trailingNewline: true });
    this.settings = next;
    rootLogger.info('[渲染工具] 浏览器配置已保存');
    // 模式被改：常驻模式要立刻拉起；非对应模式清理自动计时器
    for (const id of BROWSER_IDS) {
      const r = this.rt(id);
      if (next[id].mode === 'always') {
        if (!r.child) void this.start(id, 'system');
      } else if (r.idleTimer) {
        clearTimeout(r.idleTimer);
        r.idleTimer = null;
      }
    }
    return next;
  }

  /** 宿主启动时调用：拉起所有「常驻」模式的浏览器 */
  initOnBoot(): void {
    if (this.initTried) return;
    this.initTried = true;
    const s = this.getSettings();
    for (const id of BROWSER_IDS) {
      if (s[id].mode === 'always') void this.start(id, 'system');
    }
  }

  getStatus(id: BrowserId): BrowserStatus {
    const r = this.rt(id);
    const s = this.getSettings()[id];
    let idleRemainSec = 0;
    if (r.idleTimer && r.lastActiveAt) {
      const timeout = (r.everActive ? s.idleActiveSec : s.idleGraceSec) * 1000;
      idleRemainSec = Math.max(0, Math.ceil((r.lastActiveAt + timeout - Date.now()) / 1000));
    }
    return {
      id,
      label: BROWSER_DEFS[id].label,
      setting: { ...s },
      running: !!r.child && !r.child.killed,
      pid: r.browserPid || r.child?.pid || null,
      cdpUrl: `http://127.0.0.1:${s.port}`,
      holders: [...r.holders.keys()],
      startedAt: r.startedAt,
      idleRemainSec,
    };
  }

  getAllStatus(): BrowserStatus[] {
    return BROWSER_IDS.map((id) => this.getStatus(id));
  }

  /** 拉起浏览器进程。source 用于 plugin 模式的持有者标识 */
  async start(id: BrowserId, source = 'manual'): Promise<StartResult> {
    const r = this.rt(id);
    const s = this.getSettings()[id];

    if (r.child && !r.child.killed && r.child.exitCode === null) {
      this.markActive(id);
      if (s.mode === 'plugin' && source !== 'system' && source !== 'manual') {
        r.holders.set(source, Date.now());
      }
      return {
        ok: true, id, cdpUrl: `http://127.0.0.1:${s.port}`,
        pid: r.child.pid ?? 0, mode: s.mode,
      };
    }
    if (r.starting) return { ok: false, message: `${id} 正在启动中，请稍候` };

    const exe = managedBrowserExecutable(id);
    if (!fs.existsSync(exe)) {
      return { ok: false, message: `${BROWSER_DEFS[id].label} 尚未由咔咔珂安装，或安装不完整` };
    }

    r.starting = true;
    try {
      const userDataDir = path.join(PATHS.browsersDir, id, '.profile');
      fs.mkdirSync(userDataDir, { recursive: true });
      const args = [
        `--remote-debugging-port=${s.port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-gpu',
        '--disable-dev-shm-usage',
      ];
      if (s.headless) args.push('--headless=new');
      // 实测：Chrome for Testing v158 在 Windows 上不带 --no-sandbox 会启动即崩
      // （STATUS_BREAKPOINT，CDP 端口起不来）；无头/受限环境下沙箱无意义，三平台统一关闭。
      args.push('--no-sandbox', '--disable-setuid-sandbox');
      if (s.extraArgs.trim()) args.push(...s.extraArgs.trim().split(/\s+/));

      // 通过 watchdog 启动：watchdog 持有浏览器进程，主进程持有 watchdog 的 stdin 生命线。
      // 主进程一旦退出（含崩溃 / SIGKILL），stdin 关闭 → watchdog 自动回收浏览器进程组。
      const cfg = JSON.stringify({ exe, args, cwd: path.dirname(exe), platform: process.platform });
      const watchdog = spawn(process.execPath, ['-e', WATCHDOG_SCRIPT, cfg], {
        cwd: path.dirname(exe),
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env: { ...process.env },
      });
      r.child = watchdog;
      r.browserPid = 0;
      r.startedAt = Date.now();
      r.lastActiveAt = Date.now();
      r.everActive = false;
      if (s.mode === 'plugin' && source !== 'system' && source !== 'manual') {
        r.holders.set(source, Date.now());
      }

      // watchdog 第一行 stdout 回报真实浏览器 PID
      let pidBuf = '';
      watchdog.stdout?.on('data', (chunk: Buffer) => {
        pidBuf += chunk.toString();
        const nl = pidBuf.indexOf('\n');
        if (nl >= 0) {
          const pid = Number(pidBuf.slice(0, nl).trim());
          if (Number.isFinite(pid) && pid > 0) r.browserPid = pid;
          watchdog.stdout?.removeAllListeners('data');
        }
      });

      watchdog.on('error', (err) => {
        rootLogger.error(`[渲染工具] ${id} watchdog 启动失败:`, err);
        this.clearRuntime(id);
      });
      watchdog.on('exit', (code, signal) => {
        if (r.child === watchdog) {
          rootLogger.warn(`[渲染工具] ${id} 进程退出 code=${code} signal=${signal ?? '-'}（watchdog 已回收浏览器）`);
          this.clearRuntime(id);
        }
      });

      // 等待 CDP 端口就绪（最多 8 秒）
      const ready = await this.waitCdp(s.port, 8000);
      if (!ready) {
        this.stopProcess(id);
        return { ok: false, message: `${BROWSER_DEFS[id].label} 进程已启动但调试端口 ${s.port} 未就绪` };
      }

      rootLogger.info(`[渲染工具] ${BROWSER_DEFS[id].label} 已拉起 pid=${r.browserPid || watchdog.pid} port=${s.port} mode=${s.mode}`);
      this.scheduleIdle(id);
      return {
        ok: true, id, cdpUrl: `http://127.0.0.1:${s.port}`,
        pid: r.browserPid || watchdog.pid || 0, mode: s.mode,
      };
    } finally {
      r.starting = false;
    }
  }

  private async waitCdp(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal: AbortSignal.timeout(1000),
        });
        if (res.ok) return true;
      } catch { /* 端口还没起来，继续轮询 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }

  /** 标记一次操作：刷新空闲计时（idle 模式） */
  markActive(id: BrowserId): void {
    const r = this.rt(id);
    const s = this.getSettings()[id];
    r.lastActiveAt = Date.now();
    r.everActive = true;
    if (s.mode === 'idle') this.scheduleIdle(id);
  }

  /** plugin 模式：插件登记持有；未运行时自动拉起 */
  async acquire(id: BrowserId, pluginId: string): Promise<StartResult> {
    const s = this.getSettings()[id];
    if (s.mode !== 'plugin') {
      return { ok: false, message: `${BROWSER_DEFS[id].label} 当前不是插件模式` };
    }
    const key = pluginId || 'anonymous';
    const r = this.rt(id);
    if (!r.child || r.child.killed || r.child.exitCode !== null) {
      const res = await this.start(id, key);
      if (!res.ok) return res;
      r.holders.set(key, Date.now());
      return res;
    }
    r.holders.set(key, Date.now());
    this.markActive(id);
    return {
      ok: true, id, cdpUrl: `http://127.0.0.1:${s.port}`,
      pid: r.browserPid || r.child.pid || 0, mode: s.mode,
    };
  }

  /** plugin 模式：插件归还；引用清零即关闭 */
  release(id: BrowserId, pluginId: string): boolean {
    const r = this.rt(id);
    r.holders.delete(pluginId || 'anonymous');
    rootLogger.info(`[渲染工具] ${id} 释放持有者 ${pluginId}，剩余 ${r.holders.size}`);
    if (r.holders.size === 0 && this.getSettings()[id].mode === 'plugin') {
      this.stopProcess(id);
      return true;
    }
    return false;
  }

  /** 插件卸载/重载时：清掉它的所有持有 */
  releaseByPlugin(pluginId: string): void {
    const key = pluginId || 'anonymous';
    for (const id of BROWSER_IDS) {
      const r = this.rt(id);
      if (r.holders.delete(key) && r.holders.size === 0 && this.getSettings()[id].mode === 'plugin') {
        rootLogger.info(`[渲染工具] 插件 ${pluginId} 已卸载，${id} 无持有者，自动关闭`);
        this.stopProcess(id);
      }
    }
  }

  private scheduleIdle(id: BrowserId): void {
    const r = this.rt(id);
    const s = this.getSettings()[id];
    if (s.mode !== 'idle' || !r.child) return;
    if (r.idleTimer) clearTimeout(r.idleTimer);
    const sec = r.everActive ? s.idleActiveSec : s.idleGraceSec;
    r.idleTimer = setTimeout(() => {
      r.idleTimer = null;
      if (!r.child) return;
      rootLogger.info(`[渲染工具] ${id} 空闲 ${sec}s 无操作，自动关闭`);
      this.stopProcess(id);
    }, sec * 1000);
  }

  stop(id: BrowserId): boolean {
    const r = this.rt(id);
    // 手动停止也算一次操作，避免 idle 计时器随后又触发
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
    return this.stopProcess(id);
  }

  private stopProcess(id: BrowserId): boolean {
    const r = this.rt(id);
    const watchdog = r.child;
    if (!watchdog) return false;
    const browserPid = r.browserPid;
    r.child = null;
    r.browserPid = 0;
    r.holders.clear();
    r.startedAt = 0;
    r.lastActiveAt = 0;
    r.everActive = false;
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
    // 关闭 watchdog 的 stdin → 它收到 EOF 走与「主进程退出」相同的回收逻辑，杀浏览器进程组。
    // 这是主路径；watchdog 里还有 2~4s 的 SIGKILL 兜底。
    try { watchdog.stdin?.end(); } catch { /* ignore */ }
    // 双保险：若 watchdog 已僵死（极端情况），直接从主进程再杀一次真实浏览器进程组。
    if (browserPid > 0) {
      killProcessGroup(browserPid);
    }
    // watchdog 自身收尾
    const killer = setTimeout(() => {
      try { if (process.platform !== 'win32') watchdog.kill('SIGKILL'); } catch { /* ignore */ }
    }, 5000);
    killer.unref?.();
    rootLogger.info(`[渲染工具] ${BROWSER_DEFS[id].label} 已停止 pid=${browserPid || watchdog.pid || '-'}`);
    return true;
  }

  async restart(id: BrowserId): Promise<StartResult> {
    this.stop(id);
    await new Promise((r) => setTimeout(r, 400));
    return this.start(id, 'manual');
  }

  /** 宿主优雅退出：关闭所有浏览器进程 */
  shutdown(): void {
    for (const id of BROWSER_IDS) this.stopProcess(id);
  }

  private clearRuntime(id: BrowserId): void {
    const r = this.rt(id);
    r.child = null;
    r.browserPid = 0;
    r.startedAt = 0;
    if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  }
}

/** 从主进程直接杀一个进程（组）：POSIX 用负 PID 杀整组，Windows 用 taskkill /T 杀进程树 */
function killProcessGroup(pid: number): void {
  if (!pid || pid <= 0) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* 已退出 */ } }
    }
  } catch { /* 已退出 */ }
}

export const browserService = new BrowserService();
