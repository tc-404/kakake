import fs from 'node:fs';
import path from 'node:path';
import type { LogCategory, LogEntry } from './log-store.js';
import { PATHS } from '../paths.js';
import { formatLocalDate } from './log-time.js';
import { resolveLogLayout } from './log-layout.js';

const SYSTEM_FILE = 'system.log';
const HEALTH_INTERVAL_MS = 200;

interface Slot {
  stream: fs.WriteStream;
  file: string;
  checkedAt: number;
}

interface Target {
  key: string;
  dir: string;
  file: string;
}

const slots = new Map<string, Slot>();
let permsHardened = false;

const CATEGORY_TAG: Record<LogCategory, string> = {
  system: 'SYSTEM',
  event: 'EVENT',
  gf_event: 'GF_EVENT',
  gf_action: 'GF_ACTION',
  gf_plugin: 'GF_PLUGIN',
  tg_event: 'TG_EVENT',
  tg_action: 'TG_ACTION',
  action: 'ACTION',
  plugin: 'PLUGIN',
  sim_event: 'SIM_EVENT',
  sim_action: 'SIM_ACTION',
};

function ensureDir(dir: string): boolean {
  if (fs.existsSync(dir)) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return true;
}

function hardenRoot(): void {
  if (process.platform === 'win32' || permsHardened) return;
  try {
    fs.chmodSync(PATHS.log, 0o700);
  } catch {}
  permsHardened = true;
}

function safeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'unknown';
}

function isSystemEntry(entry: LogEntry): boolean {
  if (entry.category === 'system' || entry.category === 'sim_event' || entry.category === 'sim_action') return true;
  const key = String(entry.accountKey || '').trim();
  return !key || key === 'extension';
}

function targetFor(entry: LogEntry): Target {
  const date = formatLocalDate();
  if (isSystemEntry(entry)) {
    return { key: 'system', dir: PATHS.log, file: path.join(PATHS.log, SYSTEM_FILE) };
  }
  const key = String(entry.accountKey || '').trim();
  if (resolveLogLayout(key) === 'account') {
    const seg = safeSegment(key);
    const dir = path.join(PATHS.log, seg);
    return { key: `a:${seg}:${date}`, dir, file: path.join(dir, `${date}.log`) };
  }
  return { key: `l:${date}`, dir: PATHS.log, file: path.join(PATHS.log, `${date}.log`) };
}

function openSlot(t: Target): Slot {
  let stream: fs.WriteStream;
  if (process.platform !== 'win32') {
    try {
      if (fs.existsSync(t.file)) fs.chmodSync(t.file, 0o600);
    } catch {}
    const fd = fs.openSync(t.file, 'a', 0o600);
    stream = fs.createWriteStream(t.file, { fd, encoding: 'utf8' });
  } else {
    stream = fs.createWriteStream(t.file, { flags: 'a', encoding: 'utf8' });
  }
  stream.on('error', () => undefined);
  return { stream, file: t.file, checkedAt: Date.now() };
}

function dropSlot(key: string): void {
  const slot = slots.get(key);
  if (!slot) return;
  slots.delete(key);
  try {
    slot.stream.end();
  } catch {
    return;
  }
}

function healthy(key: string, slot: Slot): boolean {
  if (!slot.stream || slot.stream.destroyed || slot.stream.writableEnded) return false;
  const now = Date.now();
  if (now - slot.checkedAt < HEALTH_INTERVAL_MS) return true;
  slot.checkedAt = now;
  if (fs.existsSync(slot.file)) return true;
  dropSlot(key);
  return false;
}

function streamFor(t: Target): fs.WriteStream {
  if (ensureDir(PATHS.log)) {
    for (const key of [...slots.keys()]) dropSlot(key);
  }
  hardenRoot();
  if (t.dir !== PATHS.log) ensureDir(t.dir);
  const slot = slots.get(t.key);
  if (slot && healthy(t.key, slot)) return slot.stream;
  dropSlot(t.key);
  const fresh = openSlot(t);
  slots.set(t.key, fresh);
  return fresh.stream;
}

export function writeLogToFile(entry: LogEntry): void {
  try {
    const w = streamFor(targetFor(entry));
    const time = entry.time;

    if ((entry.category === 'event' || entry.category === 'gf_event' || entry.category === 'tg_event') && entry.raw) {
      w.write(`[${time}] [${CATEGORY_TAG[entry.category]}]\t${entry.raw}\n`);
      return;
    }

    const tag = CATEGORY_TAG[entry.category] ?? 'LOG';
    const prefix = entry.prefix ? `${entry.prefix} ` : '';
    const line = entry.message ? `${prefix}${entry.message}` : prefix.trim();
    const detail = entry.detail?.trim();
    w.write(detail ? `[${time}] [${tag}] ${line} | ${detail}\n` : `[${time}] [${tag}] ${line}\n`);
  } catch {
    return;
  }
}

export function initLogFiles(): void {
  ensureDir(PATHS.log);
  hardenRoot();
  const date = formatLocalDate();
  const key = `l:${date}`;
  if (!slots.has(key)) {
    slots.set(key, openSlot({ key, dir: PATHS.log, file: path.join(PATHS.log, `${date}.log`) }));
  }
}

export function closeLogStream(): void {
  for (const key of [...slots.keys()]) dropSlot(key);
}
