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

/**
 * 敏感数据的文件权限。
 *
 * 为什么要显式设置：`fs.writeFileSync` 按进程 umask 建文件，Linux 上常见
 * 结果是 0644——同机其他用户就能读 `data/auth-key.json`（登录密钥）、
 * `data/connections.json`（各连接的 Access Token / AppSecret / Cookie）。
 * 这些文件本身就是「谁读到谁就拿到管理员身份」的凭据，权限必须收紧。
 *
 * 0o600 = 仅属主可读写。Windows 上 POSIX 位被映射成 ACL，这里调用不会破坏
 * 原有继承的 ACL（chmod 只增不减对应的显式项），所以跨平台安全。
 */
const SECURE_FILE_MODE = 0o600;

/** 持凭据的目录权限：仅属主可进入，避免他人列目录。 */
const SECURE_DIR_MODE = 0o700;

/** 需要收紧权限的敏感文件（相对 PATHS.data，或绝对路径）。启动时统一修正一次。 */
export const SENSITIVE_DATA_FILES = [
  'auth-key.json',
  'connections.json',
  'config.json',
  'github-auth.json',
  'open-platform.json',
  'dau.json',
  'language.json',
  'ai/providers.json',
] as const;

function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 确保某文件所在目录存在。 */
export function ensureDirFor(absFile: string): void {
  const dir = path.dirname(absFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 尽力而为地改权限：失败只记日志，不阻断写入主流程。 */
function chmodQuietly(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    // 只读文件系统 / 非属主 / Windows ACL 受限都可能失败——不阻断主流程，
    // 但必须留痕，否则「以为收了权限其实没收」比明文更危险。
    log.warn(`设置权限失败 ${target}: ${toMessage(err)}`);
  }
}

/**
 * 原子写入：写入同目录临时文件后 rename 覆盖目标。
 * 写入失败会清理临时文件并向上抛出（调用方若需「失败不致命」应自行 try/catch）。
 *
 * 权限在 **rename 之前**设置到临时文件上：rename 不改变权限，若等 rename 后
 * 再 chmod，中间存在一个「文件已是目标名但仍是 umask 权限」的窗口。
 */
export function writeFileAtomic(absFile: string, content: string | Buffer): void {
  ensureDirFor(absFile);
  const tmp = `${absFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: SECURE_FILE_MODE });
    fs.chmodSync(tmp, SECURE_FILE_MODE);
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

/**
 * 启动时把既有敏感文件的权限修正到 0o600。
 *
 * 只处理「属主可写但权限过宽」的情况；不碰别人属主或不可写的文件（那是另一类
 * 问题，改不动也不该静默跳过）。目录收紧到 0o700 同理——注意 `data/` 本身也
 * 一并处理，否则光有文件权限、目录可被列举，信息依然会漏。
 */
export function hardenSensitiveFilePermissions(dataDir: string): { fixed: string[]; failed: string[] } {
  const fixed: string[] = [];
  const failed: string[] = [];
  const wantFile = SECURE_FILE_MODE;

  const targets = [...SENSITIVE_DATA_FILES.map((f) => path.join(dataDir, f))];

  for (const abs of targets) {
    try {
      if (!fs.existsSync(abs)) continue;
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      // 只修正「该收紧」的：当前权限比目标宽（多了 group/other 位）
      if ((st.mode & 0o077) === 0) continue;
      fs.chmodSync(abs, wantFile);
      fixed.push(path.basename(abs));
    } catch (err) {
      failed.push(`${path.basename(abs)}: ${toMessage(err)}`);
    }
  }

  // 目录：data/ 本身与其下持凭据的子目录
  for (const dir of [dataDir, path.join(dataDir, 'ai')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      const st = fs.statSync(dir);
      if (!st.isDirectory()) continue;
      if ((st.mode & 0o077) === 0) continue;
      fs.chmodSync(dir, SECURE_DIR_MODE);
      fixed.push(`${path.basename(dir) || dir}/`);
    } catch (err) {
      failed.push(`${dir}: ${toMessage(err)}`);
    }
  }

  if (fixed.length > 0) {
    log.info(`已收紧敏感文件权限（0o600）：${fixed.join('、')}`);
  }
  if (failed.length > 0) {
    log.warn(`部分敏感文件权限收紧失败：${failed.join('；')}`);
  }
  return { fixed, failed };
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
