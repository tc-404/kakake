import { getStoredToken } from './api';
import type { PendingFile, PendingImage } from './ai-attach';

/** AI 模块前端 API 封装（SSE 走手动 fetch 流解析，其余走 JSON） */

export interface FileChange {
  path: string;
  kind: 'create' | 'modify';
  diff: { t: string; s: string }[];
  /** 后端算好的真实增删行数；旧会话没有这两个字段时前端回退到现场统计 diff 数组 */
  added?: number;
  removed?: number;
  /** diff 行被截断（增删计数仍是完整值） */
  truncated?: boolean;
}

/** token 用量：`cached` 为命中提示缓存的输入 token 数，`cacheWrite` 为写入缓存的 token 数 */
export interface TurnUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

export interface AiMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  time: number;
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  toolCallId?: string;
  toolName?: string;
  toolOk?: boolean;
  change?: FileChange;
  /** assistant：本条为执行出错提示（渲染成错误卡片） */
  isError?: boolean;
  /** assistant：本轮修改过的文件汇总（文件变更网格） */
  changes?: FileChange[];
  /** assistant：本轮总耗时（毫秒） */
  durationMs?: number;
  /** assistant：本轮 token 用量（增量，非会话累计），用于「本会话」用量显示 */
  usage?: TurnUsage;
  /** assistant：过程节点记录（思考完成/瞬断重试/自动续跑），content 为空，仅时间线展示 */
  note?: string;
  /** assistant：过程节点类型，决定图标与配色 */
  noteKind?: 'access' | 'think' | 'retry' | 'note';
  /** assistant：过程节点携带的模型思考正文（reasoning_content / Anthropic thinking），可折叠展开 */
  thinking?: string;
}

export interface AiSessionMeta {
  id: string;
  title: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
  status: 'idle' | 'running' | 'error';
}

export interface AiSessionFull extends AiSessionMeta {
  messages: AiMessage[];
}

export interface AiProfile {
  id: string;
  name: string;
  protocol: 'openai' | 'anthropic';
  baseUrl: string;
  apiPath: string;
  apiKey?: string;
  hasKey?: boolean;
  model: string;
  reasoning: '' | 'low' | 'medium' | 'high';
  maxTokens: number;
  timeoutMs: number;
  retryCount: number;
  /** Anthropic 提示缓存开关（会改写请求的中转应关闭） */
  promptCache?: boolean;
  /** 图片识别（多模态）开关，默认关闭：只有确认该模型支持图片时才打开 */
  vision?: boolean;
  createdAt?: number;
}

export interface AiStreamEvent {
  type: 'user' | 'delta' | 'thinking' | 'step_start' | 'step_end' | 'file_change' | 'step_retry' | 'step_note' | 'usage' | 'done' | 'error' | '__end';
  text?: string;
  index?: number;
  /** step_retry：当前为第 attempt 次 / 最多 max 次自动重试 */
  attempt?: number;
  max?: number;
  /** step_start 为 {name,args} 对象；step_end 为工具名字符串 */
  tool?: { name: string; args?: Record<string, unknown> } | string;
  ok?: boolean;
  output?: string;
  change?: FileChange;
  message?: AiMessage;
  /** usage：本步序号 / 本轮累计 / 会话累计（含本轮） */
  step?: number;
  turn?: TurnUsage;
  session?: TurnUsage;
}

async function req<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {}),
      ...(init?.headers as Record<string, string>),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const aiApi = {
  listSessions: () => req<{ sessions: AiSessionMeta[]; runningIds: string[] }>('/api/ai/sessions'),
  createSession: (title?: string) =>
    req<{ session: AiSessionMeta }>('/api/ai/sessions', { method: 'POST', body: JSON.stringify({ title }) }),
  getSession: (id: string) =>
    req<{ session: AiSessionFull; running: boolean }>(`/api/ai/sessions/${id}`),
  renameSession: (id: string, title: string) =>
    req<{ session: AiSessionMeta }>(`/api/ai/sessions/${id}`, { method: 'PUT', body: JSON.stringify({ title }) }),
  updateSession: (id: string, patch: { title?: string; profileId?: string }) =>
    req<{ session: AiSessionMeta }>(`/api/ai/sessions/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteSession: (id: string) => req<{ ok: boolean }>(`/api/ai/sessions/${id}`, { method: 'DELETE' }),
  stopSession: (id: string) => req<{ ok: boolean }>(`/api/ai/sessions/${id}/stop`, { method: 'POST' }),

  listProviders: () => req<{ activeId: string; profiles: AiProfile[] }>('/api/ai/providers'),
  saveProvider: (p: Partial<AiProfile> & { name: string; protocol: 'openai' | 'anthropic' }) =>
    req<{ profile: AiProfile }>('/api/ai/providers', { method: 'POST', body: JSON.stringify(p) }),
  updateProvider: (id: string, p: Partial<AiProfile>) =>
    req<{ profile: AiProfile }>(`/api/ai/providers/${id}`, { method: 'PUT', body: JSON.stringify(p) }),
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/api/ai/providers/${id}`, { method: 'DELETE' }),
  copyProvider: (id: string) => req<{ profile: AiProfile }>(`/api/ai/providers/${id}/copy`, { method: 'POST' }),
  activateProvider: (id: string) =>
    req<{ ok: boolean }>('/api/ai/providers/activate', { method: 'POST', body: JSON.stringify({ id }) }),
  testProvider: (p: Partial<AiProfile>) =>
    req<{ ok: boolean; message: string }>('/api/ai/providers/test', { method: 'POST', body: JSON.stringify(p) }),
  fetchModels: (p: Partial<AiProfile>) =>
    req<{ ok: boolean; models?: string[]; message?: string }>('/api/ai/providers/models', { method: 'POST', body: JSON.stringify(p) }),
};

/**
 * 发起一轮任务并逐事件回调（POST + SSE 流）。
 * 返回时流已结束。onEvent 抛错会中断读取。
 */
export async function streamRun(
  sessionId: string,
  text: string,
  onEvent: (ev: AiStreamEvent) => void,
  abortSignal?: AbortSignal,
  files?: readonly PendingFile[],
  images?: readonly PendingImage[],
): Promise<void> {
  const hasFiles = Boolean(files?.length);
  const hasImages = Boolean(images?.length);
  const res = await fetch(`/api/ai/sessions/${sessionId}/run`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {}),
    },
    // 缺省不传对应字段：老链路（排队派发等）不带附件时请求体与改动前完全一致
    body: JSON.stringify(hasFiles || hasImages ? { text, ...(hasFiles ? { files } : {}), ...(hasImages ? { images } : {}) } : { text }),
    signal: abortSignal,
  });
  await consumeSse(res, onEvent);
}

/** 重发最后一条出错的用户消息（后端会弹出尾部错误与该消息后原样重跑） */
export async function streamRetry(
  sessionId: string,
  onEvent: (ev: AiStreamEvent) => void,
  abortSignal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`/api/ai/sessions/${sessionId}/retry`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {}),
    },
    signal: abortSignal,
  });
  await consumeSse(res, onEvent);
}

async function consumeSse(res: Response, onEvent: (ev: AiStreamEvent) => void): Promise<void> {
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim()) as AiStreamEvent;
          if (ev.type === '__end') return;
          onEvent(ev);
        } catch { /* ignore */ }
      }
    }
  }
}
