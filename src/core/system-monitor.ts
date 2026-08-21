import os from 'node:os';
import fs from 'node:fs/promises';
import { PATHS } from '../paths.js';
import { getFrameworkVersion } from '../admin/agreement.service.js';

export type SystemMetrics = {
  time: number;
  uptimeSec: number;
  frameworkVersion: string;
  host: {
    hostname: string;
    platform: string;
    platformLabel: string;
    release: string;
    arch: string;
    type: string;
    nodeVersion: string;
  };
  cpu: {
    /** 本进程 CPU 占用（相对单核，已按核数归一到 0–100 量级） */
    processPercent: number;
    cores: number;
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
  const cores = Math.max(1, os.cpus().length);
  const percent = ((diff.user + diff.system) / elapsedUs) * 100 / cores;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
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
    case 'linux':
      return `Linux ${release}`;
    default:
      return `${platform} ${release}`.trim();
  }
}

/** 采集本进程 + 宿主卷指标（轻量，可频繁调用） */
export async function collectSystemMetrics(): Promise<SystemMetrics> {
  const mem = process.memoryUsage();
  const total = os.totalmem();
  const free = os.freemem();
  const systemUsed = Math.max(0, total - free);
  const cpus = os.cpus();
  const platform = os.platform();
  const release = os.release();

  const disk = await sampleDisk(PATHS.root);

  return {
    time: Date.now(),
    uptimeSec: Math.floor(process.uptime()),
    frameworkVersion: getFrameworkVersion(),
    host: {
      hostname: os.hostname(),
      platform,
      platformLabel: platformLabel(platform, release),
      release,
      arch: os.arch(),
      type: os.type(),
      nodeVersion: process.version,
    },
    cpu: {
      processPercent: sampleProcessCpuPercent(),
      cores: Math.max(1, cpus.length),
      model: cpus[0]?.model?.trim() || 'CPU',
      speedMHz: Number(cpus[0]?.speed) || 0,
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
