/** OneBot 连接端点（反向监听 / 正向连出）统一能力 */
export interface OneBotEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
}
