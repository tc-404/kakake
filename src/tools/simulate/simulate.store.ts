/** 模拟消息历史持久化：data/simulate/<accountKey>.json，重启不丢，可清空 */
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../../storage/atomic-file.js';
import type { AccountTranscript, TranscriptEntry } from './simulate.types.js';

const SIMULATE_DIR = path.join(PATHS.data, 'simulate');
/** 每账号保留的最多记录条数，防止无限膨胀 */
const MAX_ENTRIES = 1000;

/** accountKey 落地为安全文件名 */
function safeName(accountKey: string): string {
  return String(accountKey || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'unknown';
}

function fileOf(accountKey: string): string {
  return path.join(SIMULATE_DIR, `${safeName(accountKey)}.json`);
}

export function loadTranscript(accountKey: string): AccountTranscript {
  const parsed = readJsonSafe<AccountTranscript>(
    fileOf(accountKey),
    { accountKey, updatedAt: 0, entries: [] },
    { label: `simulate/${safeName(accountKey)}.json` },
  );
  if (!Array.isArray(parsed.entries)) parsed.entries = [];
  parsed.accountKey = accountKey;
  return parsed;
}

function save(accountKey: string, transcript: AccountTranscript): void {
  transcript.updatedAt = Date.now();
  if (transcript.entries.length > MAX_ENTRIES) {
    transcript.entries = transcript.entries.slice(-MAX_ENTRIES);
  }
  writeJsonAtomic(fileOf(accountKey), transcript);
}

/** 追加若干条记录并持久化 */
export function appendEntries(accountKey: string, entries: TranscriptEntry[]): void {
  if (!entries.length) return;
  const t = loadTranscript(accountKey);
  t.entries.push(...entries);
  save(accountKey, t);
}

/** 清空某账号历史 */
export function clearTranscript(accountKey: string): void {
  const file = fileOf(accountKey);
  if (!fs.existsSync(file)) return;
  try {
    fs.unlinkSync(file);
  } catch { /* 落到兜底 */ }
  // 兜底：个别平台 unlink 未生效时，覆盖为空历史，保证「已清空」语义
  if (fs.existsSync(file)) {
    const empty: AccountTranscript = { accountKey, updatedAt: Date.now(), entries: [] };
    writeJsonAtomic(file, empty);
  }
}
