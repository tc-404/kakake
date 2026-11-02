import fs from 'node:fs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

/** initial=启动自动生成的初始密钥；custom=用户首次登录后自行设置 */
export type AuthKeyKind = 'initial' | 'custom';

const KEY_LEN = 20;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
/**
 * 符号只取 URL 安全字符（- _）：快捷登录/票据链接会把密钥或票据拼进 query，
 * 含 = & # + 等保留字符就得百分号编码，复制/点开容易让人误以为失效。
 */
const SYMBOL = '-_';
const ALL = UPPER + LOWER + DIGIT + SYMBOL;

function pick(charset: string): string {
  const buf = randomBytes(1);
  return charset[buf[0]! % charset.length]!;
}

/** 生成约 20 位英文+数字+符号混搭密钥 */
export function generateLoginKey(length = KEY_LEN): string {
  const len = Math.max(16, Math.min(32, length));
  const chars: string[] = [pick(UPPER), pick(LOWER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < len) {
    chars.push(pick(ALL));
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0]! % (i + 1);
    [chars[i], chars[j]] = [chars[j]!, chars[i]!];
  }
  return chars.join('');
}

function normalizeKind(raw: unknown): AuthKeyKind {
  return raw === 'custom' ? 'custom' : 'initial';
}

/** v2 文件结构：登录密码只存 scrypt 哈希；会话签名密钥独立随机、与密码解耦 */
export interface AuthKeyFile {
  version: 2;
  kind: AuthKeyKind;
  updatedAt: number;
  salt: string;
  keyHash: string;
  sessionSecret: string;
}

const SCRYPT_LEN = 64;

function hashWithSalt(key: string, salt: string): Buffer {
  return scryptSync(key, salt, SCRYPT_LEN);
}

interface AuthKeyCache {
  kind: AuthKeyKind;
  stamp: string;
  salt: string;
  keyHash: string;
  sessionSecret: string;
}

let keyCache: AuthKeyCache | null = null;

function fileStamp(): string {
  try {
    const st = fs.statSync(PATHS.authKey);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function persist(key: string, kind: AuthKeyKind, prevSessionSecret?: string): void {
  const salt = randomBytes(16).toString('hex');
  const keyHash = hashWithSalt(key, salt).toString('hex');
  const data: AuthKeyFile = {
    version: 2,
    kind,
    updatedAt: Date.now(),
    salt,
    keyHash,
    sessionSecret: prevSessionSecret || randomBytes(32).toString('hex'),
  };
  writeJsonAtomic(PATHS.authKey, data, { trailingNewline: true });
  keyCache = { kind, stamp: fileStamp(), salt, keyHash, sessionSecret: data.sessionSecret };
}

function readRaw(): { v2: AuthKeyFile | null; legacy: { key: string; kind: AuthKeyKind } | null } {
  const raw = readJsonSafe<Record<string, unknown> | null>(PATHS.authKey, null, { label: 'auth-key.json' });
  if (!raw) return { v2: null, legacy: null };
  if (
    raw.version === 2
    && typeof raw.salt === 'string' && raw.salt
    && typeof raw.keyHash === 'string' && raw.keyHash
    && typeof raw.sessionSecret === 'string' && raw.sessionSecret
  ) {
    return {
      v2: {
        version: 2,
        kind: normalizeKind(raw.kind),
        updatedAt: Number(raw.updatedAt) || Date.now(),
        salt: raw.salt,
        keyHash: raw.keyHash,
        sessionSecret: raw.sessionSecret,
      },
      legacy: null,
    };
  }
  // 旧版明文文件：key 字段还在，启动时立即升级为哈希存储
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (key) return { v2: null, legacy: { key, kind: normalizeKind(raw.kind) } };
  return { v2: null, legacy: null };
}

function loadCache(seed?: string): { cache: AuthKeyCache; createdKey: string | null } {
  const stamp = fileStamp();
  if (keyCache && keyCache.stamp === stamp) return { cache: keyCache, createdKey: null };
  const existing = readRaw();
  if (existing.v2) {
    const v = existing.v2;
    keyCache = { kind: v.kind, stamp: fileStamp(), salt: v.salt, keyHash: v.keyHash, sessionSecret: v.sessionSecret };
    return { cache: keyCache, createdKey: null };
  }
  if (existing.legacy) {
    persist(existing.legacy.key, existing.legacy.kind);
    return { cache: keyCache!, createdKey: null };
  }
  const key = (seed ?? '').trim() || generateLoginKey();
  persist(key, 'initial');
  return { cache: keyCache!, createdKey: key };
}

/**
 * 确保登录密钥文件存在；不存在则新建为初始密钥。
 * key 仅在该次调用**新建**了密钥时返回（明文只在创建那一刻在内存里存在过）。
 */
export function ensureAuthKey(seed?: string): { key: string; created: boolean; kind: AuthKeyKind } {
  const { cache, createdKey } = loadCache(seed);
  return { key: createdKey ?? '', created: createdKey !== null, kind: cache.kind };
}

/** 会话签名密钥：与登录密码解耦的随机值，改密码不影响它，会话失效由内存表负责 */
export function getSessionSecret(): string {
  return loadCache().cache.sessionSecret;
}

/**
 * 与登录密钥比对：对输入做同盐 scrypt 后恒定时间比较。
 * Bearer 头每个请求都会走到这里，同输入 5 分钟内缓存结果，避免反复跑 scrypt。
 */
const verifyCache = new Map<string, { ok: boolean; until: number }>();
const VERIFY_TTL_MS = 5 * 60_000;
const VERIFY_CACHE_MAX = 64;

export function matchesAuthKey(input: string): boolean {
  const { cache } = loadCache();
  const fp = createHash('sha256').update(input).digest('hex');
  const hit = verifyCache.get(fp);
  const now = Date.now();
  if (hit && hit.until > now) return hit.ok;
  const a = hashWithSalt(input, cache.salt);
  const b = Buffer.from(cache.keyHash, 'hex');
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (verifyCache.size >= VERIFY_CACHE_MAX && !verifyCache.has(fp)) {
    const oldest = verifyCache.keys().next().value;
    if (oldest !== undefined) verifyCache.delete(oldest);
  }
  verifyCache.set(fp, { ok, until: now + VERIFY_TTL_MS });
  return ok;
}

export function getAuthKeyKind(): AuthKeyKind {
  return loadCache().cache.kind;
}

export function isInitialAuthKey(): boolean {
  return getAuthKeyKind() === 'initial';
}

export function saveAuthKey(key: string, kind: AuthKeyKind): void {
  persist(key.trim(), kind, keyCache?.sessionSecret);
}

/** 用户首次设密：写入自定义密码并标记为 custom */
export function setCustomAuthKey(password: string): void {
  const key = password.trim();
  if (!key) throw new Error('密码不能为空');
  saveAuthKey(key, 'custom');
}

/** 内部兼容：空串则重新生成初始密钥 */
export function setAuthKey(next: string): string {
  const key = next.trim();
  if (!key) {
    const generated = generateLoginKey();
    saveAuthKey(generated, 'initial');
    return generated;
  }
  saveAuthKey(key, 'custom');
  return key;
}
