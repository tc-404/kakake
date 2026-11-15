/**
 * 会话 token 用量链路单测（前端「耗时」左侧那四个数字的数据来源）。
 *
 * 展示目标：输入 / 输出 / 缓存 / 缓存命中率，属**本会话**累计，每来一步新用量就刷一次。
 * 因此服务端必须把「本步增量 + 本轮累计 + 会话累计」一起下发，前端不做任何累加
 * （否则刷新后重新拉会话会算重）。
 *
 * 这里守四条线：
 *   1) 上游 usage → `usage` 流事件，`turn` 是本轮增量、`session` = 历史累计 + 本轮；
 *   2) usage 落进最终 assistant 消息，刷新后能靠它把数字还原回来；
 *   3) Anthropic `message_delta` **同时**带 usage 与 stop_reason 时两者都要取到
 *      （曾写成 else-if 链，导致 stop_reason 被吞、max_tokens 截断防护整体失效）；
 *   4) 多步 / 多次上游访问逐次累加，缓存命中数字不被 undefined 覆盖掉。
 */
import assert from 'node:assert/strict';
import { runTurn } from '../src/ai/ai-agent.js';
import { appendMessage, createSession, deleteSession, getSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile, type AiProfile } from '../src/ai/ai-provider.js';

// ── SSE 构造：按真实 Anthropic 事件流形状（message_delta 同时带 usage + stop_reason）──
const sse = (...events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

interface StepOpts { input: number; cached: number; output: number; stop?: string; cacheWrite?: number }
const anthropicStep = (text: string, o: StepOpts) =>
  sse(
    {
      type: 'message_start',
      message: {
        usage: {
          input_tokens: o.input,
          cache_read_input_tokens: o.cached,
          cache_creation_input_tokens: o.cacheWrite ?? 0,
        },
      },
    },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: o.stop ?? 'end_turn' }, usage: { output_tokens: o.output } },
  );

/** 建一个档案：toolsPassthrough 只能对**已存在**的档案回写（新建时不拷贝该字段），故两步写入 */
function makeProfile(name: string): AiProfile {
  const p = upsertProfile({
    name, protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0, maxTokens: 4096,
  });
  return upsertProfile({ ...p, toolsPassthrough: false }); // false → 文本协议，省掉穿透探测
}

const usageEvents = (events: Array<Record<string, unknown>>) => events.filter((e) => e.type === 'usage');
const lastAssistant = (sessionId: string) =>
  getSession(sessionId)?.messages.filter((m) => m.role === 'assistant').slice(-1)[0];

const originFetch = globalThis.fetch;
const created: Array<{ session: string; profile: string }> = [];
try {
  // ── 1) 单步：历史累计 + 本轮增量 → usage 事件的 turn / session 都要对 ──
  {
    globalThis.fetch = (async () => new Response(
      anthropicStep('目录已确认，插件已写好。', { input: 2000, cached: 800, output: 300, cacheWrite: 0 }),
      { status: 200 },
    )) as typeof fetch;

    const prof = makeProfile('__test_usage1__');
    const sess = createSession('t-usage1', prof.id);
    created.push({ session: sess.id, profile: prof.id });
    // 历史消息自带用量（模拟上一轮已跑过），用来验证 usageBase
    appendMessage(sess.id, {
      role: 'assistant', content: '上一轮的答复', time: Date.now(),
      usage: { input: 1000, output: 100, cached: 400, cacheWrite: 50 },
    });

    const events: Array<Record<string, unknown>> = [];
    await runTurn(sess.id, '写一个签到插件', (e) => events.push(e as Record<string, unknown>));

    const us = usageEvents(events);
    assert.equal(us.length, 1, '一步一次上游访问 → 恰好一个 usage 事件');
    assert.deepEqual(us[0].turn, { input: 2000, output: 300, cached: 800, cacheWrite: 0 }, 'turn = 本轮增量');
    assert.deepEqual(
      us[0].session, { input: 3000, output: 400, cached: 1200, cacheWrite: 50 },
      'session = 历史累计(1000/100/400/50) + 本轮(2000/300/800/0)',
    );

    const last = lastAssistant(sess.id);
    assert.deepEqual(last?.usage, { input: 2000, output: 300, cached: 800, cacheWrite: 0 }, '本轮用量落库（刷新后据此还原）');
    assert.match(String(last?.content), /插件已写好/, '正常收尾，正文完整');
    assert.equal(getSession(sess.id)?.status, 'idle');
  }

  // ── 2) Anthropic：usage 与 stop_reason 同一事件 → 截断仍要被识别（防 else-if 回归）──
  {
    globalThis.fetch = (async () => new Response(
      anthropicStep('插件已经写好，功能包括签到与查询积分，数据保存在', { input: 500, cached: 100, output: 60, stop: 'max_tokens' }),
      { status: 200 },
    )) as typeof fetch;

    const prof = makeProfile('__test_usage2__');
    const sess = createSession('t-usage2', prof.id);
    created.push({ session: sess.id, profile: prof.id });

    const events: Array<Record<string, unknown>> = [];
    await runTurn(sess.id, '继续写', (e) => events.push(e as Record<string, unknown>));

    const last = lastAssistant(sess.id);
    assert.match(String(last?.content), /插件已经写好/, '保留正文');
    assert.match(
      String(last?.content), /被上游截断，可能不完整/,
      'message_delta 同时带 usage 与 stop_reason=max_tokens 时，stop_reason 不能被 usage 分支吞掉',
    );
    // 被截断 → 自动续跑有上限，每次都是一次真实上游访问，因而累加
    const us = usageEvents(events);
    assert.equal(us.length, 3, '正文被截断 → 续跑 ×2 → 共 3 次上游访问');
    assert.deepEqual(us[2].turn, { input: 1500, output: 180, cached: 300, cacheWrite: 0 }, '多步用量逐次累加在本轮里');
    assert.deepEqual(us[2].session, us[2].turn, '无历史用量时 session 等于本轮累计');
  }

  // ── 3) 两步（含一次工具调用）：每步各发一次 usage，且 step 序号递增 ──
  {
    let call = 0;
    globalThis.fetch = (async () => {
      call += 1;
      return new Response(
        call === 1
          ? anthropicStep('先看一下目录。\n@@TOOL_CALL {"tool":"list_dir","args":{"path":"."}}', { input: 500, cached: 100, output: 50 })
          : anthropicStep('目录已确认，任务完成。', { input: 900, cached: 300, output: 80 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const prof = makeProfile('__test_usage3__');
    const sess = createSession('t-usage3', prof.id);
    created.push({ session: sess.id, profile: prof.id });

    const events: Array<Record<string, unknown>> = [];
    await runTurn(sess.id, '看看目录', (e) => events.push(e as Record<string, unknown>));

    assert.equal(call, 2, '文本协议下解析出工具调用 → 第 2 步收尾');
    const us = usageEvents(events);
    assert.equal(us.length, 2, '两步各发一次 usage（前端据此逐步刷新）');
    assert.equal(us[0].step, 1, '第一步');
    assert.equal(us[1].step, 2, '第二步');
    assert.deepEqual(us[0].turn, { input: 500, output: 50, cached: 100, cacheWrite: 0 });
    assert.deepEqual(us[1].turn, { input: 1400, output: 130, cached: 400, cacheWrite: 0 }, '第 2 步的 turn 是两步之和');
    assert.deepEqual(lastAssistant(sess.id)?.usage, { input: 1400, output: 130, cached: 400, cacheWrite: 0 }, '只把本轮总量落到最终答复上');
  }
} finally {
  for (const c of created) {
    if (c.session) deleteSession(c.session);
    if (c.profile) deleteProfile(c.profile);
  }
  globalThis.fetch = originFetch;
}

console.log('会话 token 用量 3 项场景全部通过');
