import WebSocket from 'ws';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { eventBus } from '../event/event-bus.js';
import { rootLogger } from '../core/logger.js';
import { logAction } from '../core/log-store.js';
import { KOOK_SIGNAL, KOOK_MSG_TYPE, type KookBotUser, type KookEvent } from './kook.types.js';
import {
  downloadKookRemoteMediaToTemp,
  fetchKookBotProfile,
  fetchKookGatewayUrl,
  kookApiRequest,
  kookCreateDirectMessage,
  kookCreateMessage,
  kookUploadAsset,
} from './kook-api.js';

const WS_HANDSHAKE_TIMEOUT_MS = 20_000;
/** 心跳后 pong 宽限窗口：超时视为半开连接，销毁重连 */
const PONG_TIMEOUT_MS = 6_000;
/** 心跳提前量：文档建议实际间隔比服务器下发少 0~5 秒随机 */
const HEARTBEAT_JITTER_MS = 5_000;
/** 服务端发 s=5 重连信令后，延迟再连 */
const SIGNAL_RECONNECT_DELAY_MS = 1_000;

export interface KookReconnectStatus {
  reconnecting: boolean;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  abandoned: boolean;
}

export interface KookGatewayEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  getBotUser(): KookBotUser | null;
  /** WS 网关出站连接的重连状态 */
  getReconnectStatus(): KookReconnectStatus;
}

export interface KookGatewayClientOptions {
  onReady?: () => void;
  onDisconnect?: () => void;
  /** 首次拿到机器人资料（或资料变化）时回调，用于持久化 */
  onProfileUpdated?: () => void;
}

interface KookGatewayFrame {
  s?: number;
  sn?: number;
  d?: {
    code?: number;
    session_id?: string;
    heartbeat_interval?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * KOOK 机器人 Gateway WebSocket 客户端
 * - 网关事件 → eventBus `kook/event`
 * - callAction: send_text / send_kmarkdown / send_card / send_private_msg / send_image 等
 * - 断线优先 resume（session_id + sn），失败转全新会话
 */
export class KookGatewayClient implements KookGatewayEndpoint {
  readonly id: string;
  readonly name: string;
  private running = false;
  private connected = false;
  private ws: WebSocket | null = null;
  private lastSn = 0;
  private sessionId = '';
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnecting = false;
  private attempts = 0;
  private abandoned = false;
  private botUser: KookBotUser | null = null;
  private profileFetchFailed = false;
  private lastResumeAttempt = false;
  private readonly logger: Logger;
  private readonly connection: ConnectionConfig;
  private readonly hooks: KookGatewayClientOptions;

  constructor(connection: ConnectionConfig, hooks: KookGatewayClientOptions = {}) {
    this.connection = connection;
    this.hooks = hooks;
    this.id = connection.id;
    this.name = connection.name;
    this.logger = rootLogger.child(`[KOOK:${connection.name}] `);
  }

  get isConnected(): boolean {
    return this.connected && this.running;
  }

  getBotUser(): KookBotUser | null {
    return this.botUser;
  }

  getReconnectStatus(): KookReconnectStatus {
    return {
      reconnecting: this.reconnecting,
      attempts: this.attempts,
      maxAttempts: this.connection.reconnectMaxAttempts ?? 15,
      intervalMs: this.connection.reconnectIntervalMs ?? 5000,
      abandoned: this.abandoned,
    };
  }

  private get token(): string {
    return String(this.connection.kookToken || '').trim();
  }

  start(): void {
    if (this.running) return;
    if (!this.token) {
      this.logger.warn('未配置 Token，无法连接 KOOK');
      return;
    }
    this.running = true;
    this.attempts = 0;
    this.abandoned = false;
    this.logger.info('启动 KOOK 网关连接');
    void this.connect(false);
  }

  stop(): void {
    if (!this.running && !this.ws) return;
    this.running = false;
    this.clearTimers();
    const wasConnected = this.connected;
    this.connected = false;
    try {
      this.ws?.close(1000, 'stop');
    } catch { /* ignore */ }
    this.ws = null;
    if (wasConnected) this.hooks.onDisconnect?.();
    this.logger.info('已停止');
  }

  /** 手动重连（重置尝试计数与 abandoned 状态） */
  resetAndReconnect(): void {
    if (!this.running) {
      this.start();
      return;
    }
    this.clearTimers();
    this.attempts = 0;
    this.abandoned = false;
    this.reconnecting = false;
    try {
      this.ws?.close(1000, 'manual reconnect');
    } catch { /* ignore */ }
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) { clearTimeout(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private scheduleReconnect(reason: string, allowResume: boolean): void {
    if (!this.running) return;
    this.reconnecting = true;
    this.attempts += 1;
    const max = this.connection.reconnectMaxAttempts ?? 15;
    const interval = this.connection.reconnectIntervalMs ?? 5000;
    if (max > 0 && this.attempts > max) {
      this.abandoned = true;
      this.reconnecting = false;
      this.logger.error(`重连放弃（已尝试 ${max} 次）：${reason}`);
      return;
    }
    this.logger.warn(`将在 ${interval}ms 后重连（第 ${this.attempts}/${max <= 0 ? '∞' : max} 次）：${reason}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(allowResume && !!this.sessionId && this.lastSn > 0);
    }, interval);
  }

  private async connect(resume: boolean): Promise<void> {
    if (!this.running || !this.token) return;
    this.clearTimers();

    let url: string;
    try {
      url = await fetchKookGatewayUrl(this.token);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`获取网关地址失败: ${msg}`);
      this.scheduleReconnect(`获取网关地址失败: ${msg}`, false);
      return;
    }

    if (resume && this.sessionId) {
      url += `${url.includes('?') ? '&' : '?'}resume=1&sn=${this.lastSn}&session_id=${encodeURIComponent(this.sessionId)}`;
      this.logger.info(`resume 连接（session=${this.sessionId} sn=${this.lastSn}）`);
      this.lastResumeAttempt = true;
    } else {
      this.lastResumeAttempt = false;
    }

    try {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.on('open', () => {
        this.helloTimer = setTimeout(() => {
          this.logger.error('握手超时：未在时限内收到 hello');
          try { ws.close(4000, 'hello timeout'); } catch { /* ignore */ }
        }, WS_HANDSHAKE_TIMEOUT_MS);
      });
      ws.on('message', (raw) => this.handleFrame(String(raw)));
      ws.on('error', (err) => {
        this.logger.error(`WebSocket 错误: ${err.message}`);
      });
      ws.on('close', (code, reason) => {
        const wasConnected = this.connected;
        this.connected = false;
        this.clearTimers();
        if (this.ws === ws) this.ws = null;
        if (!this.running) return;
        if (wasConnected) this.hooks.onDisconnect?.();
        this.scheduleReconnect(`连接断开 code=${code} ${String(reason || '').trim()}`.trim(), code !== 1000);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`建立 WebSocket 失败: ${msg}`);
      this.scheduleReconnect(`建立连接失败: ${msg}`, false);
    }
  }

  private handleFrame(raw: string): void {
    let frame: KookGatewayFrame;
    try {
      frame = JSON.parse(raw) as KookGatewayFrame;
    } catch {
      this.logger.warn('收到非 JSON 帧，忽略');
      return;
    }
    const s = frame.s ?? -1;

    if (s === KOOK_SIGNAL.HELLO) {
      if (this.helloTimer) { clearTimeout(this.helloTimer); this.helloTimer = null; }
      const code = Number(frame.d?.code ?? 0);
      if (code !== 0) {
        // 40101/40102/40103 Token 无效等；40106~40108 resume 失败 → 转全新会话
        this.logger.error(`握手失败 code=${code}`);
        if (code >= 40101 && code <= 40103) {
          this.logger.error('Token 无效：请检查 KOOK 机器人 Token 后重试');
          this.running = false;
          return;
        }
        this.scheduleReconnect(`握手 code=${code}`, false);
        return;
      }
      const wasResumed = this.lastResumeAttempt;
      this.sessionId = String(frame.d?.session_id || '');
      const wasConnected = this.connected;
      this.connected = true;
      this.reconnecting = false;
      this.attempts = 0;
      this.abandoned = false;
      if (!wasConnected) this.hooks.onReady?.();
      this.logger.info(wasResumed ? '会话已恢复' : '已连接 KOOK 网关');
      this.startHeartbeat(Number(frame.d?.heartbeat_interval) || 30_000);
      void this.ensureBotProfile();
      return;
    }

    if (s === KOOK_SIGNAL.PONG) {
      if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
      return;
    }

    if (s === KOOK_SIGNAL.EVENT) {
      if (Number.isFinite(frame.sn)) this.lastSn = Number(frame.sn);
      void this.dispatchEvent(frame.d as KookEvent | undefined);
      return;
    }

    if (s === KOOK_SIGNAL.RECONNECT) {
      this.logger.warn('服务端要求重连（丢弃会话）');
      this.sessionId = '';
      this.lastSn = 0;
      try { this.ws?.close(1000, 'server reconnect signal'); } catch { /* ignore */ }
      return;
    }

    if (s === KOOK_SIGNAL.RESUME_ACK) {
      const code = Number(frame.d?.code ?? 0);
      if (code !== 0) {
        this.logger.warn(`resume 被拒绝 code=${code}，转全新会话`);
        this.sessionId = '';
        this.lastSn = 0;
        try { this.ws?.close(4000, 'resume rejected'); } catch { /* ignore */ }
      }
      return;
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    const jitter = Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
    this.heartbeatTimer = setTimeout(() => {
      this.heartbeatTimer = null;
      if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      try {
        this.ws.send(JSON.stringify({ s: KOOK_SIGNAL.PING, sn: this.lastSn }));
      } catch (err: unknown) {
        this.logger.error('心跳发送失败', err);
        try { this.ws.close(4000, 'heartbeat fail'); } catch { /* ignore */ }
        return;
      }
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null;
        this.logger.warn('心跳超时：未在 6 秒内收到 pong');
        try { this.ws?.close(4000, 'pong timeout'); } catch { /* ignore */ }
      }, PONG_TIMEOUT_MS);
      this.startHeartbeat(intervalMs);
    }, Math.max(5_000, intervalMs - jitter));
  }

  private async ensureBotProfile(): Promise<void> {
    if (this.botUser && !this.profileFetchFailed) return;
    try {
      const user = await fetchKookBotProfile(this.token);
      const changed = this.botUser?.id !== user.id;
      this.botUser = user;
      this.profileFetchFailed = false;
      this.logger.info(`机器人身份: ${user.username}#${user.identify_num ?? ''} (${user.id})`);
      if (changed || this.connection.kookBotUserId !== user.id) {
        this.hooks.onProfileUpdated?.();
      }
    } catch (err: unknown) {
      this.profileFetchFailed = true;
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`获取机器人资料失败: ${msg}`);
    }
  }

  private async dispatchEvent(d: KookEvent | undefined): Promise<void> {
    if (!d || typeof d !== 'object') return;

    // 过滤机器人自己的消息，避免自回复循环
    if (this.botUser && String(d.author_id || '') === this.botUser.id) {
      this.logger.debug('忽略机器人自己的消息');
      return;
    }

    const isMessage = d.msg_id && (d.channel_type === 'GROUP' || d.channel_type === 'PERSON')
      && typeof d.type === 'number' && d.type !== KOOK_MSG_TYPE.SYSTEM;
    const event = isMessage
      ? {
        post_type: 'message',
        message_type: d.channel_type === 'PERSON' ? 'private' : 'group',
        kook: true,
        t: 'message',
        self_id: this.botUser?.id,
        channel_type: d.channel_type,
        channel_id: d.target_id,
        guild_id: d.extra?.guild_id,
        channel_name: d.extra?.channel_name,
        user_id: d.author_id,
        author_id: d.author_id,
        message_id: d.msg_id,
        timestamp: d.msg_timestamp,
        msg_type: d.type,
        message: d.content,
        raw_message: d.content,
        extra: d.extra,
        raw: d,
      }
      : {
        post_type: 'event',
        kook: true,
        t: String(d.extra?.type ?? (typeof d.type === 'string' ? d.type : 'event')),
        kook_event_type: d.extra?.type ?? d.type,
        self_id: this.botUser?.id,
        channel_type: d.channel_type,
        extra: d.extra,
        raw: d,
      };

    void eventBus.emit('kook/event', {
      connectionId: this.id,
      eventType: String(event.t),
      event,
    });
  }

  async callAction(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const token = this.token;
    if (!token) throw new Error('KOOK Token 未配置');
    if (!this.connected) throw new Error('KOOK 未连接');
    this.lastActionParams = params;

    const channelId = String(
      params.target_id ?? params.channel_id ?? params.target ?? '',
    ).trim();
    const userId = String(
      params.user_id ?? params.to_user_id ?? params.to ?? '',
    ).trim();
    const content = String(params.content ?? params.text ?? params.message ?? '');
    const quote = String(params.quote ?? params.reply ?? params.msg_id ?? '').trim();
    const msgType = Number(params.msg_type ?? params.type ?? 0);

    switch (action) {
      case 'send_text':
      case 'send_msg':
      case 'send_message':
      case 'send_channel_msg': {
        const type = msgType === KOOK_MSG_TYPE.KMARKDOWN || msgType === KOOK_MSG_TYPE.CARD
          ? msgType
          : KOOK_MSG_TYPE.TEXT;
        return this.sendToTarget(type, channelId, userId, content, quote);
      }
      case 'send_kmarkdown': {
        return this.sendToTarget(KOOK_MSG_TYPE.KMARKDOWN, channelId, userId, content, quote);
      }
      case 'send_card': {
        return this.sendToTarget(KOOK_MSG_TYPE.CARD, channelId, userId, content, quote);
      }
      case 'send_private_msg':
      case 'send_private_text':
      case 'send_direct_msg': {
        if (!userId) throw new Error('缺少 user_id（私聊目标用户）');
        if (!content.trim()) throw new Error('缺少 content');
        this.logOut(action, { userId, content });
        return kookCreateDirectMessage(token, {
          type: msgType || KOOK_MSG_TYPE.TEXT,
          targetUserId: userId,
          content,
          quote: quote || undefined,
        });
      }
      case 'send_image':
      case 'send_video':
      case 'send_file':
      case 'send_audio': {
        return this.sendMedia(action, channelId, userId);
      }
      case 'api':
      case 'kook_api':
      case 'request': {
        // 通用 KOOK HTTP API 透传：{ path: '/friend?type=request', method?: 'GET', body?: {...} }
        const apiPath = String(params.path ?? params.url ?? '').trim();
        if (!apiPath) throw new Error('缺少 path（如 /friend?type=request）');
        const method = String(params.method ?? 'GET').trim().toUpperCase() || 'GET';
        this.logOut('api', { method, path: apiPath });
        return kookApiRequest(token, apiPath, {
          method,
          body: method === 'GET' || method === 'HEAD' ? undefined : params.body,
        });
      }
      default:
        throw new Error(`KOOK 不支持动作: ${action}`);
    }
  }

  /** 频道优先；仅给了用户 ID 时走私聊 */
  private async sendToTarget(
    type: number,
    channelId: string,
    userId: string,
    content: string,
    quote: string,
  ): Promise<unknown> {
    if (!content.trim()) throw new Error('缺少 content');
    if (channelId) {
      this.logOut('send', { channelId, type, content });
      return kookCreateMessage(this.token, {
        type,
        targetId: channelId,
        content,
        quote: quote || undefined,
      });
    }
    if (userId) {
      this.logOut('send_direct', { userId, type, content });
      return kookCreateDirectMessage(this.token, {
        type,
        targetUserId: userId,
        content,
        quote: quote || undefined,
      });
    }
    throw new Error('缺少 target_id（频道）或 user_id（私聊）');
  }

  private async sendMedia(
    action: string,
    channelId: string,
    userId: string,
  ): Promise<unknown> {
    void action;
    const params = this.lastActionParams;
    const filePath = String(params?.file_path ?? params?.path ?? '').trim();
    const fileUrl = String(params?.url ?? params?.file_url ?? '').trim();

    let localPath = filePath;
    let tmpPath = '';
    try {
      if (!localPath && fileUrl) {
        const tmpDir = path.join(os.tmpdir(), 'kakake-kook-media');
        const dl = await downloadKookRemoteMediaToTemp(fileUrl, tmpDir);
        localPath = dl.filePath;
        tmpPath = dl.filePath;
      }
      if (!localPath) throw new Error('缺少 file_path 或 url');
      const assetUrl = await kookUploadAsset(this.token, localPath);
      this.logOut('send_media', { channelId, userId, assetUrl });
      return await this.sendToTarget(KOOK_MSG_TYPE.IMAGE, channelId, userId, assetUrl, '');
    } finally {
      if (tmpPath) {
        try { await fs.unlink(tmpPath); } catch { /* ignore */ }
      }
    }
  }

  /** callAction 的原始参数引用（媒体动作需要 file_path/url 等额外字段） */
  private lastActionParams: Record<string, unknown> = {};

  private logOut(action: string, detail: Record<string, unknown>): void {
    const prefix = `[KOOK输出:${this.name}] `;
    logAction(prefix, `${action} → ${JSON.stringify(detail).slice(0, 500)}`);
  }
}
