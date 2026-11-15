/** collectTaskChanges 单测：任务边界识别 + 断点续跑收集 */
import assert from 'node:assert/strict';
import { createSession, appendMessage, deleteSession } from '../src/ai/ai-session.js';
import { collectTaskChanges } from '../src/ai/ai-agent.js';

const mkChange = (path: string) => ({ path, kind: 'modify' as const, diff: [{ t: '+', s: 'x' }] });

// 场景1：正常单轮（user → assistant带toolCalls → tool(change) → tool(change)），未结束
const s1 = createSession('t1', 'p');
appendMessage(s1.id, { role: 'user', content: '任务', time: 1 });
appendMessage(s1.id, { role: 'assistant', content: '', time: 2, toolCalls: [{ id: 'a', name: 'read_file', args: {} }] });
appendMessage(s1.id, { role: 'tool', content: '', time: 3, change: mkChange('a.txt') });
appendMessage(s1.id, { role: 'tool', content: '', time: 4, change: mkChange('b.txt') });
let r = collectTaskChanges(s1.id);
assert.deepEqual(r.map((c) => c.path), ['a.txt', 'b.txt'], '场景1: 收集本轮工具变更');

// 场景2：出错卡片不应阻断，最终答复应视为上一任务边界
appendMessage(s1.id, { role: 'assistant', content: '⚠️ 执行出错', time: 5, isError: true });
r = collectTaskChanges(s1.id);
assert.deepEqual(r.map((c) => c.path), ['a.txt', 'b.txt'], '场景2: 错误卡片不阻断');

// 场景3：任务完成（最终 assistant 无 toolCalls）→ 边界成立，收集为空
appendMessage(s1.id, { role: 'assistant', content: '完成', time: 6 });
r = collectTaskChanges(s1.id);
assert.deepEqual(r, [], '场景3: 完成后回到新任务边界');
deleteSession(s1.id);

// 场景4：断点续跑——出错前半段写的文件 + 续跑段写的文件都应收集
const s2 = createSession('t2', 'p');
appendMessage(s2.id, { role: 'user', content: '做插件', time: 1 });
appendMessage(s2.id, { role: 'assistant', content: '', time: 2, toolCalls: [{ id: 'a', name: 'write_file', args: {} }] });
appendMessage(s2.id, { role: 'tool', content: '', time: 3, change: mkChange('plugins/x/index.js') });
appendMessage(s2.id, { role: 'assistant', content: '⚠️ 执行出错', time: 4, isError: true }); // 中断
// retry: 弹出错误卡，续跑
appendMessage(s2.id, { role: 'assistant', content: '', time: 5, toolCalls: [{ id: 'b', name: 'edit_file', args: {} }] });
appendMessage(s2.id, { role: 'tool', content: '', time: 6, change: mkChange('plugins/x/index.js') });
appendMessage(s2.id, { role: 'tool', content: '', time: 7, change: mkChange('plugins/x/README.md') });
r = collectTaskChanges(s2.id);
// 同路径后者覆盖：index.js 只留一次（续跑段），README.md 保留
assert.deepEqual(
  r.map((c) => c.path).sort(),
  ['plugins/x/README.md', 'plugins/x/index.js'],
  '场景4: 续跑前后变更合并且同路径去重',
);
deleteSession(s2.id);

// 场景5：不存在会话
assert.deepEqual(collectTaskChanges('no-such-id'), [], '场景5: 未知会话返回空');

console.log('collectTaskChanges 5 项场景全部通过');
