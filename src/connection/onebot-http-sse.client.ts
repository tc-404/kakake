import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import type { OneBotEndpoint } from './onebot-endpoint.js';
import {
  SSE_EVENT_PATHS,
  buildAuthHeaders,
  callOneBotHttpAction,
  emitOneBotEvent,
  parseOb11EventBody,
  resolveApiBaseUrl,
} from './onebot-http.shared.js';

export interface HttpSseReconnectStatus {
  reconnecting: boolean;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  abandoned: boolean;
}

export interface OneBotHttpSseClientOptions {
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
 * OneBot HTTP SSE 客户端
 * 主动连接对端提供的 HTTP SSE 事件流，并用同址 HTTP API 调用 action
 */
export class OneBotHttpSseClient implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private closed = false;
  private connected = false;
  private abort: AbortController | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private abandoned = false;
  private connecting = false;
  private ssePath = '/';

  constructor(private readonly options: OneBotHttpSseClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get targetUrl(): string {
    return `${resolveApiBaseUrl(this.options.connection)}${this.ssePath === '/' ? '' : this.ssePath}`;
  }

  getReconnectStatus(): HttpSseReconnectStatus {
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
    this.options.onReconnectStatusChange?.();
  }

  start(): void {
    this.closed = false;
    this.abandoned = false;
    this.reconnectAttempts = 0;
    void this.connect();
  }

  resetAndReconnect(): void {
    if (this.closed) return;
    this.abandoned = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.abort?.abort();
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = false;
    const was = this.connected;
    this.connected = false;
    this.abort?.abort();
    this.abort = null;
    this.options.onReconnectStatusChange?.();
    if (was) this.options.onDisconnect?.();
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected) {
      throw new Error('HTTP SSE 未连接');
    }
    return callOneBotHttpAction(
      resolveApiBaseUrl(this.options.connection),
      action,
      params,
      this.options.connection.accessToken,
      this.options.logger,
    );
  }

  private async connect(): Promise<void> {
    const { connection, logger } = this.options;
    if (this.closed || !connection.enable) return;

    this.abort?.abort();
    this.abort = new AbortController();
    this.connecting = true;
    this.connected = false;
    this.options.onReconnectStatusChange?.();

    const base = resolveApiBaseUrl(connection);
    logger.info(`HTTP SSE 连接 NapCat: ${base}`);

    try {
      const opened = await this.openSseStream(base, this.abort.signal);
      if (!opened || this.closed) {
        this.connecting = false;
        this.scheduleReconnect();
        return;
      }
      this.connecting = false;
      this.connected = true;
      this.reconnectAttempts = 0;
      this.abandoned = false;
      this.options.onReconnectStatusChange?.();
      logger.info(`HTTP SSE 已连接: ${connection.name} (${this.targetUrl})`);
      this.options.onReady?.();
    } catch (err: unknown) {
      if (this.closed) return;
      this.connecting = false;
      this.connected = false;
      const msg = err instanceof Error ? err.message : String(err);
      if ((err as { name?: string })?.name !== 'AbortError') {
        logger.warn(`HTTP SSE 连接失败: ${msg}`);
      }
      this.options.onReconnectStatusChange?.();
      this.options.onDisconnect?.();
      this.scheduleReconnect();
    }
  }

  private async openSseStream(base: string, signal: AbortSignal): Promise<boolean> {
    const { connection, logger } = this.options;
    const headers = {
      Accept: 'text/event-stream',
      ...buildAuthHeaders(connection.accessToken),
    };

    let lastErr: Error | null = null;
    for (const path of SSE_EVENT_PATHS) {
      if (signal.aborted || this.closed) return false;
      const url = path === '/' ? `${base}/` : `${base}${path}`;
      try {
        const res = await fetch(url, { method: 'GET', headers, signal });
        const ctype = (res.headers.get('content-type') || '').toLowerCase();
        if (!res.ok || !res.body) {
          lastErr = new Error(`SSE ${path} HTTP ${res.status}`);
          continue;
        }
        if (!ctype.includes('text/event-stream') && !ctype.includes('text/plain')) {
          // 部分实现仍返回 event-stream 但 content-type 不准；有 body 则尝试读
          if (!ctype.includes('json')) {
            // ok try
          } else {
            lastErr = new Error(`SSE ${path} 非事件流 (${ctype || 'unknown'})`);
            continue;
          }
        }

        this.ssePath = path;
        void this.consumeSse(res.body, signal).finally(() => {
          if (this.closed) return;
          const was = this.connected;
          this.connected = false;
          this.options.onReconnectStatusChange?.();
          if (was) {
            logger.warn(`HTTP SSE 断开: ${connection.name}`);
            this.options.onDisconnect?.();
          }
          this.scheduleReconnect();
        });
        return true;
      } catch (e: unknown) {
        if ((e as { name?: string })?.name === 'AbortError') return false;
        lastErr = e instanceof Error ? e : new Error(String(e));
      }
    }

    throw lastErr ?? new Error('无法打开 HTTP SSE 事件流');
  }

  private async consumeSse(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (!signal.aborted && !this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          this.handleSseChunk(chunk);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch { /* ignore */ }
    }
  }

  private handleSseChunk(chunk: string): void {
    const lines = chunk.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    if (!raw || raw === '[DONE]') return;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const event = parseOb11EventBody(parsed);
      if (event) emitOneBotEvent(this.id, this.name, event);
    } catch {
      this.options.logger.debug('SSE 数据无法解析为事件');
    }
  }

  private scheduleReconnect(): void {
    const { logger, autoReconnect = true } = this.options;
    const conn = this.options.connection;
    if (this.closed || !autoReconnect || !conn.enable || this.abandoned) return;
    if (this.reconnectTimer) return;

    const maxAttempts = resolveReconnectMaxAttempts(conn);
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.abandoned = true;
      this.options.onReconnectStatusChange?.();
      logger.warn(
        `[${conn.name}] 已达最大重连次数 ${maxAttempts}，停止自动重连（可手动重连或调整设置）`,
      );
      this.options.onReconnectAbandoned?.();
      return;
    }

    const intervalMs = resolveReconnectIntervalMs(conn);
    this.reconnectAttempts += 1;
    this.options.onReconnectStatusChange?.();
    const attemptNo = this.reconnectAttempts;
    const maxLabel = maxAttempts > 0 ? `${attemptNo}/${maxAttempts}` : `${attemptNo}`;
    logger.info(`[${conn.name}] ${intervalMs}ms 后尝试重连 HTTP SSE（第 ${maxLabel} 次）`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed || this.abandoned) return;
      void this.connect();
    }, intervalMs);
  }
}
