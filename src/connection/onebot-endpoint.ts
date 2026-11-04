import type { OneBotRawResult } from './onebot.types.js';

/** OneBot 连接端点（反向监听 / 正向连出）统一能力 */
export interface OneBotEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  /**
   * 接口代理专用的原始调用：不剥信封、不抛异常。
   * 可选是为了让新增端点可以逐步实现；未实现时代理层会降级为「协议不支持」。
   */
  callActionRaw?(
    action: string,
    params?: Record<string, unknown>,
    method?: 'GET' | 'POST',
  ): Promise<OneBotRawResult>;
  stop(): void;
}
