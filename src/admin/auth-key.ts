import fs from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { PATHS } from '../paths.js';

/** initial=启动自动生成的初始密钥；custom=用户首次登录后自行设置 */
export type AuthKeyKind = 'initial' | 'custom';

export interface AuthKeyFile {
  /** 后台登录密钥 */
  key: string;
  /** 创建/更新时间戳 */
  updatedAt: number;
  /** 密钥类型标签：初始密码需引导设密，自定义密码则跳过 */
  kind: AuthKeyKind;
}

const KEY_LEN = 20;

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGIT = '23456789';
const SYMBOL = '!@#$%^&*-_=+';
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

function readRaw(): { data: AuthKeyFile; hadKind: boolean } | null {
  if (!fs.existsSync(PATHS.authKey)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(PATHS.authKey, 'utf-8')) as Partial<AuthKeyFile>;
    const key = typeof raw.key === 'string' ? raw.key.trim() : '';
    if (!key) return null;
    const hadKind = raw.kind === 'initial' || raw.kind === 'custom';
    return {
      hadKind,
      data: {
        key,
        updatedAt: Number(raw.updatedAt) || Date.now(),
        // 旧文件无 kind 时按初始密钥处理，引导完成一次设密
        kind: normalizeKind(raw.kind),
      },
    };
  } catch {
    return null;
  }
}

export function saveAuthKey(key: string, kind: AuthKeyKind): AuthKeyFile {
  const data: AuthKeyFile = {
    key: key.trim(),
    updatedAt: Date.now(),
    kind,
  };
  fs.mkdirSync(PATHS.data, { recursive: true });
  fs.writeFileSync(PATHS.authKey, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
  return data;
}

/**
 * 确保登录密钥文件存在；不存在则新建为初始密钥。
 */
export function ensureAuthKey(seed?: string): { key: string; created: boolean; kind: AuthKeyKind } {
  const existing = readRaw();
  if (existing) {
    if (!existing.hadKind) {
      saveAuthKey(existing.data.key, existing.data.kind);
    }
    return { key: existing.data.key, created: false, kind: existing.data.kind };
  }
  const key = (seed ?? '').trim() || generateLoginKey();
  saveAuthKey(key, 'initial');
  return { key, created: true, kind: 'initial' };
}

export function getAuthKey(): string {
  return ensureAuthKey().key;
}

/**
 * 与登录密钥比对（恒定时间，长度不同直接判否）。
 * 所有校验登录密钥的地方都应走这里，避免各处用 `===` 留下时序差异。
 */
export function matchesAuthKey(input: string): boolean {
  const expected = getAuthKey();
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function getAuthKeyKind(): AuthKeyKind {
  return ensureAuthKey().kind;
}

export function isInitialAuthKey(): boolean {
  return getAuthKeyKind() === 'initial';
}

/** 用户首次设密：写入自定义密码并标记为 custom */
export function setCustomAuthKey(password: string): string {
  const key = password.trim();
  if (!key) throw new Error('密码不能为空');
  saveAuthKey(key, 'custom');
  return key;
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
