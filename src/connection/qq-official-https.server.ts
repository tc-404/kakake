import type { Request, Response, NextFunction } from 'express';
import type { ConnectionConfig } from '../core/types.js';
import { isQqOfficialConnection } from '../core/types.js';
import { configService } from '../core/config.service.js';
import { eventBus } from '../event/event-bus.js';
import { logQqOfficialEvent } from '../core/log-store.js';
import { formatLogArgs, formatQqOfficialEvent } from '../core/log-format.js';
import { displayHost } from './onebot-http.shared.js';
import {
  appendQqOfficialAuthHint,
  fetchQqOfficialAccessToken,
  qqOfficialApiRequest,
  mapQqOfficialMeToProfile,
  type QqOfficialBotProfile,
} from './qq-official-api.js';
import {
  qqOfficialSignValidation,
  qqOfficialVerifyCallbackSignature,
} from './qq-official-crypto.js';
import type { QqOfficialEndpoint } from './qq-official-ws.client.js';

export function qqOfficialHttpsCallbackPath(connectionId: string): string {
  return `/gfbot/${connectionId}`;
}

/** 供开放平台填写 / 界面复制的回调 URL */
export function qqOfficialHttpsCallbackUrl(
  connectionId: string,
  webhookBaseUrl?: string,
): string {
  const path = qqOfficialHttpsCallbackPath(connectionId);
  const base = (webhookBaseUrl || '').trim().replace(/\/+$/, '');
  if (base) return `${base}${path}`;
  const cfg = configService.getConfig();
  const h = displayHost(cfg.host || '127.0.0.1');
  return `http://${h}:${cfg.port}${path}`;
}

type WebhookHandler = {
  connection: ConnectionConfig;
  onEvent?: () => void;
};

const webhookHandlers = new Map<string, WebhookHandler>();

export function registerQqOfficialHttpsWebhook(id: string, handler: WebhookHandler): void {
  webhookHandlers.set(id, handler);
}

export function unregisterQqOfficialHttpsWebhook(id: string): void {
  webhookHandlers.delete(id);
}

export interface QqOfficialHttpsServerOptions {
  connection: ConnectionConfig;
  onReady?: () => void;
  onDisconnect?: () => void;
  onProfileUpdated?: () => void;
}

/**
 * QQ 官方机器人 — HTTPS Webhook
 * 挂在框架主端口 /gfbot/:id，等待腾讯 POST；外网用域名 HTTPS 反代即可。
 */
export class QqOfficialHttpsServer implements QqOfficialEndpoint {
  readonly id: string;
  readonly name: string;

  private active = false;
  private accessToken = '';
  private tokenExpiresAt = 0;
  private botProfile: QqOfficialBotProfile | null = null;

  constructor(private readonly options: QqOfficialHttpsServerOptions) {
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

  get isConnected(): boolean {
    return this.active;
  }

  get callbackUrl(): string {
    return qqOfficialHttpsCallbackUrl(this.id, this.options.connection.webhookBaseUrl);
  }

  getBotProfile(): QqOfficialBotProfile | null {
    return this.botProfile;
  }

  start(): void {
    const { connection } = this.options;
    if (!connection.enable || this.active) return;
    if (!isQqOfficialConnection(connection) || !connection.appId || !connection.appSecret) {
      this.log('error', '[QQ官方HTTPS] 缺少 AppID / AppSecret');
      return;
    }

    registerQqOfficialHttpsWebhook(this.id, {
      connection,
      onEvent: () => {
        /* 收到事件即通路正常 */
      },
    });
    this.active = true;
    this.log('info', `[QQ官方HTTPS] 等待腾讯回调: ${this.callbackUrl}`);
    this.log('info', `[QQ官方HTTPS] 路径: ${qqOfficialHttpsCallbackPath(this.id)} （反代到咔咔主端口即可）`);
    void this.refreshBotProfile().then(() => {
      this.options.onProfileUpdated?.();
    });
    this.options.onReady?.();
  }

  stop(): void {
    const was = this.active;
    this.active = false;
    unregisterQqOfficialHttpsWebhook(this.id);
    if (was) this.options.onDisconnect?.();
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
      });
      this.botProfile = mapQqOfficialMeToProfile(me);
      conn.botProfile = this.botProfile;
      return this.botProfile;
    } catch (err: unknown) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = appendQqOfficialAuthHint(raw, conn.sandbox);
      this.log('warn', '[QQ官方HTTPS] 获取机器人资料失败', msg);
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
    });
  }

  private async ensureAccessToken(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    const now = Date.now();
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) return;
    const res = await fetchQqOfficialAccessToken(conn.appId, conn.appSecret);
    this.accessToken = res.access_token;
    this.tokenExpiresAt = now + res.expires_in * 1000;
  }
}

function headerOne(
  headers: Request['headers'],
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

/** 挂到框架主 Express：POST /gfbot/:id */
export function createQqOfficialHttpsWebhookMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const m = /^\/gfbot\/([^/]+)\/?$/.exec(req.path || '')
      || /^\/gf_bot\/([^/]+)\/?$/.exec(req.path || '');
    if (!m) {
      next();
      return;
    }

    const id = m[1];
    const handler = webhookHandlers.get(id);
    if (!handler) {
      res.status(404).json({ message: 'qq official https webhook not active' });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      res.status(200).type('text').send('kakake qq official https webhook ok');
      return;
    }

    if (req.method !== 'POST') {
      res.status(405).json({ message: 'Method Not Allowed' });
      return;
    }

    void handleWebhookPost(req, res, handler);
  };
}

async function handleWebhookPost(
  req: Request,
  res: Response,
  handler: WebhookHandler,
): Promise<void> {
  const conn = handler.connection;
  if (!isQqOfficialConnection(conn) || !conn.appSecret) {
    res.status(500).json({ message: 'misconfigured' });
    return;
  }

  const rawBody = (req as Request & { rawBody?: Buffer | string }).rawBody
    ?? (typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {}));
  const rawStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');

  let payload: { op?: number; t?: string; d?: unknown; id?: string; s?: number };
  try {
    payload = (typeof req.body === 'object' && req.body)
      ? req.body as typeof payload
      : JSON.parse(rawStr) as typeof payload;
  } catch {
    res.status(400).json({ message: 'invalid json' });
    return;
  }

  // op=13 回调地址验证：不强制验签头，直接按文档回签名
  if (payload.op === 13) {
    const d = (payload.d && typeof payload.d === 'object')
      ? payload.d as { plain_token?: string; event_ts?: string }
      : {};
    const plainToken = String(d.plain_token ?? '');
    const eventTs = String(d.event_ts ?? '');
    if (!plainToken || !eventTs) {
      res.status(400).json({ message: 'invalid validation payload' });
      return;
    }
    try {
      const signature = qqOfficialSignValidation(conn.appSecret, eventTs, plainToken);
      res.status(200).json({ plain_token: plainToken, signature });
      logQqOfficialEvent(`[官方:${conn.name}]`, '[QQ官方HTTPS] 回调地址校验已响应', { level: 'info' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logQqOfficialEvent(`[官方:${conn.name}]`, '[QQ官方HTTPS] 回调校验签名失败', {
        level: 'error',
        detail: msg,
      });
      res.status(500).json({ message: 'sign failed' });
    }
    return;
  }

  const sig = headerOne(req.headers, 'x-signature-ed25519');
  const ts = headerOne(req.headers, 'x-signature-timestamp');
  if (!sig || !ts || !qqOfficialVerifyCallbackSignature(conn.appSecret, sig, ts, rawStr)) {
    logQqOfficialEvent(`[官方:${conn.name}]`, '[QQ官方HTTPS] 签名校验失败', { level: 'warn' });
    res.status(401).json({ message: 'unauthorized' });
    return;
  }

  if (payload.op === 0) {
    const eventType = payload.t || 'UNKNOWN';
    const data = payload.d;
    const event = (typeof data === 'object' && data)
      ? { ...data as object, t: eventType }
      : { t: eventType, d: data };
    const formatted = formatQqOfficialEvent(eventType, event);
    logQqOfficialEvent(`[官方:${conn.name}]`, formatted.message, {
      detail: formatted.detail,
      raw: formatted.raw,
      level: 'info',
    });
    void eventBus.emit('qq_official/event', {
      connectionId: conn.id,
      eventType,
      event,
    });
    handler.onEvent?.();
    // HTTP Callback ACK
    res.status(200).json({ op: 12 });
    return;
  }

  // 其它 op：仍 ACK，避免平台重试
  res.status(200).json({ op: 12 });
}
