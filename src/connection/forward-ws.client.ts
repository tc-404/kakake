import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { ConnectionConfig } from '../core/types.js';
import { connectionWsUrl } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import type { OB11ApiRequest, OB11ApiResponse, OB11Event } from './onebot.types.js';
import { eventBus } from '../event/event-bus.js';
import { logEvent } from '../core/log-store.js';
import { formatOb11Event } from '../core/log-format.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';

export interface ForwardWsReconnectStatus {
  reconnecting: boolean;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  abandoned: boolean;
}

export interface ForwardWsClientOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onReady?: () => void;
  onDisconnect?: () => void;
  onReconnectAbandoned?: () => void;
  onReconnectStatusChange?: () => void;
  autoReconnect?: boolean;
}

const DEFAULT_RECONNECT_INTERVAL_MS = 5000;

function resolveReconnectIntervalMs(conn: ConnectionConfig): number {
  const ms = conn.reconnectIntervalMs;
  if (typeof ms === 'number' && ms >= 500) return Math.floor(ms);
  return DEFAULT_RECONNECT_INTERVAL_MS;
}

function resolveReconnectMaxAttempts(conn: ConnectionConfig): number {
  const n = conn.reconnectMaxAttempts;
  if (typeof n === 'number' && n >= 0) return Math.floor(n);
  return 15;
}

/**
 * OneBot 正向 WebSocket 客户端
 * 咔咔珂主动连接对端的 WebSocket Server（对端侧选 WS 服务端）
 */
export class ForwardWsClient implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private ws: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** 手动 stop() 后为 true，不再自动重连 */
  private closed = false;
  private reconnectAttempts = 0;
  private abandoned = false;
  private connecting = false;

  constructor(private readonly options: ForwardWsClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get targetUrl(): string {
    return connectionWsUrl(this.options.connection);
  }

  getReconnectStatus(): ForwardWsReconnectStatus {
    const conn = this.options.connection;
    return {
      reconnecting: this.connecting || this.reconnectTimer !== null,
      attempts: this.reconnectAttempts,
      maxAttempts: resolveReconnectMaxAttempts(conn),
      intervalMs: resolveReconnectIntervalMs(conn),
      abandoned: this.abandoned,
    };
  }

  applyConnectionPatch(patch: Partial<ConnectionConfig>): void {
    Object.assign(this.options.connection, patch);
    this.notifyReconnectStatusChange();
  }

  start(): void {
    this.closed = false;
    this.abandoned = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  /** 手动重连：重置计数并立即尝试连接 */
  resetAndReconnect(): void {
    if (this.closed) return;
    this.abandoned = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }

  connect(): void {
    const { connection, logger } = this.options;
    if (this.closed || !connection.enable) return;

    this.destroySocket();

    const wsUrl = this.targetUrl;
    this.connecting = true;
    this.notifyReconnectStatusChange();
    logger.info(`正向 WS 连接 NapCat: ${wsUrl}`);

    const headers: Record<string, string> = {};
    if (connection.accessToken) {
      headers.Authorization = `Bearer ${connection.accessToken}`;
    }

    this.ws = new WebSocket(wsUrl, { headers });

    this.ws.on('open', () => {
      this.connecting = false;
      this.reconnectAttempts = 0;
      this.abandoned = false;
      this.notifyReconnectStatusChange();
      logger.info(`已连接 NapCat: ${connection.name}`);
      this.options.onReady?.();
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString()) as OB11Event & OB11ApiResponse;
        this.handleIncoming(data);
      } catch (e) {
        logger.warn('无法解析 WebSocket 消息', e);
      }
    });

    this.ws.on('close', () => {
      this.connecting = false;
      logger.warn(`连接断开: ${connection.name}`);
      this.rejectAllPending('连接已断开');
      this.ws = null;
      this.notifyReconnectStatusChange();
      this.options.onDisconnect?.();
      this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      logger.error(`WebSocket 错误: ${err.message}`);
    });
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = false;
    this.destroySocket();
    this.rejectAllPending('客户端已关闭');
    this.notifyReconnectStatusChange();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected || !this.ws) {
      throw new Error('NapCat 未连接（正向 WS）');
    }

    const echo = randomUUID();
    const payload: OB11ApiRequest = { action, params, echo };

    return new Promise((resolve, reject) => {
      const timeoutMs = configService.getConfig().apiTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API 超时: ${action}`));
      }, timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(payload));
    });
  }

  private handleIncoming(data: OB11Event & OB11ApiResponse): void {
    if (data.echo && this.pending.has(data.echo)) {
      const p = this.pending.get(data.echo)!;
      clearTimeout(p.timer);
      this.pending.delete(data.echo);
      if (data.status === 'ok') {
        p.resolve(data.data);
      } else {
        p.reject(new Error(data.message ?? `API 失败 retcode=${data.retcode}`));
      }
      return;
    }

    if (data.post_type) {
      const formatted = formatOb11Event(data);
      const isHeartbeat = data.post_type === 'meta_event'
        && (data as { meta_event_type?: string }).meta_event_type === 'heartbeat';
      logEvent(
        `[上报:${this.name}]`,
        formatted.message,
        {
          detail: formatted.detail,
          raw: formatted.raw,
          level: isHeartbeat ? 'debug' : 'info',
        },
      );
      void eventBus.emit('onebot/event', { connectionId: this.id, event: data });
      void eventBus.emitHierarchy(`onebot/${data.post_type}`, { connectionId: this.id, event: data });
    }
  }

  private scheduleReconnect(): void {
    const { logger, autoReconnect = true } = this.options;
    const conn = this.options.connection;
    if (this.closed || !autoReconnect || !conn.enable) return;
    if (this.abandoned) return;

    const maxAttempts = resolveReconnectMaxAttempts(conn);
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.abandoned = true;
      this.notifyReconnectStatusChange();
      logger.warn(
        `[${conn.name}] 已达最大重连次数 ${maxAttempts}，停止自动重连（可手动重连或调整设置）`,
      );
      this.options.onReconnectAbandoned?.();
      return;
    }

    const intervalMs = resolveReconnectIntervalMs(conn);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectAttempts += 1;
    this.notifyReconnectStatusChange();
    const attemptNo = this.reconnectAttempts;
    const maxLabel = maxAttempts > 0 ? `${attemptNo}/${maxAttempts}` : `${attemptNo}`;
    logger.info(`[${conn.name}] ${intervalMs}ms 后尝试重连（第 ${maxLabel} 次）`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.abandoned) return;
      this.connect();
    }, intervalMs);
  }

  private destroySocket(): void {
    if (!this.ws) return;
    const socket = this.ws;
    socket.removeAllListeners();
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    this.ws = null;
  }

  private notifyReconnectStatusChange(): void {
    this.options.onReconnectStatusChange?.();
  }

  private rejectAllPending(reason: string): void {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(echo);
    }
  }
}
