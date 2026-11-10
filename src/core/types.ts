export interface KakakeConfig {
  host: string;
  port: number;
  token: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** OneBot API 调用超时（毫秒），大文件 send_msg 建议 120000+ */
  apiTimeoutMs: number;
  /**
   * 外放 API 开关：开启后 GET /api/public 免登录返回只读概览
   * （账号列表 / 运行时长 / 日志上报接收与输出总数）。默认关闭。
   */
  publicApiEnabled: boolean;
  /**
   * 接口代理外放开关：开启后 `POST/GET /api/v1/<接口短名>` 对外可用
   * （需带控制台 Bearer 密钥，且按来源限流）。默认关闭。
   *
   * 与 publicApiEnabled 分成两个开关是有意的：前者放开的是「只读概览」，
   * 后者放开的是「能真的以机器人身份发消息」——风险量级完全不同，
   * 不能因为想给外部看个概览就连带把发消息能力暴露出去。
   */
  proxyApiEnabled: boolean;
  /**
   * AI 写入确认闸门：开启（默认）时 write_file / edit_file 只落「暂存区」，
   * 用户在 AI 页「待应用改动」面板里显式应用后才真正写盘，应用前可放弃、
   * 应用后可一键回滚——兑现 README「改动需人工确认后才部署」的承诺。
   * 关闭则恢复直写行为（写盘立即生效），不改变任何既有工作流。
   */
  aiWriteConfirm: boolean;
  /**
   * 日志写进文件：开启（默认）时日志照旧落盘 log/ 目录并进内存环形缓冲
   * （控制台日志页可翻历史）。关闭后日志不再写文件、也不驻留内存——
   * 条目只实时推给在线的控制台（SSE），看一眼即逝，刷新/重开页面不恢复，
   * 磁盘与内存都不占。收发计数不受影响（概览页数字照常累计）。
   */
  logToFile: boolean;
  inboundGuard: boolean;
  /**
   * AI 单轮任务最大步数（可选）：缺省 60，读取端 src/ai/ai-agent.ts 的 resolveMaxSteps()。
   * 上限防模型死循环烧钱，下限防误配成跑不了任务；保存端点必须用 normalizeAiMaxSteps 同规则整型化。
   */
  aiMaxSteps?: number;
}

export const DEFAULT_AI_MAX_STEPS = 60;
export const MIN_AI_MAX_STEPS = 10;
export const MAX_AI_MAX_STEPS = 200;

/** 与 ai-agent 的 resolveMaxSteps 同规则：非有限值回缺省，整型化后 clamp [10, 200]。 */
export function normalizeAiMaxSteps(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_AI_MAX_STEPS;
  return Math.min(MAX_AI_MAX_STEPS, Math.max(MIN_AI_MAX_STEPS, n));
}

export const DEFAULT_API_TIMEOUT_MS = 120_000;

export function normalizeApiTimeoutMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_API_TIMEOUT_MS;
  return Math.min(600_000, Math.max(5_000, Math.floor(n)));
}

/** 连接协议类型：OneBot、QQ 开放平台官方机器人、微信 iLink BOT、KOOK、Telegram Bot */
export type ConnectionType = 'onebot' | 'qq_official' | 'weixin_bot' | 'kook' | 'telegram';

/**
 * 连接模式：
 * - reverse / forward：WebSocket
 * - http：HTTP 服务器（收 POST 事件 + 调对端 HTTP API）
 * - http_sse：连接对端 HTTP SSE 服务端
 * - http_client：HTTP 客户端（调对端 HTTP API + 事件上报到框架路径）
 * - https：QQ 官方 HTTPS Webhook（仅 qq_official）
 * - polling：Telegram Bot `getUpdates` 长轮询（仅 telegram）
 * - webhook：Telegram Bot `setWebhook` HTTPS 回调（仅 telegram）
 *
 * 注意：Telegram 的两种模式与「本地 Bot API Server」是正交的——后者由
 * `telegramApiBase` 决定请求发到官方服务器还是自建服务器，两种模式都能用。
 */
export type ConnectionMode = 'reverse' | 'forward' | 'http' | 'http_sse' | 'http_client' | 'https' | 'polling' | 'webhook';

/** Telegram Bot 的两种收更新方式（getUpdates / Webhook 互斥，官方文档明确二选一） */
export type TelegramMode = 'polling' | 'webhook';

export type ConnectionLogLayout = 'legacy' | 'account';

export const ONEBOT_WS_MODES: ConnectionMode[] = ['reverse', 'forward'];
export const ONEBOT_HTTP_MODES: ConnectionMode[] = ['http', 'http_sse', 'http_client'];
export const ONEBOT_RECONNECT_MODES: ConnectionMode[] = ['forward', 'http_client'];

export interface ConnectionConfig {
  id: string;
  name: string;
  /** 默认 onebot；qq_official 为 QQ 开放平台官方机器人 */
  type?: ConnectionType;
  /** 见 ConnectionMode；onebot 用；qq_official 可用 https 表示 Webhook */
  mode?: ConnectionMode;
  /** 反向/HTTP服务器/HTTP SSE服务器：咔咔珂监听地址；正向/HTTP客户端：对端地址 */
  host: string;
  /** 反向/HTTP服务器/HTTP SSE服务器：咔咔珂监听端口；正向/HTTP客户端：对端端口 */
  port: number;
  accessToken?: string;
  enable: boolean;
  /**
   * HTTP / HTTP SSE 服务器模式：OneBot 协议端 HTTP API 根地址（如 http://127.0.0.1:3000）
   * 未填时默认 http://127.0.0.1:3000
   */
  apiUrl?: string;
  /**
   * QQ 官方 HTTPS Webhook：公网回调基址（如 https://bot.example.com）
   * 用于界面展示/复制完整回调 URL；实际监听仍在咔咔主端口 /gfbot/:id
   */
  webhookBaseUrl?: string;
  /** 正向 WS / HTTP SSE / QQ官方：意外断开后自动重连间隔（毫秒），默认 5000 */
  reconnectIntervalMs?: number;
  /** 正向 WS / HTTP SSE / QQ官方：最大重连次数，默认 15；0=无限重试直到手动关闭 */
  reconnectMaxAttempts?: number;
  /**
   * OneBot：连接成功后上报的机器人 QQ 号（self_id）
   * 用于 plugins_two/<botUin> 与 data/<botUin>/ 锁定
   */
  botUin?: string;
  /** QQ 官方：AppID */
  appId?: string;
  /** QQ 官方：AppSecret */
  appSecret?: string;
  /**
   * OneBot：连接背后的协议端实现。
   *
   * NapCat 与 SnowLuma 都自称 OneBot v11，但同一个功能两边的 action 名与参数键名
   * 并不总是一致，接口代理必须知道对面坐的是谁才能选对变体。
   *   - 'auto'（默认）：连上后发一次 `get_version_info` 探测，按 `app_name` 认实现
   *   - 'napcat' / 'snowluma'：显式指定，以指定为准，不做任何探测
   */
  onebotImpl?: 'auto' | 'napcat' | 'snowluma';
  /** QQ 官方：是否沙箱环境 */
  sandbox?: boolean;
  /**
   * QQ 官方 Webhook：op=13 回调校验未带签名头时是否一律拒绝（默认 false）。
   *
   * 背景：op=13 若请求不带 X-Signature-*，框架会按平台文档直接回签名——这等于
   * 把「用 AppSecret 派生密钥签任意数据」的能力借给了任何能访问 /gfbot/<id> 的人
   * （签名 oracle）。部分平台/旧文档的校验请求确实不带签名头，为不破坏既有部署，
   * 默认保持兼容；公网直挂 webhook 的部署建议开启此项强制验签。
   */
  requireValidationSignature?: boolean;
  /** QQ 官方：Gateway Intents 位标志；留空（或 0）用内置默认组合 */
  intents?: number;
  /** QQ 官方：缓存的机器人资料（GET /users/@me） */
  botProfile?: {
    id: string;
    username: string;
    avatar: string;
    unionOpenid?: string;
    desc?: string;
    shareUrl?: string;
    fetchedAt: number;
  };
  /** 微信 BOT：iLink bot_token */
  weixinToken?: string;
  /** 微信 BOT：API 基址（扫码确认后返回） */
  weixinBaseUrl?: string;
  /** 微信 BOT：ilink_bot_id，作为账号隔离键 */
  weixinAccountId?: string;
  /** 微信 BOT：ilink_user_id */
  weixinUserId?: string;
  /** 微信 BOT：getUpdates 游标 */
  weixinGetUpdatesBuf?: string;
  /** KOOK：机器人 Token（Authorization: Bot <token>） */
  kookToken?: string;
  /** KOOK：缓存的机器人用户 ID（GET /users/@me），账号隔离键 */
  kookBotUserId?: string;
  /** KOOK：缓存的机器人用户名 */
  kookBotUsername?: string;
  /** KOOK：缓存的机器人认证数字（用户名#编号 的编号段） */
  kookBotIdentifyNum?: string;
  /** KOOK：缓存的机器人头像 */
  kookBotAvatar?: string;
  // ───────────────────────── Telegram Bot ─────────────────────────
  /** BotFather 签发的 token（形如 `123456:ABC-DEF...`），全部权限，等同密钥 */
  telegramToken?: string;
  /** getMe 得到的机器人 ID，作为 plugins_two/ 账号隔离键 */
  telegramBotUserId?: string;
  /** getMe 得到的 @username（不带 @） */
  telegramBotUsername?: string;
  /** getMe 得到的显示名 */
  telegramBotFirstName?: string;
  /** getUserProfilePhotos 缓存的头像 */
  telegramBotAvatar?: string;
  /**
   * Bot API 基址。默认 `https://api.telegram.org`；填自建地址即切换到
   * 本地 Bot API Server（可用 HTTP / 任意端口、上传 2000MB、下载无大小限制、
   * getFile 直接返回本地绝对路径）。
   */
  telegramApiBase?: string;
  /** 是否走测试环境：`/bot<token>/test/METHOD_NAME` */
  telegramTestEnv?: boolean;
  /** Webhook：完整公网回调 URL（本地 Bot API Server 时可为 http 内网地址） */
  telegramWebhookUrl?: string;
  /** Webhook：secret_token，1-256 位，仅 A-Z a-z 0-9 _ -；对应 X-Telegram-Bot-Api-Secret-Token 头 */
  telegramWebhookSecret?: string;
  /** Webhook：并发连接数 1-100（本地服务器可到 100000） */
  telegramWebhookMaxConnections?: number;
  /** Webhook：固定投递 IP（替代 DNS 解析） */
  telegramWebhookIpAddress?: string;
  /** Webhook：自签公钥证书 PEM 路径（作为 certificate InputFile 上传） */
  telegramWebhookCertificatePath?: string;
  /** 订阅的 Update 类型；留空用框架默认全集（含 chat_member / message_reaction 等需显式订阅的类型） */
  telegramAllowedUpdates?: string[];
  /** 切换接入方式时丢弃积压更新 */
  telegramDropPendingUpdates?: boolean;
  /** getUpdates 长轮询超时（秒），默认 30 */
  telegramPollingTimeout?: number;
  /** getUpdates 单次取回上限 1-100，默认 100 */
  telegramPollingLimit?: number;
  /** getUpdates 游标（offset = 已处理最大 update_id + 1），持久化避免重启后重复收 */
  telegramOffset?: number;
  /** 可选 HTTP 代理地址（如 http://127.0.0.1:7897），用于服务器无法直连 Telegram 的场景 */
  telegramProxyUrl?: string;
  /** Webhook 模式下把本次事件产生的首个 API 调用直接放进 2xx 响应体（省一次请求，拿不到 result） */
  telegramWebhookReplyInResponse?: boolean;
  /** 默认文本解析模式：HTML（默认，最省心）| MarkdownV2 | Markdown | Rich */
  telegramParseMode?: 'HTML' | 'MarkdownV2' | 'Markdown' | 'Rich';
  /** 首次添加时间（毫秒时间戳）；同状态排序时越早越靠前 */
  createdAt?: number;
  logLayout?: ConnectionLogLayout;
}

/** 从磁盘读取的原始连接项（可能含旧版 url 字段） */
interface StoredConnectionConfig extends Partial<ConnectionConfig> {
  id: string;
  name: string;
  type?: ConnectionType;
  mode?: ConnectionMode;
  url?: string;
}

export interface ConnectionsFile {
  connections: ConnectionConfig[];
}

export type StoredConnectionsFile = {
  connections: StoredConnectionConfig[];
};

export type PluginStatusConfig = Record<string, boolean>;

/** 各连接独立的插件开关：connectionId -> pluginId -> enable */
export type ConnectionPluginsConfig = Record<string, Record<string, boolean>>;

export const DEFAULT_CONFIG: KakakeConfig = {
  host: '0.0.0.0',
  port: 8787,
  token: '',
  logLevel: 'info',
  apiTimeoutMs: DEFAULT_API_TIMEOUT_MS,
  publicApiEnabled: false,
  proxyApiEnabled: false,
  aiWriteConfirm: true,
  logToFile: true,
  inboundGuard: true,
};

export const DEFAULT_CONNECTIONS: ConnectionsFile = {
  connections: [
    {
      id: 'default',
      name: 'NapCat 默认接入',
      type: 'onebot',
      mode: 'reverse',
      host: '127.0.0.1',
      port: 6700,
      accessToken: '',
      enable: false,
      createdAt: 1,
    },
  ],
};

/**
 * 仅判断“类型是 QQ 官方连接”。
 *
 * 注意：**不**保证 appId / appSecret 已填（它们本身是可选字段）。
 * 需要凭证的地方必须自己再判空，别把这个断言当成“凭证完备”。
 */
export function isQqOfficialConnection(
  conn: Pick<ConnectionConfig, 'type'>,
): conn is ConnectionConfig & { type: 'qq_official' } {
  return (conn.type ?? 'onebot') === 'qq_official';
}

export function isWeixinBotConnection(conn: Pick<ConnectionConfig, 'type'>): boolean {
  return (conn.type ?? 'onebot') === 'weixin_bot';
}

export function isOnebotConnection(conn: Pick<ConnectionConfig, 'type'>): boolean {
  return (conn.type ?? 'onebot') === 'onebot';
}

export function isKookConnection(conn: Pick<ConnectionConfig, 'type'>): boolean {
  return (conn.type ?? 'onebot') === 'kook';
}

/** 仅判断「类型是 Telegram Bot 连接」；不保证 token 已填 */
export function isTelegramConnection(
  conn: Pick<ConnectionConfig, 'type'>,
): conn is ConnectionConfig & { type: 'telegram' } {
  return (conn.type ?? 'onebot') === 'telegram';
}

export function kookConnectionReady(conn: ConnectionConfig): boolean {
  return !!String(conn.kookToken || '').trim();
}

export function telegramConnectionReady(conn: ConnectionConfig): boolean {
  return !!String(conn.telegramToken || '').trim();
}

/** Telegram 连接的接入方式：默认长轮询（无需公网地址，开箱即用） */
export function parseTelegramMode(value: unknown): TelegramMode {
  return value === 'webhook' ? 'webhook' : 'polling';
}

/** Telegram 连接在 UI 中展示的摘要 */
export function telegramConnectionSummary(conn: ConnectionConfig): string {
  if (!isTelegramConnection(conn)) return '';
  if (!telegramConnectionReady(conn)) return '未配置 Bot Token';
  const user = String(conn.telegramBotUsername || '').trim();
  const mode = parseTelegramMode(conn.mode);
  const modeLabel = mode === 'webhook' ? 'Webhook' : '长轮询';
  const env = conn.telegramTestEnv ? ' · 测试环境' : '';
  const local = conn.telegramApiBase && !/api\.telegram\.org/i.test(conn.telegramApiBase)
    ? ' · 本地 API' : '';
  return user ? `@${user} · ${modeLabel}${env}${local}` : `Token 已配置 · ${modeLabel}${env}${local}`;
}

export function weixinBotLoggedIn(conn: ConnectionConfig): boolean {
  return !!(
    String(conn.weixinToken || '').trim()
    && String(conn.weixinBaseUrl || '').trim()
    && String(conn.weixinAccountId || '').trim()
  );
}

export function resolveQqOfficialApiBase(sandbox?: boolean): string {
  return sandbox
    ? 'https://sandbox.api.sgroup.qq.com'
    : 'https://api.sgroup.qq.com';
}

export function parseConnectionMode(value: unknown): ConnectionMode {
  if (value === 'forward' || value === 'http' || value === 'http_sse' || value === 'http_client') {
    return value;
  }
  return 'reverse';
}

export function isReconnectableOnebotMode(mode?: ConnectionMode): boolean {
  return mode === 'forward' || mode === 'http_client';
}

/** 将旧版 url 格式迁移为 host + port */
const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

export function normalizeConnection(conn: StoredConnectionConfig): ConnectionConfig {
  const type: ConnectionType =
    conn.type === 'qq_official' ? 'qq_official'
      : conn.type === 'weixin_bot' ? 'weixin_bot'
        : conn.type === 'kook' ? 'kook'
          : conn.type === 'telegram' ? 'telegram'
            : 'onebot';

  if (type === 'telegram') {
    const allowed = Array.isArray(conn.telegramAllowedUpdates)
      ? conn.telegramAllowedUpdates
        .map((v) => String(v || '').trim())
        .filter((v) => /^[a-z_]+$/.test(v))
      : undefined;
    const base: ConnectionConfig = {
      id: conn.id,
      name: conn.name,
      type: 'telegram',
      mode: parseTelegramMode(conn.mode),
      host: '',
      port: 0,
      enable: conn.enable ?? false,
      telegramToken: String(conn.telegramToken || '').trim(),
      telegramBotUserId: conn.telegramBotUserId ? String(conn.telegramBotUserId).trim() : undefined,
      telegramBotUsername: conn.telegramBotUsername ? String(conn.telegramBotUsername).trim() : undefined,
      telegramBotFirstName: conn.telegramBotFirstName,
      telegramBotAvatar: conn.telegramBotAvatar,
      telegramApiBase: String(conn.telegramApiBase || '').trim().replace(/\/+$/, '') || undefined,
      telegramTestEnv: conn.telegramTestEnv === true,
      telegramWebhookUrl: String(conn.telegramWebhookUrl || '').trim() || undefined,
      telegramWebhookSecret: String(conn.telegramWebhookSecret || '').trim() || undefined,
      telegramWebhookMaxConnections: conn.telegramWebhookMaxConnections !== undefined
        ? clampInt(conn.telegramWebhookMaxConnections, 1, 100000, 40) : undefined,
      telegramWebhookIpAddress: String(conn.telegramWebhookIpAddress || '').trim() || undefined,
      telegramWebhookCertificatePath: String(conn.telegramWebhookCertificatePath || '').trim() || undefined,
      telegramAllowedUpdates: allowed,
      telegramDropPendingUpdates: conn.telegramDropPendingUpdates === true,
      telegramPollingTimeout: conn.telegramPollingTimeout !== undefined
        ? clampInt(conn.telegramPollingTimeout, 0, 50, 30) : undefined,
      telegramPollingLimit: conn.telegramPollingLimit !== undefined
        ? clampInt(conn.telegramPollingLimit, 1, 100, 100) : undefined,
      telegramOffset: conn.telegramOffset !== undefined
        ? clampInt(conn.telegramOffset, 0, Number.MAX_SAFE_INTEGER, 0) : undefined,
      telegramProxyUrl: String(conn.telegramProxyUrl || '').trim() || undefined,
      telegramWebhookReplyInResponse: conn.telegramWebhookReplyInResponse === true,
      telegramParseMode: (['HTML', 'MarkdownV2', 'Markdown', 'Rich'] as const).includes(
        conn.telegramParseMode as 'HTML',
      ) ? conn.telegramParseMode : undefined,
      reconnectIntervalMs: conn.reconnectIntervalMs,
      reconnectMaxAttempts: conn.reconnectMaxAttempts,
      createdAt: typeof conn.createdAt === 'number' && Number.isFinite(conn.createdAt)
        ? Math.floor(conn.createdAt)
        : undefined,
      logLayout: conn.logLayout === 'account' ? 'account' : undefined,
    };
    return base;
  }

  if (type === 'kook') {
    return {
      id: conn.id,
      name: conn.name,
      type: 'kook',
      host: '',
      port: 0,
      enable: conn.enable ?? false,
      kookToken: conn.kookToken ?? '',
      kookBotUserId: conn.kookBotUserId,
      kookBotUsername: conn.kookBotUsername,
      kookBotIdentifyNum: conn.kookBotIdentifyNum,
      kookBotAvatar: conn.kookBotAvatar,
      reconnectIntervalMs: conn.reconnectIntervalMs,
      reconnectMaxAttempts: conn.reconnectMaxAttempts,
      createdAt: typeof conn.createdAt === 'number' && Number.isFinite(conn.createdAt)
        ? Math.floor(conn.createdAt)
        : undefined,
      logLayout: conn.logLayout === 'account' ? 'account' : undefined,
    };
  }

  if (type === 'qq_official') {
    return {
      id: conn.id,
      name: conn.name,
      type: 'qq_official',
      mode: conn.mode === 'https' ? 'https' : undefined,
      host: conn.host || '',
      port: conn.port || 0,
      enable: conn.enable ?? false,
      appId: conn.appId ?? '',
      appSecret: conn.appSecret ?? '',
      sandbox: conn.sandbox ?? true,
      intents: conn.intents,
      reconnectIntervalMs: conn.reconnectIntervalMs,
      reconnectMaxAttempts: conn.reconnectMaxAttempts,
      botProfile: conn.botProfile,
      webhookBaseUrl: conn.webhookBaseUrl,
      createdAt: typeof conn.createdAt === 'number' && Number.isFinite(conn.createdAt)
        ? Math.floor(conn.createdAt)
        : undefined,
      logLayout: conn.logLayout === 'account' ? 'account' : undefined,
    };
  }

  if (type === 'weixin_bot') {
    return {
      id: conn.id,
      name: conn.name,
      type: 'weixin_bot',
      host: '',
      port: 0,
      enable: conn.enable ?? false,
      weixinToken: conn.weixinToken,
      weixinBaseUrl: conn.weixinBaseUrl,
      weixinAccountId: conn.weixinAccountId,
      weixinUserId: conn.weixinUserId,
      weixinGetUpdatesBuf: conn.weixinGetUpdatesBuf,
      reconnectIntervalMs: conn.reconnectIntervalMs,
      reconnectMaxAttempts: conn.reconnectMaxAttempts,
      createdAt: typeof conn.createdAt === 'number' && Number.isFinite(conn.createdAt)
        ? Math.floor(conn.createdAt)
        : undefined,
      logLayout: conn.logLayout === 'account' ? 'account' : undefined,
    };
  }

  const mode = parseConnectionMode(conn.mode);
  const defaultPort =
    mode === 'forward' ? 3001
      : mode === 'http' || mode === 'http_sse' ? 6701
        : mode === 'http_client' ? 3000
          : 6700;

  const base: ConnectionConfig = {
    id: conn.id,
    name: conn.name,
    type: 'onebot',
    mode,
    host: conn.host || '127.0.0.1',
    port: conn.port || defaultPort,
    accessToken: conn.accessToken,
    enable: conn.enable ?? false,
    apiUrl: conn.apiUrl,
    reconnectIntervalMs: conn.reconnectIntervalMs,
    reconnectMaxAttempts: conn.reconnectMaxAttempts,
    botUin: conn.botUin ? String(conn.botUin).trim() : undefined,
    createdAt: typeof conn.createdAt === 'number' && Number.isFinite(conn.createdAt)
      ? Math.floor(conn.createdAt)
      : undefined,
    logLayout: conn.logLayout === 'account' ? 'account' : undefined,
  };

  if ((!conn.host || !conn.port) && conn.url) {
    try {
      const u = new URL(conn.url);
      base.host = u.hostname || '127.0.0.1';
      base.port = Number(u.port) || defaultPort;
    } catch { /* keep defaults */ }
  }

  return base;
}

export function normalizeConnectionsFile(file: ConnectionsFile): ConnectionsFile {
  return {
    connections: file.connections.map(normalizeConnection),
  };
}

/** 由 host + port 生成 WebSocket 地址 */
export function connectionWsUrl(conn: Pick<ConnectionConfig, 'host' | 'port'>): string {
  const h = conn.host === '0.0.0.0' || conn.host === '::' ? '127.0.0.1' : conn.host;
  return `ws://${h}:${conn.port}`;
}

/**
 * 连接指纹：判断两条连接是不是「同一条」（导入去重靠它）。
 *
 * **OneBot 必须四要素全同才算同一条**：`账号 + 地址 + 端口 + 密钥`。
 * 因为 OneBot 的一个机器人账号（botUin）可以同时配多个接入点——比如 6700 走反向 WS、
 * 6701 走 HTTP，它们是两条独立连接。**同账号但地址/端口不同 = 另一个接入点 = 新增**，
 * 不能按账号合并，否则导入时会把人家另一个接入点的连接覆盖掉。
 *
 * 其余三种协议（官方 / KOOK / 微信）一个账号只会有一条连接，按账号 id 判即可。
 */
export function connectionFingerprint(conn: Pick<ConnectionConfig, 'type' | 'host' | 'port' | 'accessToken' | 'botUin' | 'appId' | 'kookBotUserId' | 'weixinAccountId' | 'telegramBotUserId'>): string {
  const type = conn.type ?? 'onebot';
  if (type === 'onebot') {
    const uin = String(conn.botUin || '').trim();
    const host = String(conn.host || '').trim();
    const port = Number(conn.port ?? 0);
    const token = String(conn.accessToken || '').trim();
    return `onebot|${uin}|${host}|${port}|${token}`;
  }
  let account = '';
  if (type === 'qq_official') account = String(conn.appId || '').trim();
  else if (type === 'kook') account = String(conn.kookBotUserId || '').trim();
  else if (type === 'weixin_bot') account = String(conn.weixinAccountId || '').trim();
  else if (type === 'telegram') account = String(conn.telegramBotUserId || '').trim();
  return `${type}|${account}`;
}

/**
 * OneBot 的宽松指纹（不含账号）。
 *
 * `botUin` 是**连上之后才由事件回填**的，导出时可能还没填（比如新加的连接从没启用过）。
 * 这时严格指纹对不上，但其实是同一条——用它做二次匹配：地址 + 端口 + 密钥 相同即可。
 */
export function onebotLooseFingerprint(conn: Pick<ConnectionConfig, 'host' | 'port' | 'accessToken'>): string {
  const host = String(conn.host || '').trim();
  const port = Number(conn.port ?? 0);
  const token = String(conn.accessToken || '').trim();
  return `onebot|${host}|${port}|${token}`;
}

/** 该连接的账号是否已确定（未回填 botUin 的 OneBot 连接算未确定） */
export function hasResolvedAccount(conn: Pick<ConnectionConfig, 'type' | 'botUin' | 'appId' | 'kookBotUserId' | 'weixinAccountId' | 'telegramBotUserId'>): boolean {
  const type = conn.type ?? 'onebot';
  if (type === 'onebot') return Boolean(String(conn.botUin || '').trim());
  if (type === 'qq_official') return Boolean(String(conn.appId || '').trim());
  if (type === 'kook') return Boolean(String(conn.kookBotUserId || '').trim());
  if (type === 'weixin_bot') return Boolean(String(conn.weixinAccountId || '').trim());
  if (type === 'telegram') return Boolean(String(conn.telegramBotUserId || '').trim());
  return false;
}

export function connectionModeLabel(mode?: ConnectionMode): string {
  switch (mode) {
    case 'forward':
      return '正向 WS';
    case 'http':
      return 'HTTP 服务器';
    case 'http_sse':
      return 'HTTP SSE 服务器';
    case 'http_client':
      return 'HTTP 客户端';
    case 'https':
      return '官方 HTTPS';
    case 'webhook':
      return 'Webhook 回调';
    case 'polling':
      return '长轮询';
    default:
      return '反向 WS';
  }
}

export function connectionTypeLabel(type?: ConnectionType): string {
  if (type === 'qq_official') return 'QQ 官方机器人';
  if (type === 'weixin_bot') return '微信 AI×BOT';
  if (type === 'kook') return 'KOOK';
  if (type === 'telegram') return 'Telegram Bot';
  return 'OneBot';
}

/** KOOK 连接在 UI 中展示的摘要 */
export function kookConnectionSummary(conn: ConnectionConfig): string {
  if (!isKookConnection(conn)) return '';
  if (!kookConnectionReady(conn)) return '未配置 Token';
  const user = String(conn.kookBotUsername || '').trim();
  const num = String(conn.kookBotIdentifyNum || '').trim();
  if (user && num) return `${user}#${num}`;
  if (user) return user;
  return 'Token 已配置';
}

/** 微信 BOT 在 UI 中展示的摘要 */
export function weixinBotConnectionSummary(conn: ConnectionConfig): string {
  if (!isWeixinBotConnection(conn)) return '';
  if (!weixinBotLoggedIn(conn)) return '未扫码登录';
  return `iLink · ${conn.weixinAccountId}`;
}

/** QQ 官方连接在 UI 中展示的摘要 */
export function qqOfficialConnectionSummary(conn: ConnectionConfig): string {
  if (!isQqOfficialConnection(conn)) return '';
  const env = conn.sandbox ? '沙箱' : '正式';
  const kind = conn.mode === 'https' ? 'HTTPS' : 'WS';
  return `${kind} · AppID ${conn.appId || '未配置'} · ${env}`;
}
