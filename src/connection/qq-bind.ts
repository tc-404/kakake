import { randomBytes, createDecipheriv } from 'node:crypto';

/**
 * QQ 开放平台「扫码绑定」协议（q.qq.com/lite/*）。
 *
 * 这条链路不属于机器人 OpenAPI：域名是 q.qq.com 而不是 api.sgroup.qq.com，
 * 信封是 `{retcode,msg,data}` 而不是 `{err_code,message}`，也不需要 access token。
 * 腾讯自己的 SDK `@tencent-connect/qqbot-connector` 内部就是这套流程，但那个包是
 * UNLICENSED、dist 做过混淆、还依赖一个终端二维码渲染器——咔咔珂要整包分发，
 * 不能带这种依赖，所以这里按抓包结果自己实现一份（三个 HTTP 调用而已）。
 *
 * 流程：
 *   1. 本地生成 32 字节 AES-256 密钥（base64），交给 create_bind_task 换 task_id
 *   2. task_id 拼进二维码链接，手机 QQ 扫码后打开「我名下的机器人」授权页
 *   3. 轮询 poll_bind_result，完成后拿 bot_appid + bot_encrypt_secret，
 *      用第 1 步的密钥本地解密出 AppSecret（腾讯不在线路上明文传密钥）
 *
 * 关于「一次扫码能拿几个机器人」：实测线上只回**一个**——授权页（connect.html）里用户
 * 选中的那个。证据：
 *   - 授权页前端 connect.js 里 connectBotToOpenClaw() 调 SelectBindBot({task_id, app_id})
 *     ，app_id 是单值，没有全选/批量字段；
 *   - penguin-harness 源码注释原文 "The wire hands back ONE bot as a bare object"，
 *     数组形态只是为将来的多机器人预留，其服务层也只取 bots[0]；
 *   - hermes-agent / mateclaw / apache-maka 都按单个 bot_appid 解包。
 * 真正能列全量的是授权页里的 ListBots（tRPC 0x9b96），但它在 /http2rpc/gotrpc/auth/ 下、
 * 需要 QQ 登录态，服务端直调实测返回 retcode 4002 "uin not found"，拿不到。
 * 所以这里保留数组兼容：万一哪天官方改成一次回多个，下面不用改就能全接。
 */

const PORTAL = 'https://q.qq.com';
const CREATE_PATH = '/lite/create_bind_task';
const POLL_PATH = '/lite/poll_bind_result';
const QR_PAGE = `${PORTAL}/qqbot/openclaw/connect.html`;
/** 接入方标识，扫码页会显示成「咔咔珂」以外的默认名，不影响绑定 */
const SOURCE = 'kakake';

/** q.qq.com 有 JS 挑战页，用浏览器 UA 才不会被挡 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const CALL_TIMEOUT_MS = 15_000;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type QqBindStatus = 'none' | 'pending' | 'completed' | 'expired';

/** 一个被授权出来的机器人：AppID + 仍处于加密状态的 AppSecret */
export interface QqBoundBot {
  appId: string;
  encryptedSecret: string;
  userOpenid?: string;
}

export interface QqBindPollResult {
  status: QqBindStatus;
  /** 线上目前回单个对象，但腾讯自家客户端会包成数组——多机器人时全收 */
  bots: QqBoundBot[];
}

interface BindResultData {
  status?: number | string;
  bot_appid?: number | string;
  bot_encrypt_secret?: string;
  user_openid?: string;
}

interface Envelope<T> {
  retcode?: number;
  msg?: string;
  data?: T;
}

let portalCookie = '';
let portalCookieAt = 0;
const COOKIE_TTL_MS = 30 * 60 * 1000;

/** 预取 q.qq.com 首页 cookie，避免撞 JS 挑战页 */
async function portalHeaders(): Promise<Record<string, string>> {
  if (!portalCookie || Date.now() - portalCookieAt > COOKIE_TTL_MS) {
    try {
      const res = await fetch(`${PORTAL}/`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const list = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie') ?? ''];
      const jar = list
        .map((s) => String(s).split(';')[0]?.trim() ?? '')
        .filter(Boolean)
        .join('; ');
      if (jar) {
        portalCookie = jar;
        portalCookieAt = Date.now();
      }
    } catch { /* 拿不到也能调，只是可能被挡，失败会在下面如实报出来 */ }
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'User-Agent': UA,
    Referer: `${PORTAL}/`,
  };
  if (portalCookie) headers.Cookie = portalCookie;
  return headers;
}

async function post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
  const headers = await portalHeaders();
  let res: Response;
  try {
    res = await fetch(`${PORTAL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`请求 q.qq.com 失败：${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as Envelope<T> | null;
  if (!body || (body.retcode !== undefined && body.retcode !== 0)) {
    const detail = body?.msg || `HTTP ${res.status}`;
    const code = body?.retcode !== undefined ? `（retcode ${body.retcode}）` : '';
    throw new Error(`q.qq.com 返回失败：${detail}${code}`);
  }
  return body.data as T;
}

function statusOf(raw: unknown): QqBindStatus {
  switch (Number(raw)) {
    case 0: return 'none';
    case 2: return 'completed';
    case 3: return 'expired';
    default: return 'pending';
  }
}

function botsOf(data: BindResultData | BindResultData[] | undefined): QqBoundBot[] {
  const entries = data === undefined ? [] : Array.isArray(data) ? data : [data];
  const bots: QqBoundBot[] = [];
  for (const entry of entries) {
    const appId = entry?.bot_appid;
    const secret = entry?.bot_encrypt_secret;
    if (appId === undefined || appId === '' || typeof secret !== 'string' || secret === '') continue;
    bots.push({
      appId: String(appId),
      encryptedSecret: secret,
      ...(typeof entry?.user_openid === 'string' ? { userOpenid: entry.user_openid } : {}),
    });
  }
  return bots;
}

/** 开一个绑定任务，返回 task_id 与本次的 AES 密钥（密钥只留在内存） */
export async function createBindTask(): Promise<{ taskId: string; key: string }> {
  const key = randomBytes(KEY_BYTES).toString('base64');
  const data = await post<{ task_id?: string }>(CREATE_PATH, { key });
  const taskId = typeof data?.task_id === 'string' ? data.task_id.trim() : '';
  if (!taskId) throw new Error('q.qq.com 未返回绑定任务 ID');
  return { taskId, key };
}

/** 二维码里编码的链接（服务端不会去访问它，由手机 QQ 打开） */
export function bindQrUrl(taskId: string): string {
  return `${QR_PAGE}?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(SOURCE)}&_wv=2`;
}

export async function pollBindResult(taskId: string): Promise<QqBindPollResult> {
  const data = await post<BindResultData | BindResultData[]>(POLL_PATH, { task_id: taskId });
  const first = Array.isArray(data) ? data[0] : data;
  return { status: statusOf(first?.status), bots: botsOf(data) };
}

/**
 * 解密 bot_encrypt_secret。
 * 帧结构是约定的、不自描述：base64 解码后前 12 字节 IV、后 16 字节 GCM tag、中间是密文。
 */
export function decryptBotSecret(keyBase64: string, encryptedBase64: string): string {
  const key = Buffer.from(keyBase64, 'base64');
  const payload = Buffer.from(encryptedBase64, 'base64');
  if (key.length !== KEY_BYTES) throw new Error('绑定密钥不是 32 字节 AES 密钥');
  if (payload.length <= IV_BYTES + TAG_BYTES) throw new Error('加密载荷过短，无法解密');

  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(payload.length - TAG_BYTES);
  const ciphertext = payload.subarray(IV_BYTES, payload.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('AppSecret 解密失败（密钥不匹配或载荷损坏）');
  }
  const secret = plaintext.toString('utf8');
  if (!secret) throw new Error('解密结果为空');
  return secret;
}
