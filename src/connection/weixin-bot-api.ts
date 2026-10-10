import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  WEIXIN_BOT_TYPE,
  WEIXIN_CDN_BASE_URL,
  WEIXIN_ILINK_BASE_URL,
  WeixinMessageItemType,
  WeixinMessageState,
  WeixinMessageType,
  WeixinUploadMediaType,
  type WeixinGetUpdatesResp,
  type WeixinGetUploadUrlResp,
  type WeixinLoginCredentials,
  type WeixinMediaKind,
  type WeixinMessage,
  type WeixinMessageItem,
  type WeixinQRCodeResponse,
  type WeixinQRStatusResponse,
} from './weixin-bot.types.js';

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const QR_POLL_TIMEOUT_MS = 35_000;
const CDN_UPLOAD_TIMEOUT_MS = 120_000;
const MEDIA_DOWNLOAD_TIMEOUT_MS = 60_000;

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function apiPost<T>(
  baseUrl: string,
  endpoint: string,
  body: Record<string, unknown>,
  token?: string,
  timeoutMs = DEFAULT_API_TIMEOUT_MS,
): Promise<T> {
  const url = new URL(endpoint, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  const bodyStr = JSON.stringify(body);
  const headers = buildHeaders(token);
  headers['Content-Length'] = String(Buffer.byteLength(bodyStr, 'utf-8'));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`API ${endpoint} responded ${res.status}: ${text}`);
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function buildCdnUploadUrl(cdnBaseUrl: string, uploadParam: string, filekey: string): string {
  return `${cdnBaseUrl.replace(/\/+$/, '')}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
}

export async function fetchWeixinBotQRCode(
  baseUrl = WEIXIN_ILINK_BASE_URL,
): Promise<WeixinQRCodeResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/get_bot_qrcode?bot_type=${WEIXIN_BOT_TYPE}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`获取二维码失败: ${res.status}`);
  return (await res.json()) as WeixinQRCodeResponse;
}

export async function pollWeixinBotQRStatus(
  qrcode: string,
  baseUrl = WEIXIN_ILINK_BASE_URL,
): Promise<WeixinQRStatusResponse> {
  const url = `${baseUrl.replace(/\/+$/, '')}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'iLink-App-ClientVersion': '1' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`轮询二维码状态失败: ${res.status}`);
    return (await res.json()) as WeixinQRStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function weixinGetUpdates(
  baseUrl: string,
  token: string,
  buf: string,
  timeoutMs = DEFAULT_LONG_POLL_TIMEOUT_MS,
): Promise<WeixinGetUpdatesResp> {
  try {
    return await apiPost<WeixinGetUpdatesResp>(
      baseUrl,
      'ilink/bot/getupdates',
      { get_updates_buf: buf },
      token,
      timeoutMs,
    );
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: buf };
    }
    throw err;
  }
}

export async function weixinSendTextMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken?: string,
): Promise<void> {
  const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const items: WeixinMessageItem[] = text
    ? [{ type: WeixinMessageItemType.TEXT, text_item: { text } }]
    : [];

  await apiPost(
    baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: to,
        client_id: clientId,
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        item_list: items.length ? items : undefined,
        context_token: contextToken,
      } satisfies WeixinMessage,
    },
    token,
  );
}

export async function weixinSendTyping(
  baseUrl: string,
  token: string,
  to: string,
  contextToken?: string,
): Promise<void> {
  await apiPost(
    baseUrl,
    'ilink/bot/sendtyping',
    {
      to_user_id: to,
      context_token: contextToken,
    },
    token,
  );
}

async function weixinGetUploadUrl(
  baseUrl: string,
  token: string,
  body: Record<string, unknown>,
): Promise<WeixinGetUploadUrlResp> {
  return apiPost<WeixinGetUploadUrlResp>(baseUrl, 'ilink/bot/getuploadurl', body, token);
}

async function uploadBufferToWeixinCdn(params: {
  buf: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aeskey: Buffer;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buf, params.aeskey);
  const full = params.uploadFullUrl?.trim();
  const cdnUrl = full
    || (params.uploadParam
      ? buildCdnUploadUrl(params.cdnBaseUrl, params.uploadParam, params.filekey)
      : '');
  if (!cdnUrl) throw new Error('CDN 上传地址缺失');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_UPLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(cdnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errMsg = res.headers.get('x-error-message') ?? (await res.text());
      throw new Error(`CDN 上传失败 ${res.status}: ${errMsg}`);
    }
    const downloadParam = res.headers.get('x-encrypted-param') ?? '';
    if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');
    return downloadParam;
  } finally {
    clearTimeout(timer);
  }
}

function uploadMediaTypeOf(kind: WeixinMediaKind): number {
  if (kind === 'image') return WeixinUploadMediaType.IMAGE;
  if (kind === 'video') return WeixinUploadMediaType.VIDEO;
  if (kind === 'voice') return WeixinUploadMediaType.VOICE;
  return WeixinUploadMediaType.FILE;
}

function messageItemTypeOf(kind: WeixinMediaKind): number {
  if (kind === 'image') return WeixinMessageItemType.IMAGE;
  if (kind === 'video') return WeixinMessageItemType.VIDEO;
  if (kind === 'voice') return WeixinMessageItemType.VOICE;
  return WeixinMessageItemType.FILE;
}

function guessVoiceEncodeType(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.mp3') return 7;
  if (ext === '.amr') return 5;
  if (ext === '.silk' || ext === '.slk') return 6;
  if (ext === '.ogg') return 8;
  if (ext === '.pcm' || ext === '.wav') return 1;
  // 默认按 mp3 试发
  return 7;
}

/**
 * 上传本地文件到微信 CDN 并发送对应媒体消息
 */
export async function weixinSendMediaFile(params: {
  baseUrl: string;
  token: string;
  to: string;
  filePath: string;
  kind: WeixinMediaKind;
  fileName?: string;
  contextToken?: string;
  cdnBaseUrl?: string;
  /** 语音时长（毫秒），可选 */
  playtimeMs?: number;
  /** 语音编码类型，可选；默认按扩展名推断 */
  encodeType?: number;
}): Promise<void> {
  const plaintext = await fs.readFile(params.filePath);
  if (!plaintext.length) throw new Error('文件为空');

  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash('md5').update(plaintext).digest('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString('hex');
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString('hex');

  const uploadResp = await weixinGetUploadUrl(params.baseUrl, params.token, {
    filekey,
    media_type: uploadMediaTypeOf(params.kind),
    to_user_id: params.to,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskeyHex,
  });

  if (uploadResp.ret !== undefined && uploadResp.ret !== 0) {
    throw new Error(
      `getuploadurl 失败: ret=${uploadResp.ret} errmsg=${uploadResp.errmsg ?? ''}`,
    );
  }

  const downloadParam = await uploadBufferToWeixinCdn({
    buf: plaintext,
    uploadFullUrl: uploadResp.upload_full_url,
    uploadParam: uploadResp.upload_param,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl || WEIXIN_CDN_BASE_URL,
    aeskey,
  });

  const cdnMedia = {
    encrypt_query_param: downloadParam,
    // 协议要求：hex 字符串再做 utf8→base64（非 hex decode）
    aes_key: Buffer.from(aeskeyHex, 'utf8').toString('base64'),
    encrypt_type: 1,
  };

  const itemType = messageItemTypeOf(params.kind);
  let item: WeixinMessageItem;
  if (params.kind === 'image') {
    item = {
      type: itemType,
      image_item: {
        media: cdnMedia,
        mid_size: filesize,
        aeskey: aeskeyHex,
      },
    };
  } else if (params.kind === 'video') {
    item = {
      type: itemType,
      video_item: {
        media: cdnMedia,
        video_size: filesize,
      },
    };
  } else if (params.kind === 'voice') {
    item = {
      type: itemType,
      voice_item: {
        media: cdnMedia,
        encode_type: params.encodeType ?? guessVoiceEncodeType(params.filePath),
        playtime: params.playtimeMs,
      },
    };
  } else {
    const name = params.fileName || path.basename(params.filePath);
    item = {
      type: itemType,
      file_item: {
        media: cdnMedia,
        file_name: name,
        len: String(rawsize),
        md5: rawfilemd5,
      },
    };
  }

  const clientId = `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await apiPost(
    params.baseUrl,
    'ilink/bot/sendmessage',
    {
      msg: {
        from_user_id: '',
        to_user_id: params.to,
        client_id: clientId,
        message_type: WeixinMessageType.BOT,
        message_state: WeixinMessageState.FINISH,
        item_list: [item],
        context_token: params.contextToken,
      } satisfies WeixinMessage,
    },
    params.token,
  );
}

function extFromContentType(ct: string | null, fallback: string): string {
  const t = (ct || '').toLowerCase();
  if (t.includes('jpeg') || t.includes('jpg')) return '.jpg';
  if (t.includes('png')) return '.png';
  if (t.includes('gif')) return '.gif';
  if (t.includes('webp')) return '.webp';
  if (t.includes('mp4')) return '.mp4';
  if (t.includes('webm')) return '.webm';
  if (t.includes('mpeg') || t.includes('mp3') || t.includes('audio/mpeg')) return '.mp3';
  if (t.includes('audio/amr') || t.includes('amr')) return '.amr';
  if (t.includes('octet-stream')) return fallback;
  return fallback;
}

/**
 * 下载远程媒体到临时文件；若响应是 JSON（含 url/imgurl 等）则再跟一次
 */
export async function downloadRemoteMediaToTemp(
  url: string,
  destDir: string,
  preferredExt: string,
): Promise<{ filePath: string; contentType: string }> {
  await fs.mkdir(destDir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': 'kakake-weixin-bot/1.0' },
    });
    if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`);
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());

    // 部分接口返回 JSON：{ url / imgurl / video / data }
    if (ct.includes('json') || (buf[0] === 0x7b /* { */)) {
      try {
        const j = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
        const next = String(
          j.url ?? j.imgurl ?? j.image ?? j.video ?? j.data ?? j.src ?? '',
        ).trim();
        if (next && /^https?:\/\//i.test(next)) {
          return downloadRemoteMediaToTemp(next, destDir, preferredExt);
        }
      } catch { /* treat as binary */ }
    }

    const ext = extFromContentType(ct, preferredExt);
    const filePath = path.join(destDir, `wx-media-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    await fs.writeFile(filePath, buf);
    return { filePath, contentType: ct };
  } finally {
    clearTimeout(timer);
  }
}

export function extractWeixinText(msg: WeixinMessage): string {
  const items = msg.item_list;
  if (!items?.length) return '';
  for (const item of items) {
    if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text) {
      const ref = item.ref_msg;
      const text = item.text_item.text;
      if (!ref) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      return parts.length ? `[引用: ${parts.join(' | ')}]\n${text}` : text;
    }
  }
  return '';
}

export function credentialsFromQRConfirm(
  status: WeixinQRStatusResponse,
): WeixinLoginCredentials {
  if (!status.bot_token || !status.ilink_bot_id) {
    throw new Error('登录确认但未返回 token 或 bot_id');
  }
  return {
    token: status.bot_token,
    baseUrl: status.baseurl || WEIXIN_ILINK_BASE_URL,
    accountId: status.ilink_bot_id,
    userId: status.ilink_user_id,
  };
}
