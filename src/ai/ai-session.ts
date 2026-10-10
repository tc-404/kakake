import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PATHS } from '../paths.js';
import { truncSafe } from './ai-text.js';
import type { ChatImage } from './ai-provider.js';

/**
 * AI 会话持久化：data/ai/sessions/<id>.json
 * 由后端直接管理，模型的文件工具不经过这里（会话数据不受安全层白名单影响，
 * 但同样落在 data/ 下，用户可自行备份删除）。
 */

export interface FileChange {
  /** 项目根相对路径 */
  path: string;
  kind: 'create' | 'modify';
  /** 行级 diff（展示用，做过上下文收缩与长度截断）：[{t:'+'|'-'|'=', s:行文本}] */
  diff: { t: string; s: string }[];
  /**
   * 真实新增行数。**不能靠数 diff 数组得到**——数组是展示用的，被收缩过、并且
   * 超过 400 行会被截断，前端一数就会得到 `+0 -400` 这种固定错值。
   * 历史会话没有这两个字段，前端回退到现场统计。
   */
  added?: number;
  /** 真实删除行数，同上 */
  removed?: number;
  /** diff 行是否被截断（增删计数仍是完整值） */
  truncated?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * 一轮（从接到指令到最终答复）的 token 用量。
 * `cached` 是命中提示缓存的输入 token 数（OpenAI 的 prompt_tokens_details.cached_tokens /
 * Anthropic 的 cache_read_input_tokens），`cacheWrite` 是写入缓存的 token 数。
 * 前端「缓存百分比」= cached / input。
 */
export interface TurnUsage {
  input: number;
  output: number;
  cached: number;
  cacheWrite: number;
}

/** 求和多个用量（会话累计用） */
export function sumTurnUsage(list: readonly (TurnUsage | undefined)[]): TurnUsage {
  const total: TurnUsage = { input: 0, output: 0, cached: 0, cacheWrite: 0 };
  for (const u of list) {
    if (!u) continue;
    total.input += u.input || 0;
    total.output += u.output || 0;
    total.cached += u.cached || 0;
    total.cacheWrite += u.cacheWrite || 0;
  }
  return total;
}

export interface SessionMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  time: number;
  /** user：本条随附的图片（base64）。体积不小，但模型每轮都得看见它们，只能跟着历史走。 */
  images?: ChatImage[];
  /** assistant：本条附带的工具调用 */
  toolCalls?: ToolCall[];
  /** tool：对应的调用 id / 名称 / 是否成功 / 截断后的结果 */
  toolCallId?: string;
  toolName?: string;
  toolOk?: boolean;
  /** tool：本次调用产生的文件变更（write/edit 成功时） */
  change?: FileChange;
  /** assistant：本条为执行出错提示（前端渲染成错误卡片） */
  isError?: boolean;
  /** assistant：本条产生的文件变更（write/edit 成功时，本轮去重汇总） */
  changes?: FileChange[];
  /** assistant：本轮总耗时（从接到指令到最终答复，毫秒） */
  durationMs?: number;
  /**
   * assistant：本轮 token 用量（本轮的增量，不是会话累计）。
   * 会话累计由 `sumTurnUsage(各条消息的 usage)` 得到——前端据此显示「本会话」用量，
   * 属展示元数据，不参与模型上下文。
   */
  usage?: TurnUsage;
  /**
   * assistant：过程节点记录（思考完成 / 上游瞬断重试 / 自动续跑）。
   * content 恒为空，只在时间线上渲染成一枚定格的过程标签，
   * 既用于「刷新网页后过程状态不丢」，也用于回溯时看清每一步都发生了什么。
   * 属于元数据，不参与模型对话上下文（buildHistory 会跳过）。
   */
  note?: string;
  /** assistant：过程节点类型，决定前端渲染的图标与配色 */
  noteKind?: 'access' | 'think' | 'retry' | 'note';
  /**
   * assistant：该步骤模型的思考/推理正文（reasoning_content / Anthropic thinking）。
   * 仅用于前端「思考过程」折叠展开，**绝不进入模型上下文**（与 note 同属元数据，buildHistory 会跳过）。
   */
  thinking?: string;
}

export type SessionStatus = 'idle' | 'running' | 'error';

export interface AiSession {
  id: string;
  title: string;
  profileId: string;
  createdAt: number;
  updatedAt: number;
  status: SessionStatus;
  messages: SessionMessage[];
}

const SESSIONS_DIR = path.join(PATHS.data, 'ai', 'sessions');

function sessionFile(id: string): string {
  // id 只可能是本模块生成的 uuid，防御性校验一遍
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) throw new Error('非法会话 id');
  return path.join(SESSIONS_DIR, `${id}.json`);
}

export function listSessions(): Omit<AiSession, 'messages'>[] {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    const items = files.map((f) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf-8')) as AiSession;
        const { messages: _m, ...meta } = s;
        return meta;
      } catch {
        return null;
      }
    }).filter(Boolean) as Omit<AiSession, 'messages'>[];
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return items;
  } catch {
    return [];
  }
}

export function getSession(id: string): AiSession | null {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(id), 'utf-8')) as AiSession;
  } catch {
    return null;
  }
}

export function saveSession(session: AiSession): void {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  session.updatedAt = Date.now();
  fs.writeFileSync(sessionFile(session.id), JSON.stringify(session), 'utf-8');
}

export function createSession(title: string, profileId: string): AiSession {
  const session: AiSession = {
    id: randomUUID(),
    title: title.trim() || '新会话',
    profileId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: 'idle',
    messages: [],
  };
  saveSession(session);
  return session;
}

export function updateSessionMeta(id: string, patch: { title?: string; profileId?: string; status?: SessionStatus }): AiSession | null {
  const s = getSession(id);
  if (!s) return null;
  if (patch.title !== undefined) s.title = patch.title.trim() || s.title;
  if (patch.profileId !== undefined) s.profileId = patch.profileId;
  if (patch.status !== undefined) s.status = patch.status;
  saveSession(s);
  return s;
}

export function appendMessage(id: string, msg: SessionMessage): AiSession | null {
  const s = getSession(id);
  if (!s) return null;
  s.messages.push(msg);
  // 若仍是默认标题，用首条用户消息截断作标题
  if (s.title === '新会话' && msg.role === 'user' && msg.content.trim()) {
    // truncSafe：标题是用户消息的前 24 个 code unit，切点可能劈开 emoji
    s.title = truncSafe(msg.content.trim(), 24);
  }
  saveSession(s);
  return s;
}

export function deleteSession(id: string): boolean {
  try {
    fs.unlinkSync(sessionFile(id));
    return true;
  } catch {
    return false;
  }
}
