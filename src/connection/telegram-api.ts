/**
 * Telegram Bot API —— HTTP 客户端层
 *
 * 覆盖内容：
 * - 官方服务器 / 本地 Bot API Server / 测试环境三种请求目标
 * - JSON 与 multipart/form-data（InputFile：Buffer、本地路径、file: URI、attach:// 引用）
 * - 429 retry_after 自动重试、5xx/网络错误指数退避、migrate_to_chat_id 透传
 * - 出站限频：单聊 ~1 条/秒、群组 20 条/分钟、全局 ~30 条/秒
 * - 可选 HTTP 代理（CONNECT 隧道，零第三方依赖，复用 Node 内置 tls/https）
 * - getMe / getUpdates / setWebhook / deleteWebhook / getWebhookInfo / getFile / logOut / close
 *
 * 不依赖 grammY / Telegraf 等框架：Bot API 本身就是 HTTP，自己实现才能把
 * 连接生命周期、账号隔离、事件注入与现有 ConnectionManager 严丝合缝地接上。
 */

import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import type { Logger } from '../core/logger.js';
import {
  buildTelegramApiUrl,
  normalizeTelegramApiBase,
  TELEGRAM_DEFAULT_API_BASE,
  TELEGRAM_LIMITS,
  type TelegramApiResponse,
  type TelegramBotProfile,
  type TelegramWebhookInfo,
} from './telegram.types.js';

export class TelegramApiError extends Error {
  readonly method: string;
  readonly errorCode: number;
  readonly description: string;
  readonly retryAfter: number;
  readonly migrateToChatId?: number | string;

  constructor(method: string, message: string, extra: {
    errorCode?: number;
    description?: string;
    retryAfter?: number;
    migrateToChatId?: number | string;
  } = {}) {
    super(message);
    this.name = 'TelegramApiError';
    this.method = method;
    this.errorCode = extra.errorCode ?? 0;
    this.description = extra.description ?? message;
    this.retryAfter = extra.retryAfter ?? 0;
    this.migrateToChatId = extra.migrateToChatId;
  }
}

export interface TelegramApiClientOptions {
  token: string;
  apiBase?: string;
  testEnv?: boolean;
  /** 显式代理；不填时读 X_PROXY_URL / HTTPS_PROXY / HTTP_PROXY，'off' 关闭 */
  proxyUrl?: string;
  timeoutMs?: number;
  logger?: Logger;
  /** 出站限频开关（默认开启；本地 Bot API Server 可自行关闭） */
  rateLimit?: boolean;
}

type ParamValue = unknown;
type Params = Record<string, ParamValue>;

interface SerializedBody {
  contentType: string;
  body: Buffer;
}

/**
 * 独立/测试场景下的默认日志器。
 * 刻意不静态 import core/logger：那条链会绕回 storage/atomic-file 再引用
 * rootLogger，在动态 import（插件、单测、工具脚本）时触发 TDZ
 * "Cannot access 'rootLogger' before initialization"。传 logger 进来即可用宿主日志。
 */
export function createTelegramFallbackLogger(prefix = ''): Logger {
  const build = (p: string): Logger => ({
    debug: (...args: unknown[]) => console.debug(p, ...args),
    info: (...args: unknown[]) => console.log(p, ...args),
    warn: (...args: unknown[]) => console.warn(p, ...args),
    error: (...args: unknown[]) => console.error(p, ...args),
    child: (s: string) => build(`${p}${s}`),
  } as unknown as Logger);
  return build(prefix);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 环境变量大小写兼容（Windows 不区分、Linux 区分） */
function envAnyCase(name: string): string | undefined {
  return process.env[name] || process.env[name.toLowerCase()] || process.env[name.toUpperCase()] || undefined;
}

function resolveProxyUrl(explicit?: string): string | null {
  const raw = String(explicit ?? envAnyCase('X_PROXY_URL') ?? envAnyCase('HTTPS_PROXY') ?? envAnyCase('HTTP_PROXY') ?? '').trim();
  if (!raw || /^(off|false|none|direct)$/i.test(raw)) return null;
  return raw;
}

export function isLocalBotApiServer(apiBase?: string): boolean {
  const base = normalizeTelegramApiBase(apiBase);
  if (base === TELEGRAM_DEFAULT_API_BASE) return false;
  try {
    const u = new URL(base);
    return !/(^|\.)api\.telegram\.org$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** 判断某个参数值是不是「本地文件」，需要以 multipart 上传 */
function fileCandidate(value: ParamValue): { data: Buffer; filename: string; contentType: string } | null | Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  if (Buffer.isBuffer(value)) return { data: value, filename: 'file.bin', contentType: 'application/octet-stream' };
  if (value instanceof Uint8Array) return { data: Buffer.from(value), filename: 'file.bin', contentType: 'application/octet-stream' };
  if (value && typeof value === 'object' && 'file' in (value as Record<string, unknown>)) {
    const v = value as Record<string, unknown>;
    const inner = v.file;
    if (Buffer.isBuffer(inner) || inner instanceof Uint8Array) {
      const data = Buffer.isBuffer(inner) ? inner : Buffer.from(inner);
      return {
        data,
        filename: String(v.filename || v.file_name || 'file.bin'),
        contentType: String(v.contentType || v.mime_type || 'application/octet-stream'),
      };
    }
    if (typeof inner === 'string') return readLocalFile(inner, String(v.filename || ''));
    return null;
  }
  if (typeof value === 'string') {
    if (/^(?:data:|attach:|https?:\/\/)/i.test(value)) return null;
    const path = value.startsWith('file:') ? decodeURIComponent(new URL(value).pathname.replace(/^\/([A-Za-z]):/, '$1:')) : value;
    if (/^(?:\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/.test(path)) return readLocalFile(path);
  }
  return null;
}

async function readLocalFile(path: string, filename?: string): Promise<{ data: Buffer; filename: string; contentType: string } | null> {
  try {
    const data = await fs.readFile(path);
    const name = filename || path.split(/[\\/]/).pop() || 'file.bin';
    return { data, filename: name, contentType: guessMime(name) };
  } catch {
    // 不是可读文件就按普通字符串参数处理（可能是 file_id 或 Windows 路径写错）
    return null;
  }
}

function guessMime(name: string): string {
  const ext = name.toLowerCase().split('.').pop() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg',
    wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', json: 'application/json',
    pem: 'application/x-pem-file',
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * 参数序列化：JSON 或 multipart。
 * 支持官方 `attach://<name>` 语法（sendMediaGroup / editMessageMedia 的 InputMedia）：
 * 把 `params['<name>']` 以同名 multipart 字段上传，原值保持 `attach://<name>`。
 */
async function serialize(method: string, params: Params): Promise<SerializedBody> {
  const resolvedFiles = new Map<string, { data: Buffer; filename: string; contentType: string }>();
  const flat: Params = { ...params };

  for (const [key, value] of Object.entries(params)) {
    const candidate = await fileCandidate(value);
    if (candidate) resolvedFiles.set(key, candidate);
  }
  // attach:// 引用的文件参数（约定的键名：<name> 或 _<name>）
  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== 'string' || !/^attach:\/\//i.test(value)) continue;
    const name = value.replace(/^attach:\/\//i, '').trim();
    const holder = params[name] ?? params[`_${name}`];
    const candidate = await fileCandidate(holder);
    if (candidate) {
      resolvedFiles.set(name, candidate);
      delete flat[name];
      delete flat[`_${name}`];
    }
  }

  if (resolvedFiles.size === 0) {
    const cleaned: Params = {};
    for (const [key, value] of Object.entries(flat)) {
      if (value === undefined || value === null) continue;
      // 内部辅助键不下发
      if (key.startsWith('__')) continue;
      cleaned[key] = value;
    }
    return { contentType: 'application/json; charset=utf-8', body: Buffer.from(JSON.stringify(cleaned)) };
  }

  const boundary = `----kakakeTG${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [key, value] of Object.entries(flat)) {
    if (value === undefined || value === null || key.startsWith('__')) continue;
    if (resolvedFiles.has(key)) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${text}\r\n`));
  }
  for (const [key, file] of resolvedFiles.entries()) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.filename.replace(/[\r\n"]/g, '_')}"\r\n`
      + `Content-Type: ${file.contentType}\r\n\r\n`,
    ));
    chunks.push(file.data);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  void method;
  return { contentType: `multipart/form-data; boundary=${boundary}`, body: Buffer.concat(chunks) };
}

/** 出站限频：按 chat_id 与全局分别排队，避免插件狂发把 token 打成 429 */
class RateLimiter {
  private readonly nextPerChat = new Map<string, number>();
  private readonly groupWindow = new Map<string, { start: number; count: number }>();
  private globalWindow = { start: 0, count: 0 };

  constructor(private readonly enabled: boolean) {}

  async acquire(action: string, params: Params): Promise<void> {
    if (!this.enabled) return;
    if (!/^send|^edit|^copy|^forward|^answer/i.test(action)) return;
    const chatId = String(params.chat_id ?? params.__chat_id ?? '');
    const isGroup = /^-100|^-?\d{6,}$/.test(chatId) && !chatId.startsWith('@');
    // 官方：单聊 ~1 条/秒、群组 20 条/分钟、广播 ~30 条/秒
    for (let attempt = 0; attempt < 8; attempt++) {
      const now = Date.now();
      let wait = 0;
      if (this.globalWindow.start === 0 || now - this.globalWindow.start >= 1000) {
        this.globalWindow = { start: now, count: 0 };
      }
      if (this.globalWindow.count >= TELEGRAM_LIMITS.broadcastMessagesPerSecond) {
        wait = Math.max(wait, 1000 - (now - this.globalWindow.start));
      }
      if (chatId) {
        const next = this.nextPerChat.get(chatId) ?? 0;
        if (now < next) wait = Math.max(wait, next - now);
      }
      if (isGroup) {
        const win = this.groupWindow.get(chatId) ?? { start: now, count: 0 };
        if (now - win.start >= 60_000) { win.start = now; win.count = 0; }
        if (win.count >= TELEGRAM_LIMITS.groupMessagesPerMinute) {
          wait = Math.max(wait, 60_000 - (now - win.start));
        }
        this.groupWindow.set(chatId, win);
      }
      if (wait <= 0) {
        this.globalWindow.count += 1;
        if (chatId) this.nextPerChat.set(chatId, now + TELEGRAM_LIMITS.perChatMessageIntervalMs);
        if (isGroup) {
          const win = this.groupWindow.get(chatId)!;
          win.count += 1;
        }
        // 简单清理，防 Map 无限增长
        if (this.nextPerChat.size > 4096) {
          for (const [k, v] of this.nextPerChat) if (v < now) this.nextPerChat.delete(k);
        }
        return;
      }
      await sleep(Math.min(wait, 60_000));
    }
  }
}

/** 通过 HTTP CONNECT 代理发一次请求（fetch 不支持代理，只能手写隧道） */
async function postViaProxy(
  proxyRaw: string,
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const proxy = new URL(proxyRaw);
  const target = new URL(url);
  const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: {
        Host: `${target.hostname}:${port}`,
        ...(proxy.username || proxy.password
          ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` }
          : {}),
      },
      timeout: timeoutMs,
    });
    req.once('connect', (res, s) => {
      if (res.statusCode === 200) resolve(s as net.Socket);
      else { s.destroy(); reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`)); }
    });
    req.once('timeout', () => req.destroy(new Error('代理连接超时')));
    req.once('error', reject);
    req.end();
  });

  try {
    return await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const tlsSocket = tls.connect({ socket, servername: target.hostname });
      tlsSocket.once('secureConnect', () => {
        const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
        agent.createConnection = () => tlsSocket;
        const timer = setTimeout(() => reject(new Error('Telegram API 请求超时')), timeoutMs);
        const req = https.request(target, {
          method: 'POST',
          headers: { ...headers, 'Content-Length': String(body.length) },
          agent,
        }, (res) => {
          clearTimeout(timer);
          const parts: Buffer[] = [];
          res.on('data', (chunk: Buffer) => parts.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(parts).toString('utf-8') }));
        });
        req.once('error', (e) => { clearTimeout(timer); reject(e); });
        req.end(body);
      });
      tlsSocket.once('error', reject);
    });
  } finally {
    socket.destroy();
  }
}

export class TelegramApiClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly testEnv: boolean;
  private readonly proxyUrl: string | null;
  private readonly timeoutMs: number;
  private readonly logger: Logger;
  private readonly limiter: RateLimiter;
  private readonly localServer: boolean;

  constructor(options: TelegramApiClientOptions) {
    this.token = String(options.token || '').trim();
    this.apiBase = normalizeTelegramApiBase(options.apiBase);
    this.testEnv = options.testEnv === true;
    this.proxyUrl = resolveProxyUrl(options.proxyUrl);
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.logger = options.logger ?? createTelegramFallbackLogger('[TelegramAPI] ');
    this.limiter = new RateLimiter(options.rateLimit !== false);
    this.localServer = isLocalBotApiServer(options.apiBase);
  }

  get isLocalServer(): boolean { return this.localServer; }
  get base(): string { return this.apiBase; }
  get usesProxy(): boolean { return this.proxyUrl !== null; }
  get usesTestEnv(): boolean { return this.testEnv; }

  private url(method: string): string {
    return buildTelegramApiUrl(this.apiBase, this.token, method, this.testEnv);
  }

  /** 通用方法调用：带 429 / 网络错误重试 */
  async call<T = unknown>(method: string, params: Params = {}, retry = 0): Promise<T> {
    if (!this.token) throw new TelegramApiError(method, '未配置 Bot Token');
    await this.limiter.acquire(method, params);
    const { contentType, body } = await serialize(method, params);
    const url = this.url(method);
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept': 'application/json',
      'User-Agent': 'kakake-telegram-adapter/1.0',
    };
    const externalSignal = params.__signal instanceof AbortSignal ? params.__signal : undefined;
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const fetchSignal = externalSignal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;

    let status = 0;
    let text = '';
    try {
      if (this.proxyUrl && url.startsWith('https://')) {
        const res = await postViaProxy(this.proxyUrl, url, headers, body, this.timeoutMs);
        status = res.status;
        text = res.text;
      } else {
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body,
          signal: fetchSignal,
        });
        status = res.status;
        text = await res.text();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (retry < 3) {
        await sleep(Math.min(1000 * 2 ** retry, 8000));
        return this.call<T>(method, params, retry + 1);
      }
      throw new TelegramApiError(method, `网络请求失败：${msg}`);
    }

    let json: TelegramApiResponse<T>;
    try {
      json = JSON.parse(text) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(method, `HTTP ${status} 返回非 JSON：${text.slice(0, 200)}`, { errorCode: status });
    }

    if (!json.ok) {
      const retryAfter = Number(json.parameters?.retry_after ?? 0);
      const err = new TelegramApiError(
        method,
        `Bot API ${method} 失败：${json.description || `HTTP ${status}`}${json.error_code ? ` (${json.error_code})` : ''}`,
        {
          errorCode: json.error_code ?? status,
          description: json.description,
          retryAfter,
          migrateToChatId: json.parameters?.migrate_to_chat_id as number | string | undefined,
        },
      );
      // 429：按官方给的 retry_after 等待后重试；5xx：指数退避重试
      const retryable = status === 429 || (status >= 500 && status < 600) || json.error_code === 429;
      if (retryable && retry < 3) {
        const wait = retryAfter > 0 ? retryAfter * 1000 + 200 : Math.min(1000 * 2 ** retry, 8000);
        this.logger.warn(`${err.message}，${Math.round(wait)}ms 后重试（${retry + 1}/3）`);
        await sleep(wait);
        return this.call<T>(method, params, retry + 1);
      }
      throw err;
    }
    return json.result as T;
  }

  // ── 常用方法（保持与官方同名，插件可直接 actions.call('方法名', 参数)）──

  getMe(): Promise<TelegramBotProfile> {
    return this.call<TelegramBotProfile>('getMe');
  }

  getUpdates(params: {
    offset?: number;
    limit?: number;
    timeout?: number;
    allowed_updates?: string[];
    /** 内部：stop() 时中止挂起的长轮询请求 */
    __signal?: AbortSignal;
  }): Promise<unknown[]> {
    return this.call<unknown[]>('getUpdates', params as Params);
  }

  getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.call<TelegramWebhookInfo>('getWebhookInfo');
  }

  setWebhook(params: Record<string, unknown>): Promise<boolean> {
    return this.call<boolean>('setWebhook', params);
  }

  deleteWebhook(dropPendingUpdates = false): Promise<boolean> {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  logOut(): Promise<boolean> { return this.call<boolean>('logOut'); }
  close(): Promise<boolean> { return this.call<boolean>('close'); }

  getFile(fileId: string): Promise<{ file_id: string; file_unique_id: string; file_size?: number; file_path?: string }> {
    return this.call('getFile', { file_id: fileId });
  }

  /**
   * 下载文件：本地 Bot API Server 的 file_path 是绝对路径，直接读；
   * 官方服务器则拼 `${base}/file/bot<token>/<file_path>`。
   */
  async downloadFile(fileId: string): Promise<Buffer> {
    const info = await this.getFile(fileId);
    if (!info.file_path) throw new TelegramApiError('getFile', 'getFile 未返回 file_path');
    if (info.file_path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(info.file_path)) {
      return fs.readFile(info.file_path);
    }
    const url = `${this.apiBase}/file/bot${this.token}${this.testEnv ? '/test' : ''}/${info.file_path}`;
    const res = this.proxyUrl && url.startsWith('https://')
      ? await postViaProxyGet(this.proxyUrl, url, this.timeoutMs)
      : await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!('ok' in res) || !res.ok) throw new TelegramApiError('downloadFile', `下载文件失败：HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /** 供 webhook 自签证书：把 PEM 路径转成 multipart 参数值 */
  static certificateParam(path: string): Record<string, unknown> {
    return { file: path, filename: path.split(/[\\/]/).pop() || 'cert.pem', contentType: 'application/x-pem-file' };
  }
}

/** 代理下的 GET（文件下载用）：复用 CONNECT 隧道 */
async function postViaProxyGet(proxyRaw: string, url: string, timeoutMs: number): Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }> {
  const proxy = new URL(proxyRaw);
  const target = new URL(url);
  const port = Number(target.port) || 443;
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      headers: { Host: `${target.hostname}:${port}` },
      timeout: timeoutMs,
    });
    req.once('connect', (res, s) => {
      if (res.statusCode === 200) resolve(s as net.Socket);
      else { s.destroy(); reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`)); }
    });
    req.once('timeout', () => req.destroy(new Error('代理连接超时')));
    req.once('error', reject);
    req.end();
  });
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({ socket, servername: target.hostname });
    tlsSocket.once('secureConnect', () => {
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = () => tlsSocket;
      const req = https.request(target, { method: 'GET', agent }, (res) => {
        const parts: Buffer[] = [];
        res.on('data', (c: Buffer) => parts.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(parts);
          resolve({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          });
        });
      });
      req.once('error', reject);
      req.end();
    });
    tlsSocket.once('error', reject);
  });
}
