/**
 * 「假完成」防护 + 「直接调用」单测。
 * 1) 模型只叙述、不调用工具时（文本协议下常见失手），助手应自动续跑而不是就此收尾
 *    —— 这正是会话 a2f868e0「明明没做完却自己结束了」的根因。
 * 2) 收紧提示词后模型会「直接给调用、不写铺垫句」，此时叙述为空，也必须不落空气泡、正常走完。
 */
import assert from 'node:assert/strict';
import { runTurn, looksUnfinished } from '../src/ai/ai-agent.js';
import { createSession, deleteSession, getSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';
import { getLogs, clearLogs } from '../src/core/log-store.js';

// ── 1) 判定函数：真实失手文案必须判为「未完成」；正常最终答复不可误判 ──
assert.equal(
  looksUnfinished('plugins/ 下已经有一个 `gf-checkin` 目录。让我看看它的内容，可能是之前的半成品或可参考的结构。'),
  true, '复现会话 a2f868e0 里的真实失手文案',
);
assert.equal(looksUnfinished('GF- 的文档不多。接下来我搜索整个开发目录。'), true, '「接下来」口吻');
assert.equal(looksUnfinished('我先看一下现有插件结构'), true, '「我先…看」口吻');
assert.equal(looksUnfinished('马上就好：'), true, '句尾冒号');
assert.equal(
  looksUnfinished('已完成 gf-checkin 插件。\n\n- plugins/gf-checkin/package.json\n- plugins/gf-checkin/main.mjs\n\n群里发「签到」送积分，「查询积分」可查。'),
  false, '正常最终总结不应被误判',
);
assert.equal(looksUnfinished('你好，有什么可以帮你？'), false, '普通应答');
assert.equal(looksUnfinished(''), false, '空文本');

const NARRATION = '让我看看它的内容，可能是之前的半成品或可参考的结构。';
const sseWith = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
const probeSaysNoTools = (init?: RequestInit) => String(init?.body || '').includes('kk_probe_tool');
const NO_TOOLS = new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });

const originFetch = globalThis.fetch;
const created: { session: string; profile: string } = { session: '', profile: '' };
try {
  // ── 2) 端到端：连续「只叙述不调用工具」→ 有界自动续跑后正常收尾 ──
  let chatCalls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (probeSaysNoTools(init)) return NO_TOOLS;
    chatCalls += 1;
    return new Response(sseWith(NARRATION), { status: 200 });
  }) as typeof fetch;

  const prof = upsertProfile({
    name: '__test_autocontinue__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0,
  });
  const sess = createSession('t-autocontinue', prof.id);
  created.session = sess.id;
  created.profile = prof.id;
  const events: Array<Record<string, unknown>> = [];
  clearLogs();
  await runTurn(sess.id, '帮我写一个官方机器人签到插件', (e) => events.push(e as Record<string, unknown>));
  const notes = events.filter((e) => e.type === 'step_note');
  const s = getSession(sess.id);
  assert.equal(chatCalls, 3, '叙述→续跑→叙述→续跑→叙述：共 3 次对话请求');
  assert.equal(notes.length, 2, '恰好 2 次自动续跑（有上限，不会无限空转烧钱）');
  assert.equal(events.some((e) => e.type === 'done'), true, '最终正常收尾（发出 done）');
  assert.equal(s?.status, 'idle', '会话回到 idle');
  assert.equal(s?.messages[s.messages.length - 1]?.content, NARRATION, '末条即最终答复');
  assert.equal(s?.messages.filter((m) => m.role === 'user').length, 1, '续跑提示不落库（只有 1 条真实用户消息）');
  assert.equal(getLogs(500).filter((l) => l.message.includes('自动续跑')).length, 2, '每次自动续跑都写运行日志');

  // ── 3) 端到端：直接调用工具、零铺垫（收紧提示词后的新常态）──
  // 同一文件只保留一个 session/profile 便于清理，这里换新的一条
  deleteSession(created.session);
  deleteProfile(created.profile);

  const FINAL = '已完成：plugins 目录结构已确认。';
  const queue = [sseWith(`\n@@TOOL_CALL ${JSON.stringify({ tool: 'list_dir', args: { path: 'plugins' } })}\n`), sseWith(FINAL)];
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (probeSaysNoTools(init)) return NO_TOOLS;
    const next = queue.shift();
    if (!next) throw new Error('出现预期之外的额外请求');
    return new Response(next, { status: 200 });
  }) as typeof fetch;

  const prof2 = upsertProfile({
    name: '__test_directcall__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0,
  });
  const sess2 = createSession('t-directcall', prof2.id);
  created.session = sess2.id;
  created.profile = prof2.id;
  await runTurn(sess2.id, '看看 plugins 目录', () => { /* noop */ });
  const msgs = getSession(sess2.id)?.messages || [];
  const asst = msgs.find((m) => m.role === 'assistant' && m.toolCalls?.length);
  assert.equal(asst?.content, '', '零铺垫时 assistant 文本为空（前端据此不渲染空气泡）');
  assert.equal(msgs.some((m) => m.role === 'tool' && m.toolName === 'list_dir'), true, '工具确实被执行');
  assert.equal(msgs[msgs.length - 1]?.content, FINAL, '最终答复正常落库、任务走完');
  assert.equal(getSession(sess2.id)?.status, 'idle', '会话回到 idle');
} finally {
  if (created.session) deleteSession(created.session);
  if (created.profile) deleteProfile(created.profile);
  globalThis.fetch = originFetch;
}
