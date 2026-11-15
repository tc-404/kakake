/** QQ 官方机器人 Gateway WebSocket 载荷 */
export interface QqGatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface QqAccessTokenResponse {
  access_token: string;
  expires_in: string | number;
}

export interface QqGatewayBotResponse {
  url: string;
  shards: number;
  session_start_limit?: {
    total: number;
    remaining: number;
    reset_after: number;
    max_concurrency: number;
  };
}
