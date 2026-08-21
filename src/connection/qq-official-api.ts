import type { ConnectionConfig } from '../core/types.js';
import { isQqOfficialConnection, resolveQqOfficialApiBase } from '../core/types.js';

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';

/** 正式环境鉴权失败时常见原因：开放平台 IP 白名单（仅限制正式，不影响沙箱） */
const PROD_IP_WHITELIST_HINT =
  '正式环境：请到开放平台检查该机器人 IP 白名单是否包含本机公网出口 IP；白名单仅限制正式环境，沙箱不受影响';

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
): Promise<QqAccessTokenResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: appSecret }),
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

  const res = await fetch(url, {
    method: opts.method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
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
): Promise<QqOfficialBotProfile> {
  const token = await fetchQqOfficialAccessToken(appId, appSecret);
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
