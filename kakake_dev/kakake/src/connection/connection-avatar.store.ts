import fs from 'node:fs';
import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';

export interface ConnectionAvatarEntry {
  /** raw base64（不含 data: 前缀） */
  data: string;
  mime: string;
  /** 用于判断账号变化是否需要重新拉取（OneBot UIN / QQ AppID 等） */
  accountKey: string;
  updatedAt: string;
}

interface AvatarsFile {
  avatars: Record<string, ConnectionAvatarEntry>;
}

function emptyFile(): AvatarsFile {
  return { avatars: {} };
}

function readFile(): AvatarsFile {
  try {
    if (!fs.existsSync(PATHS.connectionAvatars)) return emptyFile();
    const raw = fs.readFileSync(PATHS.connectionAvatars, 'utf-8');
    const parsed = JSON.parse(raw) as AvatarsFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.avatars || typeof parsed.avatars !== 'object') {
      return emptyFile();
    }
    return parsed;
  } catch {
    return emptyFile();
  }
}

function writeFile(data: AvatarsFile): void {
  const dir = PATHS.data;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PATHS.connectionAvatars, JSON.stringify(data, null, 2), 'utf-8');
}

export function getConnectionAvatar(connectionId: string): ConnectionAvatarEntry | undefined {
  const id = String(connectionId || '').trim();
  if (!id) return undefined;
  return readFile().avatars[id];
}

export function getConnectionAvatarMeta(connectionId: string): {
  hasAvatar: boolean;
  avatarUpdatedAt?: string;
} {
  const entry = getConnectionAvatar(connectionId);
  if (!entry?.data) return { hasAvatar: false };
  return { hasAvatar: true, avatarUpdatedAt: entry.updatedAt };
}

export function connectionAvatarDataUrl(connectionId: string): string | undefined {
  const entry = getConnectionAvatar(connectionId);
  if (!entry?.data) return undefined;
  const mime = entry.mime || 'image/jpeg';
  return `data:${mime};base64,${entry.data}`;
}

/**
 * 写入头像；若 accountKey 相同且已有数据则跳过（force 可强制覆盖）
 * @returns 是否写入
 */
export function setConnectionAvatar(
  connectionId: string,
  opts: { data: string; mime: string; accountKey: string; force?: boolean },
): boolean {
  const id = String(connectionId || '').trim();
  const data = String(opts.data || '').trim();
  const accountKey = String(opts.accountKey || '').trim();
  if (!id || !data || !accountKey) return false;

  const file = readFile();
  const prev = file.avatars[id];
  if (!opts.force && prev?.data && prev.accountKey === accountKey) {
    return false;
  }

  file.avatars[id] = {
    data,
    mime: opts.mime || 'image/jpeg',
    accountKey,
    updatedAt: new Date().toISOString(),
  };
  writeFile(file);
  return true;
}

export function removeConnectionAvatar(connectionId: string): void {
  const id = String(connectionId || '').trim();
  if (!id) return;
  const file = readFile();
  if (!(id in file.avatars)) return;
  delete file.avatars[id];
  writeFile(file);
}

function sniffMime(buf: Buffer, contentType?: string | null): string {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct.startsWith('image/')) return ct;
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 8
    && buf[0] === 0x89
    && buf[1] === 0x50
    && buf[2] === 0x4e
    && buf[3] === 0x47
  ) {
    return 'image/png';
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
  if (
    buf.length >= 12
    && buf[0] === 0x52
    && buf[1] === 0x49
    && buf[2] === 0x46
    && buf[3] === 0x46
  ) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

/** 从 URL 下载图片并写入 base64 缓存 */
export async function fetchAndStoreAvatarFromUrl(
  connectionId: string,
  url: string,
  accountKey: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const src = String(url || '').trim();
  const key = String(accountKey || '').trim();
  if (!src || !key) return false;

  const existing = getConnectionAvatar(connectionId);
  if (!opts?.force && existing?.data && existing.accountKey === key) {
    return false;
  }

  try {
    const res = await fetch(src, {
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'kakake/avatar-fetch' },
    });
    if (!res.ok) {
      rootLogger.warn(`[Avatar] 下载失败 ${connectionId}: HTTP ${res.status}`);
      return false;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32 || buf.length > 2 * 1024 * 1024) {
      rootLogger.warn(`[Avatar] 图片大小异常 ${connectionId}: ${buf.length}`);
      return false;
    }
    const mime = sniffMime(buf, res.headers.get('content-type'));
    return setConnectionAvatar(connectionId, {
      data: buf.toString('base64'),
      mime,
      accountKey: key,
      force: opts?.force,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    rootLogger.warn(`[Avatar] 下载异常 ${connectionId}: ${msg}`);
    return false;
  }
}

/** OneBot：用 QQ 号拼 qlogo 拉取头像（s=5 为最高清档） */
export async function fetchAndStoreOnebotQlogoAvatar(
  connectionId: string,
  botUin: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const uin = String(botUin || '').trim();
  if (!uin || uin === '0') return false;
  const url = `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=5`;
  // accountKey 带上 s=5，便于从旧 s=100 缓存升级覆盖
  return fetchAndStoreAvatarFromUrl(connectionId, url, `${uin}:s5`, opts);
}
