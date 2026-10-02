import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ConnectionConfig } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import type { OB11ApiResponse, OB11Event } from './onebot.types.js';
import { eventBus } from '../event/event-bus.js';
import { logEvent } from '../core/log-store.js';
import { formatOb11Event } from '../core/log-format.js';
import {
  describeRemoteAddress,
  isLoopbackAddress,
  isTrustedLocalAddress,
  remoteAddressOf,
} from '../core/net-address.js';

export function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/** OneBot 协议端 HTTP API 根地址（无尾斜杠） */
export function resolveApiBaseUrl(conn: ConnectionConfig): string {
  const raw = (conn.apiUrl || '').trim();
  if (raw) return raw.replace(/\/+$/, '');
  const mode = conn.mode ?? 'reverse';
  // HTTP / HTTP SSE 服务器：host/port 是事件监听地址，API 默认本机 3000
  if (mode === 'http' || mode === 'http_sse') {
    return 'http://127.0.0.1:3000';
  }
  const h = displayHost(conn.host || '127.0.0.1');
  const port = conn.port || 3000;
  return `http://${h}:${port}`;
}

export function connectionHttpListenUrl(conn: Pick<ConnectionConfig, 'host' | 'port'>): string {
  return `http://${displayHost(conn.host || '127.0.0.1')}:${conn.port}`;
}

/** HTTP 客户端模式：事件上报挂在框架主端口 */
export function connectionHttpClientEventUrl(connectionId: string): string {
  const cfg = configService.getConfig();
  const h = displayHost(cfg.host || '127.0.0.1');
  return `http://${h}:${cfg.port}/onebot/http/${connectionId}`;
}

export function buildAuthHeaders(accessToken?: string): Record<string, string> {
  if (!accessToken) return {};
  return { Authorization: `Bearer ${accessToken}` };
}

function headerValue(
  headers: IncomingMessage['headers'],
  name: string,
): string | undefined {
  const v = headers[name];
  if (Array.isArray(v)) return v[0];
  return v;
}

function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 上报/取流鉴权用的最小请求形状（原生 IncomingMessage 与 Express Request 都满足） */
export type HttpAuthRequestLike = {
  headers: IncomingMessage['headers'];
  url?: string | undefined;
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined | null } | null | undefined;
};

/** Authorization / query access_token（WS、SSE、部分 HTTP 客户端） */
export function verifyHttpAccessToken(
  req: HttpAuthRequestLike,
  accessToken?: string,
): boolean {
  if (!accessToken) return true;
  const auth = headerValue(req.headers, 'authorization');
  if (auth === `Bearer ${accessToken}` || auth === accessToken) return true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('access_token') ?? url.searchParams.get('accessToken');
    return q === accessToken;
  } catch {
    return false;
  }
}

/**
 * HTTP Client 上报鉴权：用 token 对 body 做 HMAC-SHA1，
 * 放在 X-Signature: sha1=<hex>（不发 Authorization）
 */
export function verifyHttpBodySignature(
  req: { headers: IncomingMessage['headers'] },
  accessToken: string,
  rawBody: string | Buffer,
): boolean {
  const raw = headerValue(req.headers, 'x-signature');
  if (!raw) return false;
  const got = raw.trim();
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = `sha1=${createHmac('sha1', accessToken).update(body, 'utf8').digest('hex')}`;
  return safeEqualStr(got, expected);
}

/** 鉴权结论；deny 的 reason 直接用于日志与 401 响应，方便用户定位原因 */
export type HttpAuthVerdict = { ok: true } | { ok: false; reason: string };

const NO_TOKEN_HINT = '未配置 Access Token，仅接受本机/内网来源';

/**
 * HTTP 事件上报鉴权（协议端 → 框架）。
 *
 * - 配了 Access Token：Bearer / query access_token / X-Signature 任一通过即可。
 * - 没配 Access Token：只接受本机与内网来源。否则公网上任何人都能 POST 伪造事件
 *   进来并驱动插件逻辑（等于冒充任意账号向 bot 下指令），这不是"读数据"级别的
 *   风险，所以宁可拒绝也不能默认放行。
 */
export function checkHttpEventAuth(
  req: HttpAuthRequestLike,
  accessToken: string | undefined,
  rawBody?: string | Buffer,
): HttpAuthVerdict {
  const from = remoteAddressOf(req);
  if (!accessToken) {
    if (isTrustedLocalAddress(from)) return { ok: true };
    return { ok: false, reason: `${NO_TOKEN_HINT}（来源 ${describeRemoteAddress(from)}）` };
  }
  if (verifyHttpAccessToken(req, accessToken)) return { ok: true };
  if (rawBody !== undefined && verifyHttpBodySignature(req, accessToken, rawBody)) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `Access Token / X-Signature 不匹配（来源 ${describeRemoteAddress(from)}）`,
  };
}

/**
 * 事件流取用鉴权（HTTP SSE 模式下协议端 GET 框架的事件流）。
 * 与上报同一口径：没配 Access Token 时不把 bot 的事件流开放给公网。
 */
export function checkHttpStreamAuth(
  req: HttpAuthRequestLike,
  accessToken: string | undefined,
): HttpAuthVerdict {
  const from = remoteAddressOf(req);
  if (!accessToken) {
    if (isTrustedLocalAddress(from)) return { ok: true };
    return { ok: false, reason: `${NO_TOKEN_HINT}（来源 ${describeRemoteAddress(from)}）` };
  }
  if (verifyHttpAccessToken(req, accessToken)) return { ok: true };
  return { ok: false, reason: `Access Token 不匹配（来源 ${describeRemoteAddress(from)}）` };
}

/** 监听地址是否会把端口暴露到本机之外（0.0.0.0 / :: / 具体网卡地址） */
export function listenHostReachesBeyondLocalhost(host: string | undefined): boolean {
  const h = (host || '127.0.0.1').trim();
  if (!h) return false;
  if (h === '0.0.0.0' || h === '::' || h === '*') return true;
  return !isLoopbackAddress(h);
}

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function callOneBotHttpAction(
  apiBase: string,
  action: string,
  params: Record<string, unknown> | undefined,
  accessToken: string | undefined,
  logger: Logger,
): Promise<unknown> {
  const base = apiBase.replace(/\/+$/, '');
  const url = `${base}/${action.replace(/^\//, '')}`;
  const timeoutMs = configService.getConfig().apiTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...buildAuthHeaders(accessToken),
      },
      body: JSON.stringify(params ?? {}),
      signal: controller.signal,
    });

    const text = await res.text();
    let json: OB11ApiResponse | null = null;
    try {
      json = text ? (JSON.parse(text) as OB11ApiResponse) : null;
    } catch {
      throw new Error(`HTTP API 响应非 JSON (${res.status}): ${text.slice(0, 200)}`);
    }

    if (!res.ok) {
      throw new Error(json?.message || `HTTP API ${res.status}`);
    }
    if (!json) throw new Error('HTTP API 空响应');
    if (json.status === 'failed' || (typeof json.retcode === 'number' && json.retcode !== 0)) {
      throw new Error(json.message ?? `API 失败 retcode=${json.retcode}`);
    }
    return json.data;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`API 超时: ${action}`);
    }
    logger.debug(`HTTP API ${action} 失败: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export function emitOneBotEvent(connectionId: string, name: string, event: OB11Event): void {
  const formatted = formatOb11Event(event);
  const isHeartbeat = event.post_type === 'meta_event'
    && (event as { meta_event_type?: string }).meta_event_type === 'heartbeat';
  logEvent(
    `[上报:${name}]`,
    formatted.message,
    {
      detail: formatted.detail,
      raw: formatted.raw,
      level: isHeartbeat ? 'debug' : 'info',
    },
  );
  void eventBus.emit('onebot/event', { connectionId, event });
  void eventBus.emitHierarchy(`onebot/${event.post_type}`, { connectionId, event });
}

export function parseOb11EventBody(body: unknown): OB11Event | null {
  if (!body || typeof body !== 'object') return null;
  const ev = body as OB11Event;
  if (!ev.post_type) return null;
  return ev;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return null;
  return JSON.parse(raw) as unknown;
}

/** 常见 OneBot HTTP SSE 事件路径（按优先级尝试） */
export const SSE_EVENT_PATHS = ['/', '/event', '/events', '/_events', '/api/event'] as const;
