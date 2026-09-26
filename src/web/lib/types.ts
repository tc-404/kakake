export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogCategory =
  | 'system'
  | 'event'
  | 'action'
  | 'plugin'
  | 'gf_event'
  | 'gf_action'
  | 'gf_plugin'
  | 'sim_event'
  | 'sim_action';

export interface LogEntry {
  time: string;
  level: LogLevel;
  category: LogCategory;
  prefix: string;
  message: string;
  detail?: string;
}

export type ConnectionType = 'onebot' | 'qq_official' | 'weixin_bot' | 'kook';
export type ConnectionMode = 'reverse' | 'forward' | 'http' | 'http_sse' | 'http_client' | 'https';

export interface ConnectionStatus {
  id: string;
  name: string;
  type: ConnectionType;
  typeLabel: string;
  mode: ConnectionMode;
  modeLabel: string;
  host: string;
  port: number;
  listenUrl: string;
  /** HTTP 相关：OneBot 协议端 API 根地址 */
  apiUrl?: string;
  /** 是否已配置 Access Token（不回传明文） */
  hasAccessToken?: boolean;
  /** QQ 官方 HTTPS：公网回调基址 */
  webhookBaseUrl?: string;
  enable: boolean;
  connected: boolean;
  botUin?: string;
  accountKey?: string;
  appId?: string;
  sandbox?: boolean;
  /** QQ 官方：显式配置的 Intents（0/undefined = 内置默认） */
  intents?: number;
  /** QQ 官方 HTTPS：回调地址是否已被平台验证通过（未验证前“已连接”没有意义） */
  webhookVerified?: boolean;
  qqSummary?: string;
  weixinSummary?: string;
  weixinLoggedIn?: boolean;
  weixinAccountId?: string;
  kookSummary?: string;
  kookReady?: boolean;
  kookBotUserId?: string;
  botProfile?: {
    id: string;
    username: string;
    avatar: string;
    unionOpenid?: string;
    desc?: string;
    shareUrl?: string;
    fetchedAt: number;
  };
  reconnectIntervalMs?: number;
  reconnectMaxAttempts?: number;
  reconnectAttempts?: number;
  reconnecting?: boolean;
  reconnectAbandoned?: boolean;
  hasAvatar?: boolean;
  avatarUpdatedAt?: string;
  /** 首次添加时间（毫秒） */
  createdAt?: number;
}

export interface PluginItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  iconUrl?: string;
  status: 'active' | 'stopped' | 'disabled' | 'error';
  /** 连接子开关（仅连接面板列表返回） */
  connectionEnabled?: boolean;
  /** 插件总开关（plugins.json / gf-plugins.json / wx-plugins.json） */
  masterEnabled?: boolean;
  /** 插件类型 */
  kind?: 'kakake' | 'gf' | 'wx' | 'ss';
  /** 连接作用域：账号是否已锁定（QQ / AppID / 微信账号） */
  accountReady?: boolean;
  accountKey?: string;
  /** 是否已复制到 plugins_two/<account>/ */
  runtimeInstalled?: boolean;
  /** 是否允许在本连接开启（总开关开 + 账号就绪） */
  canEnableOnConnection?: boolean;
  /** 连接面板：带账号的后台入口（控制台宿主路由） */
  webUrl?: string;
  /** 经典独立窗口 HTML 后台 */
  legacyWebUrl?: string;
  /** 全局列表：已加载该插件的账号列表 */
  loadedAccounts?: string[];
  errorMessage?: string;
  hasConfig: boolean;
  hasPages: boolean;
  /** plugins/<id>/插件文档.md 是否存在 */
  hasDocs?: boolean;
  homepage?: string;
}

export interface ExtensionPage {
  pluginId: string;
  pluginName?: string;
  path: string;
  title?: string;
  icon?: string;
  description?: string;
  /** html = iframe；module = 动态 import ESM */
  kind?: 'html' | 'module';
  /** 相对插件根的 ESM 路径 */
  module?: string;
  htmlFile?: string;
  /** 控制台宿主路径 */
  hostPath?: string;
  /** 经典独立 HTML 后台 */
  legacyUrl?: string;
  /** ESM 绝对 URL */
  moduleUrl?: string;
}

export interface ConfigSchemaItem {
  key: string;
  type: string;
  label: string;
  description?: string;
  default?: unknown;
  options?: { label: string; value: string | number }[];
  hidden?: boolean;
  placeholder?: string;
}

export const DEFAULT_API_TIMEOUT_MS = 120_000;

export interface KakakeConfig {
  host: string;
  port: number;
  token: string;
  logLevel: LogLevel;
  apiTimeoutMs: number;
  /** 外放 API 开关：开启后 GET /api/public 免登录返回只读概览 */
  publicApiEnabled: boolean;
}

export const DEFAULT_KAKAKE_CONFIG: KakakeConfig = {
  host: '0.0.0.0',
  port: 8787,
  token: '',
  logLevel: 'info',
  apiTimeoutMs: DEFAULT_API_TIMEOUT_MS,
  publicApiEnabled: false,
};

export const CATEGORY_LABEL: Record<LogCategory, string> = {
  system: '系统',
  event: '上报',
  action: '输出',
  plugin: '插件',
  gf_event: '官方上报',
  gf_action: '官方输出',
  gf_plugin: '官方插件',
  sim_event: '模拟上报',
  sim_action: '模拟输出',
};

/** 与后端 LOG_CATEGORY_ORDER 一致：官方三项挨在一起，模拟两项挨在一起 */
export const CATEGORY_ORDER: LogCategory[] = [
  'system',
  'event',
  'action',
  'plugin',
  'gf_event',
  'gf_action',
  'gf_plugin',
  'sim_event',
  'sim_action',
];

export const STATUS_MAP: Record<string, { text: string; variant: 'success' | 'warning' | 'secondary' | 'destructive' }> = {
  active: { text: '运行中', variant: 'success' },
  stopped: { text: '已停止', variant: 'warning' },
  disabled: { text: '已禁用', variant: 'secondary' },
  error: { text: '错误', variant: 'destructive' },
};

/** 插件商城资源（咔咔插件分区） */
export interface StoreResource {
  id: number;
  title: string;
  version: string;
  author: string;
  category_id: number;
  cat_name: string;
  /** 上游类型：官鸡 / 野鸡 / wxbot 等 */
  resource_type?: string;
  summary: string;
  description: string;
  update_notes: string;
  sort_order: number;
  preview_count: number;
  download_count: number;
  tags: string[];
  allow_list: 0 | 1;
  allow_detail: 0 | 1;
  allow_cover_preview: 0 | 1;
  allow_download: 0 | 1;
  download_block_reason: string;
  uploader_name: string;
  created_at: string;
  updated_at: string;
  links: { cover: string; download: string };
}

export interface StoreComment {
  id: number;
  nickname: string;
  body: string;
  created_at: string;
  created_at_label: string;
}

export type MediaPlatform = 'blbl' | 'dy' | 'xhs' | 'ks' | 'tt' | 'yt' | 'x' | 'tg';
export type MediaType = 'video' | 'image' | 'live' | 'animated' | 'unknown';

export interface MediaStats {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  favorites?: number;
  coins?: number;
  danmaku?: number;
}

export interface MediaParseResult {
  ok: boolean;
  platform: MediaPlatform | null;
  type: MediaType;
  title: string;
  author?: string;
  duration?: number | null;
  /** 发布时间（已格式化文案） */
  publishTime?: string;
  /** 视频体积（人类可读，如 12.34MB） */
  sizeText?: string;
  description: string;
  tags: string[];
  stats: MediaStats;
  cover: string;
  videoUrl: string | null;
  images: string[];
  liveItems: { image: string; video: string }[];
  cookie?: string;
  message?: string;
}

export interface ZeppLastRun {
  at: string;
  ok: boolean;
  step: number | null;
  message: string;
}

export interface ZeppAccountPublic {
  id: string;
  user: string;
  userMasked: string;
  enabled: boolean;
  hasPassword: boolean;
  lastRun: ZeppLastRun | null;
}

export interface ZeppStepsState {
  ok: boolean;
  minStep: number;
  maxStep: number;
  accounts: ZeppAccountPublic[];
  message?: string;
  results?: Array<{ id: string; userMasked: string; lastRun: ZeppLastRun }>;
}
