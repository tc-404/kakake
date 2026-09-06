import os from 'node:os';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

/**
 * 运行环境识别：Windows / macOS / Linux / Termux（安卓手机）。
 *
 * 只做“识别 + 事实描述”，不改变任何业务行为；调用方按需决定要不要分支。
 * Termux 里的 Node.js 是为安卓（bionic libc）构建的，`process.platform` 返回 'android'，
 * 这是与桌面 Linux 最可靠的区分点。
 */

export type RuntimeKind = 'windows' | 'macos' | 'linux' | 'termux' | 'android' | 'unknown';

/** Termux 默认前缀；用户改过 PREFIX 时以环境变量为准 */
const TERMUX_DEFAULT_PREFIX = '/data/data/com.termux/files/usr';

/** 安卓共享存储：不支持可执行位/符号链接，npm 与前端构建会在这里失败 */
const SHARED_STORAGE_PREFIXES = [
  '/sdcard',
  '/storage/emulated',
  '/storage/self',
  '/mnt/media_rw',
  '/mnt/runtime',
];

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MACOS = process.platform === 'darwin';
/** Node 自身就是安卓构建（Termux 原生环境即如此） */
export const IS_ANDROID = process.platform === 'android';

function detectTermuxPrefix(): string | null {
  const envPrefix = (process.env.PREFIX ?? '').trim();
  if (envPrefix && envPrefix.includes('com.termux')) return envPrefix;
  if (fs.existsSync(TERMUX_DEFAULT_PREFIX)) return TERMUX_DEFAULT_PREFIX;
  return null;
}

/** Termux 前缀（$PREFIX），非 Termux 为 null */
export const TERMUX_PREFIX: string | null = detectTermuxPrefix();

/** Termux 版本号（pkg 注入的 TERMUX_VERSION），拿不到为 null */
export const TERMUX_VERSION: string | null = (process.env.TERMUX_VERSION ?? '').trim() || null;

/**
 * 是否运行在 Termux 里。
 * 只要命中任一：安卓版 Node / $PREFIX 指向 com.termux / TERMUX_VERSION 存在。
 */
export const IS_TERMUX: boolean = IS_ANDROID || TERMUX_PREFIX !== null || TERMUX_VERSION !== null;

/** 桌面/服务器 Linux（排除安卓） */
export const IS_LINUX = process.platform === 'linux' && !IS_TERMUX;

/** 内核串里带 android 特征：Termux 内 proot-distro 起的 Debian 也会命中 */
export const IS_ANDROID_KERNEL = /android|-qgki|-perf\b/i.test(os.release());

export function getRuntimeKind(): RuntimeKind {
  if (IS_WINDOWS) return 'windows';
  if (IS_MACOS) return 'macos';
  if (IS_TERMUX) return 'termux';
  if (IS_ANDROID) return 'android';
  if (process.platform === 'linux') return 'linux';
  return 'unknown';
}

let androidReleaseCache: string | null | undefined;

/**
 * 安卓系统版本（如 "14"）。`os.release()` 给的是内核版本，对用户没意义，
 * 所以读一次 getprop；非安卓或取不到返回 null（结果缓存，不重复起进程）。
 */
export function getAndroidRelease(): string | null {
  if (androidReleaseCache !== undefined) return androidReleaseCache;
  androidReleaseCache = null;
  if (!IS_ANDROID && !IS_ANDROID_KERNEL) return androidReleaseCache;
  for (const bin of ['/system/bin/getprop', 'getprop']) {
    try {
      const r = spawnSync(bin, ['ro.build.version.release'], {
        encoding: 'utf-8',
        timeout: 2000,
        shell: false,
      });
      const out = (r.stdout ?? '').trim();
      if (r.status === 0 && out) {
        androidReleaseCache = out;
        break;
      }
    } catch {
      /* 取不到就算了，不影响启动 */
    }
  }
  return androidReleaseCache;
}

/** 给人看的运行环境名，例如「Termux · Android 14」 */
export function getRuntimeLabel(): string {
  const kind = getRuntimeKind();
  const release = os.release();
  switch (kind) {
    case 'windows':
      return `Windows ${release}`;
    case 'macos':
      return `macOS ${release}`;
    case 'linux':
      return `Linux ${release}`;
    case 'termux': {
      const android = getAndroidRelease();
      return android ? `Termux · Android ${android}` : 'Termux · Android';
    }
    case 'android': {
      const android = getAndroidRelease();
      return android ? `Android ${android}` : `Android ${release}`;
    }
    default:
      return `${process.platform} ${release}`.trim();
  }
}

/**
 * 路径是否落在安卓共享存储（/sdcard、/storage/emulated 等）。
 * 这些目录挂的是 FUSE/sdcardfs，没有可执行位、不支持符号链接，
 * npm install 与 Vite 构建会以各种奇怪的 EPERM/ENOTSUP 失败。
 */
export function isSharedStoragePath(target: string): boolean {
  if (!target) return false;
  const p = target.replace(/\\/g, '/');
  return SHARED_STORAGE_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/** 安卓非 root 无法监听 1024 以下端口 */
export function isPrivilegedPort(port: number): boolean {
  return Number.isFinite(port) && port > 0 && port < 1024;
}

// ==================== 硬件信息（安卓上 os.cpus() 不可靠，走 sysfs/procfs） ====================

const CPU_SYS_DIR = '/sys/devices/system/cpu';

/** 只有 Linux/安卓有 procfs 与 sysfs；其余平台直接跳过，免得每次采集都做无用的失败读取 */
const HAS_PROCFS = process.platform === 'linux' || process.platform === 'android';

function readTextSync(file: string): string | null {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    return raw || null;
  } catch {
    // sysfs/procfs 在安卓上可能被 SELinux 拦掉，读不到就当没有
    return null;
  }
}

/** 解析内核 CPU 清单格式（"0-7"、"0-3,6,7"、"0"）为核心数 */
function countCpuList(spec: string): number {
  let total = 0;
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) continue;
    const start = Number(m[1]);
    const end = m[2] === undefined ? start : Number(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    total += end - start + 1;
  }
  return total;
}

/** 统计 /sys/devices/system/cpu 下的 cpuN 目录数量 */
function countCpuDirs(): number {
  try {
    return fs.readdirSync(CPU_SYS_DIR).filter((name) => /^cpu\d+$/.test(name)).length;
  } catch {
    return 0;
  }
}

/** 统计 /proc/cpuinfo 里的 processor 行（只含在线核，作为最后兜底） */
function countProcCpuinfo(): number {
  const raw = readTextSync('/proc/cpuinfo');
  if (!raw) return 0;
  return (raw.match(/^processor\s*:/gim) ?? []).length;
}

let physicalCpuCache: number | undefined;

/**
 * 物理存在的 CPU 核心数。
 *
 * 安卓为省电会把空闲的核热插拔下线，而 `os.cpus()` 与 `/proc/cpuinfo` 反映的是
 * “当前在线”的核，所以待机或息屏时经常只剩 1 个，看着像是取错了。
 * 内核在 sysfs 里另有一份不随在线状态变化的清单（Linux sysfs ABI 文档）：
 *   present  —— 系统中确实存在的 CPU
 *   possible —— 已分配资源、可以被拉起来的 CPU
 * 因此优先读这两个，再退回目录枚举，最后才用 /proc/cpuinfo 与 os.cpus()。
 * 结果不随时间变化，缓存一次即可。
 */
export function getPhysicalCpuCount(): number {
  if (physicalCpuCache !== undefined) return physicalCpuCache;
  if (!HAS_PROCFS) {
    physicalCpuCache = Math.max(1, os.cpus().length);
    return physicalCpuCache;
  }

  const candidates: number[] = [];
  for (const file of ['present', 'possible']) {
    const raw = readTextSync(`${CPU_SYS_DIR}/${file}`);
    if (raw) candidates.push(countCpuList(raw));
  }
  candidates.push(countCpuDirs(), countProcCpuinfo(), os.cpus().length);

  // 取最大值：任一来源被 SELinux 拦掉会得到 0，而下线的核只会让某些来源偏小
  physicalCpuCache = Math.max(1, ...candidates.filter((n) => Number.isFinite(n) && n > 0));
  return physicalCpuCache;
}

/** 当前在线（正在被调度）的核心数；手机上会随负载变化，不缓存 */
export function getOnlineCpuCount(): number {
  if (!HAS_PROCFS) return Math.max(1, os.cpus().length);
  const raw = readTextSync(`${CPU_SYS_DIR}/online`);
  if (raw) {
    const n = countCpuList(raw);
    if (n > 0) return n;
  }
  const n = countProcCpuinfo();
  return n > 0 ? n : Math.max(1, os.cpus().length);
}

function getprop(key: string): string | null {
  for (const bin of ['/system/bin/getprop', 'getprop']) {
    try {
      const r = spawnSync(bin, [key], { encoding: 'utf-8', timeout: 2000, shell: false });
      const out = (r.stdout ?? '').trim();
      if (r.status === 0 && out) return out;
    } catch {
      /* 取不到就算了 */
    }
  }
  return null;
}

let cpuModelCache: string | null | undefined;

/**
 * CPU / SoC 名称。
 *
 * ARM 的 `/proc/cpuinfo` 没有 x86 那种 "model name" 字段，`os.cpus()[0].model`
 * 往往只给个占位串。安卓 12 起强制要求提供 ro.soc.* 属性，能直接拿到芯片型号。
 */
export function getCpuModel(): string | null {
  if (cpuModelCache !== undefined) return cpuModelCache;
  cpuModelCache = null;
  if (!IS_ANDROID && !IS_ANDROID_KERNEL) return cpuModelCache;

  const vendor = getprop('ro.soc.manufacturer');
  const model = getprop('ro.soc.model');
  const joined = [vendor, model].filter(Boolean).join(' ').trim();
  if (joined) {
    cpuModelCache = joined;
    return cpuModelCache;
  }

  // 老系统没有 ro.soc.*，退回主板平台号或 /proc/cpuinfo 的 Hardware 行
  const board = getprop('ro.board.platform');
  if (board && board !== 'unknown') {
    cpuModelCache = board;
    return cpuModelCache;
  }
  const raw = readTextSync('/proc/cpuinfo');
  const hw = raw ? /^Hardware\s*:\s*(.+)$/im.exec(raw) : null;
  if (hw?.[1]) cpuModelCache = hw[1].trim();
  return cpuModelCache;
}

let cpuSpeedCache: number | undefined;

/**
 * CPU 最高主频（MHz）。安卓上 `os.cpus()[0].speed` 基本是 0，
 * 改读 cpufreq 的 cpuinfo_max_freq（单位 kHz），大小核取最大值。
 */
export function getCpuMaxSpeedMHz(): number {
  if (cpuSpeedCache !== undefined) return cpuSpeedCache;
  cpuSpeedCache = 0;
  if (!HAS_PROCFS) return cpuSpeedCache;

  const files: string[] = [];
  try {
    for (const name of fs.readdirSync(`${CPU_SYS_DIR}/cpufreq`)) {
      if (/^policy\d+$/.test(name)) files.push(`${CPU_SYS_DIR}/cpufreq/${name}/cpuinfo_max_freq`);
    }
  } catch {
    /* 没有 cpufreq/policy* 就按 cpuN 逐个试 */
  }
  if (files.length === 0) {
    try {
      for (const name of fs.readdirSync(CPU_SYS_DIR)) {
        if (/^cpu\d+$/.test(name)) files.push(`${CPU_SYS_DIR}/${name}/cpufreq/cpuinfo_max_freq`);
      }
    } catch {
      /* 读不到就返回 0，前端会隐藏主频 */
    }
  }

  let maxKHz = 0;
  for (const file of files) {
    const raw = readTextSync(file);
    const khz = raw ? Number(raw) : 0;
    if (Number.isFinite(khz) && khz > maxKHz) maxKHz = khz;
  }
  cpuSpeedCache = maxKHz > 0 ? Math.round(maxKHz / 1000) : 0;
  return cpuSpeedCache;
}

/**
 * 可用内存字节数。
 *
 * `os.freemem()` 对应的是「完全空闲」的内存，而安卓/Linux 会主动把空闲内存拿去做
 * 文件缓存，这部分随时可回收。只看 freemem 会让手机常年显示 90% 以上占用。
 * 内核在 /proc/meminfo 里给了 MemAvailable，才是「不触发换页就能拿到的量」。
 */
export function getAvailableMemoryBytes(): number {
  if (!HAS_PROCFS) return os.freemem();
  const raw = readTextSync('/proc/meminfo');
  const m = raw ? /^MemAvailable:\s*(\d+)\s*kB$/im.exec(raw) : null;
  if (m) {
    const bytes = Number(m[1]) * 1024;
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
  }
  return os.freemem();
}

/** 一行式环境摘要，用于启动日志 */
export function describeRuntime(): string {
  const parts = [getRuntimeLabel(), os.arch(), `Node ${process.versions.node}`];
  if (IS_TERMUX && TERMUX_VERSION) parts.push(`Termux ${TERMUX_VERSION}`);
  return parts.join(' · ');
}