import type { LogLevel } from './logger.js';
import { writeLogToFile } from './log-file-writer.js';
import { formatLocalDateTime } from './log-time.js';

export type LogCategory =
  | 'system'
  | 'event'
  | 'action'
  | 'plugin'
  | 'gf_event'
  | 'gf_action'
  | 'gf_plugin'
  | 'sim_event'
  | 'sim_action';

export interface LogEntry {
  time: string;
  level: LogLevel;
  category: LogCategory;
  prefix: string;
  message: string;
  detail?: string;
  /** 上报事件原始 JSON（写文件用） */
  raw?: string;
}

export interface LogQuery {
  limit?: number;
  level?: LogLevel;
  category?: LogCategory;
}

const MAX_LOGS = 800;
const logs: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();

/**
 * 本次运行以来的累计计数（进程重启即清零，与「框架运行时长」对齐）。
 * - received：收到的上报总数（event + 官方 gf_event）
 * - sent：输出/调用总数（action + 官方 gf_action）
 * 模拟消息（sim_*）不计入，因为它属于调试而非真实收发。
 */
const counters = { received: 0, sent: 0 };

export function getLogCounters(): { received: number; sent: number } {
  return { received: counters.received, sent: counters.sent };
}

export function appendLog(entry: Omit<LogEntry, 'time'> & { time?: string }): void {
  const full: LogEntry = {
    time: entry.time ?? formatLocalDateTime(),
    level: entry.level,
    category: entry.category ?? 'system',
    prefix: entry.prefix,
    message: entry.message,
    detail: entry.detail,
    raw: entry.raw,
  };
  if (full.category === 'event' || full.category === 'gf_event') counters.received += 1;
  else if (full.category === 'action' || full.category === 'gf_action') counters.sent += 1;
  // raw 仅写盘，不进入内存环形缓冲 / API
  writeLogToFile(full);
  const forMemory: LogEntry = {
    time: full.time,
    level: full.level,
    category: full.category,
    prefix: full.prefix,
    message: full.message,
    detail: full.detail,
  };
  logs.push(forMemory);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);
  for (const fn of listeners) fn(forMemory);
}

export function logEvent(
  prefix: string,
  message: string,
  opts?: { detail?: string; raw?: string; level?: LogLevel },
): void {
  appendLog({
    level: opts?.level ?? 'info',
    category: 'event',
    prefix,
    message,
    detail: opts?.detail,
    raw: opts?.raw,
  });
}

/** QQ 官方机器人 Gateway 上报 */
export function logQqOfficialEvent(
  prefix: string,
  message: string,
  opts?: { detail?: string; raw?: string; level?: LogLevel },
): void {
  appendLog({
    level: opts?.level ?? 'info',
    category: 'gf_event',
    prefix,
    message,
    detail: opts?.detail,
    raw: opts?.raw,
  });
}

export function logAction(prefix: string, message: string, detail?: string, level: LogLevel = 'info'): void {
  appendLog({ level, category: 'action', prefix, message, detail });
}

/** 模拟消息：调试输入（用户模拟的消息 / 事件上报） */
export function logSimEvent(prefix: string, message: string, detail?: string, level: LogLevel = 'info'): void {
  appendLog({ level, category: 'sim_event', prefix, message, detail });
}

/** 模拟消息：调试输出（插件在模拟中被拦截的 action） */
export function logSimAction(prefix: string, message: string, detail?: string, level: LogLevel = 'info'): void {
  appendLog({ level, category: 'sim_action', prefix, message, detail });
}

/** QQ 官方机器人 API 输出（发消息等） */
export function logQqOfficialAction(
  prefix: string,
  message: string,
  detail?: string,
  level: LogLevel = 'info',
): void {
  appendLog({ level, category: 'gf_action', prefix, message, detail });
}

export function getLogs(limit = 500, level?: LogLevel, category?: LogCategory): LogEntry[] {
  let result = logs;
  if (level) result = result.filter(l => l.level === level);
  if (category) result = result.filter(l => l.category === category);
  return result.slice(-limit);
}

export function queryLogs(query: LogQuery = {}): LogEntry[] {
  return getLogs(query.limit ?? 500, query.level, query.category);
}

export function subscribeLogs(fn: (entry: LogEntry) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearLogs(): void {
  logs.length = 0;
}

/** 将内存中的运行日志格式化为纯文本（当前进程） */
export function formatLogsAsText(limit = 5000, level?: LogLevel, category?: LogCategory): string {
  const entries = getLogs(limit, level, category);
  const lines = entries.map((e) => {
    const cat = LOG_CATEGORY_LABEL[e.category] || e.category;
    const head = `[${e.time}] [${e.level.toUpperCase()}] [${cat}]${e.prefix ? ` ${e.prefix}` : ''} ${e.message}`;
    if (e.detail) return `${head}\n${e.detail}`;
    if (e.raw) return `${head}\n${e.raw}`;
    return head;
  });
  return lines.join('\n');
}

export const LOG_CATEGORY_LABEL: Record<LogCategory, string> = {
  system: '系统',
  event: '上报',
  action: '输出',
  plugin: '插件',
  gf_event: '官方上报',
  gf_action: '官方输出',
  gf_plugin: '官方插件',
  sim_event: '模拟上报',
  sim_action: '模拟输出',
};

/** 日志页分类下拉顺序（官方三项挨在一起，模拟两项挨在一起） */
export const LOG_CATEGORY_ORDER: LogCategory[] = [
  'system',
  'event',
  'action',
  'plugin',
  'gf_event',
  'gf_action',
  'gf_plugin',
  'sim_event',
  'sim_action',
];
