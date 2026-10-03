import { KOOK_API_BASE_URL, type KookApiEnvelope, type KookBotUser } from './kook.types.js';

export function kookAuthHeader(token: string): string {
  return `Bot ${token.trim()}`;
}

export function describeKookApiError(code: number, message: string): string {
  const text = message || '未知错误';
  const hint = code === 40100 ? '（Token 无效，请检查 KOOK 机器人 Token）'
    : code === 40101 ? '（无权限访问该接口，请检查机器人权限）'
      : '';
  return `KOOK API ${code}: ${text}${hint}`;
}

/** KOOK v3 通用请求：统一解析 envelope，code!=0 抛错 */
export async function kookApiRequest<T = Record<string, unknown>>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown; timeoutMs?: number } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  try {
    const resp = await fetch(`${KOOK_API_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: kookAuthHeader(token),
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: KookApiEnvelope<T>;
    try {
      json = JSON.parse(text) as KookApiEnvelope<T>;
    } catch {
      throw new Error(`KOOK API 响应异常（HTTP ${resp.status}）: ${text.slice(0, 200)}`);
    }
    if (json.code !== 0) {
      throw new Error(describeKookApiError(json.code, json.message));
    }
    return json.data;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`KOOK API 请求超时: ${path}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 获取 WebSocket 网关地址（compress=0：文本帧，无需解压） */
export async function fetchKookGatewayUrl(token: string): Promise<string> {
  const data = await kookApiRequest<{ url?: string }>(token, '/gateway?compress=0');
  const url = String(data.url || '').trim();
  if (!url) throw new Error('KOOK 网关地址为空');
  return url;
}

/** 机器人自身资料（KOOK 路径为 /user/me，注意不是 Discord 风格的 /users/@me） */
export async function fetchKookBotProfile(token: string): Promise<KookBotUser> {
  return kookApiRequest<KookBotUser>(token, '/user/me');
}

/** 发送频道消息（type: 1 文本 / 9 KMarkdown / 10 卡片） */
export async function kookCreateMessage(
  token: string,
  params: {
    type?: number;
    targetId: string;
    content: string;
    quote?: string;
    nonce?: string;
  },
): Promise<{ msgId: string; nonce?: string }> {
  const data = await kookApiRequest<{ msg_id?: string; nonce?: string }>(
    token,
    '/message/create',
    {
      method: 'POST',
      body: {
        type: params.type ?? 1,
        target_id: params.targetId,
        content: params.content,
        ...(params.quote ? { quote: params.quote } : {}),
        ...(params.nonce ? { nonce: params.nonce } : {}),
      },
    },
  );
  return { msgId: String(data.msg_id || ''), nonce: data.nonce };
}

/** 发送私聊消息（target_id 传用户 ID） */
export async function kookCreateDirectMessage(
  token: string,
  params: {
    type?: number;
    targetUserId: string;
    content: string;
    quote?: string;
    nonce?: string;
  },
): Promise<{ msgId: string; nonce?: string }> {
  const data = await kookApiRequest<{ msg_id?: string; nonce?: string }>(
    token,
    '/direct-message/create',
    {
      method: 'POST',
      body: {
        type: params.type ?? 1,
        target_id: params.targetUserId,
        content: params.content,
        ...(params.quote ? { quote: params.quote } : {}),
        ...(params.nonce ? { nonce: params.nonce } : {}),
      },
    },
  );
  return { msgId: String(data.msg_id || ''), nonce: data.nonce };
}

/** 上传媒体资源，返回可直接放进消息内容的 URL */
export async function kookUploadAsset(
  token: string,
  filePath: string,
): Promise<string> {
  const fs = await import('node:fs/promises');
  const fileBuffer = await fs.readFile(filePath);
  const fileName = filePath.split(/[\\/]/).pop() || 'file';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(fileBuffer)]), fileName);
  const resp = await fetch(`${KOOK_API_BASE_URL}/asset/create`, {
    method: 'POST',
    headers: { Authorization: kookAuthHeader(token) },
    body: form,
  });
  const text = await resp.text();
  let json: KookApiEnvelope<{ url?: string }>;
  try {
    json = JSON.parse(text) as KookApiEnvelope<{ url?: string }>;
  } catch {
    throw new Error(`KOOK 资源上传响应异常（HTTP ${resp.status}）: ${text.slice(0, 200)}`);
  }
  if (json.code !== 0 || !json.data?.url) {
    throw new Error(describeKookApiError(json.code, json.message));
  }
  return json.data.url;
}

/** 下载远端媒体到临时文件（供 asset 上传使用） */
export async function downloadKookRemoteMediaToTemp(
  url: string,
  dir: string,
  preferredExt = '.bin',
): Promise<{ filePath: string }> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  await fs.mkdir(dir, { recursive: true });
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`下载失败 HTTP ${resp.status}`);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  const contentType = resp.headers.get('content-type') || '';
  const extFromType = contentType.includes('image/png') ? '.png'
    : contentType.includes('image/jpeg') ? '.jpg'
      : contentType.includes('image/gif') ? '.gif'
        : contentType.includes('video/') ? '.mp4'
          : contentType.includes('audio/') ? '.mp3'
            : '';
  const filePath = path.join(dir, `kook-asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extFromType || preferredExt}`);
  await fs.writeFile(filePath, buffer);
  return { filePath };
}
