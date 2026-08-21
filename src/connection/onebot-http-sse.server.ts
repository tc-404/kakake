import http from 'node:http';
import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import type { OB11Event } from './onebot.types.js';
import {
  callOneBotHttpAction,
  connectionHttpListenUrl,
  emitOneBotEvent,
  parseOb11EventBody,
  readRawBody,
  resolveApiBaseUrl,
  verifyHttpAccessToken,
  verifyHttpEventAuth,
} from './onebot-http.shared.js';

export interface OneBotHttpSseServerOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onReady?: () => void;
  onDisconnect?: () => void;
}

type SseClient = {
  res: http.ServerResponse;
  id: number;
};

/**
 * OneBot HTTP SSE 服务器
 * - POST：接收对端上报的事件
 * - GET（Accept: text/event-stream）：向对端推送事件流
 * - callAction：请求 connection.apiUrl（对端 HTTP API）
 */
export class OneBotHttpSseServer implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private server: http.Server | null = null;
  private listening = false;
  private sseClients = new Map<number, SseClient>();
  private nextClientId = 1;

  constructor(private readonly options: OneBotHttpSseServerOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.listening;
  }

  get listenUrl(): string {
    return connectionHttpListenUrl(this.options.connection);
  }

  get apiBaseUrl(): string {
    return resolveApiBaseUrl(this.options.connection);
  }

  start(): void {
    const { connection, logger } = this.options;
    if (!connection.enable || this.server) return;

    const host = connection.host || '127.0.0.1';
    const port = connection.port;

    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });

    this.server.on('listening', () => {
      this.listening = true;
      logger.info(
        `HTTP SSE 监听: ${this.listenUrl} （SSE 收事件客户端 / POST 上报；API: ${this.apiBaseUrl}）`,
      );
      this.options.onReady?.();
    });

    this.server.on('error', (err) => {
      this.listening = false;
      logger.error(`HTTP SSE 监听失败 ${host}:${port}: ${err.message}`);
      this.options.onDisconnect?.();
    });

    this.server.listen(port, host);
  }

  stop(): void {
    const was = this.listening;
    this.listening = false;
    for (const client of this.sseClients.values()) {
      try {
        client.res.end();
      } catch { /* ignore */ }
    }
    this.sseClients.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (was) this.options.onDisconnect?.();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error('HTTP SSE 服务器未就绪');
    }
    return callOneBotHttpAction(
      this.apiBaseUrl,
      action,
      params,
      this.options.connection.accessToken,
      this.options.logger,
    );
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const { connection, logger } = this.options;
    const accept = (req.headers.accept || '').toLowerCase();
    const wantsSse = accept.includes('text/event-stream');

    if ((req.method === 'GET' || req.method === 'HEAD') && wantsSse) {
      if (!verifyHttpAccessToken(req, connection.accessToken)) {
        res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Unauthorized');
        return;
      }
      this.attachSseClient(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('kakake onebot http sse ok');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: 405, message: 'Method Not Allowed' }));
      return;
    }

    try {
      const raw = await readRawBody(req);
      if (!verifyHttpEventAuth(req, connection.accessToken, raw)) {
        logger.warn('HTTP SSE 上报被拒绝：Access Token / X-Signature 不匹配');
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'failed', retcode: 401, message: 'Unauthorized' }));
        return;
      }
      const body = raw.trim() ? (JSON.parse(raw) as unknown) : null;
      const event = parseOb11EventBody(body);
      if (!event) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'Invalid event' }));
        return;
      }
      this.dispatchEvent(event);
      res.writeHead(204);
      res.end();
    } catch (e) {
      logger.warn('HTTP SSE 上报解析失败', e);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'Bad Request' }));
    }
  }

  private attachSseClient(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = this.nextClientId++;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': ok\n\n');

    this.sseClients.set(id, { res, id });
    this.options.logger.info(`HTTP SSE 客户端已连接 (#${id})，当前 ${this.sseClients.size} 路`);

    const cleanup = () => {
      if (this.sseClients.delete(id)) {
        this.options.logger.info(`HTTP SSE 客户端断开 (#${id})，剩余 ${this.sseClients.size} 路`);
      }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  private dispatchEvent(event: OB11Event): void {
    emitOneBotEvent(this.id, this.name, event);
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const [id, client] of this.sseClients) {
      try {
        client.res.write(payload);
      } catch {
        this.sseClients.delete(id);
      }
    }
  }
}
