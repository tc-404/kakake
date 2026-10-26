import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type { ConnectionConfig } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import type { OB11ApiRequest, OB11ApiResponse, OB11Event, OneBotRawResult } from './onebot.types.js';
import type { IncomingMessage } from 'node:http';
import { eventBus } from '../event/event-bus.js';
import { logEvent } from '../core/log-store.js';
import { formatOb11Event } from '../core/log-format.js';
import { describeRemoteAddress, isTrustedLocalAddress, remoteAddressOf, tokenlessSourceVerdict } from '../core/net-address.js';
import { globalBlockedMs, recordLoginFailure, sourceBlockedMs } from '../admin/login-throttle.js';
import { inboundGuardEnabled } from '../admin/inbound-guard.js';
import { listenHostReachesBeyondLocalhost } from './onebot-http.shared.js';

/**
 * 单帧上限。ws 默认 100 MiB——单帧即可打爆进程堆，而 OneBot 事件远到不了这个量级。
 * 与 HTTP 上报的 2 MiB 故意不同：WS 帧可能被中间层分包，且图片 base64 更常见，
 * 放宽到 4 MiB 仍远低于任何真实风险阈值，同时避免误伤正常大图。
 */
const MAX_WS_PAYLOAD_BYTES = 4 * 1024 * 1024;

export interface OneBotWsServerOptions {
  connection: ConnectionConfig;
  logger: Logger;
  onClientConnect?: () => void;
  onClientDisconnect?: () => void;
}

import type { OneBotEndpoint } from './onebot-endpoint.js';

/** 恒定时间比较：Access Token 校验不要用 `===` 留下时序差异 */
function safeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * OneBot 反向 WebSocket 服务端
 * 咔咔珂监听端口，等待协议端（WebSocket Client）主动连入
 */
export class OneBotWsServer implements OneBotEndpoint {
  readonly id: string;
  readonly name: string;

  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  /** raw=true 的条目属于接口代理：拿到的完整信封原样回传，不剥 data、不 reject */
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; raw?: boolean }>();

  constructor(private readonly options: OneBotWsServerOptions) {
    this.id = options.connection.id;
    this.name = options.connection.name;
  }

  get isConnected(): boolean {
    return this.client?.readyState === WebSocket.OPEN;
  }

  get listenUrl(): string {
    const { host, port } = this.options.connection;
    const h = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
    return `ws://${h}:${port}`;
  }

  start(): void {
    const { connection, logger } = this.options;
    if (!connection.enable || this.wss) return;

    const host = connection.host || '127.0.0.1';
    const port = connection.port;

    // maxPayload：ws 默认 100 MiB，单帧就能把进程堆打爆（Node OOM 后连同伴随的
    // 其它连接一起没）。OneBot 事件最大也就是带 base64 图片的消息段，4 MiB 足够；
    // 超限的帧 ws 会直接 close(1009)，协议端那侧表现为掉线，可从日志看出原因。
    this.wss = new WebSocketServer({
      host,
      port,
      maxPayload: MAX_WS_PAYLOAD_BYTES,
      // 握手前鉴权（verifyClient 在 HTTP 101 握手完成之前运行）：无 Access Token
      // + 反代/非本机来源一律拒绝，见 verifyToken 与 tokenlessSourceVerdict 的说明。
      // 若把拒绝留到 connection 事件再 ws.close()，握手已成功，协议端视角是
      // 「连上了又被踢」——对公网攻击者仍短暂可达，且复验观感不干净；在握手阶段
      // 拒绝会直接回 401，握手根本不建立，连接入口在鉴权失败前没有任何可达窗口。
      verifyClient: (info, cb) => {
        if (!this.verifyToken(info.req)) {
          const from = remoteAddressOf(info.req);
          if (inboundGuardEnabled() && !isTrustedLocalAddress(from)) {
            recordLoginFailure(from, 'Authorization 密钥');
          }
          logger.warn(
            `[安全] 反向 WS 握手被拒绝（${connection.name}）：`
            + 'Access Token 不匹配或来源不可信',
          );
          cb(false, 401, 'Unauthorized');
          return;
        }
        cb(true);
      },
    });

    this.wss.on('listening', () => {
      logger.info(`等待 NapCat 连入: ${this.listenUrl}`);
      // 无 Access Token + 监听地址超出本机：任何人都能连上来伪造事件驱动插件，
      // 这里显式告警，避免用户在不自知的情况下把 bot 控制权暴露出去。
      if (!connection.accessToken && listenHostReachesBeyondLocalhost(host)) {
        logger.warn(
          `[安全] ${connection.name} 未配置 Access Token 且监听 ${host}:${port}，`
          + '仅本机/内网来源会被接受；若该端口可从公网访问，请在连接设置里填写 Access Token',
        );
      }
    });

    this.wss.on('connection', (ws, req) => {
      if (!this.verifyToken(req)) {
        logger.warn(
          `连接被拒绝：Access Token 不匹配（来源 ${describeRemoteAddress(remoteAddressOf(req))}）`,
        );
        ws.close(1008, 'Unauthorized');
        return;
      }

      if (this.client) {
        logger.info('新连接接入，关闭旧连接');
        this.client.close();
      }

      this.client = ws;
      logger.info(`NapCat 已连入: ${connection.name}`);

      ws.on('message', (raw) => {
        try {
          const data = JSON.parse(raw.toString()) as OB11Event & OB11ApiResponse;
          this.handleIncoming(data);
        } catch (e) {
          logger.warn('无法解析消息', e);
        }
      });

      ws.on('close', () => {
        if (this.client === ws) {
          this.client = null;
          logger.warn(`NapCat 断开: ${connection.name}`);
          this.rejectAllPending('NapCat 已断开');
          this.options.onClientDisconnect?.();
        }
      });

      ws.on('error', (err) => {
        logger.error(`连接错误: ${err.message}`);
      });

      this.options.onClientConnect?.();
    });

    this.wss.on('error', (err) => {
      logger.error(`监听失败 ${host}:${port}: ${err.message}`);
    });
  }

  stop(): void {
    this.client?.close();
    this.client = null;
    this.wss?.close();
    this.wss = null;
    this.rejectAllPending('服务已停止');
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnected || !this.client) {
      throw new Error('NapCat 未连接');
    }

    const echo = randomUUID();
    const payload: OB11ApiRequest = { action, params, echo };

    return new Promise((resolve, reject) => {
      const timeoutMs = configService.getConfig().apiTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`API 超时: ${action}`));
      }, timeoutMs);

      this.pending.set(echo, { resolve, reject, timer });
      this.client!.send(JSON.stringify(payload));
    });
  }

  async callActionRaw(
    action: string,
    params?: Record<string, unknown>,
    method?: 'GET' | 'POST',
  ): Promise<OneBotRawResult> {
    // WebSocket 通道没有 HTTP 方法之分，参数仅为对齐 OneBotEndpoint 签名
    void method;
    if (!this.isConnected || !this.client) {
      return { ok: false, error: 'NapCat 未连接（反向 WS）' };
    }
    const echo = randomUUID();
    const payload: OB11ApiRequest = { action, params, echo };
    // 超时 / 断连都走 resolve 而不是 reject —— 接口代理要求「超时即超时」是一种结果
    return new Promise<OneBotRawResult>((resolve) => {
      const timeoutMs = configService.getConfig().apiTimeoutMs;
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        resolve({ ok: false, timedOut: true, error: `API 超时: ${action}` });
      }, timeoutMs);
      this.pending.set(echo, {
        resolve: (v: unknown) => resolve({ ok: true, envelope: v }),
        reject: (e: Error) => resolve({ ok: false, error: e.message }),
        timer,
        raw: true,
      });
      this.client!.send(JSON.stringify(payload));
    });
  }

  /**
   * 反向 WS 接入鉴权。
   *
   * 未配置 Access Token 时**只接受本机 / 内网来源**——与 HTTP 上报同一口径
   * （见 onebot-http.shared.ts 的 checkHttpEventAuth）：反向 WS 端口常被绑到
   * 0.0.0.0，若无条件放行，公网上任何人都能连入伪造 OneBot 事件驱动插件
   *（等于冒充协议端向 bot 下指令），还能用 echo 伪造 API 响应。
   */
  private verifyToken(req: IncomingMessage): boolean {
    const from = remoteAddressOf(req);
    const guard = inboundGuardEnabled();
    const external = !isTrustedLocalAddress(from);
    const token = this.options.connection.accessToken;
    if (!token) {
      if (guard && external && sourceBlockedMs(from) > 0) return false;
      if (guard && globalBlockedMs() > 0) return false;
      return tokenlessSourceVerdict(req.headers, from).ok;
    }

    if (guard && external && sourceBlockedMs(from) > 0) return false;

    const auth = req.headers.authorization;
    if (auth && (safeEqualStr(auth, token) || safeEqualStr(auth, `Bearer ${token}`))) return true;

    const url = new URL(req.url ?? '/', 'http://localhost');
    const q = url.searchParams.get('access_token') ?? url.searchParams.get('accessToken');
    return typeof q === 'string' && safeEqualStr(q, token);
  }

  dropTokenlessClient(): void {
    if (this.options.connection.accessToken) return;
    const client = this.client;
    if (!client) return;
    this.client = null;
    try {
      client.close(1008, 'Unauthorized');
    } catch {}
  }

  private handleIncoming(data: OB11Event & OB11ApiResponse): void {
    if (data.echo && this.pending.has(data.echo)) {
      const p = this.pending.get(data.echo)!;
      clearTimeout(p.timer);
      this.pending.delete(data.echo);
      // raw 调用（接口代理）：整个信封原样交回，绝不剥 data、绝不 reject
      if (p.raw) {
        p.resolve(data);
        return;
      }
      if (data.status === 'ok') {
        p.resolve(data.data);
      } else {
        p.reject(new Error(data.message ?? `API 失败 retcode=${data.retcode}`));
      }
      return;
    }

    if (data.post_type) {
      const formatted = formatOb11Event(data);
      const isHeartbeat = data.post_type === 'meta_event'
        && (data as { meta_event_type?: string }).meta_event_type === 'heartbeat';
      logEvent(
        `[上报:${this.name}]`,
        formatted.message,
        {
          detail: formatted.detail,
          raw: formatted.raw,
          level: isHeartbeat ? 'debug' : 'info',
        },
      );
      void eventBus.emit('onebot/event', { connectionId: this.id, event: data });
      void eventBus.emitHierarchy(`onebot/${data.post_type}`, { connectionId: this.id, event: data });
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(echo);
    }
  }
}
