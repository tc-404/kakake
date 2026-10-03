import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from '../paths.js';
import { logAction } from '../core/log-store.js';

/**
 * AI 上游配置（多档案）与协议适配：
 * - 档案持久化 data/ai/providers.json，密钥只存本地
 * - OpenAI 兼容：POST {baseUrl}{apiPath 默认 /v1/chat/completions}，流式 tool_calls
 * - Anthropic：POST {baseUrl}{apiPath 默认 /v1/messages}，流式 tool_use
 */

export type AiProtocol = 'openai' | 'anthropic';

export interface AiProfile {
  id: string;
  name: string;
  protocol: AiProtocol;
  /** 上游地址，如 https://api.openai.com 或自建中转 */
  baseUrl: string;
  /** 连接路径，留空用协议默认；也可填完整路径覆盖 */
  apiPath: string;
  apiKey: string;
  model: string;
  /** 思考级别：'' 关闭；openai→reasoning_effort；anthropic→thinking 预算 */
  reasoning: '' | 'low' | 'medium' | 'high';
  maxTokens: number;
  timeoutMs: number;
  /** 上游请求失败自动重试次数（默认 5） */
  retryCount: number;
  /** Anthropic 显式提示缓存开关：官方直连/稳定中转开着省 90% 输入费；
   *  会改写请求（注入内容/多渠道分流）导致前缀永不命中的中转应关闭，避免白付 25% 写入费 */
  promptCache?: boolean;
  createdAt: number;
  /** 工具穿透：true=上游支持函数调用；false=需走文本协议；探测后回写持久化 */
  toolsPassthrough?: boolean;
  /** 该上游流式返回空内容（探明过）：跳过流式直接非流式，请求数减半 */
  streamBroken?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  toolOk?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface UpstreamUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 命中缓存的输入 token（只按缓存价计费，省钱的关键指标） */
  cachedTokens?: number;
  /** Anthropic 缓存写入 token（首次多付 25%，之后命中省 90%） */
  cacheWriteTokens?: number;
}

export interface UpstreamEvent {
  type: 'delta' | 'thinking' | 'tool_call' | 'end';
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  stopReason?: string;
  usage?: UpstreamUsage;
}

const STORE = path.join(PATHS.data, 'ai', 'providers.json');

interface ProviderStore {
  activeId: string;
  profiles: AiProfile[];
}

function loadStore(): ProviderStore {
  try {
    const s = JSON.parse(fs.readFileSync(STORE, 'utf-8')) as ProviderStore;
    if (Array.isArray(s.profiles)) return { activeId: s.activeId || '', profiles: s.profiles };
  } catch { /* 首次为空 */ }
  return { activeId: '', profiles: [] };
}

function saveStore(s: ProviderStore): void {
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(s, null, 2), 'utf-8');
}

export function listProfiles(): AiProfile[] {
  return loadStore().profiles;
}

export function getProfile(id: string): AiProfile | null {
  return loadStore().profiles.find((p) => p.id === id) || null;
}

export function getActiveProfile(): AiProfile | null {
  const s = loadStore();
  return s.profiles.find((p) => p.id === s.activeId) || s.profiles[0] || null;
}

/** 档案字段规范化（落库与临时草稿共用同一套收口，避免两处规则漂移） */
function normalizeProfile(p: AiProfile): AiProfile {
  return {
    ...p,
    baseUrl: p.baseUrl.trim().replace(/\/+$/, ''),
    apiPath: p.apiPath.trim(),
    reasoning: (['', 'low', 'medium', 'high'] as const).includes(p.reasoning as never) ? p.reasoning : '',
    maxTokens: Math.min(Math.max(Number(p.maxTokens) || 4096, 256), 200000),
    timeoutMs: Math.min(Math.max(Number(p.timeoutMs) || 120000, 5000), 600000),
    retryCount: Math.min(Math.max(Number(p.retryCount ?? 5), 0), 20),
    promptCache: p.promptCache !== false,
  };
}

/**
 * 由草稿构造一份**不落库**的档案：测试连接 / 拉模型列表走这条。
 * 早期实现把未保存的草稿交给 upsertProfile，于是用户在弹窗里点一下「获取模型」，
 * 列表里就会凭空多出一个名为「临时测试」的档案（首次还会被设为当前使用）。
 */
export function draftProfile(input: Partial<AiProfile> & { name?: string; protocol: AiProtocol }): AiProfile {
  return normalizeProfile({
    id: input.id || '',
    name: input.name || '临时测试',
    protocol: input.protocol,
    baseUrl: input.baseUrl || '',
    apiPath: input.apiPath || '',
    apiKey: input.apiKey || '',
    model: input.model || '',
    reasoning: (input.reasoning || '') as AiProfile['reasoning'],
    maxTokens: input.maxTokens || 4096,
    timeoutMs: input.timeoutMs || 120000,
    retryCount: input.retryCount ?? 5,
    promptCache: input.promptCache !== false,
    createdAt: Date.now(),
  });
}

export function upsertProfile(input: Partial<AiProfile> & { name: string; protocol: AiProtocol }): AiProfile {
  const s = loadStore();
  if (input.id) {
    const idx = s.profiles.findIndex((p) => p.id === input.id);
    if (idx < 0) throw new Error('档案不存在');
    s.profiles[idx] = normalizeProfile({ ...s.profiles[idx], ...input } as AiProfile);
    saveStore(s);
    return s.profiles[idx];
  }
  const profile = normalizeProfile({
    id: randomUUID(),
    name: input.name,
    protocol: input.protocol,
    baseUrl: input.baseUrl || '',
    apiPath: input.apiPath || '',
    apiKey: input.apiKey || '',
    model: input.model || '',
    reasoning: (input.reasoning || '') as AiProfile['reasoning'],
    maxTokens: input.maxTokens || 4096,
    timeoutMs: input.timeoutMs || 120000,
    retryCount: input.retryCount ?? 5,
    promptCache: input.promptCache !== false,
    createdAt: Date.now(),
  });
  s.profiles.push(profile);
  if (!s.activeId) s.activeId = profile.id;
  saveStore(s);
  return profile;
}

export function deleteProfile(id: string): boolean {
  const s = loadStore();
  const before = s.profiles.length;
  s.profiles = s.profiles.filter((p) => p.id !== id);
  if (s.activeId === id) s.activeId = s.profiles[0]?.id || '';
  saveStore(s);
  return s.profiles.length < before;
}

export function activateProfile(id: string): boolean {
  const s = loadStore();
  if (!s.profiles.some((p) => p.id === id)) return false;
  s.activeId = id;
  saveStore(s);
  return true;
}

/** 密钥脱敏后的档案视图（返回给前端列表用） */
export function toPublicProfile(p: AiProfile): Omit<AiProfile, 'apiKey'> & { hasKey: boolean } {
  const { apiKey, ...rest } = p;
  return { ...rest, hasKey: Boolean(apiKey) };
}

/**
 * baseUrl 是否已经自带 API 版本段（`https://api.moonshot.cn/v1`、`.../api/v4`、`.../api/paas/v4` 这类）。
 * 带了就说明版本号已经在地址里，后面不能再补一次 `/v1`。
 */
function hasVersionSegment(baseUrl: string): boolean {
  return /\/v\d+(?:\.\d+)?$/i.test(baseUrl.trim().replace(/\/+$/, ''));
}

/**
 * 拼出实际请求地址。
 *
 * 关键规则：**baseUrl 已带版本段时不再重复补 `/v1`**。
 * 早期实现一律 `baseUrl + '/v1/chat/completions'`，于是「Kimi（.../v1）」「智谱（.../api/paas/v4）」
 * 「火山方舟（.../api/v3）」「MiniMax（.../v1）」四个预设会被拼成
 * `.../v1/v1/chat/completions` 这种上游根本不存在的路径——选了预设也永远连不通。
 */
function endpointOf(p: AiProfile, fallbackPath: string): string {
  const custom = p.apiPath.trim();
  if (custom) {
    // 支持完整 URL 覆盖
    if (/^https?:\/\//i.test(custom)) return custom;
    return `${p.baseUrl}${custom.startsWith('/') ? '' : '/'}${custom}`;
  }
  const path = hasVersionSegment(p.baseUrl)
    ? fallbackPath.replace(/^\/v\d+(?:\.\d+)?/i, '')
    : fallbackPath;
  return `${p.baseUrl}${path}`;
}

/**
 * 模型列表端点 = 「地址的版本根 + /models」。
 *
 * 版本根从 baseUrl 与自定义 apiPath 拼出的完整地址里取，而**不砍末段**：
 * `/api/paas/v4/chat/completions` 砍末段得到的是 `/api/paas/v4/chat`（错），
 * 取版本根才得到 `/api/paas/v4`（对）。apiPath 在这里只用来定位版本根，
 * 它的动作末段（chat/completions、messages）不参与——拿对话路径去拉模型列表必然 404。
 * 取不到版本根（如 `https://api.openai.com`）就按惯例补 `/v1`。
 */
function modelsEndpointOf(p: AiProfile): string {
  const base = p.baseUrl.trim().replace(/\/+$/, '');
  const custom = p.apiPath.trim();
  const full = custom && !/^https?:\/\//i.test(custom)
    ? `${base}${custom.startsWith('/') ? '' : '/'}${custom}`
    : base;
  const root = /^(.*\/v\d+(?:\.\d+)?)(?:\/|$)/i.exec(full)?.[1];
  return root ? `${root}/models` : `${base}/v1/models`;
}

/** 上游访问上下文：由 AI 智能体带上，便于把每条访问日志对应到会话与步骤 */
export interface AccessContext {
  sessionId?: string;
  step?: number;
}

/**
 * 记录一次真实的上游 HTTP 访问。
 * 铁律：**一次访问 = 一条日志**（含失败请求、空响应、兜底的非流式请求），绝不按「步骤」聚合——
 * 一个步骤可能包含好几条访问（多次瞬断重试 + 流式 + 兜底），必须逐条可见。
 */
function logAccess(
  p: AiProfile,
  ctx: AccessContext | undefined,
  mode: string,
  ms: number,
  ok: boolean,
  outcome: string,
  detail?: string,
): void {
  const proto = p.protocol === 'openai' ? 'OpenAI 兼容' : 'Anthropic';
  const where = ctx?.sessionId
    ? `会话 ${ctx.sessionId.slice(0, 8)}${ctx.step != null ? ` · 第 ${ctx.step} 步` : ''} · `
    : '';
  logAction(
    '【AI】',
    `上游访问${ok ? '成功' : '失败'}（${where}${p.name} / ${p.model} · ${proto} · ${mode} · ${ms}ms）：${outcome}`,
    detail ? detail.slice(0, 300) : undefined,
    ok ? 'info' : 'warn',
  );
}

/** 该错误是否值得重试：网关瞬断类（403/408/425/429/5xx）与网络/超时可重试；401/402/404 等配置类错误不重试 */
export function isRetryableUpstreamError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('已停止')) return false;
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return true; // 网络错误 / 超时 / 流中途断开 / 空响应 → 可重试
  const status = Number(m[1]);
  return status === 403 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** 统一 POST：一次调用 = 一次上游访问，成功/失败都落一条日志，失败抛出的信息与旧实现保持一致 */
async function postJson(
  p: AiProfile,
  ctx: AccessContext | undefined,
  mode: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<any> {
  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  } catch (err) {
    if (!signal.aborted) logAccess(p, ctx, mode, Date.now() - t0, false, '请求未完成', err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!res.ok) {
    const raw = (await res.text()).slice(0, 500);
    logAccess(p, ctx, mode, Date.now() - t0, false, `HTTP ${res.status}`, raw);
    throw new Error(`上游返回 HTTP ${res.status}：${raw}`);
  }
  const j = await res.json();
  logAccess(p, ctx, mode, Date.now() - t0, true, '正常返回');
  return j;
}

/** 拉取上游模型列表（端点由 modelsEndpointOf 推导，不受自定义聊天路径影响） */
export async function fetchModels(p: AiProfile): Promise<{ ok: boolean; models?: string[]; message?: string }> {
  const t0 = Date.now();
  const headers: Record<string, string> = p.protocol === 'openai'
    ? { Authorization: `Bearer ${p.apiKey}` }
    : { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' };
  try {
    const url = modelsEndpointOf(p);
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(Math.min(p.timeoutMs, 30000)) });
    if (!res.ok) {
      const raw = (await res.text()).slice(0, 300);
      logAccess(p, undefined, '模型列表', Date.now() - t0, false, `HTTP ${res.status}`, raw);
      return { ok: false, message: `HTTP ${res.status}：${raw}` };
    }
    const j = await res.json() as { data?: { id?: string }[] };
    const models = (j.data || []).map((m) => String(m.id || '')).filter(Boolean).sort();
    logAccess(p, undefined, '模型列表', Date.now() - t0, true, `返回 ${models.length} 个模型`);
    return { ok: true, models };
  } catch (err) {
    logAccess(p, undefined, '模型列表', Date.now() - t0, false, '请求未完成', err instanceof Error ? err.message : String(err));
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

/** 测试连接：发一条最小请求验证连通与密钥（每次尝试 = 一次上游访问，逐条落日志） */
export async function testConnection(p: AiProfile): Promise<{ ok: boolean; message: string }> {
  const attempt = async (): Promise<{ ok: boolean; message: string }> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(p.timeoutMs, 30000));
    const t0 = Date.now();
    const mode = '连接测试';
    try {
      const url = endpointOf(p, p.protocol === 'openai' ? '/v1/chat/completions' : '/v1/messages');
      const headers: Record<string, string> = p.protocol === 'openai'
        ? { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` }
        : { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' };
      const payload = p.protocol === 'openai'
        ? { model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }
        : { model: p.model, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] };
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
      if (!res.ok) {
        const raw = (await res.text()).slice(0, 300);
        logAccess(p, undefined, mode, Date.now() - t0, false, `HTTP ${res.status}`, raw);
        return { ok: false, message: `HTTP ${res.status}：${raw}` };
      }
      logAccess(p, undefined, mode, Date.now() - t0, true, '连接成功');
      return { ok: true, message: '连接成功' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logAccess(p, undefined, mode, Date.now() - t0, false, '请求未完成', msg);
      return { ok: false, message: msg };
    } finally {
      clearTimeout(timer);
    }
  };
  const first = await attempt();
  if (first.ok) return first;
  // 网络类错误重试（档案里 retryCount 控制总尝试次数）
  const retries = Math.max(0, Number(p.retryCount ?? 5));
  let last = first;
  for (let i = 0; i < retries; i++) {
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    last = await attempt();
    if (last.ok) return last;
  }
  return last;
}

const ANTHROPIC_THINKING_BUDGET: Record<string, number> = { low: 2048, medium: 8192, high: 16384 };

/**
 * 写入 Anthropic 思考参数：档位 → 本地固定预算表，并保证 max_tokens > thinking.budget_tokens
 * （上游硬性要求，否则整个请求直接 400）。流式与非流式两条路径**必须共用本函数**，避免再次漏改。
 */
function applyAnthropicThinking(p: AiProfile, body: Record<string, unknown>): void {
  if (!p.reasoning) return;
  const budget = ANTHROPIC_THINKING_BUDGET[p.reasoning] || 8192;
  body.max_tokens = Math.max(Number(body.max_tokens) || 0, budget + 1024);
  body.thinking = { type: 'enabled', budget_tokens: budget };
}

/** 非流式请求（流式失败/空响应时兜底），把结果转成统一的流式事件；本次请求同样记为一条上游访问 */
async function* nonStreamChat(
  p: AiProfile,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  ctx?: AccessContext,
  label = '非流式',
): AsyncGenerator<UpstreamEvent> {
  let j: any;
  if (p.protocol === 'openai') {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map(assistantToOpenAi),
      ],
      stream: false,
    };
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    if (p.reasoning) body.reasoning_effort = p.reasoning;
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    j = await postJson(
      p, ctx, label, endpointOf(p, '/v1/chat/completions'),
      { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body, AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
    );
    const msg = j.choices?.[0]?.message;
    const reasoning = reasoningOfOpenAi(msg);
    if (reasoning) yield { type: 'thinking', text: reasoning };
    if (msg?.content) yield { type: 'delta', text: String(msg.content) };
    for (const tc of msg?.tool_calls || []) {
      let args: Record<string, unknown> = {};
      try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
      yield { type: 'tool_call', toolCall: { id: tc.id || `call_${tc.function?.name}`, name: tc.function?.name || '', args } };
    }
  } else {
    const body: Record<string, unknown> = {
      model: p.model,
      max_tokens: p.maxTokens || 4096,
      messages: withCacheGuard(p, messages.map(assistantToAnthropic).filter(Boolean) as Record<string, unknown>[]),
      stream: false,
    };
    if (systemPrompt) body.system = cacheOn(p) ? anthropicCachedSystem(systemPrompt) : systemPrompt;
    applyAnthropicThinking(p, body);
    if (tools.length) body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    j = await postJson(
      p, ctx, label, endpointOf(p, '/v1/messages'),
      { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
      body, AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
    );
    for (const block of j.content || []) {
      // thinking：Anthropic 扩展思考正文（redacted_thinking 只有加密 data，没有可读文本，跳过）
      if (block.type === 'thinking' && block.thinking) yield { type: 'thinking', text: String(block.thinking) };
      if (block.type === 'text' && block.text) yield { type: 'delta', text: String(block.text) };
      if (block.type === 'tool_use') {
        yield { type: 'tool_call', toolCall: { id: block.id, name: block.name, args: (block.input || {}) as Record<string, unknown> } };
      }
    }
  }
  yield {
    type: 'end',
    stopReason: j.stop_reason || j.choices?.[0]?.finish_reason || '',
    usage: p.protocol === 'openai' ? usageOfOpenAi(j) : usageOfAnthropic(j),
  };
}

/**
 * 流式对话：把统一消息格式发给上游，解析 SSE 流并回调统一事件。
 * - **本函数不做内部重试**：重试统一交给上层「步级重试」，保证「一次访问 = 一条日志 = 一个重试节点」，避免嵌套双重退避
 * - 部分中转上游流式实现有缺陷（返回 200 但无内容块），此时自动降级为非流式请求兜底
 * - **每一次真实 HTTP 访问都写一条日志**：流式请求、空响应、兜底的非流式请求各算一条
 */
export async function* streamChat(
  p: AiProfile,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
  ctx?: AccessContext,
): AsyncGenerator<UpstreamEvent> {
  // 已探明该上游流式实现有缺陷（返回 200 但零内容块）：直接非流式，省掉一次注定空跑的请求
  if (p.streamBroken === true) {
    yield* nonStreamChat(p, systemPrompt, messages, tools, signal, ctx, '非流式（档案标记流式不可用）');
    return;
  }

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchUpstream(p, systemPrompt, messages, tools, signal);
  } catch (err) {
    if (!signal.aborted) logAccess(p, ctx, '流式', Date.now() - t0, false, '请求未完成', err instanceof Error ? err.message : String(err));
    throw err;
  }
  if (!res.ok) {
    const raw = (await res.text()).slice(0, 500);
    const body = raw.trim() || '（上游无响应体——多为网关/渠道瞬断，并非业务报错）';
    logAccess(p, ctx, '流式', Date.now() - t0, false, `HTTP ${res.status}`, body);
    throw new Error(`上游返回 HTTP ${res.status}：${body}`);
  }

  let gotContent = false;
  let streamErr: Error | null = null;
  try {
    for await (const ev of parseStream(p.protocol, res, signal)) {
      if (ev.type === 'delta' || ev.type === 'tool_call' || ev.type === 'thinking') gotContent = true;
      yield ev;
    }
  } catch (err) {
    streamErr = err instanceof Error ? err : new Error(String(err));
  }
  if (streamErr) {
    if (!signal.aborted) logAccess(p, ctx, '流式', Date.now() - t0, false, '响应已建立但中途断开', streamErr.message);
    throw streamErr;
  }

  // 流结束但一个内容块都没有 → 上游流式实现有问题，记档并降级为非流式兜底
  if (!gotContent) {
    logAccess(p, ctx, '流式', Date.now() - t0, false, 'HTTP 200 但无内容块（疑似中转流式缺陷，转非流式兜底）');
    if (signal.aborted) throw new Error('已停止');
    try { upsertProfile({ ...p, streamBroken: true }); } catch { /* 回写失败不影响运行 */ }
    yield* nonStreamChat(p, systemPrompt, messages, tools, signal, ctx, '非流式兜底');
    return;
  }

  logAccess(p, ctx, '流式', Date.now() - t0, true, '正常返回');
}

async function fetchUpstream(
  p: AiProfile,
  systemPrompt: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  signal: AbortSignal,
): Promise<Response> {
  if (p.protocol === 'openai') {
    const body: Record<string, unknown> = {
      model: p.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        ...messages.map(assistantToOpenAi),
      ],
      stream: true,
    };
    // 请求上游回传 usage（含缓存命中数），用于运行日志展示省钱效果
    body.stream_options = { include_usage: true };
    if (p.maxTokens) body.max_tokens = p.maxTokens;
    if (p.reasoning) body.reasoning_effort = p.reasoning;
    if (tools.length) {
      body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    return fetch(endpointOf(p, '/v1/chat/completions'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
    });
  }
  // Anthropic
  const body: Record<string, unknown> = {
    model: p.model,
    max_tokens: p.maxTokens || 4096,
    messages: withCacheGuard(p, messages.map(assistantToAnthropic).filter(Boolean) as Record<string, unknown>[]),
    stream: true,
  };
  if (systemPrompt) body.system = cacheOn(p) ? anthropicCachedSystem(systemPrompt) : systemPrompt;
  applyAnthropicThinking(p, body);
  if (tools.length) {
    body.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  return fetch(endpointOf(p, '/v1/messages'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(p.timeoutMs)]),
  });
}

function assistantToOpenAi(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
  }
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}

function assistantToAnthropic(m: ChatMessage): Record<string, unknown> | null {
  if (m.role === 'system') return null; // system 走独立参数
  if (m.role === 'assistant' && m.toolCalls?.length) {
    const content: Record<string, unknown>[] = [];
    if (m.content) content.push({ type: 'text', text: m.content });
    for (const tc of m.toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args });
    return { role: 'assistant', content };
  }
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: m.toolOk === false }],
    };
  }
  return { role: m.role, content: m.content };
}

// ---------- 上下文缓存（省钱包的核心） ----------
// Anthropic：需要显式 cache_control 断点（整个请求 ≤4 个），不打断点 = 每轮全价重算整个上下文。
// 断点打在 system + 最后一条消息上：历史只追加不重排，下一轮请求即可命中「截至上一轮末尾」的整个前缀。
// OpenAI 兼容上游：自动前缀缓存，无需参数，只要前缀字节级稳定（本实现天然满足）。

const EPHEMERAL = { type: 'ephemeral' } as const;

/** 档案级缓存开关（默认开） */
const cacheOn = (p: AiProfile): boolean => p.promptCache !== false;

function withCacheGuard(p: AiProfile, messages: Record<string, unknown>[]): Record<string, unknown>[] {
  return cacheOn(p) ? withAnthropicCacheBreakpoint(messages) : messages;
}

function anthropicCachedSystem(text: string): Record<string, unknown>[] {
  return [{ type: 'text', text, cache_control: EPHEMERAL }];
}

/** 给消息数组最后一条打 cache_control 断点（缓存它之前的全部内容） */
function withAnthropicCacheBreakpoint(messages: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!messages.length) return messages;
  const out = messages.map((m) => ({ ...m }));
  const last = out[out.length - 1];
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }];
  } else if (Array.isArray(last.content) && last.content.length) {
    const blocks = (last.content as Record<string, unknown>[]).map((b) => ({ ...b }));
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: EPHEMERAL };
    last.content = blocks;
  }
  return out;
}

function usageOfOpenAi(j: any): UpstreamUsage {
  return {
    inputTokens: j?.usage?.prompt_tokens,
    outputTokens: j?.usage?.completion_tokens,
    cachedTokens: j?.usage?.prompt_tokens_details?.cached_tokens,
  };
}

/**
 * 抽取 OpenAI 兼容协议里的「思考/推理」文本。
 * 各家中转/模型字段名不统一：DeepSeek、Qwen、Kimi 等用 `reasoning_content`；
 * OpenAI o 系列部分实现用 `reasoning`；个别中转塞在 `reasoning_details[].text`。
 * 返回空串即代表本次增量没有思考内容。
 */
function reasoningOfOpenAi(node: any): string {
  if (!node) return '';
  if (typeof node.reasoning_content === 'string' && node.reasoning_content) return node.reasoning_content;
  if (typeof node.reasoning === 'string' && node.reasoning) return node.reasoning;
  if (Array.isArray(node.reasoning_details)) {
    return node.reasoning_details
      .map((d: any) => (typeof d?.text === 'string' ? d.text : ''))
      .join('');
  }
  return '';
}

function usageOfAnthropic(j: any): UpstreamUsage {
  const u = j?.usage || j?.message?.usage;
  return {
    inputTokens: u?.input_tokens,
    outputTokens: u?.output_tokens,
    cachedTokens: u?.cache_read_input_tokens,
    cacheWriteTokens: u?.cache_creation_input_tokens,
  };
}

/**
 * 合并两次上报的 usage（Anthropic 流式：`message_start` 带输入/缓存，`message_delta` 带输出）。
 * **只覆盖上游真正上报了的字段**——直接 `{...a, ...b}` 会把 b 里的 `undefined` 也写进去，
 * 导致已经拿到的输入 token 与缓存命中数被抹掉（历史 bug：Anthropic 流式下用量显示为 0）。
 */
function mergeUsage(base: UpstreamUsage | undefined, patch: UpstreamUsage): UpstreamUsage {
  const out: UpstreamUsage = { ...(base || {}) };
  if (Number.isFinite(patch.inputTokens)) out.inputTokens = patch.inputTokens;
  if (Number.isFinite(patch.outputTokens)) out.outputTokens = patch.outputTokens;
  if (Number.isFinite(patch.cachedTokens)) out.cachedTokens = patch.cachedTokens;
  if (Number.isFinite(patch.cacheWriteTokens)) out.cacheWriteTokens = patch.cacheWriteTokens;
  return out;
}

/** 解析上游 SSE 流（OpenAI / Anthropic 两种格式） */
async function* parseStream(
  protocol: AiProtocol,
  res: Response,
  signal: AbortSignal,
): AsyncGenerator<UpstreamEvent> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('上游响应无内容');
  const decoder = new TextDecoder();
  let buf = '';
  // openai: 聚合 index → {id,name,args}
  const oaTools = new Map<number, { id: string; name: string; args: string }>();
  // anthropic: 当前 tool_use 聚合
  let atTool: { id: string; name: string; args: string } | null = null;
  let stopReason = '';
  let usage: UpstreamUsage | undefined;

  while (true) {
    if (signal.aborted) { reader.cancel().catch(() => {}); throw new Error('已停止'); }
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, sep).trim();
      buf = buf.slice(sep + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      if (protocol === 'openai') {
        // include_usage: 最后一个 chunk 带 usage。用 mergeUsage 而非直接赋值：
        // 个别中转把 prompt/completion 分成两条 chunk 上报，直接赋值会丢掉先到的字段。
        if (j.usage) usage = mergeUsage(usage, usageOfOpenAi(j));
        const choice = j.choices?.[0];
        const delta = choice?.delta;
        // 思考增量（reasoning_content / reasoning / reasoning_details）：先于正文下发
        const reasoning = reasoningOfOpenAi(delta);
        if (reasoning) yield { type: 'thinking', text: reasoning };
        if (delta?.content) yield { type: 'delta', text: String(delta.content) };
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = Number(tc.index || 0);
            const cur = oaTools.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            oaTools.set(idx, cur);
          }
        }
        if (choice?.finish_reason) {
          stopReason = String(choice.finish_reason);
          for (const [, t] of oaTools) {
            let args: Record<string, unknown> = {};
            try { args = t.args ? JSON.parse(t.args) : {}; } catch { args = {}; }
            yield { type: 'tool_call', toolCall: { id: t.id || `call_${t.name}`, name: t.name, args } };
          }
          oaTools.clear();
          if (stopReason === 'tool_calls') continue; // 等待 [DONE] 自然结束
        }
      } else {
        // Anthropic 事件流
        if (j.type === 'message_start') {
          if (j.message?.usage) usage = usageOfAnthropic(j);
        } else if (j.type === 'message_delta') {
          // 真实 Anthropic 的 message_delta **同时**带 usage 与 delta.stop_reason。
          // 必须两个都取：写成 `else if (... j.usage) usage = ...` 再 `else if (j.delta?.stop_reason)`
          // 会让带 usage 的那条永远命中前一个分支，stop_reason 被吞掉 ——
          // 后果是 Anthropic 的 max_tokens 截断永远识别不到（空答复/半截答复防护整体失效）。
          if (j.usage) usage = mergeUsage(usage, usageOfAnthropic(j));
          if (j.delta?.stop_reason) stopReason = String(j.delta.stop_reason);
        } else if (j.type === 'content_block_start' && j.content_block?.type === 'tool_use') {
          atTool = { id: j.content_block.id, name: j.content_block.name, args: '' };
        } else if (j.type === 'content_block_delta') {
          if (j.delta?.type === 'text_delta' && j.delta.text) yield { type: 'delta', text: String(j.delta.text) };
          // Anthropic 扩展思考增量（signature_delta 只是签名，无文本，忽略）
          if (j.delta?.type === 'thinking_delta' && j.delta.thinking) yield { type: 'thinking', text: String(j.delta.thinking) };
          if (j.delta?.type === 'input_json_delta' && atTool) atTool.args += String(j.delta.partial_json || '');
        } else if (j.type === 'content_block_stop' && atTool) {
          let args: Record<string, unknown> = {};
          try { args = atTool.args ? JSON.parse(atTool.args) : {}; } catch { args = {}; }
          yield { type: 'tool_call', toolCall: { id: atTool.id, name: atTool.name, args } };
          atTool = null;
        } else if (j.type === 'error') {
          throw new Error(`上游错误：${j.error?.message || JSON.stringify(j).slice(0, 300)}`);
        }
      }
    }
  }
  yield { type: 'end', stopReason, usage };
}

// ---------- 工具穿透探测 ----------
// 部分中转上游会剥离请求里的 tools 并注入自己的沙箱工具（模型看不到我们定义的工具）。
// 用一个一次性探针工具检测：上游若能返回 tool_use / tool_calls 即视为支持函数调用。

const probeCache = new Map<string, boolean>();

export async function probeToolPassthrough(p: AiProfile): Promise<boolean> {
  const key = `${p.protocol}|${p.baseUrl}|${p.model}|${p.apiKey}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;
  let ok = false;
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(p.timeoutMs, 30000));
    if (p.protocol === 'openai') {
      const res = await fetch(endpointOf(p, '/v1/chat/completions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model, max_tokens: 200,
          messages: [{ role: 'user', content: '请直接调用 kk_probe_tool 工具，不要输出其他内容。' }],
          tools: [{ type: 'function', function: { name: 'kk_probe_tool', description: '探针工具', parameters: { type: 'object', properties: {} } } }],
        }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as { choices?: { message?: { tool_calls?: unknown[] } }[] };
        ok = Boolean(j.choices?.[0]?.message?.tool_calls?.length);
        logAccess(p, undefined, '工具探测', Date.now() - t0, true, ok ? '支持函数调用（走原生工具）' : '未返回工具调用（走文本协议）');
      } else {
        logAccess(p, undefined, '工具探测', Date.now() - t0, false, `HTTP ${res.status}`);
      }
    } else {
      const res = await fetch(endpointOf(p, '/v1/messages'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: p.model, max_tokens: 300,
          messages: [{ role: 'user', content: '请直接调用 kk_probe_tool 工具，不要输出其他内容。' }],
          tools: [{ name: 'kk_probe_tool', description: '探针工具', input_schema: { type: 'object', properties: {} } }],
        }),
        signal: ctrl.signal,
      });
      if (res.ok) {
        const j = (await res.json()) as { content?: { type?: string }[] };
        ok = (j.content || []).some((b) => b.type === 'tool_use');
        logAccess(p, undefined, '工具探测', Date.now() - t0, true, ok ? '支持函数调用（走原生工具）' : '未返回工具调用（走文本协议）');
      } else {
        logAccess(p, undefined, '工具探测', Date.now() - t0, false, `HTTP ${res.status}`);
      }
    }
    clearTimeout(timer);
  } catch (err) {
    ok = false; // 探测异常时按「不支持」处理，文本协议仍然可用
    logAccess(p, undefined, '工具探测', Date.now() - t0, false, '请求未完成', err instanceof Error ? err.message : String(err));
  }
  probeCache.set(key, ok);
  return ok;
}
