import type { Request, Response, NextFunction } from 'express';
import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import {
  callOneBotHttpAction,
  connectionHttpClientEventUrl,
  emitOneBotEvent,
  parseOb11EventBody,
  resolveApiBaseUrl,
  verifyHttpEventAuth,
} from './onebot-http.shared.js';

type WebhookHandler = {
  connection: ConnectionConfig;
  logger: Logger;
  onEvent?: () => void;
};

const webhookHandlers = new Map<string, WebhookHandler>();

export function registerHttpClientWebhook(id: string, handler: WebhookHandler): void {
  webhookHandlers.set(id, handler);
}

export function unregisterHttpClientWebhook(id: string): void {
  webhookHandlers.delete(id);
}

/** 挂到框架主 Express：POST /onebot/http/:id 接收事件上报 */
export function createOnebotHttpClientWebhookMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const m = /^\/onebot\/http\/([^/]+)\/?$/.exec(req.path || '');
    if (!m) {
      next();
      return;
    }

    const id = m[1];
    const handler = webhookHandlers.get(id);
    if (!handler) {
      res.status(404).json({ status: 'failed', retcode: 404, message: 'connection not active' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      res.status(200).type('text').send('kakake onebot http client webhook ok');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ status: 'failed', retcode: 405, message: 'Method Not Allowed' });
      return;
    }

    const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody
      ?? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}));
    if (!verifyHttpEventAuth(req, handler.connection.accessToken, rawBody)) {
      handler.logger.warn('HTTP 客户端上报被拒绝：Access Token / X-Signature 不匹配');
      res.status(401).json({ status: 'failed', retcode: 401, message: 'Unauthorized' });
      return;
    }

    const event = parseOb11EventBody(req.body);
    if (!event) {
      res.status(400).json({ status: 'failed', retcode: 1400, message: 'Invalid event' });
      return;
    }

    emitOneBotEvent(handler.connection.id, handler.connection.name, event);
    handler.onEvent?.();
    res.status(204).end();
  };
}

export interface OneBotHttpClientOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onReady?: () => void;
  onDisconnect?: () => void;
}

/**
 * OneBot HTTP 客户端
 * 主动调用对端 HTTP API；事件由对端 HTTP POST 到框架路径 /onebot/http/:id
 *（适合反代/域名，无需额外监听端口）
 */
export class OneBotHttpClient implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private active = false;

  constructor(private readonly options: OneBotHttpClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.active;
  }

  get eventUrl(): string {
    return connectionHttpClientEventUrl(this.id);
  }

  get apiBaseUrl(): string {
    return resolveApiBaseUrl(this.options.connection);
  }

  start(): void {
    const { connection, logger } = this.options;
    if (!connection.enable || this.active) return;

    registerHttpClientWebhook(this.id, {
      connection,
      logger,
      onEvent: () => {
        /* webhook 收到事件即表示通路正常 */
      },
    });
    this.active = true;
    logger.info(`HTTP 客户端就绪 · 事件上报: ${this.eventUrl} · API: ${this.apiBaseUrl}`);
    this.options.onReady?.();
  }

  stop(): void {
    const was = this.active;
    this.active = false;
    unregisterHttpClientWebhook(this.id);
    if (was) this.options.onDisconnect?.();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error('HTTP 客户端未就绪');
    }
    return callOneBotHttpAction(
      this.apiBaseUrl,
      action,
      params,
      this.options.connection.accessToken,
      this.options.logger,
    );
  }
}
