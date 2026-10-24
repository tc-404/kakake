import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { ConnectionConfig } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import type { OB11ApiResponse, OB11Event, OneBotRawResult } from './onebot.types.js';
import { eventBus } from '../event/event-bus.js';
import { logEvent } from '../core/log-store.js';
import { formatOb11Event } from '../core/log-format.js';
import {
  describeRemoteAddress,
  isLoopbackAddress,
  remoteAddressOf,
  tokenlessSourceVerdict,
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
  const auth = headerValue(req.headers, 'authorization') ?? '';
  // 恒定时间比较：与反向 WS 通道（safeEqualStr）同一口径，避免时序侧信道。
  // 前缀匹配无法恒定时间，先整体比较「Bearer <token>」再退化比较裸 token。
  if (safeEqualStr(auth, `Bearer ${accessToken}`) || safeEqualStr(auth, accessToken)) return true;
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('access_token') ?? url.searchParams.get('accessToken');
    return q !== null && safeEqualStr(q, accessToken);
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
    const verdict = tokenlessSourceVerdict(req.headers, from);
    if (verdict.ok) return { ok: true };
    return { ok: false, reason: `${NO_TOKEN_HINT}（${verdict.reason}）` };
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
    const verdict = tokenlessSourceVerdict(req.headers, from);
    if (verdict.ok) return { ok: true };
    return { ok: false, reason: `${NO_TOKEN_HINT}（${verdict.reason}）` };
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

/**
 * 上报体的体积上限。
 *
 * 为什么需要：这两个端口是独立监听的事件入口（不在主端口的 express.json 10MB
 * 限制范围内），此前 `readRawBody` 一路收到流结束为止——单连接持续灌入即可
 * 把进程堆打爆（Node OOM 后整个框架连同伴随的其它连接一起没）。
 * OneBot 事件最大也就是带 base64 图片的消息段，2 MiB 足够；真要传大文件，
 * OneBot 的约定是走 `file://` / URL 引用而不是内联 base64。
 */
export const MAX_EVENT_BODY_BYTES = 2 * 1024 * 1024;

/** 超出上限时抛出，调用方转成 413。错误对象带 `statusCode` 便于统一处理 */
export class BodyTooLargeError extends Error {
  readonly statusCode = 413;
  constructor(readonly limitBytes: number) {
    super(`请求体超过 ${limitBytes} 字节上限`);
    this.name = 'BodyTooLargeError';
  }
}

/**
 * 读取上报体，超过 `MAX_EVENT_BODY_BYTES` 即抛 `BodyTooLargeError`。
 *
 * 超限时**只暂停读取、不销毁 socket**：这样调用方还有机会回一个干净的 413，
 * 而不是让客户端看到一个连接重置（curl 报 exit 56、协议端只能记一笔网络错误，
 * 分不清是限流还是真断网）。未读的数据留在内核缓冲区，不占进程堆——
 * 真正要防的是「把整个身体验完再判断」，那本身就是 DoS。
 */
export async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };

    function onData(chunk: Buffer | string): void {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > MAX_EVENT_BODY_BYTES) {
        if (settled) return;
        settled = true;
        cleanup();
        req.pause();
        reject(new BodyTooLargeError(MAX_EVENT_BODY_BYTES));
        return;
      }
      chunks.push(buf);
    }

    function onEnd(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    }

    function onError(err: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    }

    function onAborted(): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('连接在上报过程中被中断'));
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
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

/**
 * 接口代理专用的 HTTP 调用：返回完整信封，且**不抛异常**。
 *
 * 与上面 `callOneBotHttpAction` 的关系是「另开一条路」而不是「改造它」——
 * 旧函数被大量既有插件路径依赖（失败即 throw、成功只给 data），任何行为变动都会
 * 静默改变现有插件的语义。所以这里保留旧函数原样，新增一个 raw 通道。
 * `onebot-caller-parity.test.ts` 会锁死旧函数行为逐字不变。
 *
 * 注意 `ok` 的语义：HTTP 4xx/5xx 也返回 `ok:true`，因为它确实是协议端给的响应，
 * 属于「报错」而不是「没拿到结果」——需求要求报错必须原样透传。
 */
export async function callOneBotHttpActionRaw(
  apiBase: string,
  action: string,
  params: Record<string, unknown> | undefined,
  accessToken: string | undefined,
  logger: Logger,
  opts: { method?: 'GET' | 'POST'; timeoutMs?: number } = {},
): Promise<OneBotRawResult> {
  const method: 'GET' | 'POST' = opts.method === 'GET' ? 'GET' : 'POST';
  const base = apiBase.replace(/\/+$/, '');
  const url = new URL(`${base}/${action.replace(/^\//, '')}`);

  let body: string | undefined;
  if (method === 'GET') {
    // OneBot 的 GET 调用把参数放在 query string
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
  } else {
    body = JSON.stringify(params ?? {});
  }

  const timeoutMs = opts.timeoutMs ?? configService.getConfig().apiTimeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...buildAuthHeaders(accessToken),
      },
      ...(body !== undefined ? { body } : {}),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!text.trim()) {
      // 204 / 空包体：算拿到响应，envelope 为 null
      return { ok: true, httpStatus: res.status, envelope: null, rawText: '' };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      return {
        ok: false,
        httpStatus: res.status,
        rawText: text,
        error: `HTTP API 响应非 JSON (${res.status}): ${text.slice(0, 200)}`,
      };
    }
    return { ok: true, httpStatus: res.status, envelope, rawText: text };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, timedOut: true, error: `API 超时: ${action}` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(`HTTP API(raw) ${action} 失败: ${msg}`);
    return { ok: false, error: msg };
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
