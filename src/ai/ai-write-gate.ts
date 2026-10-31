import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { writeJsonAtomic, writeFileAtomic } from '../storage/atomic-file.js';
import { checkPath } from './ai-security.js';
import type { FileChange } from './ai-session.js';

/**
 * AI 写入暂存区（人工确认闸门）。
 *
 * 信任模型：模型产出的内容在用户显式「应用」之前不接触真实文件——
 * write_file / edit_file 先落 `data/ai/staging/`，diff 照常展示给用户；
 * 用户在 AI 页「待应用改动」面板里选择 应用 / 放弃；应用时会先把磁盘上的
 * 当前内容快照进记录，支持一键回滚。
 *
 * 持久化：data/ai/pending-writes.json（原子写）。进程重启后暂存依然在，
 * 面板能继续处理；记录条数有上限，防止长期运行无限膨胀。
 */

export interface PendingWrite {
  id: string;
  /** 发起的 AI 会话（用于 UI 归属展示；应用/放弃不限会话） */
  sessionId: string;
  /** 项目根相对路径（已通过安全层校验的形态） */
  relPath: string;
  kind: 'create' | 'modify';
  /** 暂存时磁盘上的原内容（modify 才有；回滚来源之一，展示用） */
  oldContent: string | null;
  /** 暂存的新内容（应用时写入磁盘的就是它） */
  newContent: string;
  /** 暂存时间（毫秒） */
  createdAt: number;
}

export interface AppliedWrite extends PendingWrite {
  appliedAt: number;
  /** 应用那一刻磁盘上的真实内容——回滚用它，而不是暂存时的 oldContent，
   *  这样「暂存后磁盘又被改过」的场景回滚也不会吞掉中间修改之外的状态 */
  appliedFromContent: string | null;
  reverted?: boolean;
}

const STORE_PATH = path.join(PATHS.data, 'ai', 'pending-writes.json');
const MAX_PENDING = 100;
const MAX_APPLIED = 50;

interface GateStore {
  pending: PendingWrite[];
  applied: AppliedWrite[];
}

let store: GateStore | null = null;

function loadStore(): GateStore {
  if (store) return store;
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<GateStore>;
    store = {
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      applied: Array.isArray(parsed.applied) ? parsed.applied : [],
    };
  } catch {
    store = { pending: [], applied: [] };
  }
  return store;
}

function saveStore(s: GateStore): void {
  store = s;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    writeJsonAtomic(STORE_PATH, s);
  } catch {
    /* 持久化失败不阻断主流程：内存态仍在，下次写盘再试 */
  }
}

/** 暂存一次写入；返回给 UI 的记录（内容含在记录里，前端可自行渲染 diff） */
export function stageWrite(input: {
  sessionId: string;
  relPath: string;
  kind: 'create' | 'modify';
  oldContent: string | null;
  newContent: string;
}): PendingWrite {
  const s = loadStore();
  const record: PendingWrite = {
    id: `pw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: input.sessionId,
    relPath: input.relPath,
    kind: input.kind,
    oldContent: input.oldContent,
    newContent: input.newContent,
    createdAt: Date.now(),
  };
  // 同路径同会话的重复暂存：覆盖旧记录（模型的连续 edit 是对同一逻辑文件的演进）
  s.pending = s.pending.filter((p) => !(p.relPath === record.relPath && p.sessionId === record.sessionId));
  s.pending.push(record);
  while (s.pending.length > MAX_PENDING) s.pending.shift();
  saveStore(s);
  return record;
}

export function listPendingWrites(sessionId?: string): PendingWrite[] {
  const s = loadStore();
  const list = sessionId ? s.pending.filter((p) => p.sessionId === sessionId) : s.pending;
  return [...list].sort((a, b) => a.createdAt - b.createdAt);
}

export function listAppliedWrites(limit = 20): AppliedWrite[] {
  const s = loadStore();
  return s.applied.slice(-limit).reverse();
}

export function pendingWriteCount(): number {
  return loadStore().pending.length;
}

/**
 * 应用暂存写入。安全层在暂存时校验过，应用时**再校验一次**（纵深防御：
 * 持久化文件可被手工编辑，不能因为过了第一道就免检第二道）。
 * 返回成功应用的 relPath 列表；被拒绝/找不到的 id 不在其中。
 */
export function applyPendingWrites(ids?: string[]): { applied: string[]; failed: { id: string; reason: string }[] } {
  const s = loadStore();
  const targets = ids && ids.length ? s.pending.filter((p) => ids.includes(p.id)) : [...s.pending];
  const applied: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const record of targets) {
    const check = checkPath(record.relPath, 'write');
    if (!check.ok) {
      failed.push({ id: record.id, reason: check.reason });
      continue;
    }
    try {
      const existed = fs.existsSync(check.absPath) && fs.statSync(check.absPath).isFile();
      const diskContent = existed ? fs.readFileSync(check.absPath, 'utf-8') : null;
      fs.mkdirSync(path.dirname(check.absPath), { recursive: true });
      writeFileAtomic(check.absPath, record.newContent);
      const appliedRecord: AppliedWrite = {
        ...record,
        appliedAt: Date.now(),
        appliedFromContent: diskContent,
      };
      s.applied.push(appliedRecord);
      applied.push(record.relPath);
    } catch (e: unknown) {
      failed.push({ id: record.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const appliedIds = new Set(targets.map((t) => t.id));
  s.pending = s.pending.filter((p) => !appliedIds.has(p.id));
  while (s.applied.length > MAX_APPLIED) s.applied.shift();
  saveStore(s);
  return { applied, failed };
}

/** 放弃暂存（不触碰磁盘） */
export function discardPendingWrites(ids?: string[]): number {
  const s = loadStore();
  const before = s.pending.length;
  s.pending = ids && ids.length ? s.pending.filter((p) => !ids.includes(p.id)) : [];
  saveStore(s);
  return before - s.pending.length;
}

/**
 * 回滚一次已应用的写入：把「应用那一刻的磁盘内容」写回去；
 * 应用前文件不存在 → 回滚即删除该文件。
 */
export function revertAppliedWrite(id: string): { ok: boolean; reason?: string } {
  const s = loadStore();
  const idx = s.applied.findIndex((a) => a.id === id);
  if (idx < 0) return { ok: false, reason: '记录不存在或已被回滚' };
  const record = s.applied[idx];
  if (record.reverted) return { ok: false, reason: '该改动已回滚过' };
  const check = checkPath(record.relPath, 'write');
  if (!check.ok) return { ok: false, reason: check.reason };
  try {
    if (record.appliedFromContent === null) {
      if (fs.existsSync(check.absPath)) fs.rmSync(check.absPath, { force: true });
    } else {
      fs.mkdirSync(path.dirname(check.absPath), { recursive: true });
      writeFileAtomic(check.absPath, record.appliedFromContent);
    }
    record.reverted = true;
    saveStore(s);
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** 供工具层把暂存记录转成 FileChange（diff 展示与既有消息渲染完全一致） */
export function pendingWriteToFileChange(record: PendingWrite, diff: FileChange['diff'], added: number, removed: number, truncated: boolean): FileChange {
  return {
    path: record.relPath,
    kind: record.kind,
    diff,
    added,
    removed,
    truncated,
  };
}
