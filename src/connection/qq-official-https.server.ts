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
  QQC_CALLBACK_MAX_SKEW_SEC,
  qqOfficialSignValidation,
  qqOfficialTimestampFresh,
  qqOfficialVerifyCallbackSignature,
} from './qq-official-crypto.js';
import type { QqOfficialEndpoint } from './qq-official-ws.client.js';

export function qqOfficialHttpsCallbackPath(connectionId: string): string {
  return `/gfbot/${connectionId}`;
}

/**
 * 供开放平台填写 / 界面复制的回调 URL。
 * 只在填了 webhookBaseUrl（公网域名）时才是平台可用的地址；
 * 缺省回落到本机地址，仅用于自测/日志，界面不该把它当成可提交的回调地址。
 */
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

/** 公网回调基址是否已配置（决定界面能否给出可提交的回调 URL） */
export function qqOfficialHttpsHasPublicBase(webhookBaseUrl?: string): boolean {
  return !!String(webhookBaseUrl ?? '').trim();
}

type WebhookHandler = {
  connection: ConnectionConfig;
  onEvent?: () => void;
  /** 平台校验过回调地址（op13 验签通过）或收到过验签通过的事件 */
  verified?: boolean;
  /** verified 由 false 翻成 true 时回调一次（用于刷新界面状态） */
  onVerified?: () => void;
};

const webhookHandlers = new Map<string, WebhookHandler>();

export function registerQqOfficialHttpsWebhook(id: string, handler: WebhookHandler): void {
  webhookHandlers.set(id, handler);
}

export function unregisterQqOfficialHttpsWebhook(id: string): void {
  webhookHandlers.delete(id);
}

/** 回调时间戳允许的最大偏差（秒）：超出即判定过期/重放 */
const QQ_CALLBACK_MAX_SKEW_SEC = QQC_CALLBACK_MAX_SKEW_SEC;
/** 平台会重推事件：按事件 id 去重，避免插件重复执行 */
const QQ_CALLBACK_DEDUPE_TTL_MS = 10 * 60_000;
const QQ_CALLBACK_DEDUPE_MAX = 4096;
/** op=13 校验载荷的长度上限（正常值都很短，超长一律拒绝） */
const QQ_VALIDATION_PLAIN_TOKEN_MAX = 512;
const QQ_VALIDATION_EVENT_TS_MAX = 64;

/** connectionId:eventId → 首次收到时间（Map 保持插入序，便于按顺序清理） */
const seenCallbackEvents = new Map<string, number>();

/** 记录事件 id 并判断是否重复（重复＝平台重试或有人重放） */
function isDuplicateCallbackEvent(connectionId: string, eventId: string): boolean {
  const now = Date.now();
  for (const [key, ts] of seenCallbackEvents) {
    if (now - ts <= QQ_CALLBACK_DEDUPE_TTL_MS) break;
    seenCallbackEvents.delete(key);
  }
  const key = `${connectionId}:${eventId}`;
  if (seenCallbackEvents.has(key)) return true;
  seenCallbackEvents.set(key, now);
  while (seenCallbackEvents.size > QQ_CALLBACK_DEDUPE_MAX) {
    const oldest = seenCallbackEvents.keys().next();
    if (oldest.done) break;
    seenCallbackEvents.delete(oldest.value);
  }
  return false;
}

/** 标记“平台确实连通过来”，并在首次翻正时刷新界面状态 */
function markWebhookVerified(handler: WebhookHandler): void {
  if (handler.verified) return;
  handler.verified = true;
  handler.onVerified?.();
}

export interface QqOfficialHttpsServerOptions {
  connection: ConnectionConfig;
  onReady?: () => void;
  onDisconnect?: () => void;
  onProfileUpdated?: () => void;
  /** 回调地址首次被平台验证通过（用于刷新连接状态） */
  onWebhookVerified?: () => void;
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

  /**
   * 回调地址是否已被平台真正验证过。
   * Webhook 模式下“监听已就绪”不等于“平台能推到”：
   * 域名没配好 / 没做反代时同样 active，界面必须靠这个标记区分。
   */
  getWebhookVerified(): boolean {
    return webhookHandlers.get(this.id)?.verified ?? false;
  }

  private logNetRetry(message: string): void {
    this.log('warn', '[QQ官方HTTPS] 网络重试', message);
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
      verified: false,
      onEvent: () => {
        /* 收到事件即通路正常 */
      },
      onVerified: () => this.options.onWebhookVerified?.(),
    });
    this.active = true;
    const hasPublicBase = qqOfficialHttpsHasPublicBase(connection.webhookBaseUrl);
    if (hasPublicBase) {
      this.log('info', `[QQ官方HTTPS] 等待腾讯回调: ${this.callbackUrl}`);
    } else {
      this.log(
        'warn',
        '[QQ官方HTTPS] 未填写「公网回调基址」：开放平台要求公网 HTTPS（80/443/8080/8443）地址，'
        + `当前监听地址 ${this.callbackUrl} 只能本机自测；请填域名并反代到本服务端口`,
      );
    }
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
        onRetry: (m) => this.logNetRetry(m),
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
    if (!conn.appId) {
      throw new Error('QQ 官方连接缺少 AppID，无法调用官方接口');
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

  private async ensureAccessToken(): Promise<void> {
    const conn = this.options.connection;
    if (!isQqOfficialConnection(conn)) return;
    if (!conn.appId || !conn.appSecret) {
      throw new Error('QQ 官方连接缺少 AppID / AppSecret，无法获取 AccessToken');
    }
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
}

function headerOne(
  headers: Request['headers'],
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

function logWebhook(conn: ConnectionConfig, level: 'debug' | 'info' | 'warn' | 'error', message: string, detail?: string): void {
  logQqOfficialEvent(`[官方:${conn.name}]`, message, { level, detail });
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

  const rawBodyField = (req as Request & { rawBody?: Buffer | string }).rawBody;
  if (rawBodyField === undefined) {
    // 没有原始报文就无法验签：正常只会在 express.json 之前被别的中间件吃掉 body 时出现
    logWebhook(
      conn,
      'warn',
      '[QQ官方HTTPS] 未取得原始报文（rawBody），签名校验可能失败',
      'body 必须由 express.json({verify}) 解析，且不得在此之前被其它 body parser 处理',
    );
  }
  const rawBody = rawBodyField
    ?? (typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {}));
  const rawStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  if (!rawStr.trim()) {
    logWebhook(conn, 'warn', '[QQ官方HTTPS] 回调请求 body 为空，已拒绝');
    res.status(400).json({ message: 'empty body' });
    return;
  }

  let payload: { op?: number; t?: string; d?: unknown; id?: string; s?: number };
  try {
    payload = (typeof req.body === 'object' && req.body)
      ? req.body as typeof payload
      : JSON.parse(rawStr) as typeof payload;
  } catch {
    res.status(400).json({ message: 'invalid json' });
    return;
  }

  const sig = headerOne(req.headers, 'x-signature-ed25519');
  const ts = headerOne(req.headers, 'x-signature-timestamp');

  // op=13 回调地址验证：平台要求用 AppSecret 派生密钥对 event_ts + plain_token 签名回包
  if (payload.op === 13) {
    // 校验请求带签名头时必须验：否则这就是一个“用机器人密钥签任意数据”的公开接口
    if (sig && ts && !qqOfficialVerifyCallbackSignature(conn.appSecret, sig, ts, rawStr)) {
      logWebhook(
        conn,
        'warn',
        '[QQ官方HTTPS] 回调地址校验请求签名不合法，已拒绝',
        '校验与事件用的是同一套签名（Ed25519(timestamp + body)，密钥由 AppSecret 派生）；'
        + '若确认开放平台的校验请求不带签名头，把这段强制校验去掉即可（本文件 op=13 分支）',
      );
      res.status(401).json({ message: 'unauthorized' });
      return;
    }
    if (!sig || !ts) {
      logWebhook(
        conn,
        'warn',
        '[QQ官方HTTPS] 回调校验请求未带签名头，按平台文档直接回签名',
        '建议在开放平台重新保存一次回调地址，让后续校验都带签名头',
      );
    }
    const d = (payload.d && typeof payload.d === 'object')
      ? payload.d as { plain_token?: string; event_ts?: string }
      : {};
    const plainToken = String(d.plain_token ?? '');
    const eventTs = String(d.event_ts ?? '');
    if (!plainToken || !eventTs) {
      res.status(400).json({ message: 'invalid validation payload' });
      return;
    }
    if (plainToken.length > QQ_VALIDATION_PLAIN_TOKEN_MAX || eventTs.length > QQ_VALIDATION_EVENT_TS_MAX) {
      logWebhook(conn, 'warn', '[QQ官方HTTPS] 回调校验载荷超长，已拒绝');
      res.status(400).json({ message: 'validation payload too long' });
      return;
    }
    try {
      const signature = qqOfficialSignValidation(conn.appSecret, eventTs, plainToken);
      res.status(200).json({ plain_token: plainToken, signature });
      // 只有验签通过的校验才算“平台真的连通过来”
      if (sig && ts) markWebhookVerified(handler);
      logWebhook(conn, 'info', '[QQ官方HTTPS] 回调地址校验已响应');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logWebhook(conn, 'error', '[QQ官方HTTPS] 回调校验签名失败', msg);
      res.status(500).json({ message: 'sign failed' });
    }
    return;
  }

  if (!sig || !ts || !qqOfficialVerifyCallbackSignature(conn.appSecret, sig, ts, rawStr)) {
    logWebhook(conn, 'warn', '[QQ官方HTTPS] 签名校验失败');
    res.status(401).json({ message: 'unauthorized' });
    return;
  }

  // 时间戳校验（防重放）：本机时间不准会误伤，所以日志里直接点明排查方向
  if (!qqOfficialTimestampFresh(ts)) {
    logWebhook(
      conn,
      'warn',
      `[QQ官方HTTPS] 回调时间戳超出允许偏差（±${QQ_CALLBACK_MAX_SKEW_SEC}s），已按过期/重放拒绝`,
      `timestamp=${ts}，若本机时间不准请先校时（NTP）`,
    );
    res.status(401).json({ message: 'stale timestamp' });
    return;
  }

  if (payload.op === 0) {
    const eventId = String(payload.id ?? '').trim();
    if (eventId && isDuplicateCallbackEvent(conn.id, eventId)) {
      logWebhook(conn, 'warn', `[QQ官方HTTPS] 重复回调已忽略（平台重试或重放） id=${eventId}`);
      res.status(200).json({ op: 12 });
      return;
    }
    markWebhookVerified(handler);
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
