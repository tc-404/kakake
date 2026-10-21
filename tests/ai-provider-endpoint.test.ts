/**
 * 上游端点拼接单测。
 *
 * 回归背景：早期实现一律拼 `baseUrl + '/v1/chat/completions'`。而「Kimi（.../v1）」
 * 「智谱（.../api/paas/v4）」「火山方舟（.../api/v3）」「MiniMax（.../v1）」这几个内置预设，
 * 地址里已经带了版本段，于是被拼成 `https://api.moonshot.cn/v1/v1/chat/completions`
 * 这种上游不存在的路径——选了预设也永远连不通，表现为「配置了也用不了」。
 * 模型列表端点同理，且它还不该被自定义的聊天路径带偏。
 */
import assert from 'node:assert/strict';
import { fetchModels, streamChat, testConnection, type AiProfile } from '../src/ai/ai-provider.js';

const mk = (o: Partial<AiProfile> = {}): AiProfile => ({
  id: 'p', name: 'n', protocol: 'openai', baseUrl: '', apiPath: '', apiKey: 'k',
  model: 'm', reasoning: '', maxTokens: 4096, timeoutMs: 5000, retryCount: 0, createdAt: 0, ...o,
});

/** 装好 fake fetch，跑一次调用，返回实际请求到的 URL */
function withFetch(body: string, run: () => Promise<void>, init: ResponseInit = { status: 200 }): Promise<string> {
  let url = '';
  globalThis.fetch = (async (u: unknown) => {
    url = String(u);
    return new Response(body, init);
  }) as typeof fetch;
  return run().then(() => url);
}

const modelsUrl = (p: AiProfile) => withFetch(JSON.stringify({ data: [{ id: 'm1' }, { id: 'm2' }] }), async () => {
  await fetchModels(p);
});

/** 流式响应要按协议给对应格式，否则解析不出内容块会被判为「无内容」而走非流式兜底 */
const OPENAI_SSE = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n';
const ANTHROPIC_SSE = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n';

const chatUrl = (p: AiProfile) => withFetch(p.protocol === 'anthropic' ? ANTHROPIC_SSE : OPENAI_SSE, async () => {
  for await (const _ of streamChat(p, '', [], [], new AbortController().signal)) { /* drain */ }
});

const testUrl = (p: AiProfile) => withFetch(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), async () => {
  await testConnection(p);
});

const originFetch = globalThis.fetch;
try {
  // 1) 模型列表：地址自带版本段时不再重复补 /v1（六个内置预设 + 中转档案）
  const modelsCases: [string, AiProfile, string][] = [
    ['OpenAI', mk({ baseUrl: 'https://api.openai.com' }), 'https://api.openai.com/v1/models'],
    ['Anthropic', mk({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models'],
    ['Kimi', mk({ baseUrl: 'https://api.moonshot.cn/v1' }), 'https://api.moonshot.cn/v1/models'],
    ['智谱 GLM', mk({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), 'https://open.bigmodel.cn/api/paas/v4/models'],
    ['火山方舟', mk({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), 'https://ark.cn-beijing.volces.com/api/v3/models'],
    ['MiniMax', mk({ baseUrl: 'https://api.minimax.chat/v1' }), 'https://api.minimax.chat/v1/models'],
    ['DeepSeek', mk({ baseUrl: 'https://api.deepseek.com' }), 'https://api.deepseek.com/v1/models'],
  ];
  for (const [label, p, want] of modelsCases) {
    assert.equal(await modelsUrl(p), want, `${label}：模型列表端点`);
  }
  // 自定义聊天路径时，模型列表落在该路径所在目录，不受末段（chat/completions）影响
  assert.equal(
    await modelsUrl(mk({ baseUrl: 'https://open.bigmodel.cn', apiPath: '/api/paas/v4/chat/completions' })),
    'https://open.bigmodel.cn/api/paas/v4/models',
    '自定义 apiPath：模型列表走其目录',
  );
  // baseUrl 无版本段、apiPath 指向 /v1/messages（典型第三方中转档案）
  assert.equal(
    await modelsUrl(mk({ protocol: 'anthropic', baseUrl: 'https://relay.example.com', apiPath: '/v1/messages' })),
    'https://relay.example.com/v1/models',
    '中转档案：模型列表取 apiPath 的 /v1 目录',
  );

  // 2) 对话端点：同样不能出现 /v1/v1 这类重复
  const chatCases: [string, AiProfile, string][] = [
    ['OpenAI', mk({ baseUrl: 'https://api.openai.com' }), 'https://api.openai.com/v1/chat/completions'],
    ['Kimi', mk({ baseUrl: 'https://api.moonshot.cn/v1' }), 'https://api.moonshot.cn/v1/chat/completions'],
    ['智谱 GLM', mk({ baseUrl: 'https://open.bigmodel.cn/api/paas/v4' }), 'https://open.bigmodel.cn/api/paas/v4/chat/completions'],
    ['火山方舟', mk({ baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' }), 'https://ark.cn-beijing.volces.com/api/v3/chat/completions'],
    ['Anthropic 官方', mk({ protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/messages'],
    ['Anthropic 中转（地址带 /v1）', mk({ protocol: 'anthropic', baseUrl: 'https://relay.example.com/v1' }), 'https://relay.example.com/v1/messages'],
  ];
  for (const [label, p, want] of chatCases) {
    assert.equal(await chatUrl(p), want, `${label}：对话端点`);
  }
  // apiPath 显式填写时以其为准（支持相对路径与完整 URL 两种覆盖）
  assert.equal(
    await chatUrl(mk({ baseUrl: 'https://api.openai.com', apiPath: '/v1/chat/completions' })),
    'https://api.openai.com/v1/chat/completions',
    'apiPath 相对路径覆盖',
  );
  assert.equal(
    await chatUrl(mk({ baseUrl: 'https://api.openai.com', apiPath: 'https://relay.example.com/custom' })),
    'https://relay.example.com/custom',
    'apiPath 完整 URL 覆盖',
  );

  // 3) 连接测试与对话端点同源（同一个推导函数，不应出现两套规则）
  assert.equal(
    await testUrl(mk({ baseUrl: 'https://api.moonshot.cn/v1' })),
    'https://api.moonshot.cn/v1/chat/completions',
    '连接测试端点与对话端点一致',
  );

  // 4) 模型列表正常解析出 id 列表
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
    { status: 200 },
  )) as typeof fetch;
  const r = await fetchModels(mk({ baseUrl: 'https://api.deepseek.com' }));
  assert.equal(r.ok, true, '模型列表请求成功');
  assert.deepEqual(r.models, ['deepseek-chat', 'deepseek-reasoner'], '按 id 升序返回模型名');
} finally {
  globalThis.fetch = originFetch;
}
