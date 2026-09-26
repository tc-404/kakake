// ---------------------------------------------------------------------------
// 经本地 HTTP 代理的请求工具。
// 背景：X（Twitter）的 x.com / twimg.com 在国内无法直连，而抖音等其他平台直连正常，
// 因此这里单独提供走代理的请求通道，仅 X 解析与 twimg 下载使用，互不影响。
// 零依赖实现：HTTP CONNECT 隧道 + node:https（Node 自带 fetch 不支持代理，故手写）。
//
// 代理地址来源（依次）: 环境变量 X_PROXY_URL / HTTPS_PROXY / HTTP_PROXY，
// 默认 http://127.0.0.1:7897（Clash 系默认混合端口）；设为 off/false/none 可关闭。
// ---------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { Readable } from 'node:stream';

const DEFAULT_PROXY_URL = 'http://127.0.0.1:7897';

export function getProxyUrl(): string | null {
  const raw = (
    process.env.X_PROXY_URL
    || process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || DEFAULT_PROXY_URL
  ).trim();
  if (!raw || /^(off|false|none|direct)$/i.test(raw)) return null;
  return raw;
}

export function proxyConfigured(): boolean {
  return getProxyUrl() !== null;
}

function connectTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: {
        Host: `${host}:${port}`,
        ...(proxy.username || proxy.password
          ? {
              'Proxy-Authorization': `Basic ${Buffer.from(
                `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
              ).toString('base64')}`,
            }
          : {}),
      },
      timeout: timeoutMs,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket as net.Socket);
      else {
        socket.destroy();
        reject(new Error(`代理 CONNECT 失败（HTTP ${res.statusCode}）`));
      }
    });
    req.once('timeout', () => req.destroy(new Error('代理连接超时')));
    req.once('error', reject);
    req.end();
  });
}

export type ProxyFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  /**
   * 逐跳校验跳转目标。不给就保持原样跟随——但用于「代理下载任意用户给的
   * 链接」时**必须**给，否则白名单只挡得住第一跳。
   */
  isAllowedRedirect?: (url: string) => boolean;
};

/**
 * 经代理对 https 目标发起请求，手动跟随重定向，返回 WHATWG Response。
 * 代理未配置/不可用/被拒时抛错，由调用方决定是否直连兜底。
 */
export async function proxyFetch(url: string, init: ProxyFetchInit = {}): Promise<Response> {
  const proxyRaw = getProxyUrl();
  if (!proxyRaw) throw new Error('未配置代理');
  const proxy = new URL(proxyRaw);

  let current = url;
  const maxRedirects = init.maxRedirects ?? 4;

  for (let hop = 0; ; hop++) {
    const target = new URL(current);
    if (target.protocol !== 'https:') throw new Error('代理请求仅支持 https 目标');
    const port = Number(target.port) || 443;
    const timeoutMs = init.timeoutMs ?? 15000;

    const socket = await connectTunnel(proxy, target.hostname, port, timeoutMs);
    try {
      const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const tlsSocket = tls.connect({
          socket,
          servername: target.hostname,
        });
        tlsSocket.once('secureConnect', () => {
          const timer = setTimeout(() => reject(new Error('代理请求超时')), timeoutMs);
          // 注意：agent:false 会让 Node 忽略 per-request createConnection（直连被墙域名），
          // 必须用自定义 Agent 实例并覆盖其 createConnection 才能复用已建立的隧道。
          const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
          agent.createConnection = () => tlsSocket;
          const req = https.request(
            target,
            {
              method: init.method ?? 'GET',
              headers: init.headers ?? {},
              agent,
            },
            (msg) => {
              clearTimeout(timer);
              resolve(msg);
            },
          );
          req.once('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          req.end();
        });
        tlsSocket.once('error', reject);
      });

      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location && hop < maxRedirects) {
        res.destroy();
        const next = new URL(location, target).toString();
        // 白名单必须逐跳校验：只查第一跳等于没查（跳转目标可以是内网地址）
        if (init.isAllowedRedirect && !init.isAllowedRedirect(next)) {
          throw new Error(`跳转目标不在白名单：${new URL(next).hostname}`);
        }
        current = next;
        continue;
      }

      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v == null) continue;
        // 逐跳头 / 长度头交给 Response 自己算
        if (['transfer-encoding', 'content-length', 'connection', 'keep-alive'].includes(k)) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
      const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
      return new Response(status === 204 ? null : body, { status, headers });
    } catch (e) {
      socket.destroy();
      throw e;
    }
  }
}

/** 经代理请求文本，非 2xx 抛错 */
export async function proxyFetchText(url: string, headers: Record<string, string> = {}, timeoutMs = 15000): Promise<string> {
  const res = await proxyFetch(url, { headers, timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 经代理跟随重定向，返回最终 URL（t.co 短链解析用） */
export async function proxyFollowRedirect(url: string, maxHops = 5): Promise<string> {
  let current = url;
  for (let hop = 0; hop < maxHops; hop++) {
    const res = await proxyFetch(current, { maxRedirects: 0, timeoutMs: 15000 });
    const status = res.status;
    const location = res.headers.get('location');
    res.body?.cancel().catch(() => {});
    if ([301, 302, 303, 307, 308].includes(status) && location) {
      current = new URL(location, current).toString();
      continue;
    }
    return current;
  }
  return current;
}
