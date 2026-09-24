export interface KakakeConfig {
  host: string;
  port: number;
  token: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  /** OneBot API 调用超时（毫秒），大文件 send_msg 建议 120000+ */
  apiTimeoutMs: number;
}

export const DEFAULT_API_TIMEOUT_MS = 120_000;

export function normalizeApiTimeoutMs(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_API_TIMEOUT_MS;
  return Math.min(600_000, Math.max(5_000, Math.floor(n)));
}

/** 连接协议类型：OneBot、QQ 开放平台官方机器人、微信 iLink BOT、KOOK */
export type ConnectionType = 'onebot' | 'qq_official' | 'weixin_bot' | 'kook';

/**
 * OneBot 连接模式：
 * - reverse / forward：WebSocket
 * - http：HTTP 服务器（收 POST 事件 + 调对端 HTTP API）
 * - http_sse：连接对端 HTTP SSE 服务端
 * - http_client：HTTP 客户端（调对端 HTTP API + 事件上报到框架路径）
 * - https：QQ 官方 HTTPS Webhook（仅 qq_official）
 */
export type ConnectionMode = 'reverse' | 'forward' | 'http' | 'http_sse' | 'http_client' | 'https';

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
  /** QQ 官方：是否沙箱环境 */
  sandbox?: boolean;
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
  /** 首次添加时间（毫秒时间戳）；同状态排序时越早越靠前 */
  createdAt?: number;
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

export function kookConnectionReady(conn: ConnectionConfig): boolean {
  return !!String(conn.kookToken || '').trim();
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
export function normalizeConnection(conn: StoredConnectionConfig): ConnectionConfig {
  const type: ConnectionType =
    conn.type === 'qq_official' ? 'qq_official'
      : conn.type === 'weixin_bot' ? 'weixin_bot'
        : conn.type === 'kook' ? 'kook'
          : 'onebot';

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
    default:
      return '反向 WS';
  }
}

export function connectionTypeLabel(type?: ConnectionType): string {
  if (type === 'qq_official') return 'QQ 官方机器人';
  if (type === 'weixin_bot') return '微信 AI×BOT';
  if (type === 'kook') return 'KOOK';
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
