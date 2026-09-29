import type { Request, Response, NextFunction } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { getAuthKey, matchesAuthKey } from './auth-key.js';
import { remoteAddressOf } from '../core/net-address.js';
import {
  describeBlockedFor,
  loginBlockedFor,
  recordLoginFailure,
  recordLoginSuccess,
} from './login-throttle.js';

export const SESSION_COOKIE = 'kakake_session';

/** 无互动空闲超时：距上次互动满 30 分钟则失效 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** 绝对上限：自登录起最多 3 小时，即使一直操作也强制退出 */
export const SESSION_ABSOLUTE_MS = 3 * 60 * 60 * 1000;

/** @deprecated 兼容旧引用，等同空闲超时 */
export const SESSION_TTL_MS = SESSION_IDLE_MS;

type SessionRecord = {
  createdAt: number;
  lastActiveAt: number;
};

const sessions = new Map<string, SessionRecord>();

function signSession(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

function pruneExpiredSessions(now = Date.now()): void {
  for (const [id, rec] of sessions) {
    if (
      now - rec.createdAt >= SESSION_ABSOLUTE_MS
      || now - rec.lastActiveAt >= SESSION_IDLE_MS
    ) {
      sessions.delete(id);
    }
  }
}

export function createSession(): string {
  pruneExpiredSessions();
  const now = Date.now();
  const raw = randomBytes(24).toString('hex');
  const session = signSession(raw, getAuthKey());
  sessions.set(session, { createdAt: now, lastActiveAt: now });
  return session;
}

export function destroySession(session: string): void {
  sessions.delete(session);
}

export function clearAllSessions(): void {
  sessions.clear();
}

export function readSessionId(req: Request): string | undefined {
  const fromCookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  if (typeof fromCookie === 'string' && fromCookie) return fromCookie;

  const header = req.headers.cookie;
  if (!header) return undefined;
  const part = header
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${SESSION_COOKIE}=`));
  return part?.slice(SESSION_COOKIE.length + 1);
}

export function getSessionRecord(sessionId: string | undefined): SessionRecord | undefined {
  if (!sessionId) return undefined;
  pruneExpiredSessions();
  return sessions.get(sessionId);
}

export function isValidSession(sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  pruneExpiredSessions();
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  const now = Date.now();
  if (now - rec.createdAt >= SESSION_ABSOLUTE_MS) {
    sessions.delete(sessionId);
    return false;
  }
  if (now - rec.lastActiveAt >= SESSION_IDLE_MS) {
    sessions.delete(sessionId);
    return false;
  }
  return true;
}

/** 互动续期：重置空闲计时（不超过绝对上限） */
export function touchSession(sessionId: string | undefined): boolean {
  if (!sessionId || !isValidSession(sessionId)) return false;
  const rec = sessions.get(sessionId);
  if (!rec) return false;
  rec.lastActiveAt = Date.now();
  return true;
}

export function sessionCookieValue(session: string, createdAt?: number): string {
  const started = createdAt ?? getSessionRecord(session)?.createdAt ?? Date.now();
  const remainMs = Math.max(0, SESSION_ABSOLUTE_MS - (Date.now() - started));
  const maxAge = Math.max(1, Math.floor(remainMs / 1000));
  return `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function isRequestAuthed(req: Request): boolean {
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : auth;
    if (matchesAuthKey(presented)) return true;
  }

  return isValidSession(readSessionId(req));
}

/** 请求是否自带登录密钥（用于把失败尝试计入限速，会话过期的 401 不算） */
function presentsAuthKey(req: Request): boolean {
  const auth = req.headers.authorization;
  return typeof auth === 'string' && auth.trim() !== '';
}

function extractQueryKey(req: Request): string {
  const q = req.query?.key;
  if (typeof q === 'string') return q;
  if (Array.isArray(q) && typeof q[0] === 'string') return q[0];
  return '';
}

function stripKeyFromUrl(req: Request): string {
  const path = req.path || '/';
  const rawQuery = (req.url || '').includes('?') ? (req.url || '').slice((req.url || '').indexOf('?') + 1) : '';
  if (!rawQuery) return path;
  const params = new URLSearchParams(rawQuery);
  params.delete('key');
  const rest = params.toString();
  return rest ? `${path}?${rest}` : path;
}

/**
 * 免鉴权路径白名单。
 *
 * 新增条目前先想清楚：这里的路径对**公网任何人**都开放，因为框架要支持远程
 * 访问后台，监听地址通常是 0.0.0.0。任何会吐出运行数据的接口都不该加进来
 * （例如 /api/events 是全量运行日志流，必须保持在白名单之外）。
 */
const PUBLIC_PREFIXES = [
  '/login',
  '/announcement',
  '/setup-password',
  '/announcement-fallback.md',
  '/assets/',
  '/favicon.ico',
  '/plugin/',
  '/onebot/',
  '/gfbot/',
  '/gf_bot/',
  '/api/status',
  '/api/auth/state',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/touch',
  '/api/announcement',
  '/api/agreement/state',
  '/api/Plugin/DefaultIcon',
  // 登录页要套用同一套自定义外观，故只读的外观参数与背景图字节对未登录者开放；
  // 该前缀下只有 GET，改参数 / 传图 / 删图仍在 /api/appearance 下且需要会话。
  '/api/appearance/public',
  // 本机 / 内网专用接口：加进白名单只是为了让本机脚本不必先登录，公网来源
  // 会在控制器里按来源 IP 被 403 拒绝。新增这类路径时，控制器**必须**自带
  // 来源校验（参考 admin/local-api.controller.ts），否则等于对公网开放。
  '/api/local/connections',
  // 外放 API：免登录只读概览。默认关闭，是否放行由控制器读「外放 API 开关」决定，
  // 开启后刻意对任意来源公开（含同局域网），不做来源校验。
  '/api/public',
];

/** 被动轮询不重置空闲计时（不算「互动」） */
const PASSIVE_NO_TOUCH_PREFIXES = [
  '/api/system/metrics',
  '/api/events',
  '/api/status',
  '/api/auth/state',
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p));
}

function shouldAutoTouch(pathname: string): boolean {
  if (pathname === '/api/auth/touch') return false;
  if (PASSIVE_NO_TOUCH_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return false;
  }
  return pathname.startsWith('/api/');
}

/** 触发限速后的统一拒绝响应 */
function denyThrottled(req: Request, res: Response, remainingMs: number): void {
  const message = `登录尝试过于频繁，请在${describeBlockedFor(remainingMs)}后重试`;
  res.status(429);
  if ((req.path || '').startsWith('/api/')) {
    res.json({ ok: false, code: -1, message });
    return;
  }
  res.type('text').send(message);
}

export function authMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIp = remoteAddressOf(req);
    const queryKey = extractQueryKey(req);
    if (queryKey) {
      const blockedMs = loginBlockedFor(clientIp);
      if (blockedMs > 0) {
        denyThrottled(req, res, blockedMs);
        return;
      }
      if (matchesAuthKey(queryKey)) {
        recordLoginSuccess(clientIp);
        const session = createSession();
        const rec = getSessionRecord(session);
        res.setHeader('Set-Cookie', sessionCookieValue(session, rec?.createdAt));
        let dest = stripKeyFromUrl(req);
        if (dest === '/login' || dest.startsWith('/login?')) dest = '/';
        res.redirect(dest);
        return;
      }
      recordLoginFailure(clientIp, '快捷登录链接');
      res.redirect('/login');
      return;
    }

    if (isPublicPath(req.path)) {
      next();
      return;
    }

    // 自带密钥的请求同样受限速约束，否则可以绕开登录接口直接爆破 Authorization
    const withKey = presentsAuthKey(req);
    if (withKey) {
      const blockedMs = loginBlockedFor(clientIp);
      if (blockedMs > 0) {
        denyThrottled(req, res, blockedMs);
        return;
      }
    }

    if (isRequestAuthed(req)) {
      if (shouldAutoTouch(req.path || '')) {
        const sid = readSessionId(req);
        if (touchSession(sid)) {
          const rec = getSessionRecord(sid);
          if (sid && rec) {
            res.setHeader('Set-Cookie', sessionCookieValue(sid, rec.createdAt));
          }
        }
      }
      next();
      return;
    }

    if (withKey) recordLoginFailure(clientIp, 'Authorization 密钥');

    if (req.path.startsWith('/api/')) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }

    res.redirect('/login');
  };
}
