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
