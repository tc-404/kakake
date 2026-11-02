/**
 * 行级 diff 的增删统计。
 *
 * 这些用例几乎全部来自同一个线上 bug：文件变更卡片上的增删数字恒为 `+0 -400`。
 * 根因是前端（以及任何调用方）拿 diff **展示数组**去数 `+` / `-`，而展示数组被
 * 「上下文收缩 + maxLines 截断」加工过，数出来的只是被展示的那部分。
 * 400 正是 lineDiff 的 maxLines 默认值——截断取前 400 项，恰好全是删除行。
 *
 * 所以这里锁的核心不变量是：**计数必须独立于展示长度**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff, lineDiffResult } from '../src/ai/ai-tools.js';

/** 生成 n 行文本，sep 可指定行分隔符（用于构造 CRLF 文件） */
function gen(n: number, f: (i: number) => string = (i) => `line ${i}`, sep = '\n'): string {
  return Array.from({ length: n }, (_, i) => f(i)).join(sep);
}

/** 展示数组里数出来的增删数——这正是出 bug 的旧算法，用例里用它做对照 */
function naiveCount(ops: { t: string }[]): { added: number; removed: number } {
  return {
    added: ops.filter((l) => l.t === '+').length,
    removed: ops.filter((l) => l.t === '-').length,
  };
}

test('小文件改 2 行：+2 -2', () => {
  const oldText = gen(40, (i) => `  "key${i}": ${i},`);
  const newText = oldText.replace('"key5": 5,', '"key5": 500,').replace('"key9": 9,', '"key9": 900,');
  const d = lineDiffResult(oldText, newText);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 2);
  assert.equal(d.truncated, false);
});

test('大文件改 1 行：+1 -1，不再是 +0 -400', () => {
  // 曾经：文件超 1500 行就退化成「整段替换」，再被 maxLines 切一刀 → 前 400 项全是删除行
  const oldText = gen(1800);
  const newText = oldText.replace('line 900', 'line 900 changed');
  const d = lineDiffResult(oldText, newText);

  assert.equal(d.added, 1, '新增行数应为 1');
  assert.equal(d.removed, 1, '删除行数应为 1');

  // 且展示侧也没退化：前后缀裁剪后只有改动处附近几行进 diff
  assert.ok(d.ops.length <= 12, `展示行数应很小，实际 ${d.ops.length}`);
  assert.equal(d.truncated, false);
});

test('CRLF 原文件 + LF 新内容：内容相同即视为未变，+0 -0', () => {
  // 行尾不归一化时，逐行比较会判定「每一行都不同」→ 整份文件全删全加 → 截断后 +0 -400
  const crlf = gen(500, (i) => `line ${i}`, '\r\n');
  const lf = gen(500, (i) => `line ${i}`, '\n');
  const d = lineDiffResult(crlf, lf);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.ops.length, 1, '整份文件应当被折叠成一行「……」');
});

test('CRLF 文件改 1 行：+1 -1，行尾差异不干扰匹配', () => {
  const crlf = gen(500, (i) => `line ${i}`, '\r\n');
  const d = lineDiffResult(crlf, crlf.replace('line 10', 'line 10 changed'));
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
});

test('改动量大到展示被截断：计数仍是完整值，truncated 置位', () => {
  const oldText = gen(800);
  const newText = gen(800, (i) => (i % 2 ? `line ${i}` : `CHANGED ${i}`));
  const d = lineDiffResult(oldText, newText);

  assert.equal(d.added, 400, '真实新增 400 行');
  assert.equal(d.removed, 400, '真实删除 400 行');
  assert.equal(d.truncated, true, '展示确实被截断了');
  assert.ok(d.ops.length <= 401, '展示行数受 maxLines 约束');

  // 对照：数展示数组只能得到被切剩的那点数字，这就是线上错值的来源
  const naive = naiveCount(d.ops);
  assert.ok(naive.added < 400 && naive.removed < 400, '展示数组数出来的必然偏小');
});

test('新建文件：added = 行数，removed = 0（旧串为空不该凭空多出一行删除）', () => {
  const d = lineDiffResult('', 'a\nb\nc');
  assert.equal(d.added, 3);
  assert.equal(d.removed, 0, '空串 split 会得到 [""]，历史上这里会多算 1 行删除');
});

test('纯追加：removed = 0', () => {
  const d = lineDiffResult(gen(20, (i) => `l${i}`), gen(25, (i) => `l${i}`));
  assert.equal(d.added, 5);
  assert.equal(d.removed, 0);
});

test('不变量：added - removed 恒等于新行数 - 旧行数（随机改动 30 组）', () => {
  // 这是唯一能一次性兜住所有截断/收缩/退化分支的断言：
  // 无论 diff 怎么被加工，「行数变化量」必须与文本本身自洽。
  let seed = 20261010;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 30; round++) {
    const n = Math.floor(rnd() * 600) + 1;
    const oldText = gen(n, (i) => `row-${i}`);
    const lines = oldText.split('\n');
    const newLines: string[] = [];
    for (const l of lines) {
      const r = rnd();
      if (r < 0.06) continue; // 删
      if (r < 0.12) { newLines.push(`${l}-new`); newLines.push(`${l}-extra`); continue; } // 改并多插一行
      if (r < 0.18) { newLines.push('插一行'); newLines.push(l); continue; }
      newLines.push(l);
    }
    const newText = newLines.join('\n');
    const d = lineDiffResult(oldText, newText);
    assert.equal(
      d.added - d.removed,
      newText.split('\n').length - oldText.split('\n').length,
      `第 ${round} 组：行数变化量应自洽（旧 ${n} 行）`,
    );
  }
});

test('lineDiff 旧签名仍可用，返回展示行数组', () => {
  const ops = lineDiff('a\nb\nc', 'a\nB\nc');
  assert.ok(Array.isArray(ops));
  assert.equal(ops.filter((l) => l.t === '+').length, 1);
  assert.equal(ops.filter((l) => l.t === '-').length, 1);
});
