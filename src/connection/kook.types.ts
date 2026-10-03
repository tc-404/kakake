/** KOOK 开放平台常量与事件类型定义 */

/** KOOK HTTP API 基址 */
export const KOOK_API_BASE_URL = 'https://www.kookapp.cn/api/v3';

/** WebSocket 网关帧信令 */
export const KOOK_SIGNAL = {
  /** 事件推送（含 sn） */
  EVENT: 0,
  /** 握手（服务端下发，d.code=0 表示成功，并携带 session_id 与心跳间隔） */
  HELLO: 1,
  /** 心跳 ping（客户端发，d/sn 为最新 sn） */
  PING: 2,
  /** 心跳 pong（服务端回复） */
  PONG: 3,
  /** 链接尚存活时的恢复请求（客户端发） */
  RESUME: 4,
  /** 服务端要求断开重连（必须丢弃 session 重新连接） */
  RECONNECT: 5,
  /** resume 结果包 */
  RESUME_ACK: 6,
} as const;

/** KOOK 消息 type 字段 */
export const KOOK_MSG_TYPE = {
  TEXT: 1,
  IMAGE: 2,
  VIDEO: 3,
  FILE: 4,
  AUDIO: 8,
  KMARKDOWN: 9,
  CARD: 10,
  SYSTEM: 255,
} as const;

export interface KookApiEnvelope<T = Record<string, unknown>> {
  code: number;
  message: string;
  data: T;
}

export interface KookBotUser {
  id: string;
  username: string;
  identify_num?: string;
  bot?: boolean;
  avatar?: string;
}

export interface KookMessageExtra {
  type?: number | string;
  guild_id?: string;
  channel_name?: string;
  mention?: string[];
  mention_all?: boolean;
  mention_users?: Array<Record<string, unknown>>;
  mention_roles?: string[];
  mention_here?: boolean;
  author?: { id?: string; username?: string; identify_num?: string; avatar?: string };
  kmarkdown?: { mention_part?: Array<{ user_id?: string }>; mention_role_part?: unknown[] };
  /** 系统事件（type=255）：事件名字符串，如 joined_guild / message.deleted */
  type_name?: string;
  body?: Record<string, unknown>;
}

/** 事件帧 d 的公共结构（与 webhook 一致） */
export interface KookEvent {
  /** 消息事件为数字（1/2/9/10...）；系统事件为 255 */
  type?: number | string;
  channel_type?: 'GROUP' | 'PERSON' | 'BROADCAST';
  target_id?: string;
  author_id?: string;
  content?: string;
  msg_id?: string;
  msg_timestamp?: number;
  nonce?: string;
  extra?: KookMessageExtra;
  [key: string]: unknown;
}
