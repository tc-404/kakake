/**
 * 图片识别（多模态）回归锁。
 *
 * 三条必须一直成立的约束：
 *  ① 开关默认关 —— 没勾「图片识别」的档案，请求体里绝不能出现图片（否则不支持的上游直接 400）。
 *  ② 开了开关才按各家协议拼成对应的多模态块（OpenAI image_url / Anthropic image+source）。
 *  ③ **上游不支持图片时绝不中断任务** —— 这是用户明确的要求。表现为：第一次请求被拒，
 *     自动摘掉图片重跑同一步，任务照常完成，时间线上留一条说明。
 *
 * 与 ai-cache-prefix 一样用 fake fetch 抓真实请求体，锁的是**真正发出去的东西**。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { buildUserContent } from '../src/ai/ai-agent.js';
import { PATHS } from '../src/paths.js';
import {
  streamChat, upsertProfile, deleteProfile,
  isVisionRejection, clearVisionBlock,
  type AiProfile,
} from '../src/ai/ai-provider.js';

const PNG_1 = 'AAAA';
const PNG_2 = 'BBBB';
const IMG = { name: 'shot.png', mime: 'image/png', b64: PNG_1 };

/** Anthropic 协议的最小可用 SSE 响应 */
const SSE = (text: string): string =>
  `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`
  + `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`
  + `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`;

/** OpenAI 协议的最小可用 SSE 响应 */
const SSE_OA = (text: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`
  + 'data: [DONE]\n\n';

const originFetch = typeof globalThis.fetch === 'function' ? globalThis.fetch : undefined;
const bodies: Array<Record<string, any>> = [];
const ids: string[] = [];

/** 装一个「只回纯文本」的 fake fetch，并把每次请求体记录下来 */
function stubFetch(protocol: 'openai' | 'anthropic'): void {
  bodies.length = 0;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const raw = String(init?.body || '');
    if (raw.includes('kk_probe_tool')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    }
    bodies.push(JSON.parse(raw));
    return new Response(protocol === 'openai' ? SSE_OA('收到') : SSE('收到'), { status: 200 });
  }) as typeof fetch;
}

/**
 * 消费掉一个异步生成器。
 * 注意：`await streamChat(...)` 是**不会执行请求**的——它只会 resolve 出生成器对象本身，
 * 必须真正迭代才会发起上游访问（ai-agent 里用的是 `for await`）。
 */
async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  for await (const _ of gen) { /* 只消费，不关心事件 */ }
}

function mkProfile(protocol: 'openai' | 'anthropic', vision?: boolean): AiProfile {
  const p = upsertProfile({
    name: `__test_vision_${protocol}_${vision ? 'on' : 'off'}_${ids.length}__`,
    protocol, baseUrl: 'https://upstream.invalid', apiPath: '', apiKey: 'k',
    model: 'm', retryCount: 0, maxTokens: 4096, timeoutMs: 120000,
  });
  ids.push(p.id);
  if (vision !== undefined) return upsertProfile({ ...p, vision });
  return p;
}

/**
 * 隔离：这些用例会往**真实的** `data/ai/providers.json` 里写测试档案
 * （upsertProfile 走的是真实存储）。跑一次测试就把用户配好的模型列表搅乱，
 * 甚至可能把某个会话绑定的档案顶掉——所以这里先备份，跑完原样还回去。
 */
const STORE = path.join(PATHS.data, 'ai', 'providers.json');
let storeBackup: string | null = null;

before(() => {
  try { storeBackup = fs.readFileSync(STORE, 'utf-8'); } catch { storeBackup = null; }
  stubFetch('openai');
});
beforeEach(() => { clearVisionBlock(); bodies.length = 0; });
after(() => {
  if (originFetch) globalThis.fetch = originFetch;
  for (const id of ids) { try { deleteProfile(id); } catch { /* ignore */ } }
  // 还原用户真实的档案列表（包括 activeId），别把测试档案留在里面
  if (storeBackup !== null) {
    try { fs.writeFileSync(STORE, storeBackup, 'utf-8'); } catch { /* ignore */ }
  } else {
    try { fs.unlinkSync(STORE); } catch { /* ignore */ }
  }
});

// ───────────────────────── ① 开关默认关 ─────────────────────────

test('未勾选图片识别：请求体里不出现任何图片，content 仍是字符串', async () => {
  stubFetch('openai');
  const p = mkProfile('openai');
  await drain(streamChat(p, 'sys', [{ role: 'user', content: '看看', images: [IMG] }], [], new AbortController().signal, {}));
  const body = bodies[bodies.length - 1];
  assert.equal(typeof body.messages[1].content, 'string', '没开开关就该和改动前逐字节一致（保前缀缓存）');
  assert.ok(!JSON.stringify(body).includes(PNG_1), '图片数据绝不能出现在请求里');
});

test('未勾选图片识别（Anthropic）：同样不出现图片', async () => {
  stubFetch('anthropic');
  const p = mkProfile('anthropic');
  await drain(streamChat(p, 'sys', [{ role: 'user', content: '看看', images: [IMG] }], [], new AbortController().signal, {}));
  const body = bodies[bodies.length - 1];
  // 注意：Anthropic 的缓存断点会把末条消息包成块数组，所以这里不能断言「是字符串」，
  // 只断言里面没有 image 块——这才是本用例真正要锁的东西。
  const content = body.messages[0].content;
  const hasImage = Array.isArray(content) && content.some((b: any) => b?.type === 'image');
  assert.ok(!hasImage, '没开开关就不该有 image 块');
  assert.ok(!JSON.stringify(body).includes(PNG_1));
});

// ───────────────────────── ② 开了开关按协议拼块 ─────────────────────────

test('OpenAI：图片走 image_url 的 data URL', async () => {
  stubFetch('openai');
  const p = mkProfile('openai', true);
  await drain(streamChat(p, 'sys', [{ role: 'user', content: '看看', images: [IMG, { name: 'b.jpg', mime: 'image/jpeg', b64: PNG_2 }] }], [], new AbortController().signal, {}));
  const content = bodies[bodies.length - 1].messages[1].content;
  assert.ok(Array.isArray(content), '有图就该展开成内容块数组');
  const blocks = content as Array<Record<string, any>>;
  const urls = blocks.filter((b) => b.type === 'image_url').map((b) => b.image_url?.url);
  assert.deepEqual(urls, [`data:image/png;base64,${PNG_1}`, `data:image/jpeg;base64,${PNG_2}`]);
  assert.equal(blocks.find((b) => b.type === 'text')?.text, '看看', '文本块内容不丢');
});

test('Anthropic：图片走 source.base64，且排在文本块之前（官方建议顺序）', async () => {
  stubFetch('anthropic');
  const p = mkProfile('anthropic', true);
  await drain(streamChat(p, 'sys', [{ role: 'user', content: '看看', images: [IMG] }], [], new AbortController().signal, {}));
  const blocks = bodies[bodies.length - 1].messages[0].content as Array<Record<string, any>>;
  assert.equal(blocks[0].type, 'image');
  assert.deepEqual(blocks[0].source, { type: 'base64', media_type: 'image/png', data: PNG_1 });
  assert.equal(blocks[blocks.length - 1].type, 'text');
  assert.equal(blocks[blocks.length - 1].text, '看看');
});

test('不支持的 MIME（bmp/svg）一律不拼进请求', async () => {
  stubFetch('openai');
  const p = mkProfile('openai', true);
  await drain(streamChat(p, 'sys', [{
    role: 'user', content: '看看',
    images: [{ name: 'x.bmp', mime: 'image/bmp', b64: 'QQ==' }, { name: 'y.svg', mime: 'image/svg+xml', b64: 'QQ==' }],
  }], [], new AbortController().signal, {}));
  const body = bodies[bodies.length - 1];
  assert.equal(typeof body.messages[1].content, 'string', '没有合法图片时应退回纯字符串');
  assert.ok(!body.messages[1].content.includes('x.bmp'.slice(0, 0) + 'QQ=='), '不该出现图片数据');
});

// ───────────────────────── ③ 上游不支持 → 降级不中断 ─────────────────────────

test('上游以 400 拒收图片：自动摘掉图片重跑，任务完成且不报错', async () => {
  const { runTurn } = await import('../src/ai/ai-agent.js');
  const { createSession, deleteSession, getSession } = await import('../src/ai/ai-session.js');
  stubFetch('anthropic');
  const p = mkProfile('anthropic', true);
  const sess = createSession('t-vision-degrade', p.id);

  const allRaw: string[] = [];
  let real = 0;
  const events: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const raw = String(init?.body || '');
    if (raw.includes('kk_probe_tool')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    }
    real++;
    allRaw.push(raw);
    // 第一次带图的请求被上游拒收：各家报法不同，这里用 Anthropic 的原文
    if (real === 1) {
      return new Response(
        JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'image is not supported for this model' } }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(SSE('看清楚了，这是一张截图。'), { status: 200 });
  }) as typeof fetch;

  await runTurn(sess.id, '看看这张图', (ev) => events.push(ev as Record<string, unknown>), [], [IMG]);

  // ① 任务没有中断：收尾是正常答复，不是错误卡片
  const s = getSession(sess.id);
  assert.ok(s, '会话应存在');
  const last = s!.messages[s!.messages.length - 1];
  assert.equal(last.role, 'assistant');
  assert.ok(!last.isError, '不该留下错误卡片');
  assert.ok(s!.messages.some((m) => (m.content || '').includes('看清楚了')), '模型答复应落库');

  // ② 第一次带图、第二次不带图
  assert.equal(allRaw.length, 2, `应共两次真实请求（第一次被拒、第二次降级重跑），实为 ${allRaw.length}`);
  assert.ok(allRaw[0].includes(PNG_1), '第一次请求应带图');
  assert.ok(!allRaw[1].includes(PNG_1), '第二次请求必须已经摘掉图片');

  // ③ 时间线上要有一条「已降级」的说明，不能默默了事
  assert.ok(
    events.some((e) => e.type === 'step_note' && String(e.text || '').includes('不支持图片')),
    `应广播一条降级说明，实际事件：${JSON.stringify(events.map((e) => e.type))}`,
  );
  deleteSession(sess.id);
});

test('降级只发生一次：摘掉图片仍失败就照常报错，不无限重试', async () => {
  const { runTurn } = await import('../src/ai/ai-agent.js');
  const { createSession, deleteSession, getSession } = await import('../src/ai/ai-session.js');
  stubFetch('anthropic');
  const p = mkProfile('anthropic', true);
  const sess = createSession('t-vision-degrade-hard', p.id);

  let real = 0;
  const events: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    const raw = String(init?.body || '');
    if (raw.includes('kk_probe_tool')) {
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'no tools' }] }), { status: 200 });
    }
    real++;
    // 一直 400：摘掉图片后依然失败，说明是别的问题（比如 key 无效）
    return new Response(JSON.stringify({ error: { message: 'invalid api key', type: 'invalid_request_error' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  // runTurn 不向外抛异常，而是把错误写成会话里的错误卡片（设计如此）
  await runTurn(sess.id, '看看', (ev) => events.push(ev as Record<string, unknown>), [], [IMG]);

  assert.equal(real, 2, `只允许降级重试一次（共 2 次请求），实为 ${real} 次`);
  const s = getSession(sess.id);
  const last = s?.messages[s?.messages.length - 1];
  assert.ok(last?.isError, '非图片原因的 400 必须照常变成错误卡片，不能被降级分支吞掉');
  assert.ok((last?.content || '').includes('invalid api key'), `错误原文应保留：${last?.content}`);
  assert.ok(events.some((e) => e.type === 'error'), '应广播 error 事件');
  deleteSession(sess.id);
});

// ───────────────────────── ④ 报错识别 ─────────────────────────

test('isVisionRejection：覆盖各家常见的报错文案', () => {
  const samples = [
    '上游返回 HTTP 400：image is not supported for this model',
    '上游返回 HTTP 400：Invalid content type. Only text is supported',
    '上游返回 HTTP 400：当前模型不支持图片',
    '上游返回 HTTP 400：不支持多模态',
    '上游返回 HTTP 415：Unsupported Media Type',
    '上游返回 HTTP 422：unprocessable',
    'vision not enabled for this deployment',
  ];
  for (const s of samples) assert.ok(isVisionRejection(new Error(s)), `应识别为图片拒收：${s}`);
  // 网络类错误不该被误判成图片问题
  assert.ok(!isVisionRejection(new Error('fetch failed')), '网络错误不是图片拒收');
  assert.ok(!isVisionRejection(new Error('已停止')), '用户主动停止不是图片拒收');
});

// ───────────────────────── ⑤ 文本侧：文件名一定写进消息 ─────────────────────────

test('buildUserContent：图片名一定进文本，且按开关说明是否发了图', () => {
  const on = buildUserContent('看看', [], [IMG], true);
  assert.ok(on.includes(IMG.name), '图片名要进文本（否则模型不知道有个它没看到的东西）');
  assert.ok(on.includes('已随本条消息作为图片一并发送'));

  const off = buildUserContent('看看', [], [IMG], false);
  assert.ok(off.includes(IMG.name));
  assert.ok(off.includes('未开启图片识别'), '关掉时必须明确告知模型「没发图」，否则它会开始编');
  assert.ok(!off.includes(PNG_1), 'base64 绝不进文本');
});

test('buildUserContent：文件与图片统一编号，且不会重复拼（重跑幂等）', () => {
  const once = buildUserContent('看看', [{ name: 'a.js', content: 'x' }], [IMG], true);
  assert.ok(once.includes('【附件 1/2】'), '文件在前');
  assert.ok(once.includes('【附件 2/2】'), '图片续号');
  assert.equal(buildUserContent(once, [], [IMG], true), once, '已含附件块的原文再拼一次不应变化');
});
