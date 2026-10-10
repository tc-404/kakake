import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { checkPath, audit, MAX_READ_BYTES } from './ai-security.js';
import { truncSafe } from './ai-text.js';
import type { FileChange } from './ai-session.js';

/**
 * AI 文件工具集：list_dir / read_file / write_file / edit_file / search_text
 * 一律先过安全层，操作与拒绝都写审计。刻意不提供删除与命令执行类工具。
 */

/** diff 行：`+` 新增 / `-` 删除 / `=` 未变（含「……」折叠标记） */
export interface DiffLine {
  t: string;
  s: string;
}

export interface DiffResult {
  /** 可直接渲染的 diff 行（已做上下文收缩与长度截断） */
  ops: DiffLine[];
  /** 真实新增行数——在截断与收缩之前统计，不受展示长度影响 */
  added: number;
  /** 真实删除行数 */
  removed: number;
  /** ops 是否因过长被截断（计数仍是真实值） */
  truncated: boolean;
}

/** 变更块前后各保留几行上下文 */
const DIFF_CTX = 3;
/** LCS 矩阵边长上限，超出不做精确匹配 */
const LCS_LIMIT = 1500;

/**
 * 行级 diff（LCS），返回「展示行 + 真实增删数」。
 *
 * 为什么增删数必须在这里单独算、而不是让前端去数 diff 数组：
 * diff 数组是**给眼睛看的**——它做过两道加工，都会吃掉行号信息：
 *   1. 上下文收缩：只留变更块 ±3 行，中间的未变行压成一枚「……」；
 *   2. 长度截断：超过 maxLines（默认 400）就直接切掉尾部。
 * 于是前端 `diff.filter(t === '+').length` 数出来的永远只是「被展示出来的那部分」。
 * 历史 bug：改动稍多或文件稍大，数字就固定成 `+0 -400`——400 正是这里的 maxLines，
 * 因为截断取的是数组前 400 项，而那 400 项恰好全是删除行。展开折叠看到的又是另一回事，
 * 所以现象是「数字错、内容对」。
 *
 * 另外两个同源陷阱，一并在这里处理掉：
 *   - 行尾归一化：原文件 CRLF 而模型写的是 LF 时，逐行比较会判定「每一行都不同」，
 *     整份文件被当成全删 + 全加。归一化后内容相同即视为未变。
 *   - 公共前后缀先裁掉：大文件的小改动不必退化为整段替换，中间块才进 LCS 矩阵。
 */
export function lineDiffResult(oldText: string, newText: string, maxLines = 400): DiffResult {
  // 空串 split 会得到 ['']，凭空多出一行；新建 / 清空文件要用真正的空数组
  const a = oldText ? oldText.replace(/\r\n?/g, '\n').split('\n') : [];
  const b = newText ? newText.replace(/\r\n?/g, '\n').split('\n') : [];
  const ops = diffOps(a, b);

  // 真实增删数：必须在收缩 / 截断之前统计
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.t === '+') added += 1;
    else if (op.t === '-') removed += 1;
  }

  const shown = shrink(ops, DIFF_CTX);
  const truncated = shown.length > maxLines;
  return {
    ops: truncated
      ? [...shown.slice(0, maxLines), { t: '=', s: `（diff 过长，仅展示前 ${maxLines} 行；增删统计为完整值 +${added} -${removed}）` }]
      : shown,
    added,
    removed,
    truncated,
  };
}

/** 旧签名：只要展示行。保留给外部直接调用，内部一律用 lineDiffResult */
export function lineDiff(oldText: string, newText: string, maxLines = 400): DiffLine[] {
  return lineDiffResult(oldText, newText, maxLines).ops;
}

/** 完整的行级操作序列（未收缩、未截断） */
function diffOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  // 先裁掉公共前后缀：大文件的小改动也能走精确 LCS，不必整段替换
  let p = 0;
  while (p < n && p < m && a[p] === b[p]) p += 1;
  let s = 0;
  while (s < n - p && s < m - p && a[n - 1 - s] === b[m - 1 - s]) s += 1;

  const out: DiffLine[] = [];
  for (let i = 0; i < p; i++) out.push({ t: '=', s: a[i] });
  out.push(...lcsOps(a.slice(p, n - s), b.slice(p, m - s)));
  for (let i = m - s; i < m; i++) out.push({ t: '=', s: b[i] });
  return out;
}

/** 中间块的 LCS；过大时退化为整块替换（计数仍准确，只是展示不精确） */
function lcsOps(a: string[], b: string[]): DiffLine[] {
  const n = a.length;
  const m = b.length;
  const out: DiffLine[] = [];
  if (!n) { for (const s of b) out.push({ t: '+', s }); return out; }
  if (!m) { for (const s of a) out.push({ t: '-', s }); return out; }

  if (n <= LCS_LIMIT && m <= LCS_LIMIT) {
    // 扁平矩阵：嵌套数组在 1500×1500 时的开销远大于 4 字节/格的 Int32Array
    const w = m + 1;
    const dp = new Int32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = a[i] === b[j]
          ? dp[(i + 1) * w + j + 1] + 1
          : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { out.push({ t: '=', s: a[i] }); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push({ t: '-', s: a[i] }); i++; }
      else { out.push({ t: '+', s: b[j] }); j++; }
    }
    while (i < n) { out.push({ t: '-', s: a[i] }); i++; }
    while (j < m) { out.push({ t: '+', s: b[j] }); j++; }
    return out;
  }

  // 超出矩阵上限：整块替换。真实增删数依然是准确的，只是展示上不区分哪些行真改了
  for (const s of a) out.push({ t: '-', s });
  for (const s of b) out.push({ t: '+', s });
  return out;
}

/** 收缩：只保留变更块前后各 ctx 行上下文，其余压成一枚「……」 */
function shrink(ops: DiffLine[], ctx: number): DiffLine[] {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.t !== '=') {
      for (let k = Math.max(0, idx - ctx); k <= Math.min(ops.length - 1, idx + ctx); k++) keep[k] = true;
    }
  });
  const out: DiffLine[] = [];
  let skipping = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (keep[idx]) { out.push(ops[idx]); skipping = false; }
    else if (!skipping) { out.push({ t: '=', s: '……' }); skipping = true; }
  }
  return out;
}

function truncStr(s: string, max = 4000): string {
  // truncSafe 而非 slice：切点撞上 emoji 会劈出半截代理项，被严格上游判 400
  return s.length > max ? `${truncSafe(s, max)}\n……（内容过长已截断）` : s;
}

/** read_file 单次返回的默认行数（防止一次把长文件全塞进上下文） */
const READ_DEFAULT_LINES = 400;
/** read_file 单次返回的最大行数（模型显式指定 limit 时的上限） */
const READ_MAX_LINES = 2000;
/** 单行内容在搜索结果里的截断长度 */
const SEARCH_LINE_MAX = 240;
/** 搜索结果条数上限（每条含文件:行号 + 该行内容） */
const SEARCH_HIT_CAP = 120;

export interface ToolResult {
  ok: boolean;
  output: string;
  change?: FileChange;
}

/**
 * 按行切出 [offset, offset+limit) 区间的文本，并返回带「总行数 / 本次区间 / 继续读法」的头部。
 * 这是「读到文件后半段」的唯一正路——历史 bug：read_file 只返回文件开头，
 * 于是模型为了看第 675 行只能换个关键词反复 search_text，形成死循环。
 */
function readRange(text: string, cwdRel: string, offset: number, limit: number): string {
  const lines = text.split('\n');
  const total = lines.length;
  const start = Math.min(Math.max(1, offset), total);
  const end = Math.min(start + limit - 1, total);
  const body = lines.slice(start - 1, end).join('\n');
  const more = end < total ? `。可用 read_file {path:"${cwdRel}", offset:${end + 1}} 继续读后面` : '';
  return `文件 ${cwdRel}：共 ${total} 行，本次返回第 ${start}-${end} 行${more}\n${body}`;
}

export function runTool(name: string, args: Record<string, unknown>, sessionId: string): ToolResult {
  const argPath = typeof args.path === 'string' ? args.path : '';
  // 缺 path 与「非法路径」是两回事：分开报，否则模型会误以为路径写错而反复改路径。
  if (!argPath.trim() && name !== 'search_text') {
    return fail(name, '', sessionId, `缺少 path 参数（${name} 必须传相对路径，如 plugins/xxx/index.js）`);
  }
  try {
    switch (name) {
      case 'list_dir': {
        const c = checkPath(argPath, 'read');
        if (!c.ok) return fail(name, argPath, sessionId, c.reason);
        const entries = fs.readdirSync(c.absPath, { withFileTypes: true });
        const lines = entries.slice(0, 500).map((e) => `${e.isDirectory() ? '[目录]' : '[文件]'} ${e.name}`);
        return ok(name, argPath, sessionId, lines.length ? lines.join('\n') : '（空目录）');
      }
      case 'read_file': {
        const c = checkPath(argPath, 'read');
        if (!c.ok) return fail(name, argPath, sessionId, c.reason);
        const st = fs.statSync(c.absPath);
        if (st.isDirectory()) return fail(name, argPath, sessionId, '目标是目录，不是文件（列目录请用 list_dir）');
        if (st.size > MAX_READ_BYTES) {
          return fail(name, argPath, sessionId, `文件过大（${st.size} 字节），超过单次读取上限 ${MAX_READ_BYTES} 字节`);
        }
        const content = fs.readFileSync(c.absPath, 'utf-8');
        // offset 为 1 起的起始行号；不给 limit 时默认 400 行（小文件一次读完，大文件自动分页）
        const rawOffset = Number(args.offset);
        const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 1;
        const rawLimit = Number(args.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), READ_MAX_LINES)
          : READ_DEFAULT_LINES;
        return ok(name, argPath, sessionId, readRange(content, c.relPath, offset, limit));
      }
      case 'write_file': {
        const content = typeof args.content === 'string' ? args.content : '';
        const c = checkPath(argPath, 'write');
        if (!c.ok) return fail(name, argPath, sessionId, c.reason);
        if (fs.existsSync(c.absPath) && fs.statSync(c.absPath).isDirectory()) {
          return fail(name, argPath, sessionId, '目标路径是目录，无法写入');
        }
        const existed = fs.existsSync(c.absPath);
        const oldText = existed ? fs.readFileSync(c.absPath, 'utf-8') : '';
        fs.mkdirSync(path.dirname(c.absPath), { recursive: true });
        fs.writeFileSync(c.absPath, content, 'utf-8');
        const d = lineDiffResult(oldText, content);
        const change: FileChange = {
          path: c.relPath,
          kind: existed ? 'modify' : 'create',
          diff: d.ops,
          added: d.added,
          removed: d.removed,
          truncated: d.truncated,
        };
        return { ok: true, output: `已${existed ? '修改' : '创建'}文件 ${c.relPath}（${content.length} 字符）`, change };
      }
      case 'edit_file': {
        const oldTextArg = typeof args.oldText === 'string' ? args.oldText : '';
        const newTextArg = typeof args.newText === 'string' ? args.newText : '';
        const c = checkPath(argPath, 'write');
        if (!c.ok) return fail(name, argPath, sessionId, c.reason);
        if (!fs.existsSync(c.absPath)) return fail(name, argPath, sessionId, '文件不存在，请先用 write_file 创建');
        const text = fs.readFileSync(c.absPath, 'utf-8');
        if (!oldTextArg || !text.includes(oldTextArg)) {
          return fail(name, argPath, sessionId, 'oldText 在文件中未找到精确匹配，请读取文件后重试（注意空白与换行）');
        }
        const next = text.replace(oldTextArg, newTextArg);
        fs.writeFileSync(c.absPath, next, 'utf-8');
        const d = lineDiffResult(text, next);
        const change: FileChange = {
          path: c.relPath,
          kind: 'modify',
          diff: d.ops,
          added: d.added,
          removed: d.removed,
          truncated: d.truncated,
        };
        return { ok: true, output: `已修改文件 ${c.relPath}`, change };
      }
      case 'search_text': {
        const query = typeof args.query === 'string' ? args.query : '';
        if (!query) return fail(name, argPath, sessionId, '缺少 query 参数');
        const base = argPath || 'plugins';
        const c = checkPath(base, 'read');
        if (!c.ok) return fail(name, argPath, sessionId, c.reason);
        const hits: string[] = [];
        let truncated = false;
        const walk = (dir: string, depth: number) => {
          if (hits.length >= SEARCH_HIT_CAP || depth > 8) return;
          let entries: fs.Dirent[];
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (hits.length >= SEARCH_HIT_CAP) { truncated = true; return; }
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { walk(full, depth + 1); continue; }
            try {
              const st = fs.statSync(full);
              if (st.size > MAX_READ_BYTES) continue;
              const text = fs.readFileSync(full, 'utf-8');
              const rel = path.relative(PATHS.root, full).split(path.sep).join('/');
              const lines = text.split('\n');
              // 逐行扫描：一个文件里的所有命中都要列出（历史 bug：只用 indexOf 取第一处，
              // 且只回「文件:行号」不给内容，模型无法判断命中是否相关，只能再 read_file 瞎猜）
              for (let ln = 0; ln < lines.length; ln++) {
                if (!lines[ln].includes(query)) continue;
                if (hits.length >= SEARCH_HIT_CAP) { truncated = true; return; }
                hits.push(`${rel}:${ln + 1}: ${truncStr(lines[ln].trim(), SEARCH_LINE_MAX)}`);
              }
            } catch { /* 二进制或不可读文件跳过 */ }
          }
        };
        walk(c.absPath, 0);
        if (!hits.length) return ok(name, argPath, sessionId, `无匹配结果（在 ${c.relPath} 下未找到包含「${query}」的文本）`);
        const head = `命中 ${hits.length}${truncated ? '+' : ''} 处（${c.relPath}）`;
        const tail = truncated ? `\n……（命中过多，已截断到 ${SEARCH_HIT_CAP} 条）` : '';
        return ok(name, argPath, sessionId, `${head}\n${hits.join('\n')}${tail}`);
      }
      default:
        return fail(name, argPath, sessionId, `未知工具：${name}`);
    }
  } catch (err) {
    return fail(name, argPath, sessionId, err instanceof Error ? err.message : String(err));
  }
}

function ok(name: string, rel: string, sessionId: string, output: string): ToolResult {
  audit({ action: name, relPath: rel || undefined, ok: true, sessionId });
  return { ok: true, output };
}

function fail(name: string, rel: string, sessionId: string, reason: string): ToolResult {
  audit({ action: name, relPath: rel || undefined, ok: false, reason, sessionId });
  return { ok: false, output: `操作被拒绝：${reason}` };
}
