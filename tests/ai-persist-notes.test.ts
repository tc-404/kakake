/**
 * 过程节点落库单测（刷新不丢）。
 *
 * 背景：思考完成 / 上游瞬断重试 / 自动续跑 这些过程状态原来只存在于前端流内状态，
 * 一旦刷新网页（甚至本轮刚一结束 clearLive）就消失，用户反馈「是不是没保存？」
 * 现在它们会作为 note 元数据落进会话文件：
 *  1) 每一步思考出结果 → 落一条 note（瞬断恢复记 retry，否则记 think）；
 *  2) 自动续跑 → 落一条 note；
 *  3) note 只是时间线展示，绝不能进模型上下文（buildHistory 必须跳过）；
 *  4) 也不能干扰文件变更汇总（collectTaskChanges 的任务边界判定）。
 */
import assert from 'node:assert/strict';
import { runTurn } from '../src/ai/ai-agent.js';
import { createSession, deleteSession, getSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';

const sseWith = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
const probeSaysNoTools = (init?: RequestInit) => String(init?.body || '').includes('kk_probe_tool');
const NO_TOOLS = new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });

const originFetch = globalThis.fetch;
const createdSessions: string[] = [];
const createdProfiles: string[] = [];
const mkProfile = (name: string, retryCount = 0) => {
  const p = upsertProfile({
    name, protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount,
  });
  createdProfiles.push(p.id);
  return p;
};

try {
  // ── 1) 文本协议 + 工具调用：每步落 think note；note 不进上下文 ──
  {
    const bodies: string[] = [];
    const queue = [
      sseWith(`\n@@TOOL_CALL ${JSON.stringify({ tool: 'list_dir', args: { path: 'plugins' } })}\n`),
      sseWith('已完成：plugins 目录结构已确认。'),
    ];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (probeSaysNoTools(init)) return NO_TOOLS;
      bodies.push(String(init?.body || ''));
      const next = queue.shift();
      if (!next) throw new Error('出现预期之外的额外请求');
      return new Response(next, { status: 200 });
    }) as typeof fetch;

    const prof = mkProfile('__test_note_think__');
    const sess = createSession('t-note-think', prof.id);
    createdSessions.push(sess.id);
    await runTurn(sess.id, '看看 plugins 目录', () => { /* noop */ });

    const msgs = getSession(sess.id)?.messages || [];
    const notes = msgs.filter((m) => m.note);
    assert.equal(notes.length, 2, '两步各落一条过程节点');
    assert.equal(notes.every((m) => m.content === ''), true, '过程节点 content 恒为空');
    assert.equal(notes.every((m) => m.noteKind === 'think'), true, '无瞬断时记「思考完成」');
    assert.equal(notes.every((m) => m.note === '思考完成'), true, '文案为「思考完成」');
    // 顺序：思考完成 → 工具调用（步骤卡），即 note 落在对应步骤的 assistant 调用之前
    const firstNote = msgs.findIndex((m) => m.note);
    const firstToolcalls = msgs.findIndex((m) => m.role === 'assistant' && m.toolCalls?.length);
    assert.ok(firstNote >= 0 && firstNote < firstToolcalls, 'note 排在它所属步骤的工具调用之前');
    // note 绝不进模型上下文（第二次请求发生在第一条 note 落库之后）
    assert.equal(bodies.some((b) => b.includes('思考完成')), false, '过程节点不得进入模型上下文');
  }

  // ── 2) 上游瞬断：重试记录成 retry note，刷新后仍能看到「已自动重试 N 次」──
  {
    const queue: Array<Response | string> = [
      new Response('upstream boom', { status: 503 }),
      sseWith('已完成：目录已确认。'),
    ];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (probeSaysNoTools(init)) return NO_TOOLS;
      const next = queue.shift();
      if (!next) throw new Error('出现预期之外的额外请求');
      return next instanceof Response ? next : new Response(next, { status: 200 });
    }) as typeof fetch;

    const prof = mkProfile('__test_note_retry__', 1);
    const sess = createSession('t-note-retry', prof.id);
    createdSessions.push(sess.id);
    const events: Array<Record<string, unknown>> = [];
    await runTurn(sess.id, '确认一下目录', (e) => events.push(e as Record<string, unknown>));

    assert.equal(events.filter((e) => e.type === 'step_retry').length, 1, '发生过一次瞬断重试');
    const notes = (getSession(sess.id)?.messages || []).filter((m) => m.note);
    assert.equal(notes.length, 1, '恢复后落一条过程节点');
    assert.equal(notes[0].noteKind, 'retry', '类型为重试');
    assert.ok(/已自动重试 1 次/.test(notes[0].note || ''), '文案记录了重试次数');
  }

  // ── 3) 自动续跑：落 note，且续跑提示本身仍不落库 ──
  {
    const NARRATION = '让我看看它的内容，可能是之前的半成品或可参考的结构。';
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (probeSaysNoTools(init)) return NO_TOOLS;
      return new Response(sseWith(NARRATION), { status: 200 });
    }) as typeof fetch;

    const prof = mkProfile('__test_note_autocontinue__');
    const sess = createSession('t-note-autocontinue', prof.id);
    createdSessions.push(sess.id);
    await runTurn(sess.id, '帮我写一个官方机器人签到插件', () => { /* noop */ });

    const msgs = getSession(sess.id)?.messages || [];
    const continueNotes = msgs.filter((m) => m.note && m.noteKind === 'note');
    assert.equal(continueNotes.length, 2, '2 次自动续跑 → 2 条过程节点');
    assert.equal(continueNotes.every((m) => /自动续跑/.test(m.note || '')), true, '文案标记自动续跑');
    assert.equal(msgs.filter((m) => m.role === 'user').length, 1, '续跑提示仍不落库');
    assert.equal(msgs[msgs.length - 1].content, NARRATION, '末条为最终答复');
  }
} finally {
  for (const id of createdSessions) deleteSession(id);
  for (const id of createdProfiles) deleteProfile(id);
  globalThis.fetch = originFetch;
}
