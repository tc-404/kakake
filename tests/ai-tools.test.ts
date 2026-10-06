/** 文件工具单测：按行分页读取 / 搜索返回命中内容 / 参数缺失的报错文案
 *
 *  背景（为什么要有这个测试）：
 *  历史 bug —— read_file 只返回文件开头且工具结果入库被截到 8000 字符，
 *  模型为了看日志中段只能换关键词反复 search_text（实测同一目录被搜 86 次），
 *  最后得出「我读不到」的错误结论。这里锁住修复后的三个行为。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runTool } from '../src/ai/ai-tools.js';
import { PATHS } from '../src/paths.js';

const DIR = 'data/tmp/ai-tools-test';
const ABS = path.join(PATHS.root, DIR);
fs.rmSync(ABS, { recursive: true, force: true });
fs.mkdirSync(ABS, { recursive: true });

// 造一个 1000 行的文件，第 675 行放一个独特标记（还原「日志中段读不到」的场景）
const lines = Array.from({ length: 1000 }, (_, i) => `row ${String(i + 1).padStart(4, '0')} filler`);
lines[674] = 'row 0675 NEEDLE_IN_MIDDLE';
fs.writeFileSync(path.join(ABS, 'big.txt'), lines.join('\n'), 'utf-8');
fs.writeFileSync(path.join(ABS, 'small.txt'), 'a\nb\nc', 'utf-8');

// —— 1. 默认只给前 400 行，并明确告知总数与后续读法 ——
let r = runTool('read_file', { path: `${DIR}/big.txt` }, 's');
assert.equal(r.ok, true);
assert.match(r.output, /共 1000 行/, '1: 头部应给出总行数');
assert.match(r.output, /本次返回第 1-400 行/, '1: 默认返回前 400 行');
assert.match(r.output, /offset:401/, '1: 应告知用 offset=401 继续读');
assert.ok(!r.output.includes('NEEDLE_IN_MIDDLE'), '1: 第 675 行不应出现在默认窗口里');

// —— 2. offset 能精确读到中段（这是「读不到」的修复点）——
r = runTool('read_file', { path: `${DIR}/big.txt`, offset: 670, limit: 10 }, 's');
assert.equal(r.ok, true);
assert.match(r.output, /本次返回第 670-679 行/, '2: offset+limit 生效');
assert.ok(r.output.includes('NEEDLE_IN_MIDDLE'), '2: 第 675 行必须能读到');

// —— 3. 超出文件尾不越界、小文件一次读完 ——
r = runTool('read_file', { path: `${DIR}/big.txt`, offset: 990, limit: 100 }, 's');
assert.match(r.output, /本次返回第 990-1000 行/, '3: 末段正确夹紧');
r = runTool('read_file', { path: `${DIR}/small.txt` }, 's');
assert.match(r.output, /共 3 行，本次返回第 1-3 行/, '3: 小文件全量返回');
assert.ok(r.output.includes('a\nb\nc'), '3: 内容完整');

// —— 4. search_text 返回「文件:行号: 该行内容」，不再是光秃秃的行号 ——
r = runTool('search_text', { query: 'NEEDLE_IN_MIDDLE', path: DIR }, 's');
assert.equal(r.ok, true);
assert.match(r.output, new RegExp(`${DIR}/big\\.txt:675: row 0675 NEEDLE_IN_MIDDLE`), '4: 命中行要带内容');

// —— 5. 一个文件里的多处命中都要列出（旧实现只用 indexOf 取第一处）——
r = runTool('search_text', { query: 'filler', path: DIR }, 's');
assert.match(r.output, /big\.txt:1: /, '5: 第 1 行命中');
assert.match(r.output, /big\.txt:10: /, '5: 第 10 行也命中（旧实现只会给第一处）');

// —— 6. 无命中时给出可诊断的信息，而不是干巴巴的「无匹配结果」——
r = runTool('search_text', { query: '绝不可能出现的串_xyz', path: DIR }, 's');
assert.equal(r.ok, true);
assert.match(r.output, /无匹配结果/, '6: 无命中');
assert.match(r.output, /绝不可能出现的串_xyz/, '6: 回显 query 便于自纠');

// —— 7. 缺 path 参数 → 报「缺少 path 参数」，不是笼统的「非法路径输入」——
r = runTool('write_file', { content: 'x' }, 's');
assert.equal(r.ok, false);
assert.match(r.output, /缺少 path 参数/, '7: 点名缺 path');
assert.ok(!r.output.includes('非法路径输入'), '7: 不应再误报非法路径');

// —— 8. search_text 的 path 可省略（默认 plugins/）——
r = runTool('search_text', { query: 'plugin_onmessage', path: '' }, 's');
assert.equal(r.ok, true, '8: 省略 path 时默认搜 plugins/');

// —— 9. write_file / edit_file 仍能正常工作 ——
r = runTool('write_file', { path: `${DIR}/w.txt`, content: 'hello' }, 's');
assert.equal(r.ok, true);
assert.equal(r.change?.kind, 'create');
r = runTool('edit_file', { path: `${DIR}/w.txt`, oldText: 'hello', newText: 'world' }, 's');
assert.equal(r.ok, true);
assert.equal(fs.readFileSync(path.join(ABS, 'w.txt'), 'utf-8'), 'world', '9: 替换生效');

// —— 10. 越界路径仍被拒绝（白名单没被放宽）——
r = runTool('read_file', { path: 'src/ai/ai-agent.ts' }, 's');
assert.equal(r.ok, false, '10: src/ 不可读');

fs.rmSync(ABS, { recursive: true, force: true });
console.log('文件工具 10 项场景全部通过');
