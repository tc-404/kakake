/** OneBot 11 通用事件结构 */
export interface OB11Event {
  post_type: string;
  self_id?: number;
  time?: number;
  [key: string]: unknown;
}

export interface OB11Message extends OB11Event {
  post_type: 'message' | 'message_sent';
  message_type: 'private' | 'group';
  message_id: number;
  user_id: number;
  raw_message: string;
  group_id?: number;
  sender?: Record<string, unknown>;
  message?: unknown[];
}

export interface OB11ApiRequest {
  action: string;
  params?: Record<string, unknown>;
  echo?: string;
}

export interface OB11ApiResponse {
  status: 'ok' | 'failed';
  retcode: number;
  data?: unknown;
  echo?: string;
  message?: string;
}

export type ActionCaller = (
  action: string,
  params?: Record<string, unknown>,
  adapter?: string,
  config?: unknown,
) => Promise<unknown>;

/**
 * 接口代理专用的原始调用结果。
 *
 * 与 `callAction` 的三点根本差异，都是为了「严格透传」这条硬需求：
 *
 *   1. **不剥信封**。整个响应体原文放在 `envelope`，`retcode` / `message` / `wording`
 *      / `echo` 全部保留。原来的 `callAction` 成功时只返回 `data`，这些信息全丢了。
 *   2. **不抛异常**。超时、网络错误、HTTP 4xx/5xx 一律走返回值，不 throw。
 *      代理层才能把「超时」做成一种**结果**而不是异常（需求：超时即超时，绝不空返回）。
 *   3. **`ok` 只表示「是否拿到响应」，不表示「调用是否成功」**。
 *      HTTP 500 也算拿到了响应，`ok` 是 true。真正的成败看 `envelope.status` / `retcode`。
 */
export interface OneBotRawResult {
  /** 是否拿到了协议端响应。false = 超时 / 网络错误 / 未连接 / 响应非 JSON */
  ok: boolean;
  /** 完整响应体原文，一字不改。仅 ok=true 时存在 */
  envelope?: unknown;
  /** HTTP 状态码；WebSocket 通道没有这个字段 */
  httpStatus?: number;
  timedOut?: boolean;
  /** ok=false 时的原因 */
  error?: string;
  /** 响应体原文文本，用于非 JSON 响应的诊断 */
  rawText?: string;
}

export type RawActionCaller = (
  action: string,
  params?: Record<string, unknown>,
  method?: 'GET' | 'POST',
) => Promise<OneBotRawResult>;
