/**
 * 咔咔珂「整个进程树」内存统计。
 *
 * 背景：控制台原先显示的内存是 `process.memoryUsage().rss`——只算 main.mjs 这一个进程。
 * 但咔咔珂实际由一棵进程树组成：
 *   bootstrap.mjs(父) → main.mjs → { 浏览器 watchdog, 插件子进程, 浏览器进程... }
 * 用户在任务管理器里看到的「咔咔珂相关进程」总和远大于单进程 RSS，于是觉得数据是假的。
 *
 * 本模块从当前进程 pid 出发：
 *   - 向上追溯祖先（bootstrap）
 *   - 向下收集所有后代（watchdog / 插件 server / 浏览器进程）
 * 汇总整棵树的 RSS，返回总字节数与进程数。识别依据是真实现父子链，不靠进程名，
 * 因此不会把机器上其它无关 node 进程算进来。
 *
 * 采样走系统命令（Windows: PowerShell CIM；POSIX: ps），在【后台每 5 秒异步刷新】，
 * HTTP 接口读取纯内存缓存，绝不触发同步阻塞。Windows 的 CIM 查询要几百毫秒到数秒，
 * 若用 execFileSync 放在请求路径上会阻塞整个事件循环，拖慢所有接口——这是血泪教训。
 * 任何失败都优雅降级为「仅本进程 RSS」。
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { rootLogger } from './logger.js';

export interface ProcessTreeMemory {
  /** 整棵咔咔珂进程树的 RSS 总和（字节） */
  totalRssBytes: number;
  /** 进程树里的进程数（含本进程） */
  processCount: number;
  /** 本进程自身 RSS（字节） */
  selfRssBytes: number;
}

interface ProcInfo {
  pid: number;
  ppid: number;
  rss: number;
  /** 命令行（用于向上追溯时判定咔咔珂根边界） */
  cmd: string;
}

/** 规范化路径用于命令行匹配（转小写、统一斜杠）；取项目根的末段作为兜底标识 */
const ROOT_MARK = path.normalize(PATHS.root).toLowerCase();
const ROOT_BASENAME = path.basename(PATHS.root).toLowerCase();

/** 命令行是否属于咔咔珂（含项目根路径，或特征脚本名兜底） */
function isKakakeCmd(cmd: string): boolean {
  const c = cmd.toLowerCase().replace(/\//g, '\\');
  if (c.includes(ROOT_MARK.replace(/\//g, '\\')) || c.includes(ROOT_BASENAME)) return true;
  // bootstrap 用相对路径启动（node scripts\bootstrap.mjs），命令行不含项目路径，
  // 但这些特征脚本名只属于咔咔珂的启动链，据此识别。
  return ['bootstrap.mjs', 'main.mjs', 'start.bat', 'start.sh'].some((k) => c.includes(k));
}

/** 后台刷新间隔：进程数变化慢，5 秒足够，且大幅降低系统命令开销 */
const REFRESH_INTERVAL_MS = 5000;
/** 缓存值；HTTP 接口只读它，永不为读它而跑系统命令 */
let cache: ProcessTreeMemory | null = null;
/** 防止后台刷新重入 */
let refreshing = false;

function selfOnlyFallback(): ProcessTreeMemory {
  const rss = process.memoryUsage().rss;
  return { totalRssBytes: rss, processCount: 1, selfRssBytes: rss };
}

/** 异步列出所有进程的 pid / ppid / rss（字节）。绝不使用 execFileSync。 */
function listProcesses(): Promise<ProcInfo[]> {
  return new Promise((resolve) => {
    const platform = os.platform();
    const done = (rows: ProcInfo[]) => resolve(rows);
    try {
      if (platform === 'win32') {
        // PowerShell CIM：WorkingSetSize 即 RSS。通过 -Command 传入，避免引号转义问题。
        const script = [
          'Get-CimInstance Win32_Process',
          '| Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine',
          '| ConvertTo-Json -Compress',
        ].join(' ');
        execFile('powershell', ['-NoProfile', '-Command', script], {
          encoding: 'utf8', timeout: 8000, windowsHide: true,
        }, (err, out) => {
          if (err || !out) return done([]);
          try {
            const raw = JSON.parse(out) as unknown;
            const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
            done(list.map((r) => {
              const o = r as Record<string, unknown>;
              return {
                pid: Number(o.ProcessId) || 0,
                ppid: Number(o.ParentProcessId) || 0,
                rss: Number(o.WorkingSetSize) || 0,
                cmd: typeof o.CommandLine === 'string' ? o.CommandLine : '',
              };
            }).filter((p) => p.pid > 0));
          } catch { done([]); }
        });
        return;
      }
      // POSIX: ps -eo pid=,ppid=,rss=,args=（rss 单位 KB）
      execFile('ps', ['-eo', 'pid=,ppid=,rss=,args='], {
        encoding: 'utf8', timeout: 8000,
      }, (err, out) => {
        if (err || !out) return done([]);
        done(out.split(/\r?\n/).map((line) => {
          const m = line.trim().split(/\s+/);
          return {
            pid: Number(m[0]) || 0,
            ppid: Number(m[1]) || 0,
            rss: (Number(m[2]) || 0) * 1024,
            cmd: m.slice(3).join(' '),
          };
        }).filter((p) => p.pid > 0));
      });
    } catch {
      resolve([]);
    }
  });
}

/** 纯计算：从进程快照算出咔咔珂进程树内存（CPU 内运算，无 IO） */
function computeTree(procs: ProcInfo[]): ProcessTreeMemory {
  const selfRss = process.memoryUsage().rss;
  if (!procs.length) return selfOnlyFallback();

  const byPid = new Map<number, ProcInfo>();
  for (const p of procs) byPid.set(p.pid, p);

  // 1) 向上收集祖先链，但只纳入「属于咔咔珂」的祖先（bootstrap / start 启动器）。
  //    遇到不含 kakake 路径的祖先（如 WorkBuddy、explorer、shell）立即停止。
  const inTree = new Set<number>([process.pid]);
  let cur = byPid.get(process.pid);
  let guard = 0;
  while (cur && cur.ppid > 0 && cur.ppid !== cur.pid && guard++ < 64) {
    const parent = byPid.get(cur.ppid);
    if (!parent || inTree.has(parent.pid)) break;
    if (!isKakakeCmd(parent.cmd)) break;
    inTree.add(parent.pid);
    cur = parent;
  }

  // 2) 向下收集所有后代（watchdog / 插件 server / 浏览器进程）
  const childrenOf = new Map<number, number[]>();
  for (const p of procs) {
    if (p.ppid <= 0 || p.ppid === p.pid) continue;
    const list = childrenOf.get(p.ppid) || [];
    list.push(p.pid);
    childrenOf.set(p.ppid, list);
  }
  const stack = [process.pid];
  guard = 0;
  while (stack.length && guard++ < 10000) {
    const pid = stack.pop()!;
    for (const child of childrenOf.get(pid) || []) {
      if (inTree.has(child)) continue;
      const cp = byPid.get(child);
      if (cp && !isKakakeCmd(cp.cmd)) continue;
      inTree.add(child);
      stack.push(child);
    }
  }

  let total = 0;
  for (const pid of inTree) total += byPid.get(pid)?.rss || 0;
  return {
    totalRssBytes: total > 0 ? total : selfRss,
    processCount: Math.max(1, inTree.size),
    selfRssBytes: selfRss,
  };
}

/** 后台异步刷新一次进程树快照（不阻塞事件循环） */
async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  try {
    const procs = await listProcesses();
    cache = computeTree(procs);
  } catch (e) {
    // 刷新失败保留上一次缓存；首次失败则写入降级值
    if (!cache) cache = selfOnlyFallback();
    rootLogger.warn('[进程树] 后台刷新失败:', e instanceof Error ? e.message : String(e));
  } finally {
    refreshing = false;
  }
}

/**
 * 读取咔咔珂进程树内存。【纯读缓存，零 IO、零阻塞】——HTTP 接口放心调用。
 * 首次调用可能返回仅本进程的降级值，后台刷新完成后自动更新为真实进程树值。
 */
export function collectProcessTreeMemory(): ProcessTreeMemory {
  return cache ?? selfOnlyFallback();
}

/** 启动后台定时刷新。由 main.ts 在启动时调用一次；定时器 unref 不阻止进程退出。 */
export function startProcessTreeMonitor(): void {
  void refresh(); // 立即拉一次
  const timer = setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS);
  timer.unref?.();
}
