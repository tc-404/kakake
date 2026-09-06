import type { ConnectionConfig } from '../core/types.js';
import type { Logger } from '../core/logger.js';
import { configService } from '../core/config.service.js';
import { eventBus } from '../event/event-bus.js';
import { rootLogger } from '../core/logger.js';
import {
  extractWeixinText,
  weixinGetUpdates,
  weixinSendMediaFile,
  weixinSendTextMessage,
  weixinSendTyping,
  downloadRemoteMediaToTemp,
} from './weixin-bot-api.js';
import {
  WEIXIN_CDN_BASE_URL,
  WeixinMessageType,
  type WeixinLoginCredentials,
  type WeixinMediaKind,
  type WeixinMessage,
} from './weixin-bot.types.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_CONSECUTIVE_FAILURES = 5;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

export interface WeixinBotEndpoint {
  id: string;
  name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  getCredentials(): WeixinLoginCredentials | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 微信 BOT：iLink 长轮询客户端
 * - getUpdates 收消息 → eventBus `weixin_bot/event`
 * - callAction: send_text / send_typing
 */
export class WeixinBotClient implements WeixinBotEndpoint {
  readonly id: string;
  readonly name: string;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private connected = false;
  private getUpdatesBuf = '';
  private readonly contextTokens = new Map<string, string>();
  private readonly logger: Logger;
  private credentials: WeixinLoginCredentials | null;

  constructor(
    private readonly connection: ConnectionConfig,
    private readonly hooks: {
      onReady?: () => void;
      onDisconnect?: () => void;
    } = {},
  ) {
    this.id = connection.id;
    this.name = connection.name;
    this.logger = rootLogger.child(`[微信BOT:${connection.name}] `);
    this.credentials = this.readCredentials(connection);
    this.getUpdatesBuf = connection.weixinGetUpdatesBuf || '';
  }

  get isConnected(): boolean {
    return this.connected && this.running;
  }

  getCredentials(): WeixinLoginCredentials | null {
    return this.credentials;
  }

  private readCredentials(conn: ConnectionConfig): WeixinLoginCredentials | null {
    const token = String(conn.weixinToken || '').trim();
    const baseUrl = String(conn.weixinBaseUrl || '').trim();
    const accountId = String(conn.weixinAccountId || '').trim();
    if (!token || !baseUrl || !accountId) return null;
    return {
      token,
      baseUrl,
      accountId,
      userId: conn.weixinUserId,
    };
  }

  start(): void {
    if (this.running) return;
    this.credentials = this.readCredentials(this.connection);
    if (!this.credentials) {
      this.logger.warn('未登录：请先扫码获取凭证后再启用');
      return;
    }
    this.running = true;
    this.connected = true;
    this.hooks.onReady?.();
    this.logger.info(`已启动长轮询 accountId=${this.credentials.accountId}`);
    this.loopPromise = this.pollLoop().finally(() => {
      this.loopPromise = null;
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.hooks.onDisconnect?.();
    this.logger.info('已停止');
  }

  private persistUpdatesBuf(buf: string): void {
    this.getUpdatesBuf = buf;
    const data = configService.getConnections();
    const conn = data.connections.find((c) => c.id === this.id);
    if (!conn) return;
    conn.weixinGetUpdatesBuf = buf;
    configService.saveConnections(data);
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running && this.credentials) {
      try {
        const resp = await weixinGetUpdates(
          this.credentials.baseUrl,
          this.credentials.token,
          this.getUpdatesBuf,
        );

        if (resp.ret !== undefined && resp.ret !== 0) {
          failures += 1;
          this.logger.warn(
            `getUpdates 错误: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`,
          );
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            failures = 0;
            await sleep(BACKOFF_DELAY_MS);
          } else {
            await sleep(RETRY_DELAY_MS);
          }
          continue;
        }

        failures = 0;
        if (resp.get_updates_buf && resp.get_updates_buf !== this.getUpdatesBuf) {
          this.persistUpdatesBuf(resp.get_updates_buf);
        }

        for (const msg of resp.msgs ?? []) {
          await this.handleMessage(msg);
        }
      } catch (err) {
        if (!this.running) break;
        failures += 1;
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.error(`轮询异常: ${msg}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          failures = 0;
          await sleep(BACKOFF_DELAY_MS);
        } else {
          await sleep(RETRY_DELAY_MS);
        }
      }
    }
  }

  private async handleMessage(msg: WeixinMessage): Promise<void> {
    if (msg.message_type !== WeixinMessageType.USER) return;
    const fromUser = msg.from_user_id;
    if (!fromUser) return;

    if (msg.context_token) {
      this.contextTokens.set(fromUser, msg.context_token);
    }

    const text = extractWeixinText(msg);
    const event = {
      post_type: 'message',
      message_type: 'private',
      weixin_bot: true,
      t: 'message',
      from_user_id: fromUser,
      to_user_id: msg.to_user_id,
      message_id: msg.message_id,
      session_id: msg.session_id,
      context_token: msg.context_token || this.contextTokens.get(fromUser),
      raw_message: text,
      message: text,
      item_list: msg.item_list,
      create_time_ms: msg.create_time_ms,
      raw: msg,
    };

    void eventBus.emit('weixin_bot/event', {
      connectionId: this.id,
      eventType: 'message',
      event,
    });
  }

  async callAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.credentials) throw new Error('微信 BOT 未登录');
    const creds = this.credentials;
    const to = String(params?.to_user_id ?? params?.user_id ?? params?.to ?? '').trim();
    const text = String(params?.text ?? params?.message ?? '').trim();
    const contextToken = String(
      params?.context_token
      ?? (to ? this.contextTokens.get(to) : '')
      ?? '',
    ).trim() || undefined;

    switch (action) {
      case 'send_text':
      case 'send_msg':
      case 'send_message': {
        if (!to) throw new Error('缺少 to_user_id');
        if (!text) throw new Error('缺少 text');
        await weixinSendTextMessage(creds.baseUrl, creds.token, to, text, contextToken);
        return { ok: true };
      }
      case 'send_typing': {
        if (!to) throw new Error('缺少 to_user_id');
        await weixinSendTyping(creds.baseUrl, creds.token, to, contextToken);
        return { ok: true };
      }
      case 'send_image':
      case 'send_video':
      case 'send_file':
      case 'send_voice': {
        if (!to) throw new Error('缺少 to_user_id');
        const kind: WeixinMediaKind =
          action === 'send_image' ? 'image'
            : action === 'send_video' ? 'video'
              : action === 'send_voice' ? 'voice'
                : 'file';
        const filePath = String(params?.file_path ?? params?.path ?? '').trim();
        const fileUrl = String(params?.url ?? params?.file_url ?? '').trim();
        const fileName = String(params?.file_name ?? params?.filename ?? '').trim() || undefined;
        const playtimeMs = params?.playtime != null ? Number(params.playtime) : undefined;
        const encodeType = params?.encode_type != null ? Number(params.encode_type) : undefined;

        let localPath = filePath;
        let tmpPath = '';
        try {
          if (!localPath && fileUrl) {
            const preferredExt =
              kind === 'image' ? '.jpg'
                : kind === 'video' ? '.mp4'
                  : kind === 'voice' ? '.mp3'
                    : '.bin';
            const tmpDir = path.join(os.tmpdir(), 'kakake-weixin-media');
            const dl = await downloadRemoteMediaToTemp(fileUrl, tmpDir, preferredExt);
            localPath = dl.filePath;
            tmpPath = dl.filePath;
          }
          if (!localPath) throw new Error('缺少 file_path 或 url');
          await weixinSendMediaFile({
            baseUrl: creds.baseUrl,
            token: creds.token,
            to,
            filePath: localPath,
            kind,
            fileName: fileName || path.basename(localPath),
            contextToken,
            cdnBaseUrl: WEIXIN_CDN_BASE_URL,
            playtimeMs: Number.isFinite(playtimeMs) ? playtimeMs : undefined,
            encodeType: Number.isFinite(encodeType) ? encodeType : undefined,
          });
          return { ok: true };
        } finally {
          if (tmpPath) {
            try { await fs.unlink(tmpPath); } catch { /* ignore */ }
          }
        }
      }
      default:
        throw new Error(`微信 BOT 不支持动作: ${action}`);
    }
  }
}
