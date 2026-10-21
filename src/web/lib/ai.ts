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

/** 计费货币单位：人民币 / 美元 / 虚拟积分 */
export type AiPricingCurrency = 'cny' | 'usd' | 'credit';

/** 计费模式与费率 */
export interface AiPricing {
  /** custom：用下面手填的费率；deepseek：走官方峰谷价（UTC 周一至周五峰时，其余含周末与法定节假日为谷时=半价） */
  mode: 'custom' | 'deepseek';
  /** 货币单位（credit 模式单位为积分） */
  currency: AiPricingCurrency;
  /** 每 1M token 价格（对应 currency 单位） */
  inputPerM: number;
  /** 每 1M token 输出价格 */
  outputPerM: number;
  /** 每 1M token 缓存命中读取价格（prompt cache hit） */
  cachePerM: number;
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
  /** 自由模式：不注入内置人设，仅保留基础工具读写与技能调用 */
  free?: boolean;
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
  /** 计费配置：自定义费率或 DeepSeek 官方峰谷价 */
  pricing?: AiPricing;
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
  updateSession: (id: string, patch: { title?: string; profileId?: string; free?: boolean }) =>
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

  // —— 技能包：导入（单 .md / zip，base64 传内容）/ 列表 / 删除 ——
  importSkill: (name: string, data: string) =>
    req<{ ok: boolean; imported: SkillMetaLite[] }>('/api/ai/skills/import', {
      method: 'POST',
      body: JSON.stringify({ name, data }),
    }),
  listSkills: () => req<{ ok: boolean; skills: SkillMetaLite[] }>('/api/ai/skills'),
  deleteSkill: (name: string) =>
    req<{ ok: boolean }>(`/api/ai/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  /** 全量 token 计量（全局，按档案聚合所有会话用量 + 预估花费） */
  globalUsage: () =>
    req<{
      perProfile: Array<{
        profileId: string;
        name: string;
        model: string;
        sessions: number;
        usage: TurnUsage;
        cost: { currency: AiPricingCurrency; amount: number } | null;
      }>;
      totals: TurnUsage;
    }>('/api/ai/usage'),
};

/** 人民币 ↔ 美元参考汇率（用于多币种汇总时的换算展示，近似值） */
export const USD_TO_CNY = 7.2;

export type CostResult = { currency: AiPricingCurrency; amount: number } | null;

/**
 * DeepSeek 官方计费（USD / 1M tokens，峰值价；谷时=峰值一半），数据来自官方 API 文档
 * https://api-docs.deepseek.com/quick_start/pricing （2026-09 核对）：
 * - flash（DeepSeek-V4.1-Flash，旧别名 deepseek-chat / deepseek-reasoner / deepseek-v3 / deepseek-r1 现均按此档计费）：
 *     缓存命中 峰值$0.006 / 谷$0.003；缓存未命中 峰值$0.30 / 谷$0.15；输出 峰值$1.20 / 谷$0.60
 * - pro（DeepSeek-V4-Pro，推理/编码旗舰）：
 *     缓存命中 峰值$0.044 / 谷$0.022；缓存未命中 峰值$1.32 / 谷$0.66；输出 峰值$3.96 / 谷$1.98
 * 人民币按 USD_TO_CNY 折算。
 */
const DEEPSEEK_USD = {
  flash: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  pro: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
} as const;

/** 2026 年中国法定节假日（含放假调休区间，月/日起止含端点）；峰时判定会将其排除为谷时。每年需更新。 */
const CN_HOLIDAYS_2026: ReadonlyArray<readonly [number, number, number, number]> = [
  [1, 1, 1, 3],
  [2, 15, 2, 23],
  [4, 4, 4, 6],
  [5, 1, 5, 5],
  [6, 19, 6, 21],
  [9, 25, 9, 27],
  [10, 1, 10, 7],
];

function isCnHoliday(d: Date): boolean {
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return CN_HOLIDAYS_2026.some(([sm, sd, em, ed]) => (m > sm || (m === sm && day >= sd)) && (m < em || (m === em && day <= ed)));
}

/**
 * DeepSeek 峰时（其余为谷时，谷时价=峰时一半）：
 * UTC 周一至周五的 01:00–04:00 与 06:00–10:00，且排除周末与中国法定节假日。
 * 即北京时间为工作日 09:00–12:00、14:00–18:00 为峰时。
 */
export function isDeepSeekOffPeak(now: Date = new Date()): boolean {
  const h = now.getUTCHours();
  const dow = now.getUTCDay();
  if (dow === 0 || dow === 6) return true; // 周末谷时
  if (isCnHoliday(now)) return true; // 法定节假日谷时
  const peakWindow = (h >= 1 && h < 4) || (h >= 6 && h < 10);
  return !peakWindow;
}

/** 取档案当前生效费率（DeepSeek 模式按 UTC 工作日峰谷 + 币种换算得到） */
export function effectiveRate(p: AiProfile): { currency: AiPricingCurrency; inputPerM: number; outputPerM: number; cachePerM: number; offPeak: boolean } | null {
  const pr = p.pricing;
  if (!pr) return null;
  if (pr.mode === 'deepseek') {
    const kind: 'flash' | 'pro' = /pro/i.test(p.model) ? 'pro' : 'flash';
    const peak = !isDeepSeekOffPeak();
    const t = DEEPSEEK_USD[kind];
    const fx = (pr.currency || 'cny') === 'cny' ? USD_TO_CNY : 1;
    const half = peak ? 1 : 0.5;
    return {
      currency: pr.currency || 'cny',
      // inputPerM 在此语义为「缓存未命中（非缓存）输入」单价，cachePerM 为「缓存命中」单价
      inputPerM: t.cacheMiss * half * fx,
      outputPerM: t.output * half * fx,
      cachePerM: t.cacheHit * half * fx,
      offPeak: !peak,
    };
  }
  return { currency: pr.currency, inputPerM: pr.inputPerM || 0, outputPerM: pr.outputPerM || 0, cachePerM: pr.cachePerM || 0, offPeak: false };
}

/**
 * 前端预估花费（与后端 computeCost 逻辑一致）：
 * - custom 模式用档案手填费率；
 * - deepseek 模式按官方峰谷价（UTC 周一至周五峰时，其余谷时=半价，且排除中国法定节假日）自动计算。
 * 档案未配置计费时返回 null。
 */
export function computeCost(usage: { input: number; output: number; cached: number }, p: AiProfile): CostResult {
  const pr = p.pricing;
  if (!pr) return null;
  if (pr.mode === 'custom' && !pr.inputPerM && !pr.outputPerM && !pr.cachePerM) return null;
  const r = effectiveRate(p);
  if (!r) return null;
  // 正确区分缓存命中(hit)与未命中(miss)：非缓存输入 = input - cached，按各自单价计费，避免重复计
  const nonCached = Math.max(0, usage.input - usage.cached);
  const amount = (nonCached / 1e6) * r.inputPerM + (usage.cached / 1e6) * r.cachePerM + (usage.output / 1e6) * r.outputPerM;
  return { currency: r.currency, amount: Math.round(amount * 1e6) / 1e6 };
}

/** 把花费格式化成带符号的字符串 */
export function formatCost(c: CostResult): string {
  if (!c) return '';
  const sym = c.currency === 'cny' ? '¥' : c.currency === 'usd' ? '$' : '◆';
  return `${sym}${c.amount.toFixed(c.amount < 1 ? 4 : 2)}`;
}

/**
 * 发起一轮任务并逐事件回调（POST + SSE 流）。
 * 返回时流已结束。onEvent 抛错会中断读取。
 */
/** 已安装技能的前端精简视图（后端 SkillMeta 去掉了只在服务端用的 root 字段） */
export interface SkillMetaLite {
  name: string;
  displayName: string;
  description: string;
  hasSkillMd: boolean;
}

export type AiMode = 'plan' | 'ask' | 'default';

export async function streamRun(
  sessionId: string,
  text: string,
  onEvent: (ev: AiStreamEvent) => void,
  abortSignal?: AbortSignal,
  files?: readonly PendingFile[],
  images?: readonly PendingImage[],
  mode: AiMode = 'default',
  activeSkills?: readonly string[],
): Promise<void> {
  const hasFiles = Boolean(files?.length);
  const hasImages = Boolean(images?.length);
  const modeFlag = mode === 'plan' || mode === 'ask' ? { mode } : null;
  const skillsFlag = activeSkills && activeSkills.length ? { skills: [...activeSkills] } : null;
  const res = await fetch(`/api/ai/sessions/${sessionId}/run`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(getStoredToken() ? { Authorization: `Bearer ${getStoredToken()}` } : {}),
    },
    // 缺省不传对应字段：老链路（排队派发等）不带附件 / 不带模式 / 不带技能时，请求体与改动前完全一致
    body: JSON.stringify(
      hasFiles || hasImages || modeFlag || skillsFlag
        ? {
            text,
            ...(hasFiles ? { files } : {}),
            ...(hasImages ? { images } : {}),
            ...(modeFlag ?? {}),
            ...(skillsFlag ?? {}),
          }
        : { text },
    ),
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
