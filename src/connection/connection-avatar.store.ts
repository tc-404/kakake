import { PATHS } from '../paths.js';
import { rootLogger } from '../core/logger.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

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
  const parsed = readJsonSafe<AvatarsFile>(PATHS.connectionAvatars, emptyFile(), {
    label: 'connection-avatars.json',
  });
  if (!parsed || typeof parsed !== 'object' || !parsed.avatars || typeof parsed.avatars !== 'object') {
    return emptyFile();
  }
  return parsed;
}

function writeFile(data: AvatarsFile): void {
  writeJsonAtomic(PATHS.connectionAvatars, data);
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

/**
 * 透明图层：认不出类型时的兜底 MIME。
 *
 * 必须是 PNG 不能是 JPEG——JPEG 没有 alpha 通道，一旦把带透明的 PNG / WebP
 * 标成 image/jpeg，浏览器就按 JPEG 解码，透明区被填成黑（或白），
 * 透明头像直接废掉。以前这里三处兜底全都写的 image/jpeg，
 * 于是整条头像链路（下载 → 落盘 → dataUrl → <img>）都不支持透明图。
 */
const FALLBACK_MIME = 'image/png';

function decodeBase64(data: string): Buffer | null {
  try {
    const buf = Buffer.from(data, 'base64');
    return buf.length > 0 ? buf : null;
  } catch {
    return null;
  }
}

/**
 * 读出条目时按字节复核一次 MIME。
 * 历史数据里存着「mime: image/jpeg 但实际是 PNG」的记录会被就地救回来，
 * 不用等下次重新拉取——透明头像立刻恢复。
 */
function resolveMime(entry: ConnectionAvatarEntry): string {
  const buf = decodeBase64(entry.data);
  if (buf) {
    const sniffed = sniffMime(buf);
    if (sniffed) return sniffed;
  }
  const stored = String(entry.mime || '').trim().toLowerCase();
  // 字节认不出来 + 存的是 jpeg：多半当初就标错了，按 PNG 兜底，别再吞透明层
  return stored.startsWith('image/') && stored !== 'image/jpeg' ? stored : FALLBACK_MIME;
}

export function connectionAvatarDataUrl(connectionId: string): string | undefined {
  const entry = getConnectionAvatar(connectionId);
  if (!entry?.data) return undefined;
  return `data:${resolveMime(entry)};base64,${entry.data}`;
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
    /*
     * 图没换人，但旧记录可能把 MIME 标错了（PNG 标成 image/jpeg）。
     * 这里就地纠正一次再放行：不改 data、不动 updatedAt，
     * 只是把类型改对，透明通道立刻恢复，不必等下次重新下载。
     */
    const fixed = resolveMime(prev);
    if (fixed !== String(prev.mime || '').trim().toLowerCase()) {
      file.avatars[id] = { ...prev, mime: fixed };
      writeFile(file);
      return true;
    }
    return false;
  }

  const declared = String(opts.mime || '').trim().toLowerCase();
  const buf = decodeBase64(data);
  const sniffed = buf ? sniffMime(buf, declared) : null;
  const mime = sniffed
    || (declared.startsWith('image/') && declared !== 'image/jpeg' ? declared : FALLBACK_MIME);

  file.avatars[id] = {
    data,
    mime,
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

/**
 * 按魔数判断图片类型；认不出来返回 null，由调用方决定兜底。
 *
 * 字节永远优先于服务端声明：平台常把 PNG / WebP 报成 image/jpeg，
 * 而 JPEG 是唯一没有 alpha 的常见格式，误报一次透明头像就没了。
 * 所以即便 Content-Type 写着 jpeg，也必须先过一遍魔数。
 */
function sniffMime(buf: Buffer, contentType?: string | null): string | null {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  // 非标准写法，统一成标准 MIME 再参与后续判断
  const declared = ct === 'image/jpg' ? 'image/jpeg' : ct;

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
    && buf[8] === 0x57
    && buf[9] === 0x45
    && buf[10] === 0x42
    && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  // AVIF / HEIC：都是 ISOBMFF，靠 ftyp 后的 brand 区分
  if (
    buf.length >= 12
    && buf[4] === 0x66
    && buf[5] === 0x74
    && buf[6] === 0x79
    && buf[7] === 0x70
  ) {
    const brand = buf.toString('latin1', 8, 12).toLowerCase();
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'mif1') return 'image/heic';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';

  // 字节没认出来才信声明，但 jpeg 声明一律不信（无 alpha，代价太大）
  if (declared.startsWith('image/') && declared !== 'image/jpeg') return declared;
  return null;
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
    const mime = sniffMime(buf, res.headers.get('content-type')) ?? FALLBACK_MIME;
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

/** OneBot：用 QQ 号拼 qlogo 头像地址（s=5 为最高清档）；QQ 号缺失或为 0 时返回空串 */
export function onebotQlogoAvatarUrl(botUin: string): string {
  const uin = String(botUin || '').trim();
  if (!uin || uin === '0') return '';
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=5`;
}

/** OneBot：下载并缓存 qlogo 头像 */
export async function fetchAndStoreOnebotQlogoAvatar(
  connectionId: string,
  botUin: string,
  opts?: { force?: boolean },
): Promise<boolean> {
  const uin = String(botUin || '').trim();
  const url = onebotQlogoAvatarUrl(uin);
  if (!url) return false;
  // accountKey 带上 s=5，便于从旧 s=100 缓存升级覆盖
  return fetchAndStoreAvatarFromUrl(connectionId, url, `${uin}:s5`, opts);
}
