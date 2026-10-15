import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';

/**
 * AI 文件操作安全层：
 * - 白名单目录（相对项目根），模型的一切文件工具都必须经过这里校验
 * - 五重校验：规范化 / 白名单 / 非法输入 / 符号链接逃逸 / 敏感文件黑名单
 * - 全操作写入审计（data/ai/audit/），拒绝同样记录
 */

/** 可读写的白名单目录（相对项目根） */
const WRITE_ROOTS = ['plugins', 'plugins_two', 'data', 'log'];

/** 额外只读目录（AI 创作插件时的规范参考） */
const READ_EXTRA_ROOTS = [path.join('使用教程', '插件开发')];

/** 敏感文件黑名单（相对白名单目录，读写均拒绝）：含登录密钥与连接 Token */
const SENSITIVE_FILES = new Set([
  path.join('data', 'auth-key.json'),
  path.join('data', 'connections.json'),
  path.join('data', 'github-auth.json'),
].map((p) => p.split(path.sep).join('/')));

/** 单文件读取上限（8MB）：read_file 现在按行分页返回，落进上下文只有一小段，
 *  所以这里的上限只防「把超大二进制/巨型文件整个读进内存」，不再是上下文护栏。 */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export type SecurityCheck =
  | { ok: true; absPath: string; relPath: string; readonly: boolean }
  | { ok: false; reason: string };

function hasNulOrIllegal(p: string): boolean {
  return p.includes('\0') || p.trim() === '' || /[\u0000-\u001f]/.test(p.replace(/\n|\t/g, ''));
}

/** 解析并校验一个相对路径；mode: 'read' | 'write' */
export function checkPath(input: string, mode: 'read' | 'write'): SecurityCheck {
  if (typeof input !== 'string' || hasNulOrIllegal(input)) {
    return { ok: false, reason: '非法路径输入' };
  }
  // 只接受相对路径，拒绝盘符 / 绝对路径
  const cleaned = input.replace(/\\/g, '/').replace(/^\/+/, '');
  if (path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    return { ok: false, reason: '只允许相对路径，拒绝绝对路径' };
  }
  const abs = path.resolve(PATHS.root, cleaned);
  const rel = path.relative(PATHS.root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: '路径越界：不能离开项目根目录' };
  }

  const allowedRoots = mode === 'write' ? WRITE_ROOTS : [...WRITE_ROOTS, ...READ_EXTRA_ROOTS];
  const normRel = rel.split(path.sep).join('/');
  const inAllowed = allowedRoots.some((root) => {
    const rootRel = root.split(path.sep).join('/');
    return normRel === rootRel || normRel.startsWith(`${rootRel}/`);
  });
  if (!inAllowed) {
    const extra = mode === 'read' ? `（只读目录：${READ_EXTRA_ROOTS.join('、')}）` : '';
    return { ok: false, reason: `路径不在白名单内${extra}。允许的目录：${WRITE_ROOTS.join('、')}` };
  }

  // 符号链接逃逸校验：校验已存在的最深祖先真实路径
  let cur = abs;
  const toCheck: string[] = [];
  while (true) {
    toCheck.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const p of toCheck) {
    if (fs.existsSync(p)) {
      try {
        const real = fs.realpathSync(p);
        const realRel = path.relative(PATHS.root, real);
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return { ok: false, reason: '符号链接指向项目外，拒绝访问' };
        }
      } catch {
        return { ok: false, reason: '路径解析失败' };
      }
      break; // 最深的已存在祖先即可代表整条链
    }
  }

  // 敏感文件黑名单（读写都拒绝）
  if (SENSITIVE_FILES.has(normRel)) {
    return { ok: false, reason: '该文件包含密钥/Token，已被安全策略禁止访问' };
  }

  return { ok: true, absPath: abs, relPath: normRel, readonly: mode === 'read' && READ_EXTRA_ROOTS.some((root) => normRel.startsWith(root.split(path.sep).join('/')) && normRel !== root.split(path.sep).join('/')) };
}

/** 审计：所有文件操作（含拒绝）落 data/ai/audit/<date>.jsonl */
export function audit(entry: {
  action: string;
  relPath?: string;
  ok: boolean;
  reason?: string;
  sessionId?: string;
}): void {
  try {
    const dir = path.join(PATHS.data, 'ai', 'audit');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `ai-audit-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify({ time: Date.now(), ...entry })}\n`;
    fs.appendFileSync(file, line, 'utf-8');
  } catch {
    /* 审计失败不阻断主流程 */
  }
}
