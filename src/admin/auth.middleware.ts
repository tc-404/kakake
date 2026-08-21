import type { Request, Response, NextFunction } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { getAuthKey } from './auth-key.js';

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
  const key = getAuthKey();

  const auth = req.headers.authorization;
  if (auth === `Bearer ${key}` || auth === key) return true;

  return isValidSession(readSessionId(req));
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

export function authMiddleware() {
  return (req: Request, res: Response, next: NextFunction) => {
    const queryKey = extractQueryKey(req);
    if (queryKey) {
      if (queryKey === getAuthKey()) {
        const session = createSession();
        const rec = getSessionRecord(session);
        res.setHeader('Set-Cookie', sessionCookieValue(session, rec?.createdAt));
        let dest = stripKeyFromUrl(req);
        if (dest === '/login' || dest.startsWith('/login?')) dest = '/';
        res.redirect(dest);
        return;
      }
      res.redirect('/login');
      return;
    }

    if (isPublicPath(req.path)) {
      next();
      return;
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

    if (req.path.startsWith('/api/')) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }

    res.redirect('/login');
  };
}
