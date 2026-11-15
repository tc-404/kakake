/**
 * Anthropic 思考预算单测：流式与非流式两条路径都必须满足 max_tokens > thinking.budget_tokens。
 * 回归背景：非流式路径曾漏掉这句（流式有、非流式没有），导致 streamBroken 档案发出非法组合。
 */
import assert from 'node:assert/strict';
import { streamChat, type AiProfile } from '../src/ai/ai-provider.js';

const mk = (o: Partial<AiProfile> = {}): AiProfile => ({
  id: 'p', name: 'n', protocol: 'anthropic', baseUrl: 'https://upstream.invalid', apiPath: '', apiKey: 'k',
  model: 'm', reasoning: '', maxTokens: 4096, timeoutMs: 5000, retryCount: 0, createdAt: 0, ...o,
});

const SSE = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n';
const JSON_OK = JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });

async function capture(p: AiProfile): Promise<Record<string, unknown>> {
  let raw = '';
  globalThis.fetch = (async (_u: string, init?: RequestInit) => {
    raw = String(init?.body || '');
    return new Response(p.streamBroken ? JSON_OK : SSE, { status: 200 });
  }) as typeof fetch;
  for await (const _ of streamChat(p, 'sys', [], [], new AbortController().signal)) { /* drain */ }
  return JSON.parse(raw) as Record<string, unknown>;
}

const originFetch = globalThis.fetch;
try {
  // 1) 三档 × 两条路径：预算与 max_tokens 的不变量必须同时成立
  for (const level of ['low', 'medium', 'high'] as const) {
    for (const streamBroken of [false, true]) {
      const j = await capture(mk({ reasoning: level, maxTokens: 4096, streamBroken }));
      const budget = (j.thinking as { budget_tokens?: number } | undefined)?.budget_tokens;
      const mt = Number(j.max_tokens);
      const tag = `${level} / streamBroken=${streamBroken}`;
      assert.equal(typeof budget, 'number', `${tag}: 应下发 thinking`);
      assert.ok(mt > (budget as number), `${tag}: max_tokens(${mt}) 必须 > budget(${budget})`);
      assert.ok(mt >= (budget as number) + 1024, `${tag}: max_tokens 至少为 budget+1024`);
    }
  }

  // 2) 复现用户当前档案：anthropic + high + maxTokens 4096 + streamBroken（曾经的非法组合）
  const j = await capture(mk({ reasoning: 'high', maxTokens: 4096, streamBroken: true }));
  assert.deepEqual(j.thinking, { type: 'enabled', budget_tokens: 16384 }, 'high → budget 16384');
  assert.equal(j.max_tokens, 17408, 'high(16384)+1024=17408，且不应低于用户填写的 4096');

  // 3) 用户手填的更大 max_tokens 不应被压低
  const j2 = await capture(mk({ reasoning: 'low', maxTokens: 32000, streamBroken: true }));
  assert.equal(j2.max_tokens, 32000, '保留用户填写的更大值');

  // 4) 关闭思考时不得注入 thinking
  const j3 = await capture(mk({ reasoning: '', maxTokens: 4096, streamBroken: true }));
  assert.equal(j3.thinking, undefined, '不设置思考强度时不下发 thinking');
  assert.equal(j3.max_tokens, 4096, '不设置思考强度时 max_tokens 保持原值');

  // 5) OpenAI 协议走 reasoning_effort，不应被套上 Anthropic 的 thinking
  const j4 = await capture(mk({ protocol: 'openai', reasoning: 'high', maxTokens: 4096, streamBroken: true }));
  assert.equal(j4.reasoning_effort, 'high', 'OpenAI 协议映射为 reasoning_effort');
  assert.equal(j4.thinking, undefined, 'OpenAI 协议不应出现 anthropic thinking');
} finally {
  globalThis.fetch = originFetch;
}
