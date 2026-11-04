/**
 * 思考内容（reasoning / thinking）捕获单测。
 *
 * 背景：以前 agent 只把「思考状态」画成一个闪烁的 chip，**模型实际的思考正文被整个丢掉了**
 * （OpenAI 的 reasoning_content、Anthropic 的 thinking block 都没有解析），
 * 用户既看不到连续思考的过程，也没有任何地方能展开查看思考内容。
 *
 * 现在三层都要成立：
 *  1) provider 层：两种协议 × 流式/非流式，都要把思考正文解析成 `thinking` 事件（且先于正文）；
 *  2) agent 层：思考增量随流下发（thinking 事件）并累计，本步结束随过程节点落库；
 *  3) 上下文安全：思考正文字段绝不能进模型上下文（buildHistory 跳过）。
 */
import assert from 'node:assert/strict';
import { streamChat, type AiProfile } from '../src/ai/ai-provider.js';
import { runTurn } from '../src/ai/ai-agent.js';
import { createSession, deleteSession, getSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';

const mkProfile = (o: Partial<AiProfile> = {}): AiProfile => ({
  id: '__test_thinking__', name: '思考测试', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
  apiPath: '', apiKey: 'k', model: 'm', reasoning: 'high', maxTokens: 4096,
  timeoutMs: 5000, retryCount: 0, createdAt: 0, ...o,
});

const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
const sseText = (t: string) => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } });
const sseThink = (t: string) => sse({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } });
const SSE_STOP = sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });

/** 跑一遍 streamChat，收集 (类型, 文本) 序列 */
async function collect(p: AiProfile, body: string): Promise<Array<{ type: string; text?: string }>> {
  globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
  const out: Array<{ type: string; text?: string }> = [];
  for await (const ev of streamChat(p, 'sys', [{ role: 'user', content: 'hi' }], [], new AbortController().signal)) {
    out.push({ type: ev.type, text: ev.text });
  }
  return out;
}

const originFetch = globalThis.fetch;
const createdSessions: string[] = [];
const createdProfiles: string[] = [];

try {
  // ── 1) Anthropic 流式：thinking_delta 必须解析成 thinking，且排在正文之前 ──
  {
    const evs = await collect(
      mkProfile(),
      sseThink('我先看看目录') + sseThink('，再决定改哪里。') + sseText('已完成') + SSE_STOP,
    );
    const thinking = evs.filter((e) => e.type === 'thinking').map((e) => e.text).join('');
    assert.equal(thinking, '我先看看目录，再决定改哪里。', 'Anthropic 流式思考正文被完整捕获');
    const firstThink = evs.findIndex((e) => e.type === 'thinking');
    const firstDelta = evs.findIndex((e) => e.type === 'delta');
    assert.ok(firstThink >= 0 && firstThink < firstDelta, '思考先于正文下发');
  }

  // ── 2) Anthropic 非流式：content 里的 thinking block ──
  {
    const body = JSON.stringify({
      content: [{ type: 'thinking', thinking: '非流式思考' }, { type: 'text', text: '答案' }],
      stop_reason: 'end_turn',
    });
    const evs = await collect(mkProfile({ streamBroken: true }), body);
    assert.equal(evs.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), '非流式思考');
    assert.equal(evs.filter((e) => e.type === 'delta').map((e) => e.text).join(''), '答案');
  }

  // ── 3) OpenAI 流式：reasoning_content 必须解析成 thinking ──
  {
    const body = sse({ choices: [{ delta: { reasoning_content: '先想一下' } }] })
      + sse({ choices: [{ delta: { content: '答案' } }] })
      + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      + 'data: [DONE]\n\n';
    const evs = await collect(mkProfile({ protocol: 'openai' }), body);
    assert.equal(evs.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), '先想一下', 'reasoning_content 被捕获');
    assert.equal(evs.filter((e) => e.type === 'delta').map((e) => e.text).join(''), '答案');
  }

  // ── 4) OpenAI 非流式：reasoning / reasoning_details 兜底字段 ──
  {
    const a = await collect(
      mkProfile({ protocol: 'openai', streamBroken: true }),
      JSON.stringify({ choices: [{ message: { content: '答案', reasoning: '推理字段' } }] }),
    );
    assert.equal(a.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), '推理字段');
    const b = await collect(
      mkProfile({ protocol: 'openai', streamBroken: true }),
      JSON.stringify({ choices: [{ message: { content: '答案', reasoning_details: [{ text: '甲' }, { text: '乙' }] } }] }),
    );
    assert.equal(b.filter((e) => e.type === 'thinking').map((e) => e.text).join(''), '甲乙');
  }

  // ── 5) 端到端：连续两步思考 → 逐块流事件 + 每步各落一条带思考正文的过程节点 ──
  {
    const bodies: string[] = [];
    const probeSaysNoTools = (init?: RequestInit) => String(init?.body || '').includes('kk_probe_tool');
    const NO_TOOLS = new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    const queue = [
      sseThink('第一步思考：') + sseThink('先列目录。')
        + sseText(`\n@@TOOL_CALL ${JSON.stringify({ tool: 'list_dir', args: { path: 'plugins' } })}\n`) + SSE_STOP,
      sseThink('第二步思考：目录已确认。') + sseText('已完成：plugins 目录结构已确认。') + SSE_STOP,
    ];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      if (probeSaysNoTools(init)) return NO_TOOLS;
      bodies.push(String(init?.body || ''));
      const next = queue.shift();
      if (!next) throw new Error('出现预期之外的额外请求');
      return new Response(next, { status: 200 });
    }) as typeof fetch;

    const prof = upsertProfile({
      name: '__test_thinking_flow__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
      apiPath: '', apiKey: 'k', model: 'm', retryCount: 0,
    });
    createdProfiles.push(prof.id);
    const sess = createSession('t-thinking-flow', prof.id);
    createdSessions.push(sess.id);

    const events: Array<Record<string, unknown>> = [];
    await runTurn(sess.id, '看看 plugins 目录', (e) => events.push(e as Record<string, unknown>));

    // 逐块下发：前端才能看到「连续思考」而不是一次性的一个状态
    const streamed = events.filter((e) => e.type === 'thinking').map((e) => String(e.text)).join('');
    assert.equal(streamed, '第一步思考：先列目录。第二步思考：目录已确认。', '思考增量按发生顺序逐块下发');

    // 落库：每一步各一条过程节点，各自带自己的思考正文
    const notes = (getSession(sess.id)?.messages || []).filter((m) => m.note);
    assert.equal(notes.length, 2, '两步各落一条过程节点');
    assert.equal(notes[0].thinking, '第一步思考：先列目录。', '第一条节点带第一步的思考');
    assert.equal(notes[1].thinking, '第二步思考：目录已确认。', '第二条节点带第二步的思考');
    assert.ok(notes.every((m) => m.noteKind === 'think'), '无瞬断时记「思考完成」');

    // 上下文安全：思考正文只是展示元数据，绝不能回灌给模型
    assert.equal(bodies.length, 2, '两次模型请求');
    assert.equal(bodies.some((b) => b.includes('第一步思考')), false, '思考正文不得进入模型上下文');
    assert.equal((getSession(sess.id)?.messages || []).some((m) => m.content.includes('第一步思考')), false, '思考正文不得混进正文 content');
  }
} finally {
  for (const id of createdSessions) deleteSession(id);
  for (const id of createdProfiles) deleteProfile(id);
  globalThis.fetch = originFetch;
}
