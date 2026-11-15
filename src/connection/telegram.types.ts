/**
 * Telegram Bot 协议 —— 类型、常量与纯函数（零运行时依赖，可单独单测）
 *
 * 设计目标：把 Bot API 的 `Update` 完整映射到框架插件生态熟悉的
 * OneBot v11 风格事件对象，同时**无损保留原生 Update**，让插件既能用
 * `event.raw_message` 也能直接用 `event.raw.callback_query` 等原生结构。
 *
 * 参考：https://core.telegram.org/bots/api （Bot API 10.4，2026-11-09）
 */

export const TELEGRAM_EVENT_NAME = 'telegram/event';
export const TELEGRAM_ACTION_RESULT_NAME = 'telegram/action_result';
export const TELEGRAM_DEFAULT_API_BASE = 'https://api.telegram.org';
/** 官方服务器允许的 Webhook 端口；本地 Bot API Server 不受此限制 */
export const TELEGRAM_WEBHOOK_PORTS = [443, 80, 88, 8443] as const;
/** Webhook 回调路径（主端口），完整 URL 形如 https://host/tgbot/<连接id> */
export const TELEGRAM_WEBHOOK_CALLBACK_PREFIX = '/tgbot/';

/** 每条 Telegram 连接独立的 Webhook 回调路径（挂框架主端口） */
export function telegramWebhookCallbackPath(connectionId: string): string {
  return `${TELEGRAM_WEBHOOK_CALLBACK_PREFIX}${encodeURIComponent(connectionId)}`;
}
/** secret_token 合法字符集：1-256 位 A-Z a-z 0-9 _ - */
export const TELEGRAM_SECRET_TOKEN_RE = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Bot API `Update` 的全部可选字段（含 10.x 新增）。
 * 官方约束：一个 Update 里最多只有一个可选字段有值。
 * 显式列出 chat_member / message_reaction / message_reaction_count 很关键——
 * 这三类默认**不会**下发，必须在 allowed_updates 里显式订阅。
 */
export const TELEGRAM_ALL_UPDATE_TYPES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages',
  'guest_message',
  'message_reaction',
  'message_reaction_count',
  'inline_query',
  'chosen_inline_result',
  'callback_query',
  'widget_query',
  'shared_widget_query',
  'shipping_query',
  'pre_checkout_query',
  'purchased_paid_media',
  'poll',
  'poll_answer',
  'my_chat_member',
  'chat_member',
  'chat_join_request',
  'chat_boost',
  'removed_chat_boost',
  'managed_bot',
  'subscription',
  'stopped_message_generation',
] as const;

export type TelegramUpdateType = typeof TELEGRAM_ALL_UPDATE_TYPES[number];

/**
 * 默认订阅全集：官方默认是「除 chat_member / message_reaction /
 * message_reaction_count 之外的全部」，框架这里主动把这三类也打开，
 * 免得用户纳闷「为什么群成员变化和表情回应收不到」。
 */
export const TELEGRAM_DEFAULT_ALLOWED_UPDATES: string[] = [...TELEGRAM_ALL_UPDATE_TYPES];

/** 官方服务器限制（本地 Bot API Server 会放宽，见文档） */
export const TELEGRAM_LIMITS = {
  officialUploadBytes: 50 * 1024 * 1024,
  officialDownloadBytes: 20 * 1024 * 1024,
  localUploadBytes: 2000 * 1024 * 1024,
  webhookMaxConnectionsOfficial: 100,
  webhookMaxConnectionsLocal: 100000,
  perChatMessageIntervalMs: 1000,
  groupMessagesPerMinute: 20,
  broadcastMessagesPerSecond: 30,
  pollingLimitMax: 100,
  pollingTimeoutMax: 50,
  updateRetentionMs: 24 * 60 * 60 * 1000,
} as const;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  [key: string]: unknown;
}

export interface TelegramChat {
  id: number | string;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
  [key: string]: unknown;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  url?: string;
  user?: TelegramUser;
  language?: string;
  custom_emoji_id?: string;
  [key: string]: unknown;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  from?: TelegramUser;
  sender_chat?: TelegramChat;
  date: number;
  chat: TelegramChat;
  forward_from?: TelegramUser;
  reply_to_message?: TelegramMessage;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
  video?: { file_id: string; duration?: number; file_name?: string; mime_type?: string; [key: string]: unknown };
  audio?: { file_id: string; duration?: number; title?: string; [key: string]: unknown };
  voice?: { file_id: string; duration?: number; [key: string]: unknown };
  document?: { file_id: string; file_name?: string; mime_type?: string; [key: string]: unknown };
  animation?: { file_id: string; file_name?: string; [key: string]: unknown };
  sticker?: { file_id: string; emoji?: string; is_animated?: boolean; [key: string]: unknown };
  video_note?: { file_id: string; [key: string]: unknown };
  location?: { latitude: number; longitude: number; [key: string]: unknown };
  contact?: Record<string, unknown>;
  poll?: Record<string, unknown>;
  dice?: { emoji?: string; value?: number; [key: string]: unknown };
  new_chat_members?: TelegramUser[];
  left_chat_member?: TelegramUser;
  new_chat_title?: string;
  new_chat_photo?: unknown[];
  delete_chat_photo?: boolean;
  group_chat_created?: boolean;
  supergroup_chat_created?: boolean;
  channel_chat_created?: boolean;
  migrate_to_chat_id?: number;
  migrate_from_chat_id?: number;
  pinned_message?: TelegramMessage;
  successful_payment?: Record<string, unknown>;
  invoice?: { title?: string; description?: string; [key: string]: unknown };
  game?: { title?: string; description?: string; [key: string]: unknown };
  venue?: { title?: string; address?: string; [key: string]: unknown };
  forward_from_chat?: TelegramChat;
  connected_website?: string;
  reply_markup?: Record<string, unknown>;
  /** 10.x：Guest Mode 的唤起标识，回复时须带上 */
  guest_query_id?: string;
  guest_bot_caller_user?: TelegramUser;
  guest_bot_caller_chat?: TelegramChat;
  /** 10.x：Ephemeral / Business / Widget 等 */
  receiver_user?: TelegramUser;
  ephemeral_message_id?: string;
  business_connection_id?: string;
  widget?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  inline_message_id?: string;
  chat_instance?: string;
  data?: string;
  game_short_name?: string;
  [key: string]: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  [key: string]: unknown;
}

export interface TelegramApiResponse<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number; [key: string]: unknown };
}

export interface TelegramWebhookInfo {
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  ip_address?: string;
  last_error_date?: number;
  last_error_message?: string;
  last_synchronization_error_date?: number;
  max_connections?: number;
  allowed_updates?: string[];
}

export interface TelegramBotProfile {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
  can_join_groups?: boolean;
  can_read_all_group_messages?: boolean;
  supports_inline_queries?: boolean;
  can_connect_to_business?: boolean;
  has_main_web_app?: boolean;
  [key: string]: unknown;
}

export interface TelegramReconnectStatus {
  reconnecting: boolean;
  attempts: number;
  maxAttempts: number;
  intervalMs: number;
  abandoned: boolean;
}

/** Bot API 端点的最小契约（ConnectionManager 的 ActionCallableClient 也满足） */
export interface TelegramEndpoint {
  readonly id: string;
  readonly name: string;
  isConnected: boolean;
  callAction(action: string, params?: Record<string, unknown>): Promise<unknown>;
  stop(): void;
  getBotUser(): TelegramBotProfile | null;
  getReconnectStatus(): TelegramReconnectStatus;
  getWebhookInfo(): TelegramWebhookInfo | null;
  /** 供 Webhook 中间件投递 Update（含 secret_token 校验与事件派发） */
  acceptWebhookUpdate(update: TelegramUpdate, secretHeader?: string): Promise<boolean>;
  /** 响应内直接回复：取回本次 update 产生的首个可直回 API 调用 */
  takeResponseMethod?(updateId: number): Record<string, unknown> | null;
}

// ───────────────────────────── 纯函数 ─────────────────────────────

const MDV2_SPECIAL = /[_*\[\]()~`>#+\-=|{}.!\\]/g;

/** MarkdownV2 转义：官方要求 18 个特殊字符全部转义，否则报 "can't parse entities" */
export function escapeMarkdownV2(text: string): string {
  return String(text ?? '').replace(MDV2_SPECIAL, (ch) => `\\${ch}`);
}

/** HTML 解析模式下的实体转义（Bot API 只支持有限的标签集） */
export function escapeHtml(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 规范化 API 基址：空值回落官方服务器；容错去掉尾斜杠与误填的 /bot 尾巴 */
export function normalizeTelegramApiBase(base?: string): string {
  const trimmed = String(base || '').trim().replace(/\/+$/, '');
  if (!trimmed) return TELEGRAM_DEFAULT_API_BASE;
  if (!/^https?:\/\//i.test(trimmed)) return TELEGRAM_DEFAULT_API_BASE;
  return trimmed.replace(/\/bot[^/]*$/i, '');
}

/**
 * 拼 Bot API 请求地址。
 * - 官方：`https://api.telegram.org/bot<token>/<METHOD>`
 * - 测试环境：`https://api.telegram.org/bot<token>/test/<METHOD>`
 * - 本地 Bot API Server：`http://127.0.0.1:8081/bot<token>/<METHOD>`
 */
export function buildTelegramApiUrl(
  base: string,
  token: string,
  method: string,
  testEnv = false,
): string {
  const root = normalizeTelegramApiBase(base);
  const t = String(token || '').trim();
  const m = String(method || '').trim().replace(/^\/+/, '');
  return `${root}/bot${t}${testEnv ? '/test' : ''}/${m}`;
}

/** 判断一个 Update 属于哪种类型（官方保证最多一个可选字段有值） */
export function telegramUpdateType(update: unknown): string {
  if (!update || typeof update !== 'object') return 'unknown';
  const u = update as Record<string, unknown>;
  for (const key of TELEGRAM_ALL_UPDATE_TYPES) {
    if (u[key] !== undefined && u[key] !== null) return key;
  }
  return 'unknown';
}

/**
 * 解析 `/command[@BotUsername] [args]`。
 * 群里带 @别的机器人 的命令会原样返回并带上 target，由插件决定是否忽略
 * （官方：update 里不含 command scope，后端必须自己校验权限）。
 */
export function parseTelegramCommand(
  text: string,
  botUsername?: string,
): { command: string; args: string; target?: string } | null {
  const raw = String(text ?? '').trim();
  const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,32}))?(?:\s+([\s\S]*))?$/.exec(raw);
  if (!m) return null;
  const target = m[2];
  return target ? { command: m[1], args: (m[3] ?? '').trim(), target } : { command: m[1], args: (m[3] ?? '').trim() };
}

/** Telegram chat.type → 插件生态熟悉的 OneBot message_type */
export function telegramChatTypeToOneBot(type?: string): 'private' | 'group' | 'channel' {
  if (type === 'private') return 'private';
  if (type === 'channel') return 'channel';
  return 'group';
}

/** 把一条 Telegram Message 拆成 OneBot v11 风格的消息段数组 */
export function telegramMessageToOb11Segments(message: TelegramMessage): Array<{ type: string; data: Record<string, unknown> }> {
  const seg: Array<{ type: string; data: Record<string, unknown> }> = [];
  const text = message.text ?? message.caption;
  if (text) seg.push({ type: 'text', data: { text } });
  if (message.reply_to_message) {
    seg.unshift({ type: 'reply', data: { id: String(message.reply_to_message.message_id) } });
  }
  const media = (
    kind: string,
    value: { file_id?: string; file_name?: string; [key: string]: unknown } | undefined,
  ) => {
    if (!value?.file_id) return;
    seg.push({
      type: kind,
      data: {
        file: value.file_id,
        file_id: value.file_id,
        ...(value.file_name ? { file_name: value.file_name } : {}),
        ...(value.file_size ? { file_size: value.file_size } : {}),
      },
    });
  };
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    media('image', { file_id: largest?.file_id, file_size: largest?.file_size });
  }
  media('video', message.video);
  media('record', message.voice);
  media('audio', message.audio);
  media('file', message.document);
  media('animation', message.animation);
  media('video_note', message.video_note);
  if (message.sticker?.file_id) {
    seg.push({ type: 'sticker', data: { file: message.sticker.file_id, file_id: message.sticker.file_id, emoji: message.sticker.emoji } });
  }
  if (message.location) seg.push({ type: 'location', data: { ...message.location } });
  if (message.contact) seg.push({ type: 'contact', data: { ...message.contact } });
  if (message.poll) seg.push({ type: 'poll', data: { ...message.poll } });
  if (message.dice) seg.push({ type: 'dice', data: { ...message.dice } });
  if (message.new_chat_members?.length) {
    seg.push({ type: 'notice', data: { notice_type: 'group_increase', users: message.new_chat_members } });
  }
  if (message.left_chat_member) {
    seg.push({ type: 'notice', data: { notice_type: 'group_decrease', user: message.left_chat_member } });
  }
  return seg;
}

/**
 * Update → 框架插件事件对象。
 *
 * 兼容策略：
 * 1. 生成 OneBot 风格字段（post_type / message_type / user_id / group_id /
 *    message / raw_message），让习惯 kakake-plugin-* 写法的插件能平滑迁移；
 * 2. `raw` 保留整个原生 Update，`telegram` 标记协议，插件可直接用原生结构；
 * 3. `update_type` 明确事件种类，callback_query / inline_query / 成员变动等
 *    非消息事件用 post_type=notice/request，避免刷进 plugin_onmessage 的文本逻辑。
 */
export function telegramUpdateToEvent(
  update: unknown,
  botUsername?: string,
): Record<string, unknown> {
  const u = (update && typeof update === 'object' ? update : {}) as TelegramUpdate & Record<string, unknown>;
  const updateType = telegramUpdateType(u);
  const now = Date.now();
  const base: Record<string, unknown> = {
    time: now,
    self_id: 0,
    post_type: 'notice',
    telegram: true,
    platform: 'telegram',
    protocol: 'telegram',
    update_id: u.update_id ?? 0,
    update_type: updateType,
    raw: u,
    t: updateType,
  };

  const messageFields = [
    'message', 'edited_message', 'channel_post', 'edited_channel_post',
    'business_message', 'edited_business_message', 'guest_message',
  ];
  if (messageFields.includes(updateType)) {
    const message = u[updateType] as TelegramMessage | undefined;
    if (message) {
      const chat = message.chat ?? ({} as TelegramChat);
      const from = message.from ?? ({} as TelegramUser);
      const text = String(message.text ?? message.caption ?? '');
      const command = text.startsWith('/') ? parseTelegramCommand(text, botUsername) : null;
      const segments = telegramMessageToOb11Segments(message);
      const messageType = telegramChatTypeToOneBot(chat.type);
      Object.assign(base, {
        post_type: 'message',
        sub_type: updateType.startsWith('edited') ? 'edited' : (chat.type === 'private' ? 'friend' : 'normal'),
        message_type: messageType,
        message_id: message.message_id,
        user_id: from.id ?? 0,
        group_id: messageType === 'private' ? undefined : chat.id,
        chat_id: chat.id,
        chat_type: chat.type,
        message_thread_id: message.message_thread_id,
        business_connection_id: message.business_connection_id,
        guest_query_id: message.guest_query_id,
        message: segments,
        raw_message: text,
        sender: from,
        chat,
        font: 0,
        ...(command ? { command: command.command, command_args: command.args, command_target: command.target } : {}),
        ...(message.reply_to_message ? { reply_to_message_id: message.reply_to_message.message_id } : {}),
      });
    }
    return base;
  }

  if (updateType === 'callback_query') {
    const q = u.callback_query as TelegramCallbackQuery | undefined;
    Object.assign(base, {
      post_type: 'notice',
      notice_type: 'callback_query',
      callback_query_id: q?.id,
      callback_data: q?.data ?? '',
      inline_message_id: q?.inline_message_id,
      chat_instance: q?.chat_instance,
      user_id: q?.from?.id ?? 0,
      chat_id: q?.message?.chat?.id,
      message_id: q?.message?.message_id,
      raw_message: q?.data ?? q?.game_short_name ?? '',
    });
    return base;
  }

  if (updateType === 'inline_query' || updateType === 'chosen_inline_result') {
    const q = (u[updateType] ?? {}) as Record<string, unknown>;
    Object.assign(base, {
      post_type: 'request',
      request_type: updateType,
      query_id: q.id,
      query: q.query ?? '',
      offset: q.offset ?? '',
      user_id: (q.from as TelegramUser | undefined)?.id ?? 0,
      raw_message: String(q.query ?? ''),
    });
    return base;
  }

  if (updateType === 'chat_join_request') {
    const r = (u.chat_join_request ?? {}) as Record<string, unknown>;
    Object.assign(base, {
      post_type: 'request',
      request_type: 'chat_join_request',
      chat_id: (r.chat as TelegramChat | undefined)?.id,
      user_id: (r.from as TelegramUser | undefined)?.id ?? 0,
    });
    return base;
  }

  // 其余全部归为 notice（成员变动、反应、投票、支付、Business、Guest、Widget、
  // Managed Bots、订阅、停止生成等），插件可按 update_type / notice_type 细分。
  Object.assign(base, {
    post_type: 'notice',
    notice_type: updateType === 'unknown' ? 'unknown' : updateType,
    payload: u[updateType],
  });
  const payload = u[updateType] as Record<string, unknown> | undefined;
  if (payload && typeof payload === 'object') {
    if (typeof payload.user_id === 'number') base.user_id = payload.user_id;
    if (typeof payload.chat_id === 'number' || typeof payload.chat_id === 'string') base.chat_id = payload.chat_id;
    const chat = payload.chat as TelegramChat | undefined;
    if (chat?.id !== undefined) base.chat_id = chat.id;
    const user = (payload.from ?? payload.user) as TelegramUser | undefined;
    if (user?.id !== undefined) base.user_id = user.id;
  }
  return base;
}

/**
 * Telegram 上报预览格式化（与 OneBot formatOb11Event / QQ 官方格式化同风格）。
 * 把结构化的 Update 转成一行可读摘要：按消息内容类型打 [图片]/[视频]/[语音]… 标签，
 * 群/私聊带发言人，便于在日志/消息监控里一眼区分消息种类。
 * 参考 https://core.telegram.org/bots/api（Bot API 10.x 的 Message 与 Update 全字段）。
 *
 * 以前这里只对 `text` / `callback_query.data` 做了展示，其它类型（图片、语音、贴纸、
 * 位置、名片、群服务消息、成员变动、表情回应……）一律留空，于是监控页里 TG 上报
 * 「只有纯文本能看，其它都是空白」。本函数把 Bot API 的全部消息/事件类型都覆盖上。
 */
export interface TelegramFormattedUpdate {
  message: string;
  detail?: string;
  raw: string;
}

/** 用户可读名：昵称( @username)，兜底 id */
function tgName(user?: TelegramUser): string {
  if (!user) return '';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  const uname = user.username ? `@${user.username}` : '';
  if (name && uname) return `${name} (${uname})`;
  return name || uname || String(user.id ?? '');
}

/** 会话可读名：群/频道取标题，私聊取 @username 或名 */
function tgChatLabel(chat?: TelegramChat): string {
  if (!chat) return '';
  if (chat.type === 'private') {
    const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
    if (chat.username) return `@${chat.username}`;
    return name || String(chat.id);
  }
  if (chat.title) return chat.title;
  if (chat.username) return `@${chat.username}`;
  return String(chat.id);
}

/** 一条 Message 的正文预览：媒体打类型标签、文本/配文正常显示，与 OneBot [图片] 风格对齐 */
function telegramMessagePreview(message: TelegramMessage): string {
  const tags: string[] = [];
  // ── 媒体 / 非文本附件：先打标签，用户一眼能区分是什么类型 ──
  if (Array.isArray(message.photo) && message.photo.length) tags.push('[图片]');
  if (message.video) tags.push('[视频]');
  if (message.video_note) tags.push('[圆形视频]');
  if (message.voice) tags.push('[语音]');
  if (message.audio) tags.push('[音频]');
  if (message.document) {
    const fn = typeof message.document.file_name === 'string' ? ` ${message.document.file_name}` : '';
    tags.push(`[文件${fn}]`);
  }
  if (message.animation) tags.push('[动画]');
  if (message.sticker) tags.push(`[贴纸 ${message.sticker.emoji ?? ''}]`.trim());
  if (message.location) tags.push('[位置]');
  if (message.venue) tags.push(`[地点 ${message.venue.title ?? ''}]`.trim());
  if (message.contact) {
    const c = message.contact as Record<string, unknown>;
    const label = c.first_name ? String(c.first_name) : c.phone_number ? String(c.phone_number) : '';
    tags.push(`[联系人${label ? ` ${label}` : ''}]`.trim());
  }
  if (message.poll) tags.push('[投票]');
  if (message.dice) tags.push(`[骰子 ${message.dice.emoji ?? ''}]`.trim());
  if (message.game) tags.push(`[游戏 ${message.game.title ?? ''}]`.trim());
  if (message.invoice) tags.push(`[商品 ${typeof message.invoice.title === 'string' ? message.invoice.title : ''}]`.trim());
  if (message.successful_payment) tags.push('[支付成功]');
  if (message.connected_website) tags.push('[网页授权]');
  // ── 转发 / 回复 ──
  if (message.forward_from || message.forward_from_chat) tags.push('[转发]');
  if (message.reply_to_message) tags.push('[回复]');
  // ── 群服务消息 ──
  if (message.new_chat_members?.length) tags.push(`[新成员 ×${message.new_chat_members.length}]`);
  if (message.left_chat_member) tags.push(`[退群 ${tgName(message.left_chat_member)}]`);
  if (message.new_chat_title) tags.push(`[改群名 → ${message.new_chat_title}]`);
  if (message.new_chat_photo) tags.push('[改群头像]');
  if (message.delete_chat_photo) tags.push('[删群头像]');
  if (message.pinned_message) tags.push('[置顶消息]');
  if (message.group_chat_created) tags.push('[创建群]');
  if (message.supergroup_chat_created) tags.push('[升级超级群]');
  if (message.channel_chat_created) tags.push('[创建频道]');

  const text = message.text ?? message.caption ?? '';
  const parts: string[] = [];
  if (tags.length) parts.push(tags.join(' '));
  if (text) parts.push(text);
  if (!parts.length) parts.push('(非文本)');
  const joined = parts.join(' ');
  return joined.length > 200 ? `${joined.slice(0, 200)}…` : joined;
}

/**
 * Update → 上报预览（与 OneBot formatOb11Event / QQ 官方格式化同风格）。
 * 覆盖 Bot API 全部 Update 类型（消息类 / callback / inline / 支付 / 投票 / 成员变动 /
 * 表情回应 / Business / Widget / 订阅等），确保任意消息在监控页都有可读预览，不再留白。
 */
export function formatTelegramUpdate(
  update: unknown,
  botUsername?: string,
): TelegramFormattedUpdate {
  void botUsername; // 保留签名兼容，命令解析在 telegramUpdateToEvent 内完成
  const raw = JSON.stringify(update);
  const u = (update && typeof update === 'object' ? update : {}) as TelegramUpdate & Record<string, unknown>;
  const updateType = telegramUpdateType(u);
  const detail = raw.length <= 2048 ? raw : `${raw.slice(0, 2048)}…`;

  const messageFields = [
    'message', 'edited_message', 'channel_post', 'edited_channel_post',
    'business_message', 'edited_business_message', 'guest_message',
  ];
  if (messageFields.includes(updateType)) {
    const message = u[updateType] as TelegramMessage | undefined;
    if (message) {
      const chat = message.chat ?? ({} as TelegramChat);
      const from = message.from ?? ({} as TelegramUser);
      const isChannel = updateType === 'channel_post' || updateType === 'edited_channel_post';
      const scope = isChannel ? '频道' : (chat.type === 'private' ? '私聊' : '群');
      const edited = updateType.startsWith('edited') ? '✎ ' : '';
      const who = chat.type === 'private' ? tgName(from) : `${tgChatLabel(chat)} · ${tgName(from)}`;
      const business = message.business_connection_id ? ' [Business]' : '';
      return { message: `message · ${scope} ${who}: ${edited}${telegramMessagePreview(message)}${business}`, detail, raw };
    }
  }

  if (updateType === 'callback_query') {
    const q = u.callback_query as TelegramCallbackQuery | undefined;
    const data = q?.data ?? q?.game_short_name ?? '';
    return { message: `callback_query · ${tgName(q?.from)}: ${data ? `[回调数据] ${data}` : '[回调]'}`, detail, raw };
  }

  if (updateType === 'inline_query' || updateType === 'chosen_inline_result') {
    const q = (u[updateType] ?? {}) as Record<string, unknown>;
    const query = String(q.query ?? '');
    return { message: `${updateType} · ${tgName(q.from as TelegramUser | undefined)}: ${query ? `[查询] ${query}` : '[查询]'}`, detail, raw };
  }

  if (updateType === 'shipping_query') {
    const q = (u[updateType] ?? {}) as Record<string, unknown>;
    return { message: `shipping_query · ${tgName(q.from as TelegramUser | undefined)}: ${String(q.invoice_payload ?? '')}`, detail, raw };
  }

  if (updateType === 'pre_checkout_query') {
    const q = (u[updateType] ?? {}) as Record<string, unknown>;
    return { message: `pre_checkout_query · ${tgName(q.from as TelegramUser | undefined)}: ${String(q.currency ?? '')} ${String(q.total_amount ?? '')}`, detail, raw };
  }

  if (updateType === 'poll') {
    const p = (u.poll ?? {}) as Record<string, unknown>;
    const type = String(p.type ?? 'regular');
    const question = String(p.question ?? '');
    return { message: `poll · ${type === 'quiz' ? '[测验]' : '[投票]'} ${question}`, detail, raw };
  }

  if (updateType === 'poll_answer') {
    const p = (u.poll_answer ?? {}) as Record<string, unknown>;
    const optionIds = Array.isArray(p.option_ids) ? (p.option_ids as unknown[]).join(',') : '';
    return { message: `poll_answer · ${tgName(p.user as TelegramUser | undefined)}: 选项[${optionIds}]`, detail, raw };
  }

  if (updateType === 'my_chat_member' || updateType === 'chat_member') {
    const m = (u[updateType] ?? {}) as Record<string, unknown>;
    const oldStatus = (m.old_chat_member as Record<string, unknown> | undefined)?.status;
    const newStatus = (m.new_chat_member as Record<string, unknown> | undefined)?.status;
    return {
      message: `${updateType} · ${tgChatLabel(m.chat as TelegramChat | undefined)} · ${tgName(m.from as TelegramUser | undefined)}: ${oldStatus ?? '?'} → ${newStatus ?? '?'}`,
      detail, raw,
    };
  }

  if (updateType === 'chat_join_request') {
    const r = (u.chat_join_request ?? {}) as Record<string, unknown>;
    return { message: `chat_join_request · ${tgChatLabel(r.chat as TelegramChat | undefined)} · ${tgName(r.from as TelegramUser | undefined)}`, detail, raw };
  }

  if (updateType === 'chat_boost' || updateType === 'removed_chat_boost') {
    const c = (u[updateType] ?? {}) as Record<string, unknown>;
    const chat = c.chat as TelegramChat | undefined;
    const boost = c.boost as Record<string, unknown> | undefined;
    const boostId = String(c.boost_id ?? boost?.boost_id ?? '');
    return { message: `${updateType} · ${tgChatLabel(chat)}${boostId ? ` · ${boostId}` : ''}`, detail, raw };
  }

  if (updateType === 'message_reaction' || updateType === 'message_reaction_count') {
    const r = (u[updateType] ?? {}) as Record<string, unknown>;
    const chat = r.chat as TelegramChat | undefined;
    const actor = r.user ? tgName(r.user as TelegramUser | undefined) : '';
    const newReaction = Array.isArray(r.new_reaction)
      ? (r.new_reaction as Array<Record<string, unknown>>).map((rx) => String(rx.emoji ?? rx.type ?? '')).join('')
      : '';
    return { message: `${updateType} · ${tgChatLabel(chat)} · ${actor}: ${newReaction || '[表情回应]'}`, detail, raw };
  }

  if (updateType === 'business_connection') {
    const b = (u.business_connection ?? {}) as Record<string, unknown>;
    return { message: `business_connection · ${String(b.id ?? '')} · ${b.is_enabled ? '已启用' : '已停用'}`, detail, raw };
  }

  if (updateType === 'deleted_business_messages') {
    const b = (u.deleted_business_messages ?? {}) as Record<string, unknown>;
    return { message: `deleted_business_messages · ${tgChatLabel(b.chat as TelegramChat | undefined)}`, detail, raw };
  }

  if (updateType === 'widget_query' || updateType === 'shared_widget_query') {
    const q = (u[updateType] ?? {}) as Record<string, unknown>;
    return { message: `${updateType} · ${tgName(q.user as TelegramUser | undefined)}: ${String(q.data ?? '')}`, detail, raw };
  }

  if (['subscription', 'stopped_message_generation', 'purchased_paid_media', 'managed_bot'].includes(updateType)) {
    return { message: `${updateType}`, detail, raw };
  }

  // unknown / 其余归总
  return { message: `telegram · ${updateType}`, detail, raw };
}

function tgCut(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function tgPlain(s: string): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function tgFileName(v: unknown): string {
  if (typeof v === 'string') return v.split(/[\\/]/).pop() ?? v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.filename ?? o.file_name ?? '');
  }
  return '';
}

function tgChatTarget(v: unknown): string {
  if (v === undefined || v === null || v === '') return '';
  const s = String(v);
  if (/^-?\d+$/.test(s)) return s.startsWith('-') ? `群 ${s}` : `私 ${s}`;
  return s;
}

function tgReaction(v: unknown): string {
  if (!Array.isArray(v)) return '';
  return v.map((x) => String((x as Record<string, unknown>)?.emoji ?? '')).join('');
}

function tgMediaName(t: string): string {
  if (t === 'photo') return '图';
  if (t === 'video') return '视频';
  if (t === 'audio') return '音频';
  if (t === 'document') return '文件';
  return t;
}

function tgActionTag(method: string, p: Record<string, unknown>): string {
  switch (method) {
    case 'sendPhoto': return '[图片]';
    case 'sendVideo': return '[视频]';
    case 'sendAnimation': return '[动画]';
    case 'sendAudio': return `[音频 ${tgCut(String(p.title ?? tgFileName(p.audio)), 40)}]`.replace(/\s+\]$/, ']');
    case 'sendVoice': return '[语音]';
    case 'sendVideoNote': return '[圆形视频]';
    case 'sendDocument': return `[文件 ${tgCut(tgFileName(p.document), 40)}]`.replace(/\s+\]$/, ']');
    case 'sendSticker': return '[贴纸]';
    case 'sendMediaGroup': {
      const arr = Array.isArray(p.media) ? p.media as Array<Record<string, unknown>> : [];
      const count: Record<string, number> = {};
      for (const m of arr) {
        const t = String(m?.type ?? 'photo');
        count[t] = (count[t] ?? 0) + 1;
      }
      const parts = Object.entries(count).map(([t, n]) => `${tgMediaName(t)}${n > 1 ? `×${n}` : ''}`).join(' ');
      return `[媒体组 ×${arr.length}${parts ? ` ${parts}` : ''}]`;
    }
    case 'sendLocation': return `[位置 ${p.latitude ?? ''},${p.longitude ?? ''}]`;
    case 'sendVenue': return `[地点 ${tgCut(String(p.title ?? ''), 40)}]`.replace(/\s+\]$/, ']');
    case 'sendContact': return `[联系人 ${tgCut(String(p.first_name ?? ''), 40)}]`.replace(/\s+\]$/, ']');
    case 'sendPoll': return `${p.type === 'quiz' ? '[测验]' : '[投票]'} ${tgCut(String(p.question ?? ''), 80)}`;
    case 'sendDice': return `[骰子 ${p.emoji ?? '🎲'}]`;
    case 'editMessageText': return '[编辑文本]';
    case 'editMessageCaption': return '[编辑说明]';
    case 'editMessageMedia': return '[编辑媒体]';
    case 'editMessageReplyMarkup': return '[编辑按钮]';
    case 'deleteMessage': return `[删除] #${p.message_id ?? ''}`;
    case 'setMessageReaction': return `[回应 ${tgReaction(p.reaction)}]`;
    case 'answerCallbackQuery': return '[回调应答]';
    case 'answerInlineQuery': return `[内联结果 ×${Array.isArray(p.results) ? p.results.length : 0}]`;
    case 'sendChatAction': return `[状态 ${p.action ?? ''}]`;
    case 'copyMessage': return `[复制] #${p.message_id ?? ''}`;
    case 'forwardMessage': return `[转发] #${p.message_id ?? ''}`;
    case 'getChat': return '[查询会话]';
    case 'getChatMemberCount': return '[成员数]';
    case 'getChatAdministrators': return '[管理员列表]';
    case 'getChatMember': return '[成员信息]';
    case 'getMe': return '[机器人信息]';
    case 'setMyCommands': return `[设置命令 ×${Array.isArray(p.commands) ? p.commands.length : 0}]`;
    case 'getMyCommands': return '[读取命令]';
    case 'deleteMyCommands': return '[删除命令]';
    case 'getChatMenuButton': return '[读取菜单按钮]';
    case 'setChatMenuButton': return '[设置菜单按钮]';
    case 'getMyDescription': return '[读取描述]';
    case 'getMyShortDescription': return '[读取简短描述]';
    case 'getStickerSet': return `[贴纸集 ${tgCut(String(p.name ?? ''), 40)}]`.replace(/\s+\]$/, ']');
    case 'getFile': return '[查询文件]';
    case 'download_file':
    case 'downloadFile': return '[下载文件]';
    default: return '';
  }
}

/** 输出侧摘要：方法名 + 会话目标 + 内容类型标签 + 文本预览 */
export function formatTelegramAction(
  method: string,
  params: Record<string, unknown> = {},
): { message: string; detail?: string } {
  const p = params ?? {};
  const target = tgChatTarget(p.chat_id);
  const tag = tgActionTag(method, p);
  const head = `${method}${target ? ` → ${target}` : ''}${tag ? ` · ${tag}` : ''}`;
  const noText = new Set([
    'sendPoll', 'sendVenue', 'sendContact', 'sendDice', 'sendMediaGroup', 'sendChatAction',
    'sendLocation', 'getChat', 'getChatMemberCount', 'getChatAdministrators', 'getChatMember',
    'getMe', 'getMyCommands', 'deleteMyCommands', 'getChatMenuButton', 'setChatMenuButton',
    'getMyDescription', 'getMyShortDescription', 'getStickerSet', 'getFile',
    'download_file', 'downloadFile', 'deleteMessage', 'copyMessage', 'forwardMessage',
    'setMessageReaction',
  ]);
  const text = tgCut(tgPlain(String(p.text ?? p.caption ?? '')), 120);
  const message = text && !noText.has(method) ? `${head}: ${text}` : head;
  let detail = '';
  try {
    detail = JSON.stringify(p).slice(0, 2000);
  } catch {
    detail = '';
  }
  return { message, detail };
}
