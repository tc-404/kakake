/**
 * 「服务端仍在执行本轮」的契约单测。
 *
 * 背景：刷新网页后 SSE 流必然断开（流挂在原来那次 POST 请求上），本地 `running` 变 false，
 * 但服务端仍在正常跑。前端只能靠服务端**内存里的运行标记**把界面恢复成「执行中」：
 *   - `GET /api/ai/sessions/:id` → `running: isRunning(id)`，且落库 status = 'running'
 *   - `GET /api/ai/sessions`     → `runningIds: runningSessionIds()`，且自愈残留的 running
 * 这两个接口的语义一旦变了，前端就会退回「假空闲」（明明在跑却允许下新指令）。
 * 这里直接把控制器方法拉起来断言，锁死契约。
 */
import assert from 'node:assert/strict';
import { AiApiController } from '../src/admin/ai-api.controller.js';
import { runTurn, isRunning } from '../src/ai/ai-agent.js';
import { createSession, deleteSession, getSession, updateSessionMeta } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile } from '../src/ai/ai-provider.js';

const sseWith = (text: string) =>
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
const probeSaysNoTools = (init?: RequestInit) => String(init?.body || '').includes('kk_probe_tool');
const NO_TOOLS = new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
const FINAL = '已完成：服务端契约检查。';

const originFetch = globalThis.fetch;
const ctrl = new AiApiController();
const createdSessions: string[] = [];
const createdProfiles: string[] = [];

try {
  // ── 1) 一轮在飞：getSession 必须报 running、落库 status 必须是 running ──
  // 用一个「卡住不返回」的流，把这一轮定格在飞行中，模拟用户此刻刷新网页
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (probeSaysNoTools(init)) return NO_TOOLS;
    return new Response(new ReadableStream({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(sseWith(FINAL)));
        controller.close();
      },
    }), { status: 200 });
  }) as typeof fetch;

  const prof = upsertProfile({
    name: '__test_running_flag__', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
    apiPath: '', apiKey: 'k', model: 'm', retryCount: 0,
  });
  createdProfiles.push(prof.id);
  const sess = createSession('t-running-flag', prof.id);
  createdSessions.push(sess.id);

  const inFlight = runTurn(sess.id, '跑一个长任务', () => { /* noop */ });
  // runTurn 同步执行到第一个 await 之前就已登记内存运行标记并落库 running
  assert.equal(isRunning(sess.id), true, '调用后立刻登记内存运行标记');

  const detail = ctrl.getSessionApi(sess.id);
  assert.equal(detail.running, true, 'GET /sessions/:id 必须如实报 running=true（前端据此恢复执行中状态）');
  assert.equal(detail.session.status, 'running', '落库状态为 running');

  const list = ctrl.listSessionsApi();
  assert.equal(list.runningIds.includes(sess.id), true, 'GET /sessions 的 runningIds 必须含该会话');
  const meta = list.sessions.find((s) => s.id === sess.id);
  assert.equal(meta?.status, 'running', '真在跑的会话不得被自愈成 idle');

  release();
  await inFlight;

  // ── 2) 跑完：两个接口都要回到「不在跑」 ──
  assert.equal(isRunning(sess.id), false, '结束后内存标记清除');
  assert.equal(ctrl.getSessionApi(sess.id).running, false, '结束后 running=false');
  const list2 = ctrl.listSessionsApi();
  assert.equal(list2.runningIds.includes(sess.id), false, '结束后 runningIds 不含该会话');
  assert.equal(list2.sessions.find((s) => s.id === sess.id)?.status, 'idle', '会话回到 idle');
  assert.equal(getSession(sess.id)?.messages.at(-1)?.content, FINAL, '任务确实跑完了');

  // ── 3) 自愈：进程异常退出残留的 running 必须被归位（否则前端会永远转圈） ──
  updateSessionMeta(sess.id, { status: 'running' }); // 内存无对应运行，模拟残留
  const healed = ctrl.listSessionsApi();
  assert.equal(healed.sessions.find((s) => s.id === sess.id)?.status, 'idle', '残留 running 被自愈为 idle');
  assert.equal(healed.runningIds.includes(sess.id), false, '残留状态不进 runningIds');
  assert.equal(getSession(sess.id)?.status, 'idle', '自愈结果写回文件，后续 getSession 也一致');
} finally {
  for (const id of createdSessions) deleteSession(id);
  for (const id of createdProfiles) deleteProfile(id);
  globalThis.fetch = originFetch;
}
