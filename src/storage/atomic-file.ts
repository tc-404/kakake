import fs from 'node:fs';
import path from 'node:path';
import { rootLogger } from '../core/logger.js';

/**
 * 统一的原子文件读写工具（面向绝对路径）。
 *
 * 设计目标（对应「读写加固」需求）：
 * - 原子写：先写同目录临时文件再 rename 覆盖，进程崩溃/断电不会留下半截文件；
 *   同目录 rename 保证同一文件系统内的原子替换（跨盘 rename 才会失败）。
 * - 安全读：文件缺失返回兜底值；解析失败**不再静默吞掉**，而是记录错误并把损坏文件
 *   隔离为 <file>.corrupt-<ts>（只重命名、绝不删除），既避免坏数据继续污染，又保留原始
 *   字节供人工恢复。
 * - 统一日志：所有失败都经 rootLogger，便于排查「配置莫名变回默认」这类问题。
 */

const log = rootLogger.child('[storage] ');

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 确保某文件所在目录存在。 */
export function ensureDirFor(absFile: string): void {
  const dir = path.dirname(absFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 原子写入：写入同目录临时文件后 rename 覆盖目标。
 * 写入失败会清理临时文件并向上抛出（调用方若需「失败不致命」应自行 try/catch）。
 */
export function writeFileAtomic(absFile: string, content: string | Buffer): void {
  ensureDirFor(absFile);
  const tmp = `${absFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, absFile);
  } catch (err) {
    try {
      if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true });
    } catch {
      /* 清理临时文件失败不致命 */
    }
    log.error(`写入失败 ${absFile}: ${toMessage(err)}`);
    throw err;
  }
}

export interface WriteJsonOptions {
  /** 末尾追加换行（部分历史文件以 '\n' 结尾，保持一致以减小 diff） */
  trailingNewline?: boolean;
  /** 缩进空格数；传 null 表示压缩输出（无空格）。默认 2 */
  indent?: number | null;
}

/** 原子写入 JSON（统一格式化）。 */
export function writeJsonAtomic(absFile: string, data: unknown, opts?: WriteJsonOptions): void {
  const indent = opts?.indent === null ? undefined : (opts?.indent ?? 2);
  let text = JSON.stringify(data, null, indent);
  if (opts?.trailingNewline) text += '\n';
  writeFileAtomic(absFile, text);
}

/** 原子写入文本。 */
export function writeTextAtomic(absFile: string, content: string): void {
  writeFileAtomic(absFile, content);
}

export interface ReadSafeOptions {
  /** 日志中标识用途（如 'connections.json'），便于定位 */
  label?: string;
  /** 解析失败时是否把损坏文件重命名隔离；默认 true（只改名，不删除） */
  quarantine?: boolean;
}

function quarantineCorrupt(absFile: string, label: string): void {
  try {
    const bak = `${absFile}.corrupt-${Date.now()}`;
    fs.renameSync(absFile, bak);
    log.warn(`已隔离损坏文件 ${label}: ${bak}`);
  } catch (err) {
    // 隔离失败则保留原文件，下次写入仍会原子覆盖它
    log.warn(`隔离损坏文件失败 ${label}: ${toMessage(err)}`);
  }
}

/**
 * 安全读取 JSON：
 * - 文件不存在 → 返回 fallback；
 * - 读盘失败 → 记录并返回 fallback；
 * - 解析失败 → 记录错误、隔离损坏文件（默认）并返回 fallback。
 */
export function readJsonSafe<T>(absFile: string, fallback: T, opts?: ReadSafeOptions): T {
  const label = opts?.label || path.basename(absFile);
  if (!fs.existsSync(absFile)) return fallback;

  let raw: string;
  try {
    raw = fs.readFileSync(absFile, 'utf-8');
  } catch (err) {
    log.warn(`读取失败 ${label}: ${toMessage(err)}`);
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    log.error(`解析失败 ${label}: ${toMessage(err)}`);
    if (opts?.quarantine !== false) quarantineCorrupt(absFile, label);
    return fallback;
  }
}

/** 安全读取文本：文件缺失或读失败返回 fallback。 */
export function readTextSafe(absFile: string, fallback = '', opts?: Pick<ReadSafeOptions, 'label'>): string {
  const label = opts?.label || path.basename(absFile);
  if (!fs.existsSync(absFile)) return fallback;
  try {
    return fs.readFileSync(absFile, 'utf-8');
  } catch (err) {
    log.warn(`读取失败 ${label}: ${toMessage(err)}`);
    return fallback;
  }
}
