import { configService } from './config.service.js';
import { pluginAccountService } from '../plugin/plugin-account.service.js';
import type { ConnectionConfig, ConnectionLogLayout } from './types.js';

const CACHE_TTL_MS = 3000;
const CACHE_LIMIT = 2000;

const cache = new Map<string, { value: string | null; at: number }>();

export function clearLogAccountCache(): void {
  cache.clear();
}

function accountKeyOf(conn: ConnectionConfig): string {
  return pluginAccountService.resolveAccountKey(conn) || String(conn.id || '').trim();
}

function matches(conn: ConnectionConfig, candidate: string): boolean {
  const c = candidate.trim();
  if (!c || c === 'extension') return false;
  return c === conn.id
    || c === conn.name
    || c === accountKeyOf(conn)
    || c === String(conn.botUin || '').trim()
    || c === String(conn.appId || '').trim()
    || c === String(conn.weixinAccountId || '').trim()
    || c === String(conn.kookBotUserId || '').trim()
    || c === String(conn.telegramBotUserId || '').trim();
}

function candidates(prefix: string): string[] {
  const inner = prefix.replace(/^\[+/, '').replace(/\]+$/, '').trim();
  const out: string[] = [];
  const at = inner.lastIndexOf('@');
  if (at >= 0) {
    const tail = inner.slice(at + 1).replace(/\].*$/, '').trim();
    if (tail) out.push(tail);
  }
  for (const part of inner.split(':')) {
    const value = part.replace(/\].*$/, '').trim();
    if (value) out.push(value);
  }
  if (inner) out.push(inner);
  return out;
}

function compute(prefix: string): string | null {
  const list = candidates(prefix);
  if (!list.length) return null;
  const connections = configService.getConnections().connections;
  for (const conn of connections) {
    for (const candidate of list) {
      if (matches(conn, candidate)) return accountKeyOf(conn) || null;
    }
  }
  return null;
}

export function resolveLogAccountFromPrefix(prefix: string): string | null {
  const raw = String(prefix || '').trim();
  if (!raw) return null;
  const now = Date.now();
  const hit = cache.get(raw);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = compute(raw);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(raw, { value, at: now });
  return value;
}

export function resolveLogLayoutForAccount(accountKey: string): ConnectionLogLayout {
  const key = String(accountKey || '').trim();
  if (!key || key === 'extension') return 'legacy';
  for (const conn of configService.getConnections().connections) {
    if (key === conn.id || key === accountKeyOf(conn)) {
      return conn.logLayout === 'account' ? 'account' : 'legacy';
    }
  }
  return 'legacy';
}
