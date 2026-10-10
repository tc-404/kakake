import type { ConnectionConfig } from '../core/types.js';
import { isQqOfficialConnection, resolveQqOfficialApiBase } from '../core/types.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** 正式环境鉴权失败时常见原因：开放平台 IP 白名单（仅限制正式，不影响沙箱） */
const PROD_IP_WHITELIST_HINT =
  '正式环境：请到开放平台检查该机器人 IP 白名单是否包含本机公网出口 IP；白名单仅限制正式环境，沙箱不受影响';

/**
 * 单次请求超时（毫秒）。undici 内置连接超时为 10s，这里必须比它大，
 * 否则永远看不到底层 errno（ETIMEDOUT / ENETUNREACH 等）。
 * 可用环境变量 KAKAKE_GF_API_TIMEOUT_MS 覆盖。
 */
const DEFAULT_GF_API_TIMEOUT_MS = 20_000;
/** 网络层失败后的额外重试次数，可用 KAKAKE_GF_API_RETRY 覆盖（0 = 不重试） */
const DEFAULT_GF_API_RETRY = 2;
/** 重试基础间隔（毫秒），按次数线性递增 */
const GF_API_RETRY_DELAY_MS = 800;

/**
 * 这些 errno 只会出现在“连接还没建立”的阶段：请求体一定没发出去，
 * 重试不会产生重复消息。ECONNRESET / EPIPE 等发送中断的错误不在此列。
 */
const CONNECT_STAGE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EACCES',
  'UND_ERR_CONNECT_TIMEOUT',
]);

interface NodeErrorLike extends Error {
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  address?: unknown;
  port?: unknown;
  cause?: unknown;
  errors?: unknown;
}

function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function gfApiTimeoutMs(): number {
  return readEnvInt('KAKAKE_GF_API_TIMEOUT_MS', DEFAULT_GF_API_TIMEOUT_MS, 3_000, 300_000);
}

function gfApiRetry(): number {
  return readEnvInt('KAKAKE_GF_API_RETRY', DEFAULT_GF_API_RETRY, 0, 5);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 收集一层 Error 上的 errno / syscall / 目标地址 */
function describeErrorLayer(err: NodeErrorLike): string {
  const tags: string[] = [];
  if (err.code) tags.push(String(err.code));
  if (err.syscall) tags.push(String(err.syscall));
  if (err.address) {
    tags.push(err.port ? `${String(err.address)}:${String(err.port)}` : String(err.address));
  }
  const msg = String(err.message ?? '').trim();
  const tail = tags.length ? ` (${tags.join(' ')})` : '';
  return `${msg}${tail}`.trim();
}

/**
 * 把 undici 的 `TypeError: fetch failed` 展开成可诊断文本。
 * 真正的失败原因藏在 error.cause（以及 AggregateError.errors）里，
 * 只打 error.message 的话日志里永远只有 “fetch failed”。
 */
export function describeQqOfficialNetworkError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const layers: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || depth > 5 || layers.length >= 4 || seen.has(node)) return;
    seen.add(node);
    if (!(node instanceof Error)) {
      const text = String(node).trim();
      if (text && !layers.includes(text)) layers.push(text);
      return;
    }
    const e = node as NodeErrorLike;
    const text = describeErrorLayer(e);
    if (text && !layers.includes(text)) layers.push(text);
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) walk(sub, depth + 1);
    }
    walk(e.cause, depth + 1);
  };
  walk(err, 0);
  return layers.join(' ← ') || err.message;
}

/** 从整条 cause 链里找出第一个 errno，用于判断能否安全重试 */
function collectErrorCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (!(node instanceof Error)) return;
    const e = node as NodeErrorLike;
    if (e.code) codes.push(String(e.code));
    if (Array.isArray(e.errors)) {
      for (const sub of e.errors) walk(sub, depth + 1);
    }
    walk(e.cause, depth + 1);
  };
  walk(err, 0);
  return codes;
}

function isTimeoutAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** 请求体是否肯定没有送达服务端（可以安全重试） */
function isSafeToRetry(err: unknown, method: string): boolean {
  const idempotent = method === 'GET' || method === 'HEAD';
  if (isTimeoutAbort(err)) return idempotent;
  const codes = collectErrorCodes(err);
  if (codes.some((c) => CONNECT_STAGE_CODES.has(c))) return true;
  return idempotent && codes.length > 0;
}

export interface QqOfficialFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 日志标签，出现在错误信息里，例如 `POST /v2/users/xxx/messages` */
  label: string;
  /** 网络层重试时的提示回调（调用方传入自己的 logger） */
  onRetry?: (message: string) => void;
}

/**
 * QQ 官方接口统一出口：显式超时 + 连接阶段失败重试 + 展开 cause。
 * 只处理网络层，HTTP 状态码交给调用方判断。
 */
export async function qqOfficialFetch(
  url: string,
  opts: QqOfficialFetchOptions,
): Promise<Response> {
  const method = (opts.method ?? 'GET').toUpperCase();
  const timeoutMs = gfApiTimeoutMs();
  const maxRetry = gfApiRetry();
  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    try {
      return await fetch(url, {
        method,
        headers: opts.headers,
        body: opts.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: unknown) {
      lastErr = err;
      const detail = isTimeoutAbort(err)
        ? `请求超时 ${timeoutMs}ms`
        : describeQqOfficialNetworkError(err);
      const canRetry = attempt < maxRetry && isSafeToRetry(err, method);
      if (!canRetry) {
        throw new Error(`网络请求失败: ${opts.label} ${detail}`);
      }
      const delay = GF_API_RETRY_DELAY_MS * (attempt + 1);
      opts.onRetry?.(
        `${opts.label} 网络失败（第 ${attempt + 1}/${maxRetry + 1} 次）: ${detail}，${delay}ms 后重试`,
      );
      await sleep(delay);
    }
  }
  throw new Error(
    `网络请求失败: ${opts.label} ${describeQqOfficialNetworkError(lastErr)}`,
  );
}

export interface QqOfficialBotProfile {
  id: string;
  username: string;
  avatar: string;
  unionOpenid?: string;
  /** 开放平台资料简介（若接口未返回则为空） */
  desc?: string;
  /** GET /users/@me 返回的机器人分享链接 */
  shareUrl?: string;
  fetchedAt: number;
}

/** 将 GET /users/@me 响应映射为本地资料结构 */
export function mapQqOfficialMeToProfile(me: {
  id?: string;
  username?: string;
  avatar?: string;
  union_openid?: string;
  desc?: string;
  bio?: string;
  share_url?: string;
}): QqOfficialBotProfile {
  const shareUrl = String(me.share_url ?? '').trim();
  return {
    id: String(me.id ?? ''),
    username: String(me.username ?? '未命名机器人'),
    avatar: String(me.avatar ?? ''),
    unionOpenid: me.union_openid,
    desc: me.desc || me.bio || '',
    shareUrl: shareUrl || undefined,
    fetchedAt: Date.now(),
  };
}

export interface QqAccessTokenResult {
  access_token: string;
  expires_in: number;
}

export function formatQqOfficialEnvLabel(sandbox?: boolean): string {
  return sandbox ? '沙箱' : '正式';
}

/** 截断响应正文，避免日志过长 */
export function clipQqOfficialErrorBody(text: string, max = 300): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function looksLikeAuthFailure(message: string): boolean {
  return /\b401\b/i.test(message)
    || /unauthorized/i.test(message)
    || /鉴权|认证失败|校验.?token|wrong.?token|check.?token/i.test(message);
}

/** 正式环境且像鉴权失败时追加 IP 白名单排查提示 */
export function appendQqOfficialAuthHint(message: string, sandbox?: boolean): string {
  if (sandbox) return message;
  if (!looksLikeAuthFailure(message)) return message;
  if (message.includes('IP 白名单')) return message;
  return `${message}（${PROD_IP_WHITELIST_HINT}）`;
}

export async function fetchQqOfficialAccessToken(
  appId: string,
  appSecret: string,
  onRetry?: (message: string) => void,
): Promise<QqAccessTokenResult> {
  const res = await qqOfficialFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
    label: `POST ${TOKEN_URL}`,
    onRetry,
  });
  const text = await res.text();
  let data: { access_token?: string; expires_in?: string | number; message?: string };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(
      `AccessToken 响应无效: HTTP ${res.status} ${TOKEN_URL} ${clipQqOfficialErrorBody(text)}`,
    );
  }
  if (!res.ok || !data.access_token) {
    const body = clipQqOfficialErrorBody(text);
    const base = data.message
      || `获取 AccessToken 失败: HTTP ${res.status} ${TOKEN_URL}${body ? ` ${body}` : ''}`;
    // Token 接口本身不区分沙箱/正式；仍带 status/body 便于对照
    throw new Error(base);
  }
  return {
    access_token: data.access_token,
    expires_in: Number(data.expires_in) || 7200,
  };
}

export async function qqOfficialApiRequest<T = unknown>(opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  appId: string;
  accessToken: string;
  sandbox?: boolean;
  body?: Record<string, unknown>;
  /** 网络层重试提示回调 */
  onRetry?: (message: string) => void;
}): Promise<T> {
  const apiBase = resolveQqOfficialApiBase(opts.sandbox);
  const env = formatQqOfficialEnvLabel(opts.sandbox);
  const path = opts.path.startsWith('/') ? opts.path : `/${opts.path}`;
  const url = `${apiBase}${path}`;
  const headers: Record<string, string> = {
    Authorization: `QQBot ${opts.accessToken}`,
    'X-Union-Appid': opts.appId,
  };
  if (opts.body) headers['Content-Type'] = 'application/json';

  const res = await qqOfficialFetch(url, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    label: `${opts.method} [${env}] ${url}`,
    onRetry: opts.onRetry,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const apiMsg = typeof data === 'object' && data && 'message' in data
      ? String((data as { message: unknown }).message)
      : '';
    const body = clipQqOfficialErrorBody(text);
    const detail = [apiMsg, body && body !== apiMsg ? body : '']
      .filter(Boolean)
      .join(' ');
    const msg = `HTTP ${res.status} [${env}] ${apiBase}${path}${detail ? ` ${detail}` : ''}`;
    throw new Error(appendQqOfficialAuthHint(msg, opts.sandbox));
  }
  return data as T;
}

/** GET /users/@me — 官方提供的当前机器人资料（昵称、头像） */
export async function fetchQqOfficialBotProfile(
  appId: string,
  appSecret: string,
  sandbox?: boolean,
  onRetry?: (message: string) => void,
): Promise<QqOfficialBotProfile> {
  const token = await fetchQqOfficialAccessToken(appId, appSecret, onRetry);
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
    appId,
    accessToken: token.access_token,
    sandbox,
    onRetry,
  });
  return mapQqOfficialMeToProfile(me);
}

export function pickQqOfficialCredentials(
  conn: ConnectionConfig,
): { appId: string; appSecret: string; sandbox: boolean } | null {
  if (!isQqOfficialConnection(conn)) return null;
  if (!conn.appId || !conn.appSecret) return null;
  return { appId: conn.appId, appSecret: conn.appSecret, sandbox: conn.sandbox ?? true };
}
