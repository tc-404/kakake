/**
 * Telegram Bot 连接端点 —— 一个连接 = 一个 bot token = 一个账号
 *
 * 三种对接方式全部落在同一个端点里：
 *  1. `mode='polling'`：getUpdates 长轮询（默认，无需公网地址）
 *  2. `mode='webhook'`：setWebhook HTTPS 回调（由 telegram-webhook.server.ts 收 POST）
 *  3. `telegramApiBase` 指向自建地址：本地 Bot API Server（与 1/2 正交，
 *     可用 HTTP / 任意端口 / 2000MB 上传 / file_path 为本地绝对路径）
 *  另：`telegramTestEnv` 把请求切到 `/bot<token>/test/METHOD` 测试环境。
 *
 * 职责：getMe 认身份 → 按模式建链 → Update 规范化并派发 `telegram/event`
 * → 插件通过 `actions.call` 调任意 Bot API 方法（含 OneBot 风格别名兼容）。
 */

import { timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConnectionConfig, TelegramMode } from '../core/types.js';
import { parseTelegramMode } from '../core/types.js';
import { configService } from '../core/config.service.js';
import type { Logger } from '../core/logger.js';
import { logTelegramAction, logTelegramEvent } from '../core/log-store.js';
import { eventBus } from '../event/event-bus.js';
import { TelegramApiClient, isLocalBotApiServer, createTelegramFallbackLogger } from './telegram-api.js';
import {
  TELEGRAM_DEFAULT_ALLOWED_UPDATES,
  TELEGRAM_EVENT_NAME,
  TELEGRAM_SECRET_TOKEN_RE,
  TELEGRAM_WEBHOOK_PORTS,
  TELEGRAM_LIMITS,
  telegramUpdateToEvent,
  telegramUpdateType,
  formatTelegramUpdate,
  formatTelegramAction,
  telegramWebhookCallbackPath,
  type TelegramBotProfile,
  type TelegramEndpoint,
  type TelegramReconnectStatus,
  type TelegramUpdate,
  type TelegramWebhookInfo,
} from './telegram.types.js';

export interface TelegramClientHooks {
  onReady?: () => void;
  onDisconnect?: () => void;
  /** getMe 拿到机器人资料时回调（ConnectionManager 据此持久化账号隔离键） */
  onProfileUpdated?: () => void;
  onStatusChanged?: () => void;
}

/** 当前正在处理的 Webhook update_id（用于「响应内直接回复」这一官方技巧） */
const webhookUpdateStorage = new AsyncLocalStorage<number>();

/** 把 snake_case 的 OneBot/自定动作名转成 Bot API 的小驼峰方法名 */
function toBotApiMethod(action: string): string {
  const trimmed = String(action || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(trimmed)) return '';
  const camel = trimmed.replace(/_([a-z0-9])/gi, (_, ch: string) => ch.toUpperCase());
  return camel.charAt(0).toLowerCase() + camel.slice(1);
}

/** OneBot v11 风格动作 → Telegram 方法（让既有插件写法不用重写就能跑） */
const OB11_ACTION_ALIASES: Record<string, string> = {
  send_msg: 'sendMessage',
  send_message: 'sendMessage',
  send_private_msg: 'sendMessage',
  send_group_msg: 'sendMessage',
  send_text: 'sendMessage',
  delete_msg: 'deleteMessage',
  set_msg_emoji_like: 'setMessageReaction',
  get_login_info: 'getMe',
  get_stranger_info: 'getChat',
  get_group_info: 'getChat',
  get_group_member_info: 'getChatMember',
  get_group_member_list: 'getChatAdministrators',
  set_group_ban: 'banChatMember',
  set_group_kick: 'banChatMember',
  set_group_admin: 'promoteChatMember',
  get_friend_list: 'getChatAdministrators',
  get_file: 'getFile',
  set_group_card: 'setChatMemberTag',
};

/** 支持插件用 `actions.call('api', { method:'sendMessage', params:{...} })` 原样透传 */
function unwrapRawCall(action: string, params: Record<string, unknown>): { method: string; params: Record<string, unknown> } | null {
  if (!/^(?:api|raw|callApi|call_api|telegram_api)$/i.test(action)) return null;
  const method = String(params.method ?? params.action ?? params.name ?? '').trim();
  const inner = (params.params ?? params.args ?? params.payload ?? {}) as Record<string, unknown>;
  return method ? { method, params: inner } : null;
}

export class TelegramBotClient implements TelegramEndpoint {
  readonly id: string;
  readonly name: string;

  private readonly connection: ConnectionConfig;
  private readonly hooks: TelegramClientHooks;
  private readonly logger: Logger;
  private readonly api: TelegramApiClient;
  private readonly mode: TelegramMode;

  private running = false;
  private connected = false;
  private botUser: TelegramBotProfile | null = null;
  private webhookInfo: TelegramWebhookInfo | null = null;
  private offset = 0;
  private lastOffsetPersistAt = 0;
  private attempts = 0;
  private reconnecting = false;
  private abandoned = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private webhookCheckTimer: NodeJS.Timeout | null = null;
  private abortController: AbortController | null = null;
  private readyEmitted = false;
  private readonly seenUpdateIds = new Set<number>();
  /** update_id → 本次 webhook 事件里插件产生的首个可直回 API 调用 */
  private readonly responseMethods = new Map<number, Record<string, unknown>>();

  constructor(connection: ConnectionConfig, hooks: TelegramClientHooks = {}, logger?: Logger) {
    this.connection = connection;
    this.hooks = hooks;
    this.id = connection.id;
    this.name = connection.name;
    this.mode = parseTelegramMode(connection.mode);
    this.logger = logger ?? createTelegramFallbackLogger(`[Telegram:${connection.name}] `);
    this.offset = Number(connection.telegramOffset ?? 0) || 0;
    this.api = new TelegramApiClient({
      token: String(connection.telegramToken || '').trim(),
      apiBase: connection.telegramApiBase,
      testEnv: connection.telegramTestEnv,
      proxyUrl: connection.telegramProxyUrl,
      timeoutMs: Math.max(30_000, (Number(connection.telegramPollingTimeout ?? 30) + 20) * 1000),
      logger: this.logger,
      // 本地 Bot API Server 有自己的限频口径，交给用户自己控
      rateLimit: !isLocalBotApiServer(connection.telegramApiBase),
    });
  }

  private get token(): string { return String(this.connection.telegramToken || '').trim(); }

  get isConnected(): boolean { return this.running && this.connected; }
  getBotUser(): TelegramBotProfile | null { return this.botUser; }
  getWebhookInfo(): TelegramWebhookInfo | null { return this.webhookInfo; }
  getMode(): TelegramMode { return this.mode; }
  getApiClient(): TelegramApiClient { return this.api; }

  getReconnectStatus(): TelegramReconnectStatus {
    return {
      reconnecting: this.reconnecting,
      attempts: this.attempts,
      maxAttempts: this.connection.reconnectMaxAttempts ?? 15,
      intervalMs: this.connection.reconnectIntervalMs ?? 5000,
      abandoned: this.abandoned,
    };
  }

  /** 供界面复制的回调地址；未填完整 URL 时用公网基址拼 */
  resolveWebhookUrl(): string {
    const explicit = String(this.connection.telegramWebhookUrl || '').trim();
    if (explicit) return explicit;
    const base = String(this.connection.webhookBaseUrl || '').trim().replace(/\/+$/, '');
    return base ? `${base}${telegramWebhookCallbackPath(this.id)}` : '';
  }

  start(): void {
    if (this.running) return;
    if (!this.token) {
      this.logger.warn('未配置 Bot Token，无法连接 Telegram Bot API');
      return;
    }
    this.running = true;
    this.attempts = 0;
    this.abandoned = false;
    this.readyEmitted = false;
    this.logger.info(
      `启动 Telegram Bot（${this.mode === 'webhook' ? 'Webhook' : '长轮询'}`
      + `${this.api.usesTestEnv ? ' · 测试环境' : ''}${this.api.isLocalServer ? ' · 本地 Bot API Server' : ''}`
      + `${this.api.usesProxy ? ' · 代理' : ''}）`,
    );
    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    try {
      const me = await this.api.getMe();
      this.botUser = me;
      this.logger.info(`机器人身份：@${me.username || me.id} (${me.id})`);
      this.hooks.onProfileUpdated?.();
      this.attempts = 0;
      this.reconnecting = false;
      this.abandoned = false;
      if (this.mode === 'webhook') await this.setupWebhook();
      else await this.setupPolling();
      if (!this.running) return;
      this.markConnected(true);
      if (this.mode === 'webhook') this.startWebhookHealthCheck();
      else void this.pollLoop();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.error(`Telegram Bot 启动失败：${msg}`);
      this.scheduleRetry(msg);
    }
  }

  /** Webhook：先确保与 getUpdates 互斥，再 setWebhook；失败重试 */
  private async setupWebhook(): Promise<void> {
    const url = this.resolveWebhookUrl();
    if (!url) throw new Error('Webhook 模式必须填写完整回调 URL（或公网基址 webhookBaseUrl）');
    if (!url.startsWith('https://') && !this.api.isLocalServer) {
      throw new Error(`官方 Bot API Server 要求 Webhook 必须是 HTTPS URL（支持端口 ${TELEGRAM_WEBHOOK_PORTS.join('/')}）：${url}`);
    }
    const secret = String(this.connection.telegramWebhookSecret || '').trim();
    if (secret && !TELEGRAM_SECRET_TOKEN_RE.test(secret)) {
      throw new Error('secret_token 只能是 1-256 位 A-Z a-z 0-9 _ -');
    }
    // 与 getUpdates 互斥：官方明确「设置了 webhook 就不能长轮询」，这里反过来
    // 先删掉可能残留的旧 webhook，再按当前配置重设，避免 409 冲突。
    const params: Record<string, unknown> = {
      url,
      allowed_updates: this.allowedUpdates(),
      drop_pending_updates: this.connection.telegramDropPendingUpdates === true,
      ...(secret ? { secret_token: secret } : {}),
      ...(this.connection.telegramWebhookMaxConnections
        ? { max_connections: this.connection.telegramWebhookMaxConnections } : {}),
      ...(this.connection.telegramWebhookIpAddress
        ? { ip_address: this.connection.telegramWebhookIpAddress } : {}),
      ...(this.connection.telegramWebhookCertificatePath
        ? { certificate: TelegramApiClient.certificateParam(this.connection.telegramWebhookCertificatePath) } : {}),
    };
    await this.api.setWebhook(params);
    this.webhookInfo = await this.api.getWebhookInfo();
    this.logger.info(`Webhook 已设置：${url}${secret ? '（已启用 secret_token 校验）' : ''}`);
  }

  /** 长轮询：先 deleteWebhook 保证互斥 */
  private async setupPolling(): Promise<void> {
    await this.api.deleteWebhook(this.connection.telegramDropPendingUpdates === true);
    if (this.offset === 0) {
      this.logger.info('长轮询就绪（未发现持久化 offset，从最早未确认更新开始）');
    } else {
      this.logger.info(`长轮询就绪，从 offset ${this.offset} 继续`);
    }
  }

  private allowedUpdates(): string[] {
    const configured = this.connection.telegramAllowedUpdates;
    return Array.isArray(configured) && configured.length ? configured : [...TELEGRAM_DEFAULT_ALLOWED_UPDATES];
  }

  private pollingTimeout(): number {
    const n = Number(this.connection.telegramPollingTimeout ?? 30);
    return Math.min(TELEGRAM_LIMITS.pollingTimeoutMax, Math.max(0, Math.floor(Number.isFinite(n) ? n : 30)));
  }

  private pollingLimit(): number {
    const n = Number(this.connection.telegramPollingLimit ?? 100);
    return Math.min(TELEGRAM_LIMITS.pollingLimitMax, Math.max(1, Math.floor(Number.isFinite(n) ? n : 100)));
  }

  /** getUpdates 循环：offset 确认、错误指数退避、断线状态上报 */
  private async pollLoop(): Promise<void> {
    if (!this.running) return;
    this.abortController = new AbortController();
    try {
      const updates = await this.api.getUpdates({
        offset: this.offset,
        limit: this.pollingLimit(),
        timeout: this.pollingTimeout(),
        allowed_updates: this.allowedUpdates(),
        __signal: this.abortController.signal,
      });
      if (!this.running) return;
      this.attempts = 0;
      this.reconnecting = false;
      this.abandoned = false;
      this.markConnected(true);
      for (const raw of updates) {
        await this.dispatch(raw as TelegramUpdate);
      }
    } catch (error) {
      if (!this.running) return;
      if (this.abortController?.signal.aborted) return;
      const msg = error instanceof Error ? error.message : String(error);
      // 409：webhook 与 getUpdates 冲突，自动删 webhook 后继续
      if (/409|conflict|webhook/i.test(msg)) {
        this.logger.warn('检测到 Webhook 与长轮询冲突，自动清理 Webhook');
        try { await this.api.deleteWebhook(false); } catch { /* 下一轮再试 */ }
      } else {
        this.logger.warn(`长轮询出错：${msg}`);
      }
      this.markConnected(false);
      this.scheduleRetry(msg);
      return;
    }
    if (this.running) this.pollTimer = setTimeout(() => { void this.pollLoop(); }, 0);
  }

  private scheduleRetry(reason: string): void {
    if (!this.running) return;
    const max = this.connection.reconnectMaxAttempts ?? 15;
    if (max > 0 && this.attempts >= max) {
      if (!this.abandoned) {
        this.abandoned = true;
        this.logger.error(`重试 ${max} 次仍失败，放弃自动重连：${reason}`);
        this.hooks.onStatusChanged?.();
      }
      return;
    }
    this.attempts += 1;
    this.reconnecting = true;
    const base = this.connection.reconnectIntervalMs ?? 5000;
    const wait = Math.min(60_000, base * 2 ** Math.min(this.attempts - 1, 5));
    this.logger.warn(`${Math.round(wait)}ms 后重连（${this.attempts}${max > 0 ? `/${max}` : ''}）`);
    this.hooks.onStatusChanged?.();
    this.pollTimer = setTimeout(() => {
      if (!this.running) return;
      void this.bootstrap();
    }, wait);
  }

  /** Webhook 模式没有常连接：定时用 getWebhookInfo 体检，出错自动重设 */
  private startWebhookHealthCheck(): void {
    const tick = async (): Promise<void> => {
      if (!this.running || this.mode !== 'webhook') return;
      try {
        const info = await this.api.getWebhookInfo();
        this.webhookInfo = info;
        if (info.last_error_message) {
          this.logger.warn(`Webhook 投递异常：${info.last_error_message}`);
        }
        const expected = this.resolveWebhookUrl();
        if (!info.url || (expected && info.url !== expected)) {
          this.logger.warn('Webhook 已被外部改动或清除，正在重新设置');
          await this.setupWebhook();
        }
        this.markConnected(true);
      } catch (error) {
        this.logger.warn(`Webhook 健康检查失败：${error instanceof Error ? error.message : String(error)}`);
        this.markConnected(false);
      }
      this.webhookCheckTimer = setTimeout(() => { void tick(); }, 60_000);
    };
    this.webhookCheckTimer = setTimeout(() => { void tick(); }, 60_000);
  }

  private markConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    if (value && !this.readyEmitted) {
      this.readyEmitted = true;
      this.hooks.onReady?.();
    } else if (!value) {
      this.hooks.onDisconnect?.();
    }
    this.hooks.onStatusChanged?.();
  }

  /**
   * 投递一条 Update：规范化成插件事件 → 写日志 → 发到 `telegram/event`。
   * Webhook 与长轮询共用这一条路径，保证两种接入方式的插件行为完全一致。
   */
  private async dispatch(update: TelegramUpdate): Promise<void> {
    if (!update || typeof update !== 'object' || !Number.isFinite(Number(update.update_id))) return;
    const id = Number(update.update_id);
    if (this.seenUpdateIds.has(id)) return;
    this.seenUpdateIds.add(id);
    if (this.seenUpdateIds.size > 2048) {
      const oldest = this.seenUpdateIds.values().next().value;
      if (oldest !== undefined) this.seenUpdateIds.delete(oldest);
    }
    // offset = 已处理最大 update_id + 1（官方确认语义）
    if (id >= this.offset) {
      this.offset = id + 1;
      this.persistOffset();
    }
    const updateType = telegramUpdateType(update);
    const event = telegramUpdateToEvent(update, this.botUser?.username);
    // 机器人自己的消息不回灌，避免自回复循环（Bot-to-Bot 场景尤其重要）
    const fromId = Number(event.user_id ?? 0);
    if (this.botUser && fromId === this.botUser.id && event.post_type === 'message') {
      this.logger.debug('忽略机器人自身消息');
      return;
    }
    // 把收到的消息显形到消息监控：TG 专属分类 tg_event（info 级、计入接收计数），
    // 与 OneBot(event) / QQ官方(gf_event) 各自独立，日志页可按「TG上报」单独筛选。
    const formatted = formatTelegramUpdate(update, this.botUser?.username);
    logTelegramEvent(
      `[Telegram输入:${this.name}]`,
      formatted.message,
      { detail: formatted.detail, raw: formatted.raw, level: 'info' },
    );
    await eventBus.emit(TELEGRAM_EVENT_NAME, {
      connectionId: this.id,
      eventType: updateType,
      event,
      raw: update,
      time: Date.now(),
    });
  }

  /** offset 持久化：节流写盘，重启后不重复消费 24 小时内的积压更新 */
  private persistOffset(): void {
    const now = Date.now();
    if (now - this.lastOffsetPersistAt < 2000) return;
    this.lastOffsetPersistAt = now;
    const value = this.offset;
    try {
      configService.mutateConnections((data) => {
        const conn = data.connections.find((c) => c.id === this.id);
        if (!conn) return null;
        conn.telegramOffset = value;
        return value;
      });
    } catch (error) {
      this.logger.warn(`持久化 offset 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Webhook 中间件入口：校验 secret_token、派发事件、收集响应内回复 */
  async acceptWebhookUpdate(update: TelegramUpdate, secretHeader?: string): Promise<boolean> {
    const secret = String(this.connection.telegramWebhookSecret || '').trim();
    if (secret) {
      const given = String(secretHeader || '');
      if (!timingSafeEqualText(given, secret)) {
        this.logger.warn('Webhook 请求 secret_token 校验失败，已拒绝');
        return false;
      }
    }
    if (!this.running) return false;
    const id = Number(update?.update_id ?? 0);
    // 官方：webhook 可用 update_id 忽略重复/乱序
    await webhookUpdateStorage.run(id, async () => {
      await this.dispatch(update);
    });
    this.markConnected(true);
    return true;
  }

  takeResponseMethod(updateId: number): Record<string, unknown> | null {
    const value = this.responseMethods.get(updateId);
    this.responseMethods.delete(updateId);
    return value ?? null;
  }

  /**
   * 插件动作入口。
   * - 原生 Bot API 方法名直接透传（sendMessage / answerCallbackQuery / getFile / ...）
   * - snake_case 自动转小驼峰
   * - OneBot v11 风格别名映射，让既有插件少改代码
   * - `api` / `raw` 动作支持 `{ method, params }` 原样透传
   * - `download_file` 返回 Buffer 的 base64（本地 Server 走本地路径）
   */
  async callAction(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const raw = unwrapRawCall(action, params);
    let method = raw ? raw.method : action;
    let callParams: Record<string, unknown> = raw ? { ...raw.params } : { ...params };

    if (!raw) {
      method = OB11_ACTION_ALIASES[action] || toBotApiMethod(action);
      if (!method) throw new Error(`非法的 Bot API 方法名：${action}`);
      callParams = this.normalizeOb11Params(action, callParams);
      // send_msg 带媒体段时，改写成对应的 sendPhoto / sendDocument / ...
      const rewrite = String(callParams.__rewriteSendMethod ?? '');
      if (rewrite && method === 'sendMessage') {
        const map: Record<string, string> = {
          photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument',
          audio: 'sendAudio', voice: 'sendVoice', animation: 'sendAnimation',
        };
        method = map[rewrite] ?? method;
      }
      delete callParams.__rewriteSendMethod;
    }
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)) {
      throw new Error(`非法的 Bot API 方法名：${method}`);
    }

    // 特殊本地动作
    if (/^(?:download_file|downloadFile)$/.test(method)) {
      const fileId = String(callParams.file_id ?? callParams.file ?? '');
      const buf = await this.api.downloadFile(fileId);
      return { size: buf.length, base64: buf.toString('base64'), data: buf };
    }
    if (/^(?:get_login_info|getMe)$/.test(method)) return this.botUser ?? await this.api.getMe();
    if (/^(?:get_webhook_info|getWebhookInfo)$/.test(method)) return await this.api.getWebhookInfo();
    if (/^(?:set_webhook|setWebhook)$/.test(method)) return await this.api.setWebhook(callParams);
    if (/^(?:delete_webhook|deleteWebhook)$/.test(method)) {
      return await this.api.deleteWebhook(Boolean(callParams.drop_pending_updates));
    }

    // Webhook 响应内直接回复（官方技巧，省一次请求但拿不到 result）
    const currentUpdateId = webhookUpdateStorage.getStore();
    if (
      this.connection.telegramWebhookReplyInResponse === true
      && currentUpdateId !== undefined
      && /^send[A-Z]/.test(method)
      && !this.responseMethods.has(currentUpdateId)
    ) {
      const payload: Record<string, unknown> = { method, ...callParams };
      this.responseMethods.set(currentUpdateId, payload);
      const out = formatTelegramAction(method, callParams);
      logTelegramAction(`[Telegram输出:${this.name}] `, `${out.message} · webhook`, out.detail);
      return { ok: true, via_webhook_response: true, method };
    }

    // 默认 parse_mode：显式配置才注入，避免把插件文本里的 < 当成 HTML 标签
    const configuredMode = this.connection.telegramParseMode;
    if (configuredMode && !callParams.parse_mode && /^send(?:Message|Photo|Video|Document|Animation|Audio|Voice|Poll)$/.test(method)) {
      callParams.parse_mode = configuredMode === 'Rich' ? undefined : configuredMode;
      if (callParams.parse_mode === undefined) delete callParams.parse_mode;
    }
    // 10.x：reply_to_message_id → reply_parameters
    if (callParams.reply_to_message_id !== undefined && callParams.reply_parameters === undefined) {
      callParams.reply_parameters = { message_id: Number(callParams.reply_to_message_id) };
      delete callParams.reply_to_message_id;
    }
    // 清掉内部辅助键
    for (const key of Object.keys(callParams)) if (key.startsWith('__')) delete callParams[key];

    const out = formatTelegramAction(method, callParams);
    logTelegramAction(`[Telegram输出:${this.name}] `, out.message, out.detail);
    return this.api.call(method, callParams);
  }

  /** OneBot 风格参数 → Bot API 参数 */
  private normalizeOb11Params(action: string, params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = { ...params };
    if (out.chat_id === undefined) {
      if (out.group_id !== undefined) out.chat_id = out.group_id;
      else if (out.user_id !== undefined && /private|msg/.test(action)) out.chat_id = out.user_id;
      else if (out.target_id !== undefined) out.chat_id = out.target_id;
    }
    delete out.group_id;
    if (out.message !== undefined && out.text === undefined) {
      const msg = out.message;
      if (typeof msg === 'string') out.text = msg;
      else if (Array.isArray(msg)) {
        const texts = msg
          .filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).type === 'text')
          .map((s) => String(((s as Record<string, unknown>).data as Record<string, unknown> | undefined)?.text ?? ''));
        out.text = texts.join('');
        const media = msg.find((s) => s && typeof s === 'object' && ['image', 'video', 'file', 'audio', 'record'].includes(String((s as Record<string, unknown>).type)));
        if (media) {
          const data = (media as Record<string, unknown>).data as Record<string, unknown> | undefined;
          const file = data?.file ?? data?.file_id;
          const kind = String((media as Record<string, unknown>).type);
          out.__media_kind = kind;
          out.__media_file = file;
        }
      }
      delete out.message;
    }
    if (out.__media_file) {
      const kind = String(out.__media_kind ?? 'image');
      const map: Record<string, string> = {
        image: 'photo', video: 'video', file: 'document', audio: 'audio', record: 'voice',
      };
      const field = map[kind] ?? 'photo';
      out[field] = out.__media_file;
      delete out.__media_file;
      delete out.__media_kind;
      // 由 callAction 里的方法名决定具体 sendPhoto / sendDocument
      if (out.text && field !== 'photo') out.caption = out.text;
      else if (out.text) out.caption = out.text;
      delete out.text;
      out.__rewriteSendMethod = field;
    }
    // get_group_member_info：user_id 要保留为 user_id（getChatMember 参数）
    if (/getChatMember|get_group_member_info/.test(action) && params.user_id !== undefined) {
      out.user_id = params.user_id;
    }
    return out;
  }

  stop(): void {
    if (!this.running && !this.connected) return;
    this.running = false;
    this.connected = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
    if (this.webhookCheckTimer) { clearTimeout(this.webhookCheckTimer); this.webhookCheckTimer = null; }
    this.abortController?.abort();
    this.abortController = null;
    this.logger.info('Telegram Bot 连接已停止');
    // 与 getUpdates 互斥：停下时摘掉 webhook，避免下次改用长轮询时收到 409。
    // 只在真的设置过 webhook 时才调用，且 fire-and-forget 不阻塞关机。
    if (this.mode === 'webhook' && this.token) {
      void this.api.deleteWebhook(false).catch((e: unknown) => {
        this.logger.warn(`清理 Webhook 失败：${e instanceof Error ? e.message : String(e)}`);
      });
    }
    this.hooks.onDisconnect?.();
  }
}

/** 常数时间字符串比较，防 secret_token 被时序侧信道探测 */
function timingSafeEqualText(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
