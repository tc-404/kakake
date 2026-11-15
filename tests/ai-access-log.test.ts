/**
 * 上游访问日志单测：铁律「一次访问 = 一条日志」。
 * 覆盖：成功 / 失败（HTTP 状态） / 网络错误 / 空响应降级兜底，逐条计数，不按步骤聚合。
 */
import assert from 'node:assert/strict';
import {
  streamChat, fetchModels, testConnection, isRetryableUpstreamError, type AiProfile,
} from '../src/ai/ai-provider.js';
import { getLogs, clearLogs } from '../src/core/log-store.js';

// 不存在的 id：空响应路径会尝试回写 streamBroken，但 upsertProfile 对未知 id 抛错并被吞掉，不会污染真实档案
const mkProfile = (o: Partial<AiProfile> = {}): AiProfile => ({
  id: '__test_access_log__', name: '测试档案', protocol: 'anthropic', baseUrl: 'https://upstream.invalid',
  apiPath: '', apiKey: 'sk-x', model: 'test-model', reasoning: '', maxTokens: 128,
  timeoutMs: 5000, retryCount: 5, createdAt: 0, ...o,
});

const accessLogs = () => getLogs(1000).filter((l) => l.message.includes('上游访问'));
const okJson = (obj: unknown) => new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });

async function drain(gen: AsyncGenerator<unknown>, sink: string[] = []): Promise<string[]> {
  for await (const ev of gen) {
    const e = ev as { type?: string; text?: string };
    if (e.type === 'delta' && e.text) sink.push(e.text);
  }
  return sink;
}

// ── 1) 重试判定：网关瞬断类可重试，配置类不可 ──
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 403：x')), true, '403 可重试');
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 503：x')), true, '503 可重试');
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 429：x')), true, '429 可重试');
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 401：x')), false, '401 不重试');
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 402：x')), false, '402 不重试');
assert.equal(isRetryableUpstreamError(new Error('上游返回 HTTP 404：x')), false, '404 不重试');
assert.equal(isRetryableUpstreamError(new Error('fetch failed')), true, '网络错误可重试');
assert.equal(isRetryableUpstreamError(new Error('已停止')), false, '主动停止不重试');

const originFetch = globalThis.fetch;
try {
  // ── 2) fetchModels 成功：恰好 1 条 ──
  clearLogs();
  globalThis.fetch = (async () => okJson({ data: [{ id: 'm1' }, { id: 'm2' }] })) as typeof fetch;
  await fetchModels(mkProfile());
  let logs = accessLogs();
  assert.equal(logs.length, 1, '模型列表成功 → 1 条访问日志');
  assert.match(logs[0].message, /上游访问成功/);
  assert.match(logs[0].message, /模型列表/);
  assert.match(logs[0].message, /返回 2 个模型/);

  // ── 3) fetchModels 失败：也是 1 条（warn） ──
  clearLogs();
  globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
  await fetchModels(mkProfile());
  logs = accessLogs();
  assert.equal(logs.length, 1, '模型列表失败 → 1 条访问日志');
  assert.match(logs[0].message, /上游访问失败/);
  assert.match(logs[0].message, /HTTP 500/);
  assert.equal(logs[0].level, 'warn');

  // ── 4) 连接测试失败后再成功：每次尝试各 1 条 ──
  clearLogs();
  let n = 0;
  globalThis.fetch = (async () => (++n === 1 ? new Response('bad', { status: 401 }) : okJson({ content: [], stop_reason: 'end_turn' }))) as typeof fetch;
  await testConnection(mkProfile({ retryCount: 1 }));
  logs = accessLogs();
  assert.equal(logs.length, 2, '连接测试 2 次尝试 → 2 条访问日志');
  assert.match(logs[0].message, /HTTP 401/);
  assert.match(logs[1].message, /连接成功/);

  // ── 5) 流式 403：1 条失败日志并抛出 ──
  clearLogs();
  globalThis.fetch = (async () => new Response('nope', { status: 403 })) as typeof fetch;
  let threw = '';
  try { await drain(streamChat(mkProfile(), '', [], [], new AbortController().signal)); }
  catch (e) { threw = (e as Error).message; }
  logs = accessLogs();
  assert.equal(logs.length, 1, '流式 403 → 1 条访问日志');
  assert.match(logs[0].message, /上游访问失败/);
  assert.match(logs[0].message, /HTTP 403/);
  assert.match(threw, /HTTP 403/, '错误应向上抛出（交给步级重试）');

  // ── 6) 流式正常返回：1 条成功日志 ──
  clearLogs();
  const sse = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n'
    + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n';
  globalThis.fetch = (async () => new Response(sse, { status: 200 })) as typeof fetch;
  const got = await drain(streamChat(mkProfile(), '', [], [], new AbortController().signal));
  assert.deepEqual(got, ['hi'], '流式内容应正常外发');
  logs = accessLogs();
  assert.equal(logs.length, 1, '流式成功 → 1 条访问日志');
  assert.match(logs[0].message, /上游访问成功/);
  assert.match(logs[0].message, /正常返回/);

  // ── 7) 空响应 + 非流式兜底：恰好 2 条（流式 1 条 + 兜底 1 条）──
  clearLogs();
  const queue: Array<() => Response> = [
    () => new Response('data: {"type":"message_start","message":{"usage":{"input_tokens":3}}}\n\n', { status: 200 }),
    () => okJson({ content: [{ type: 'text', text: 'fallback' }], stop_reason: 'end_turn' }),
  ];
  globalThis.fetch = (async () => {
    const make = queue.shift();
    if (!make) throw new Error('意外请求');
    return make();
  }) as typeof fetch;
  const got2 = await drain(streamChat(mkProfile(), '', [], [], new AbortController().signal));
  assert.deepEqual(got2, ['fallback'], '空响应应降级为非流式兜底');
  logs = accessLogs();
  assert.equal(logs.length, 2, '空流 + 兜底 → 2 条访问日志（一次访问一条）');
  assert.match(logs[0].message, /无内容块/);
  assert.match(logs[1].message, /非流式兜底/);

  // ── 8) 档案已标记流式不可用：直接非流式，1 条 ──
  clearLogs();
  globalThis.fetch = (async () => okJson({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' })) as typeof fetch;
  await drain(streamChat(mkProfile({ streamBroken: true }), '', [], [], new AbortController().signal));
  logs = accessLogs();
  assert.equal(logs.length, 1, 'streamBroken 直达非流式 → 1 条访问日志');
  assert.match(logs[0].message, /流式不可用/);
} finally {
  globalThis.fetch = originFetch;
}
