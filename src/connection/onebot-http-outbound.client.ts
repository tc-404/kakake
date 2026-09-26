import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import { OneBotHttpSseClient, type HttpSseReconnectStatus } from './onebot-http-sse.client.js';
import { OneBotHttpClient } from './onebot-http.client.js';
import {
  callOneBotHttpAction,
  connectionHttpClientEventUrl,
  resolveApiBaseUrl,
} from './onebot-http.shared.js';

export interface OneBotHttpOutboundClientOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onReady?: () => void;
  onDisconnect?: () => void;
  onReconnectAbandoned?: () => void;
  onReconnectStatusChange?: () => void;
}

/**
 * OneBot HTTP 客户端（出站）
 * - 主动连接对端 HTTP SSE 收事件（可重连）
 * - 同时挂框架路径 /onebot/http/:id 接收 HTTP POST 上报
 * - callAction 走对端 HTTP API
 */
export class OneBotHttpOutboundClient implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private readonly sse: OneBotHttpSseClient;
  private readonly webhook: OneBotHttpClient;
  private started = false;

  constructor(private readonly options: OneBotHttpOutboundClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;

    this.sse = new OneBotHttpSseClient({
      connection: options.connection,
      logger: options.logger.child('[SSE] '),
      autoReconnect: true,
      onDisconnect: () => {
        options.onReconnectStatusChange?.();
      },
      onReconnectAbandoned: () => options.onReconnectAbandoned?.(),
      onReconnectStatusChange: () => options.onReconnectStatusChange?.(),
    });

    this.webhook = new OneBotHttpClient({
      connection: options.connection,
      logger: options.logger.child('[Webhook] '),
    });
  }

  get isConnected(): boolean {
    return this.started && (this.sse.isConnected || this.webhook.isConnected);
  }

  get eventUrl(): string {
    return connectionHttpClientEventUrl(this.id);
  }

  get apiBaseUrl(): string {
    return resolveApiBaseUrl(this.options.connection);
  }

  getReconnectStatus(): HttpSseReconnectStatus {
    return this.sse.getReconnectStatus();
  }

  applyConnectionPatch(patch: Partial<ConnectionConfig>): void {
    this.sse.applyConnectionPatch(patch);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.webhook.start();
    this.sse.start();
    // webhook 就绪即可视为可用（API 可调；事件可走 POST 或 SSE）
    this.options.onReady?.();
  }

  resetAndReconnect(): void {
    this.sse.resetAndReconnect();
  }

  stop(): void {
    this.started = false;
    this.sse.stop();
    this.webhook.stop();
    this.options.onDisconnect?.();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.started) {
      throw new Error('HTTP 客户端未就绪');
    }
    // 不依赖 SSE 是否已连上：HTTP API 可独立调用
    return callOneBotHttpAction(
      this.apiBaseUrl,
      action,
      params,
      this.options.connection.accessToken,
      this.options.logger,
    );
  }
}
