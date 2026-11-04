import fs from 'node:fs';
import path from 'node:path';
import type { LogCategory, LogEntry } from './log-store.js';
import { PATHS } from '../paths.js';
import { formatLocalDate } from './log-time.js';

let currentDate = '';
let stream: fs.WriteStream | null = null;
/** 一次性收紧标记：旧日志文件的 0644 收紧成 0600 只做一遍 */
let permsHardened = false;

function ensureLogDir(): void {
  if (!fs.existsSync(PATHS.log)) {
    // 日志里有全量聊天记录原文，目录权限与 data/ 同一口径
    fs.mkdirSync(PATHS.log, { recursive: true, mode: 0o700 });
  } else if (process.platform !== 'win32' && !permsHardened) {
    try {
      fs.chmodSync(PATHS.log, 0o700);
    } catch { /* ignore */ }
    permsHardened = true;
  }
}

function openStreamForToday(): fs.WriteStream {
  ensureLogDir();
  const date = formatLocalDate();
  if (date !== currentDate || !stream) {
    stream?.end();
    currentDate = date;
    const file = path.join(PATHS.log, `${date}.log`);
    if (process.platform !== 'win32') {
      // 已存在的旧文件一并收紧；新文件直接按 0600 打开
      try {
        if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
      } catch { /* ignore */ }
      const fd = fs.openSync(file, 'a', 0o600);
      stream = fs.createWriteStream(file, { fd, encoding: 'utf8' });
    } else {
      stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
    }
  }
  return stream;
}

const CATEGORY_TAG: Record<LogCategory, string> = {
  system: 'SYSTEM',
  event: 'EVENT',
  gf_event: 'GF_EVENT',
  gf_action: 'GF_ACTION',
  gf_plugin: 'GF_PLUGIN',
  action: 'ACTION',
  plugin: 'PLUGIN',
  sim_event: 'SIM_EVENT',
  sim_action: 'SIM_ACTION',
};

/** 写入磁盘：上报原样 JSON；系统/插件原样输出文本 */
export function writeLogToFile(entry: LogEntry): void {
  try {
    const w = openStreamForToday();
    const time = entry.time;

    if ((entry.category === 'event' || entry.category === 'gf_event') && entry.raw) {
      w.write(`[${time}] [${CATEGORY_TAG[entry.category]}]\t${entry.raw}\n`);
      return;
    }

    const tag = CATEGORY_TAG[entry.category] ?? 'LOG';
    const prefix = entry.prefix ? `${entry.prefix} ` : '';
    const line = entry.message ? `${prefix}${entry.message}` : prefix.trim();
    const detail = entry.detail?.trim();
    w.write(detail ? `[${time}] [${tag}] ${line} | ${detail}\n` : `[${time}] [${tag}] ${line}\n`);
  } catch {
    // 文件写入失败不影响运行
  }
}

export function initLogFiles(): void {
  ensureLogDir();
  openStreamForToday();
}

/** 退出前调用：结束当日日志流，确保缓冲区写入落盘（优雅退出用） */
export function closeLogStream(): void {
  try {
    stream?.end();
  } catch {
    /* ignore */
  } finally {
    stream = null;
  }
}
