import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConnectionConfig } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import type { OB11ApiRequest, OB11ApiResponse, OB11Event } from './onebot.types.js';
import type { IncomingMessage } from 'node:http';
import { eventBus } from '../event/event-bus.js';
import { logEvent } from '../core/log-store.js';
import { formatOb11Event } from '../core/log-format.js';

export interface OneBotWsServerOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onClientConnect?: () => void;
  onClientDisconnect?: () => void;
}

import type { OneBotEndpoint } from './onebot-endpoint.js';

/**
 * OneBot 反向 WebSocket 服务端
 * 咔咔珂监听端口，等待协议端（WebSocket Client）主动连入
 */
export class OneBotWsServer implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: OneBotWsServerOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  get listenUrl(): string {
    const { host, port } = this.options.connection;
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `ws://${h}:${port}`;
  }

  start(): void {
    const { connection, logger } = this.options;
    if (!connection.enable || this.wss) return;

    const host = connection.host || '127.0.0.1';
    const port = connection.port;

    this.wss = new WebSocketServer({ host, port });

    this.wss.on('listening', () => {
      logger.info(`等待 NapCat 连入: ${this.listenUrl}`);
    });

    this.wss.on('connection', (ws, req) => {
      if (!this.verifyToken(req)) {
        logger.warn('连接被拒绝：Access Token 不匹配');
        ws.close(1008, 'Unauthorized');
        return;
      }

      if (this.client) {
        logger.info('新连接接入，关闭旧连接');
        this.client.close();
      }

      this.client = ws;
      logger.info(`NapCat 已连入: ${connection.name}`);

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString()) as OB11Event & OB11ApiResponse;
          this.handleIncoming(data);
        } catch (e) {
          logger.warn('无法解析消息', e);
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          logger.warn(`NapCat 断开: ${connection.name}`);
          this.rejectAllPending('NapCat 已断开');
          this.options.onClientDisconnect?.();
        }
      });

      ws.on('error', (err) => {
        logger.error(`连接错误: ${err.message}`);
      });

      this.options.onClientConnect?.();
    });

    this.wss.on('error', (err) => {
      logger.error(`监听失败 ${host}:${port}: ${err.message}`);
    });
  }

  stop(): void {
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
    this.rejectAllPending('服务已停止');
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected || !this.client) {
      throw new Error('NapCat 未连接');
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
      this.client!.send(JSON.stringify(payload));
    });
  }

  private verifyToken(req: IncomingMessage): boolean {
    const token = this.options.connection.accessToken;
    if (!token) return true;

    const auth = req.headers.authorization;
    if (auth === `Bearer ${token}` || auth === token) return true;

    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('access_token') ?? url.searchParams.get('accessToken');
    return q === token;
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

  private rejectAllPending(reason: string): void {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(echo);
    }
  }
}
