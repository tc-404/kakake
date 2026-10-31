/**
 * 「思考烧完输出预算 → 空答复静默结束」防护单测。
 *
 * 复现会话 221a504c 的真实故障：第 4 步模型流式只回了 8019 字思考（thinking_delta），
 * 既没有正文也没有工具调用，且上游以 max_tokens 截断。修复前会落一条 content 为空的
 * 最终答复、界面什么都不显示 —— 用户看到的是「到这一步就直接卡住、没有下一步操作」。
 *
 * 现在的要求：
 *   1) 空答复绝不当成最终答复 → 先自动续跑（有上限）
 *   2) 续跑额度用完后 → 落一条**非空**的可诊断提示（不是空气泡）
 *   3) 有正文但被 max_tokens 截断 → 续跑；仍截断时在答复尾部补「不完整」说明
 */
import assert from 'node:assert/strict';
import { runTurn, isLengthStop, emptyAnswerNotice } from '../src/ai/ai-agent.js';
import { createSession, deleteSession, getSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';
import { getLogs, clearLogs } from '../src/core/log-store.js';

// ── 0) 停止原因的归一化：OpenAI 的 length 与 Anthropic 的 max_tokens 同义 ──
assert.equal(isLengthStop('length'), true, 'OpenAI finish_reason=length 视为截断');
assert.equal(isLengthStop('max_tokens'), true, 'Anthropic stop_reason=max_tokens 视为截断');
assert.equal(isLengthStop('end_turn'), false, '正常收尾不是截断');
assert.match(emptyAnswerNotice(4, 8019, 'max_tokens'), /最大输出长度/, '兜底文案要点明是 max_tokens');

// ── Anthropic SSE 片段 ──
const thinkingSSE = (text: string, stopReason: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: text } })}\n\n`
  + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}\n\n`;
const textSSE = (text: string, stopReason: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}\n\n`;

const probeSaysNoTools = (init?: RequestInit) => String(init?.body || '').includes('kk_probe_tool');
const NO_TOOLS = new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });

const originFetch = globalThis.fetch;
const created: { session: string; profile: string } = { session: '', profile: '' };
try {
  // ── 1) 端到端：连续「只有思考、无正文无工具」 → 有界续跑 → 最后给出非空提示 ──
  let chatCalls = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (probeSaysNoTools(init)) return NO_TOOLS;
    chatCalls += 1;
    return new Response(thinkingSSE('用户在等一个签到插件，我再推演一下数据结构的边界情况……', 'max_tokens'), { status: 200 });
  }) as typeof fetch;

  const prof = upsertProfile({
    name: '__test_emptyanswer__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0, maxTokens: 4096,
  });
  const sess = createSession('t-emptyanswer', prof.id);
  created.session = sess.id;
  created.profile = prof.id;
  const events: Array<Record<string, unknown>> = [];
  clearLogs();
  await runTurn(sess.id, '帮我写一个官方机器人签到插件', (e) => events.push(e as Record<string, unknown>));

  const s = getSession(sess.id);
  const last = s?.messages[s.messages.length - 1];
  const notes = events.filter((e) => e.type === 'step_note');

  assert.equal(chatCalls, 3, '只思考 → 续跑 ×2 → 共 3 次对话请求（有上限，不会无限烧钱）');
  assert.equal(notes.length, 2, '恰好 2 次自动续跑');
  assert.match(String(notes[0]?.text || ''), /只有思考/, '续跑原因点明「只有思考」');
  assert.equal(events.some((e) => e.type === 'done'), true, '最终正常收尾（发出 done）');
  assert.equal(s?.status, 'idle', '会话回到 idle');
  assert.equal(last?.role, 'assistant', '末条是 assistant');
  assert.ok((last?.content || '').trim().length > 0, '末条绝不能是空气泡（这就是「界面卡死」的根因）');
  assert.match(String(last?.content), /^⚠️ 本轮在第 3 步停止/, '给出可诊断的收尾提示');
  assert.match(String(last?.content), /最大输出长度/, '点明 max_tokens 截断');
  assert.equal(s?.messages.some((m) => m.role === 'assistant' && m.content === '' && !m.note && !m.toolCalls), false, '不允许出现空正文的 assistant 消息');
  assert.ok(
    getLogs(500).some((l) => l.message.includes('无正文且无工具调用')),
    '运行日志记录该异常收尾，便于事后排查',
  );

  // ── 2) 端到端：有正文但被截断 → 先续跑；额度用完后答复尾部补「不完整」说明 ──
  deleteSession(created.session);
  deleteProfile(created.profile);

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (probeSaysNoTools(init)) return NO_TOOLS;
    return new Response(textSSE('插件已经写好，功能包括签到与查询积分，数据保存在', 'max_tokens'), { status: 200 });
  }) as typeof fetch;

  const prof2 = upsertProfile({
    name: '__test_emptyanswer2__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0, maxTokens: 4096,
  });
  const sess2 = createSession('t-emptyanswer2', prof2.id);
  created.session = sess2.id;
  created.profile = prof2.id;
  await runTurn(sess2.id, '继续', () => { /* noop */ });
  const last2 = getSession(sess2.id)?.messages.slice(-1)[0];
  assert.match(String(last2?.content), /^插件已经写好/, '保留正文');
  assert.match(String(last2?.content), /被上游截断，可能不完整/, '尾部补截断说明');
  assert.equal(getSession(sess2.id)?.status, 'idle', '会话回到 idle');
} finally {
  if (created.session) deleteSession(created.session);
  if (created.profile) deleteProfile(created.profile);
  globalThis.fetch = originFetch;
}

console.log('空答复防护 2 项场景全部通过');
