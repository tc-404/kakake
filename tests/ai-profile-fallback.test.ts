/**
 * 「会话绑定的档案被删掉后，老会话彻底发不出消息」——回归锁。
 *
 * 现场表现：用户在设置里配好了模型、连接测试也成功，却在**旧会话**里发出的每条消息都失败，
 * 前端显示「执行中断 · 可重试」，界面一片空白，连自己刚发的消息都看不见，后端日志里
 * 一条上游记录都没有。
 *
 * 根因：会话创建时把 `profileId` 快照下来，`runTurn` 里是
 *   `session.profileId ? getProfile(session.profileId) : getActiveProfile()`
 * 档案被删后 `getProfile` 返回 null，直接抛「未配置 AI 上游档案」。而这一行在
 * `appendMessage` **之前**，所以消息连库都进不去；又因为没走到 `logAction`，日志里什么都没有。
 * 于是「我明明配好了模型」和「发消息就失败」看起来像两件矛盾的事。
 *
 * 正确行为：绑不到就回退到当前激活档案，并把悬空引用就地修正。
 *
 * 注意隔离：这些用例会写真实的 `data/ai/providers.json`（ai-vision 也这么写），
 * 所以这里备份并在 after 里原样恢复，避免跑一次测试就把用户的模型配置搅乱。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { runTurn } from '../src/ai/ai-agent.js';
import { createSession, getSession, deleteSession } from '../src/ai/ai-session.js';
import { upsertProfile, deleteProfile, activateProfile, listProfiles } from '../src/ai/ai-provider.js';
import { PATHS } from '../src/paths.js';

const STORE = path.join(PATHS.data, 'ai', 'providers.json');
const originFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;

let storeBackup: string | null = null;
const bodies: Array<Record<string, any>> = [];
const madeProfiles: string[] = [];
const madeSessions: string[] = [];

/** OpenAI 协议的最小可用 SSE 响应 */
const SSE_OA = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
  + 'data: [DONE]\n\n';

function stubFetch(): void {
  bodies.length = 0;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const raw = String(init?.body || '');
    if (raw.includes('kk_probe_tool')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    }
    bodies.push(JSON.parse(raw));
    return new Response(SSE_OA('收到'), { status: 200 });
  }) as typeof fetch;
}

function mkProfile(name: string, model: string): string {
  const p = upsertProfile({
    name, protocol: 'openai', baseUrl: 'https://upstream.invalid', apiPath: '',
    apiKey: 'k', model, retryCount: 0, maxTokens: 4096, timeoutMs: 120000,
  });
  madeProfiles.push(p.id);
  return p.id;
}

before(() => {
  // 备份真实档案，测试结束后原样还回去
  try { storeBackup = fs.readFileSync(STORE, 'utf-8'); } catch { storeBackup = null; }
  stubFetch();
});

after(() => {
  for (const id of madeSessions) { try { deleteSession(id); } catch { /* ignore */ } }
  for (const id of madeProfiles) { try { deleteProfile(id); } catch { /* ignore */ } }
  if (storeBackup !== null) {
    try { fs.writeFileSync(STORE, storeBackup, 'utf-8'); } catch { /* ignore */ }
  } else {
    try { fs.unlinkSync(STORE); } catch { /* ignore */ }
  }
  if (originFetch) globalThis.fetch = originFetch;
});

beforeEach(() => { bodies.length = 0; });

/** 收集一次 runTurn 产生的事件 */
async function run(sessionId: string, text: string): Promise<void> {
  await runTurn(sessionId, text, () => { /* noop */ });
}

test('会话绑定的档案已被删除 → 回退到当前激活档案，任务照常完成', async () => {
  const alive = mkProfile('__test_fb_alive__', 'm-alive');
  const ghost = mkProfile('__test_fb_ghost__', 'm-ghost');
  activateProfile(alive);
  // 造出悬空引用：会话绑了 ghost，随后把 ghost 删掉
  deleteProfile(ghost);

  const sess = createSession('t-profile-fallback', ghost);
  madeSessions.push(sess.id);
  await run(sess.id, '你好');

  const s = getSession(sess.id);
  assert.ok(s, '会话应存在');
  const err = s.messages.find((m) => m.isError);
  assert.equal(err, undefined, `不该报错，实际：${err?.content || ''}`);
  assert.equal(s.profileId, alive, '悬空引用应被就地修正为回退后的档案');
  assert.equal(s.messages.at(-1)?.role, 'assistant', '应留下一条答复');
  assert.ok(bodies.length > 0, '应该真的发出过上游请求');
  assert.equal(bodies.at(-1)?.model, 'm-alive', '请求应打在回退后的档案上');
});

test('回退时会留下一条过程说明，刷新后也能看到', async () => {
  const alive = mkProfile('__test_fb_note__', 'm-alive');
  const ghost = mkProfile('__test_fb_note_ghost__', 'm-ghost');
  activateProfile(alive);
  deleteProfile(ghost);

  const sess = createSession('t-profile-fallback-note', ghost);
  madeSessions.push(sess.id);
  await run(sess.id, '你好');

  const s = getSession(sess.id);
  assert.ok(s);
  const note = s.messages.find((m) => m.note && m.note.includes('已不存在'));
  assert.ok(note, '应落一条「原档案已不存在」的过程节点');
  assert.ok(String(note.note).includes('__test_fb_note__'), `说明里应写明改用了哪个模型：${note.note}`);
});

test('会话绑定的档案仍在 → 沿用绑定档案，不被激活档案顶掉', async () => {
  const active = mkProfile('__test_fb_active__', 'm-active');
  const bound = mkProfile('__test_fb_bound__', 'm-bound');
  activateProfile(active);

  const sess = createSession('t-profile-fallback-bound', bound);
  madeSessions.push(sess.id);
  await run(sess.id, '你好');

  const s = getSession(sess.id);
  assert.ok(s);
  assert.equal(s.profileId, bound, '绑定有效时不该改');
  assert.equal(bodies.at(-1)?.model, 'm-bound', '应打在会话绑定的档案上');
});

test('确实一个档案都没有时才报「未配置 AI 上游档案」', async () => {
  // 必须把 store 清空到「一个档案都没有」——只删自己建的不够，
  // 用户真实的档案（备份里的）还在，getActiveProfile 会回退到它。after 会原样还原。
  for (const p of listProfiles()) { try { deleteProfile(p.id); } catch { /* ignore */ } }
  madeProfiles.length = 0;
  assert.equal(listProfiles().length, 0, '前置条件：档案应已清空');

  const sess = createSession('t-profile-fallback-none', 'no-such-profile-id');
  madeSessions.push(sess.id);
  // 开场前的失败是直接往外抛的（不进尾部 catch），所以这里断言 rejects
  await assert.rejects(() => run(sess.id, '你好'), /未配置 AI 上游档案/);

  const s = getSession(sess.id);
  assert.ok(s);
  // 关键：即便往外抛，也必须已经落好错误卡片——否则前端只有「执行中断」四个字，正文一片空白
  const err = s.messages.find((m) => m.isError);
  assert.ok(err, '应当留下错误卡片');
  assert.match(err.content, /未配置 AI 上游档案/);
  assert.equal(bodies.length, 0, '没有档案就不该发任何上游请求');
});
