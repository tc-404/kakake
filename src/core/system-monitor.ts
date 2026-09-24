import os from 'node:os';
import fs from 'node:fs/promises';
import { PATHS } from '../paths.js';
import { getFrameworkVersion } from '../admin/agreement.service.js';
import {
  getAvailableMemoryBytes,
  getCpuMaxSpeedMHz,
  getCpuModel,
  getOnlineCpuCount,
  getPhysicalCpuCount,
  getRuntimeKind,
  getRuntimeLabel,
} from './runtime-env.js';

export type SystemMetrics = {
  time: number;
  /** 咔珂进程运行时长（秒） */
  uptimeSec: number;
  /** 系统开机运行时长（秒），os.uptime() */
  systemUptimeSec: number;
  frameworkVersion: string;
  host: {
    hostname: string;
    platform: string;
    platformLabel: string;
    /** 运行环境类别：windows / macos / linux / termux / android */
    runtime: string;
    release: string;
    arch: string;
    type: string;
    nodeVersion: string;
  };
  cpu: {
    /** 本进程 CPU 占用（相对单核，已按核数归一到 0–100 量级） */
    processPercent: number;
    /** 整机所有核心的总占用（0–100），跨采样间隔统计 idle/total 得出 */
    systemPercent: number;
    /** 每个逻辑核心各自的占用（0–100），跨采样间隔得出；用于核心点阵可视化 */
    perCore: number[];
    /** 物理存在的核心数（安卓会下线空闲核，这里取不受在线状态影响的值） */
    cores: number;
    /** 当前在线、正在被调度的核心数；安卓上会小于 cores */
    coresOnline: number;
    model: string;
    speedMHz: number;
  };
  memory: {
    /** 本进程 RSS 占系统总内存百分比 */
    processPercent: number;
    processRssBytes: number;
    processHeapUsedBytes: number;
    /**
     * 咔咔自身 Node.js 进程占用（即本进程；不含机器上其它 node）
     * 与 processRss* 同源，供前端单独着色展示
     */
    nodeRssBytes: number;
    nodePercent: number;
    nodeHeapUsedBytes: number;
    systemUsedBytes: number;
    systemTotalBytes: number;
    systemPercent: number;
  };
  disk: {
    /** 项目所在卷已用百分比 */
    usedPercent: number;
    usedBytes: number;
    totalBytes: number;
    freeBytes: number;
    path: string;
  };
};

let prevCpu = process.cpuUsage();
let prevHr = process.hrtime.bigint();
let cpuPrimed = false;

function sampleProcessCpuPercent(): number {
  if (!cpuPrimed) {
    prevCpu = process.cpuUsage();
    prevHr = process.hrtime.bigint();
    cpuPrimed = true;
    return 0;
  }

  const diff = process.cpuUsage(prevCpu);
  const nowHr = process.hrtime.bigint();
  const elapsedNs = Number(nowHr - prevHr);
  prevCpu = process.cpuUsage();
  prevHr = nowHr;

  if (!Number.isFinite(elapsedNs) || elapsedNs <= 0) return 0;
  // user/system 为微秒；elapsed 为纳秒
  const elapsedUs = elapsedNs / 1000;
  // 用物理核数归一：安卓的在线核数会随负载抖动，拿它做分母会让曲线无故跳动
  const cores = getPhysicalCpuCount();
  const percent = ((diff.user + diff.system) / elapsedUs) * 100 / cores;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

/** 累计所有核心的 idle 与 total 时钟节拍 */
function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

let prevCpuTotals = cpuTotals();
let sysCpuPrimed = false;

/**
 * 整机 CPU 总占用：对比两次采样的 idle/total 增量。
 * 首帧无基准返回 0，之后每次刷新给出区间平均占用（含系统上所有进程）。
 */
function sampleSystemCpuPercent(): number {
  const now = cpuTotals();
  if (!sysCpuPrimed) {
    prevCpuTotals = now;
    sysCpuPrimed = true;
    return 0;
  }
  const idleDiff = now.idle - prevCpuTotals.idle;
  const totalDiff = now.total - prevCpuTotals.total;
  prevCpuTotals = now;
  if (totalDiff <= 0) return 0;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return clampPercent(usage);
}

/** 每核 idle/total 快照 */
function perCoreTotals(): { idle: number; total: number }[] {
  return os.cpus().map((cpu) => {
    const t = cpu.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.idle + t.irq };
  });
}

let prevPerCore = perCoreTotals();
let perCorePrimed = false;

/**
 * 每个逻辑核心各自的占用。首帧无基准返回全 0；
 * 核心数变化（安卓下线核）时重置基准，避免错位。
 */
function sampledPerCorePercent(): number[] {
  const now = perCoreTotals();
  if (!perCorePrimed || prevPerCore.length !== now.length) {
    prevPerCore = now;
    perCorePrimed = true;
    return now.map(() => 0);
  }
  const out = now.map((cur, i) => {
    const prev = prevPerCore[i];
    const idleDiff = cur.idle - prev.idle;
    const totalDiff = cur.total - prev.total;
    if (totalDiff <= 0) return 0;
    return clampPercent((1 - idleDiff / totalDiff) * 100);
  });
  prevPerCore = now;
  return out;
}

async function sampleDisk(rootPath: string): Promise<SystemMetrics['disk']> {
  try {
    const s = await fs.statfs(rootPath);
    const bsize = Number(s.bsize || 0);
    const blocks = Number(s.blocks || 0);
    const bavail = Number(s.bavail || 0);
    const totalBytes = blocks * bsize;
    const freeBytes = bavail * bsize;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? clampPercent((usedBytes / totalBytes) * 100) : 0;
    return {
      usedPercent,
      usedBytes,
      totalBytes,
      freeBytes,
      path: rootPath,
    };
  } catch {
    return {
      usedPercent: 0,
      usedBytes: 0,
      totalBytes: 0,
      freeBytes: 0,
      path: rootPath,
    };
  }
}

function platformLabel(platform: string, release: string): string {
  switch (platform) {
    case 'win32':
      return `Windows ${release}`;
    case 'darwin':
      return `macOS ${release}`;
    default:
      // linux / android（Termux）由 runtime-env 统一给出可读名
      return getRuntimeLabel();
  }
}

/** 采集本进程 + 宿主卷指标（轻量，可频繁调用） */
export async function collectSystemMetrics(): Promise<SystemMetrics> {
  const mem = process.memoryUsage();
  const total = os.totalmem();
  const free = getAvailableMemoryBytes();
  const systemUsed = Math.max(0, total - free);
  const cpus = os.cpus();
  const platform = os.platform();
  const release = os.release();

  const disk = await sampleDisk(PATHS.root);

  return {
    time: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    systemUptimeSec: Math.floor(os.uptime()),
    frameworkVersion: getFrameworkVersion(),
    host: {
      hostname: os.hostname(),
      platform,
      platformLabel: platformLabel(platform, release),
      runtime: getRuntimeKind(),
      release,
      arch: os.arch(),
      type: os.type(),
      nodeVersion: process.version,
    },
    cpu: {
      processPercent: sampleProcessCpuPercent(),
      systemPercent: sampleSystemCpuPercent(),
      perCore: sampledPerCorePercent(),
      cores: getPhysicalCpuCount(),
      coresOnline: getOnlineCpuCount(),
      model: getCpuModel() || cpus[0]?.model?.trim() || 'CPU',
      speedMHz: Number(cpus[0]?.speed) || getCpuMaxSpeedMHz(),
    },
    memory: {
      processPercent: total > 0 ? clampPercent((mem.rss / total) * 100) : 0,
      processRssBytes: mem.rss,
      processHeapUsedBytes: mem.heapUsed,
      // 仅本咔咔 Node 进程，不汇总系统上其它 node
      nodeRssBytes: mem.rss,
      nodePercent: total > 0 ? clampPercent((mem.rss / total) * 100) : 0,
      nodeHeapUsedBytes: mem.heapUsed,
      systemUsedBytes: systemUsed,
      systemTotalBytes: total,
      systemPercent: total > 0 ? clampPercent((systemUsed / total) * 100) : 0,
    },
    disk,
  };
}
