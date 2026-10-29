import http from 'node:http';
import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import type { OneBotRawResult } from './onebot.types.js';
import {
  callOneBotHttpAction,
  callOneBotHttpActionRaw,
  checkHttpEventAuth,
  connectionHttpListenUrl,
  emitOneBotEvent,
  listenHostReachesBeyondLocalhost,
  parseOb11EventBody,
  BodyTooLargeError,
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

  async callActionRaw(
    action: string,
    params?: Record<string, unknown>,
    method?: 'GET' | 'POST',
  ): Promise<OneBotRawResult> {
    if (!this.isConnected) {
      return { ok: false, error: 'HTTP 服务器未就绪' };
    }
    return callOneBotHttpActionRaw(
      this.apiBaseUrl,
      action,
      params,
      this.options.connection.accessToken,
      this.options.logger,
      { method },
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
      // 体积超限单独回 413：这是「你发太大了」，不是「你发错了」，混在一起
      // 会让协议端把限流当成解析错误去重试，反而放大压力。
      if (e instanceof BodyTooLargeError) {
        logger.warn(`HTTP 上报体超限（>${e.limitBytes} 字节），已拒绝`, e);
        // Connection: close：请求体没读完了就回响应，必须显式告诉客户端
        // 「这条连接回完就断」，否则客户端可能以为还能复用。
        res.writeHead(413, {
          'Content-Type': 'application/json; charset=utf-8',
          Connection: 'close',
        });
        res.end(JSON.stringify({
          status: 'failed', retcode: 1413, message: 'Payload Too Large',
          wording: `上报体超过 ${e.limitBytes} 字节上限`,
        }));
        return;
      }
      logger.warn('HTTP 上报解析失败', e);
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1400, message: 'Bad Request' }));
    }
  }
}
