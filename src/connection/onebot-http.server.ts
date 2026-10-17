import http from 'node:http';
import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import {
  callOneBotHttpAction,
  checkHttpEventAuth,
  connectionHttpListenUrl,
  emitOneBotEvent,
  listenHostReachesBeyondLocalhost,
  parseOb11EventBody,
  readRawBody,
  resolveApiBaseUrl,
} from './onebot-http.shared.js';

export interface OneBotHttpServerOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onReady?: () => void;
  onDisconnect?: () => void;
}

/**
 * OneBot HTTP 服务器
 * 咔咔珂监听端口接收对端 HTTP POST 事件上报，并通过 apiUrl 调用对端 HTTP API
 */
export class OneBotHttpServer implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private server: http.Server | null = null;
  private listening = false;

  constructor(private readonly options: OneBotHttpServerOptions) {
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
      logger.info(`HTTP 事件上报监听: ${this.listenUrl} （API: ${this.apiBaseUrl}）`);
      if (!connection.accessToken && listenHostReachesBeyondLocalhost(host)) {
        logger.warn(
          `未配置 Access Token：${host}:${port} 只接受本机/内网来源的上报，公网来源会被拒绝。`
          + '若协议端在公网，请在连接设置里填写 Access Token',
        );
      }
      this.options.onReady?.();
    });

    this.server.on('error', (err) => {
      this.listening = false;
      logger.error(`HTTP 监听失败 ${host}:${port}: ${err.message}`);
      this.options.onDisconnect?.();
    });

    this.server.listen(port, host);
  }

  stop(): void {
    const wasListening = this.listening;
    this.listening = false;
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (wasListening) this.options.onDisconnect?.();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error('HTTP 服务器未就绪');
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

    if (req.method === 'GET' || req.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('kakake onebot http ok');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: 405, message: 'Method Not Allowed' }));
      return;
    }

    try {
      const raw = await readRawBody(req);
      const verdict = checkHttpEventAuth(req, connection.accessToken, raw);
      if (!verdict.ok) {
        logger.warn(`HTTP 上报被拒绝：${verdict.reason}`);
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
      emitOneBotEvent(this.id, this.name, event);
      res.writeHead(204);
      res.end();
    } catch (e) {
      logger.warn('HTTP 上报解析失败', e);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'Bad Request' }));
    }
  }
}
