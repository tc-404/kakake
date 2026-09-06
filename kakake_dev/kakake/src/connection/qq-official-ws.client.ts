import WebSocket from 'ws';
import type { ConnectionConfig } from '../core/types.js';
import { isQqOfficialConnection, resolveQqOfficialApiBase } from '../core/types.js';
import { eventBus } from '../event/event-bus.js';
import { logQqOfficialEvent } from '../core/log-store.js';
import { formatLogArgs, formatQqOfficialEvent } from '../core/log-format.js';
import { DEFAULT_QQ_OFFICIAL_INTENTS } from './qq-official-intents.js';
import {
  appendQqOfficialAuthHint,
  clipQqOfficialErrorBody,
  fetchQqOfficialAccessToken,
  formatQqOfficialEnvLabel,
  qqOfficialApiRequest,
  qqOfficialFetch,
  describeQqOfficialNetworkError,
  type QqOfficialBotProfile,
  mapQqOfficialMeToProfile,
} from './qq-official-api.js';

/** WebSocket 握手超时：不设的话握手卡死会让 connecting 永久为 true，重连彻底停摆 */
const WS_HANDSHAKE_TIMEOUT_MS = 20_000;

/** QQ Gateway 关闭码含义（4000+ 为官方自定义），用于把静默断开变成可读原因 */
const QQ_WS_CLOSE_HINTS: Record<number, string> = {
  1000: '正常关闭',
  1001: '对端离开',
  1006: '连接异常中断（未收到关闭帧，多为网络中断/中间设备掐断）',
  4001: '无效的 opcode',
  4002: '解析 payload 失败',
  4006: '无效的 session id',
  4007: 'seq 错误',
  4008: '发送 payload 过快',
  4009: '连接过期，需要重连',
  4010: '无效的 shard',
  4011: '分片需要拆分',
  4012: '无效的 API 版本',
  4013: '无效的 intents',
  4014: 'intents 未获授权（去开放平台确认该机器人已开通对应事件权限）',
  4900: '内部错误，请重连',
  4914: '机器人已下架，只能连沙箱环境',
  4915: '机器人已封禁，只能连沙箱环境',
};

function describeQqWsClose(code: number, reason: string): string {
  const hint = QQ_WS_CLOSE_HINTS[code];
  const text = String(reason ?? '').trim();
  return [`code=${code}`, hint, text].filter(Boolean).join(' · ');
}

interface QqGatewayBotResponse {
  url?: string;
  shards?: number;
  session_start_limit?: Record<string, number>;
}

interface QqGatewayPayload {
  op: number;
  s?: number | null;
  t?: string;
  d?: unknown;
}

export interface QqOfficialEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  getBotProfile(): import('./qq-official-api.js').QqOfficialBotProfile | null;
  refreshBotProfile(): Promise<import('./qq-official-api.js').QqOfficialBotProfile | null>;
}

export interface QqOfficialWsClientOptions {
  connection: ConnectionConfig;
  onReady?: () => void;
  onDisconnect?: () => void;
  onProfileUpdated?: () => void;
}

/**
 * QQ 开放平台官方机器人 — Gateway WebSocket 客户端
 * 参考 bot.q.qq.com API v2 / 社区 SDK（qq-official-bot、botgo）连接流程
 */
export class QqOfficialWsClient implements QqOfficialEndpoint {
  readonly id: string;
  readonly name: string;

  private ws: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatIntervalMs = 45000;
  private lastSeq: number | null = null;
  private sessionId: string | null = null;
  private accessToken = '';
  private tokenExpiresAt = 0;
  private closed = false;
  private connecting = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(private readonly options: QqOfficialWsClientOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
    if (options.connection.botProfile) {
      this.botProfile = options.connection.botProfile;
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    ...args: unknown[]
  ): void {
    logQqOfficialEvent(`[官方:${this.name}]`, message, {
      level,
      detail: args.length ? formatLogArgs(args) : undefined,
    });
  }

  private logNetRetry(message: string): void {
    this.log('warn', '[QQ官方] 网络重试', message);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && !!this.sessionId;
  }

  start(): void {
    if (!isQqOfficialConnection(this.options.connection)) {
      this.log('error', '[QQ官方] 连接配置类型错误');
      return;
    }
    this.closed = false;
    this.reconnectAttempts = 0;
    void this.connect();
  }

  stop(): void {
    this.closed = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.sessionId = null;
    this.lastSeq = null;
    this.options.onDisconnect?.();
  }

  private botProfile: QqOfficialBotProfile | null = null;

  getBotProfile(): QqOfficialBotProfile | null {
    return this.botProfile;
  }

  async refreshBotProfile(): Promise<QqOfficialBotProfile | null> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn) || !conn.appId || !conn.appSecret) return null;
    try {
      await this.ensureAccessToken();
      const me = await qqOfficialApiRequest<{
        id?: string;
        username?: string;
        avatar?: string;
        union_openid?: string;
        desc?: string;
        bio?: string;
        share_url?: string;
      }>({
        method: 'GET',
        path: '/users/@me',
        appId: conn.appId,
        accessToken: this.accessToken,
        sandbox: conn.sandbox,
        onRetry: (m) => this.logNetRetry(m),
      });
      this.botProfile = mapQqOfficialMeToProfile(me);
      conn.botProfile = this.botProfile;
      return this.botProfile;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, conn.sandbox);
      this.log('warn', '[QQ官方] 获取机器人资料失败', msg);
      return null;
    }
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) {
      throw new Error('非 QQ 官方连接');
    }
    await this.ensureAccessToken();
    const p = { ...(params ?? {}) };
    const method = (p.__method as string) || 'POST';
    delete p.__method;
    const body = method === 'GET' || Object.keys(p).length === 0 ? undefined : p;
    return qqOfficialApiRequest({
      method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
      path: action.startsWith('/') ? action : `/${action}`,
      appId: conn.appId,
      accessToken: this.accessToken,
      sandbox: conn.sandbox,
      body,
      onRetry: (m) => this.logNetRetry(m),
    });
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting) return;
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    this.connecting = true;

    try {
      await this.ensureAccessToken();
      const apiBase = resolveQqOfficialApiBase(conn.sandbox);
      const env = formatQqOfficialEnvLabel(conn.sandbox);
      const gwRes = await qqOfficialFetch(`${apiBase}/gateway/bot`, {
        method: 'GET',
        headers: {
          Authorization: `QQBot ${this.accessToken}`,
          'X-Union-Appid': conn.appId,
        },
        label: `GET [${env}] ${apiBase}/gateway/bot`,
        onRetry: (m) => this.logNetRetry(m),
      });
      if (!gwRes.ok) {
        const errText = await gwRes.text();
        const body = clipQqOfficialErrorBody(errText);
        throw new Error(appendQqOfficialAuthHint(
          `获取 Gateway 失败: HTTP ${gwRes.status} [${env}] ${apiBase}/gateway/bot${body ? ` ${body}` : ''}`,
          conn.sandbox,
        ));
      }
      const gw = await gwRes.json() as QqGatewayBotResponse;
      if (!gw.url) throw new Error(`Gateway 响应缺少 url [${env}] ${apiBase}`);

      const wsUrl = `${gw.url}?v=1&encoding=json`;
      this.log('info', `[QQ官方] 连接 Gateway [${env}]`, gw.url);

      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl, { handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS });
        this.ws = ws;
        const onOpen = (): void => {
          cleanup();
          resolve();
        };
        const onError = (err: Error): void => {
          cleanup();
          reject(new Error(`WebSocket 握手失败: ${describeQqOfficialNetworkError(err)}`));
        };
        const onEarlyClose = (code: number, reason: Buffer): void => {
          cleanup();
          reject(new Error(`WebSocket 握手期被关闭: ${describeQqWsClose(code, reason.toString())}`));
        };
        const cleanup = (): void => {
          ws.off('open', onOpen);
          ws.off('error', onError);
          ws.off('close', onEarlyClose);
        };
        ws.once('open', onOpen);
        ws.once('error', onError);
        ws.once('close', onEarlyClose);
      });

      this.ws!.on('message', (raw) => this.handleMessage(raw.toString()));
      this.ws!.on('close', (code: number, reason: Buffer) => {
        this.handleClose(code, reason?.toString?.() ?? '');
      });
      this.ws!.on('error', (err) => {
        this.log('warn', '[QQ官方] WebSocket 错误', describeQqOfficialNetworkError(err));
      });
      this.reconnectAttempts = 0;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, conn.sandbox);
      this.log('error', '[QQ官方] 连接失败', msg);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private async ensureAccessToken(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) return;

    const res = await fetchQqOfficialAccessToken(
      conn.appId,
      conn.appSecret,
      (m) => this.logNetRetry(m),
    );
    this.accessToken = res.access_token;
    this.tokenExpiresAt = now + res.expires_in * 1000;
  }

  private handleMessage(raw: string): void {
    let payload: QqGatewayPayload;
    try {
      payload = JSON.parse(raw) as QqGatewayPayload;
    } catch {
      this.log('warn', '[QQ官方] 无法解析 Gateway 消息');
      return;
    }

    if (payload.s != null) this.lastSeq = payload.s;

    switch (payload.op) {
      case 10: // Hello
        this.heartbeatIntervalMs = (payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 45000;
        void this.sendIdentify();
        this.startHeartbeat();
        break;
      case 11: // Heartbeat ACK
        break;
      case 0: // Dispatch
        this.handleDispatch(payload.t, payload.d);
        break;
      case 7: // Reconnect
        this.log('warn', '[QQ官方] 服务端要求重连');
        this.reconnect();
        break;
      case 9: // Invalid Session
        this.sessionId = null;
        this.lastSeq = null;
        void this.sendIdentify();
        break;
      default:
        break;
    }
  }

  private async sendIdentify(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn) || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    await this.ensureAccessToken();

    const intents = conn.intents ?? DEFAULT_QQ_OFFICIAL_INTENTS;
    // Resume 不会刷新 intents；若需订阅新 Intent（如 GROUP_MEMBER），必须走 Identify
    const canResume = !!this.sessionId;
    if (canResume) {
      this.send({
        op: 6,
        d: {
          token: `QQBot ${this.accessToken}`,
          session_id: this.sessionId,
          seq: this.lastSeq ?? null,
        },
      });
      this.log('info', `[QQ官方] Resume session intents=${intents}`);
      return;
    }

    const d: Record<string, unknown> = {
      token: `QQBot ${this.accessToken}`,
      intents,
      shard: [0, 1],
      properties: {
        $os: process.platform,
        $browser: 'kakake',
        $device: 'kakake',
      },
    };
    this.log('info', `[QQ官方] Identify intents=${intents} (含 GROUP_MEMBER=${!!(intents & (1 << 24))})`);
    this.send({ op: 2, d });
  }

  private handleDispatch(eventType: string | undefined, data: unknown): void {
    if (!eventType) return;

    if (eventType === 'READY') {
      const ready = data as { session_id?: string };
      this.sessionId = ready.session_id ?? null;
      this.log('info', '[QQ官方] Gateway READY');
      void this.refreshBotProfile().then(() => {
        this.options.onProfileUpdated?.();
      });
      this.options.onReady?.();
      return;
    }

    const event = (typeof data === 'object' && data) ? { ...data as object, t: eventType } : { t: eventType, d: data };
    const formatted = formatQqOfficialEvent(eventType, event);
    logQqOfficialEvent(
      `[官方:${this.name}]`,
      formatted.message,
      { detail: formatted.detail, raw: formatted.raw, level: eventType === 'READY' ? 'debug' : 'info' },
    );

    void eventBus.emit('qq_official/event', {
      connectionId: this.id,
      eventType,
      event,
    });
  }

  private send(payload: QqGatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(payload));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.lastSeq ?? null });
    }, this.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private handleClose(code?: number, reason?: string): void {
    this.clearHeartbeat();
    this.ws = null;
    if (typeof code === 'number') {
      this.log('warn', '[QQ官方] Gateway 连接断开', describeQqWsClose(code, reason ?? ''));
    }
    this.options.onDisconnect?.();
    if (!this.closed) this.scheduleReconnect();
  }

  private reconnect(): void {
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.clearHeartbeat();
    void this.connect();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const conn = this.options.connection;
    const interval = Math.max(500, conn.reconnectIntervalMs ?? 5000);
    const max = conn.reconnectMaxAttempts ?? 15;
    if (max > 0 && this.reconnectAttempts >= max) {
      this.log('error', '[QQ官方] 已达最大重连次数，停止重连');
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, interval);
  }
}
