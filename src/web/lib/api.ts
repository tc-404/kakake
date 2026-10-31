import type { AnnouncementSource } from './announcement';
import type {
  ConnectionMode,
  ConnectionStatus,
  ConnectionType,
  KakakeConfig,
  LogEntry,
  LogFileInfo,
  PluginItem,
  ExtensionPage,
  ConfigSchemaItem,
  StoreResource,
  StoreComment,
  MediaParseResult,
  OpenPlatformState,
  OpenPlatformProfile,
  OpenPlatformInsight,
  OpenPlatformChannel,
  MenuItem,
  PanelItem,
  PanelRecord,
  PanelScope,
} from './types';
import type {
  AppearanceSettings,
  AppearanceState,
  BackgroundFit,
  BackgroundOrientation,
  BackgroundPreset,
} from './appearance';
import type {
  SimulateAccount,
  SimulateEventInput,
  SimulateSendInput,
  SimulateTranscript,
} from './simulate-types';
import type { NavLayout } from './nav-layout';

const TOKEN_KEY = 'token';

export function getStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setStoredToken(token: string): void {
  if (typeof window === 'undefined') return;
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/** 更新中心里用户选定的镜像 id（localStorage，与资源界面共用同一个源） */
function selectedMirrorId(): string {
  if (typeof window === 'undefined') return '';
  try {
    return localStorage.getItem('kakake_update_mirror') || '';
  } catch {
    return '';
  }
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function authHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { ...(extra as Record<string, string>) };
  const t = getStoredToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

/** request() 默认超时；慢端点（插件导入 / 分享上传等）自带显式 signal，不受影响 */
export const REQUEST_TIMEOUT_MS = 60_000;

/**
 * 收到 401 时的全局回调（跳登录），由 AuthGuard 注册——api 层不依赖 router。
 * 登录 / 设密端点自身的 401 是凭据错误，交调用方提示，不触发全局跳转。
 */
let unauthorizedHandler: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null): void {
  unauthorizedHandler = fn;
}

const AUTH_EXEMPT_PATHS = ['/api/auth/login', '/api/auth/setup-password'];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string>),
    },
    // 已有显式 signal（如 mediaParse 可取消）原样保留，否则统一兜底超时
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401 && !AUTH_EXEMPT_PATHS.some((p) => url.includes(p))) {
    unauthorizedHandler?.();
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = j.message || j.error || msg;
    } catch { /* ignore */ }
    throw new ApiError(msg || `HTTP ${res.status}`, res.status);
  }
  return res.json() as Promise<T>;
}

/** blob 下载公共路径：拉取 → 取 Content-Disposition 文件名 → 触发浏览器保存 */
async function downloadBlob(res: Response, fallbackName: string): Promise<void> {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { message?: string };
      msg = j.message || msg;
    } catch { /* ignore */ }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const dispo = res.headers.get('Content-Disposition') || '';
  const match = dispo.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  const filename = match?.[1] || fallbackName;
  const objUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objUrl;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(objUrl);
}

export type UpdateMirrorView = {
  id: string;
  label: string;
  url: string;
  /** 最近一次探测延迟（ms）；未测/失败为 null */
  latencyMs: number | null;
  reachable: boolean;
  version: string;
  error: string;
  /** 最近一次探测时间（ISO），用于列表排序 */
  lastCheckedAt: string;
};

/**
 * 发布通道：stable = 正式版；beta/rc/alpha 为预发布。
 * unknown = 版本号带预发布后缀但认不出通道（如 0.6.9-bta.2）——
 * 它仍然是预发布，界面显示 PRE，绝不能当作正式版 / LTS。
 */
export type UpdateChannel = 'stable' | 'beta' | 'rc' | 'alpha' | 'unknown';

export type UpdateVersionInfo = {
  version: string;
  tag: string;
  name: string;
  url: string;
  publishedAt: string;
  /** 发布通道 */
  channel: UpdateChannel;
};

export type UpdateStateResp = {
  ok: boolean;
  status: 'idle' | 'checking' | 'latest' | 'update' | 'unreachable';
  checkedThisSession: boolean;
  currentVersion: string;
  /** 当前安装版本所属通道 */
  currentChannel: UpdateChannel;
  remoteVersion: string;
  /** remoteVersion 所属通道（正式版用户只会是 stable） */
  remoteChannel: UpdateChannel;
  /** 比当前更高的预发布版本（不点亮 NEW，只做提示） */
  latestPrerelease: string;
  latestPrereleaseTag: string;
  hasUpdate: boolean;
  hasPrerelease: boolean;
  activeMirrorId: string;
  message: string;
  releaseUrl: string;
  mirrors: UpdateMirrorView[];
  versions: UpdateVersionInfo[];
};

/** 在线安装（下载+校验+暂存）任务快照 */
export type UpdateInstallJob = {
  phase: 'idle' | 'resolving' | 'downloading' | 'verifying' | 'staged' | 'error';
  tag: string;
  version: string;
  percent: number;
  receivedBytes: number;
  totalBytes: number;
  message: string;
  error: string;
  /** 机器可读错误码（unsigned_source_update=源码包无签名，需用户确认自担风险） */
  errorCode?: string;
};

/** 在线更新环境能力 + 当前任务 + 已暂存待应用信息 */
export type UpdateInstallState = {
  ok: boolean;
  currentVersion: string;
  edition: 'source' | 'portable';
  platform: 'win' | 'linux' | 'other';
  /** 当前启动方式是否支持网页触发的自动重启 */
  canRestart: boolean;
  /** 当前环境是否支持在线更新（便携版依赖对应平台发行包） */
  onlineUpdateSupported: boolean;
  /** 不可重启 / 不支持时的说明文案 */
  launchNote: string;
  inflight: boolean;
  job: UpdateInstallJob | null;
  pending: { tag: string; version: string; edition: 'source' | 'portable' } | null;
};

export type UpdateRestartResp = {
  ok: boolean;
  canRestart: boolean;
  willApplyUpdate: boolean;
  message: string;
};

/** 图片引擎（sharp）安装任务：安装中按 1s 轮询，lines 是日志尾部 */
export type SharpInstallJob = {
  phase: 'idle' | 'running' | 'done' | 'error';
  message: string;
  error: string;
  exitCode: number | null;
  command: string;
  startedAt: string;
  finishedAt: string;
  lines: string[];
};

/** 图片引擎环境状态（设置页「图片引擎环境」卡片） */
export type SharpEnvState = {
  ok: boolean;
  root: string;
  /** 一键安装的目标目录：data/runtime-deps（与 MKbot 插件共用同一份 sharp） */
  installDir: string;
  /** 当前实际用的那一份在哪（共享目录 / 项目内置副本 / null） */
  loadedDir: string | null;
  edition: 'source' | 'portable';
  platform: 'win' | 'linux' | 'other';
  arch: string;
  nodeVersion: string;
  /** node_modules 里有 sharp 包（不代表能用：可能缺本平台预编译二进制） */
  packagePresent: boolean;
  packageVersion: string | null;
  /** 实测能否 import —— 界面以这个为「可用」判据 */
  loadable: boolean;
  version: string | null;
  vips: string | null;
  error: string | null;
  npm: { available: boolean; label: string; version: string | null };
  /** 当前缺失的依赖（必需 + 可选） */
  missingDeps: string[];
  canInstall: boolean;
  note: string;
  command: string;
  job: SharpInstallJob | null;
  updatedAt: string;
};

export const api = {
  authState: () =>
    request<{
      authed: boolean;
      authRequired: boolean;
      sessionTtlMs?: number;
      idleTimeoutMs?: number;
      absoluteTimeoutMs?: number;
      idleRemainingMs?: number;
      absoluteRemainingMs?: number;
      needsPasswordSetup?: boolean;
      authKeyKind?: 'initial' | 'custom';
    }>('/api/auth/state'),
  login: (token: string) =>
    request<{
      ok: boolean;
      message?: string;
      authRequired?: boolean;
      expiresInMs?: number;
      idleTimeoutMs?: number;
      absoluteTimeoutMs?: number;
    }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),
  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  /** 后台互动续期（重置空闲 30 分钟） */
  touchSession: () =>
    request<{
      ok: boolean;
      idleTimeoutMs?: number;
      absoluteTimeoutMs?: number;
      idleRemainingMs?: number;
      absoluteRemainingMs?: number;
    }>('/api/auth/touch', { method: 'POST' }),

  /** 首次设密（仅初始密钥） */
  setupPassword: (password: string, confirm: string) =>
    request<{ ok: boolean; needsPasswordSetup?: boolean; message?: string }>('/api/auth/setup-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password, confirm }),
    }),

  /** 服务端版本协议门禁（data/agreement/<version>.json） */
  agreementState: () =>
    request<{ version: string; agreed: boolean }>('/api/agreement/state'),
  agreementAgree: () =>
    request<{ ok: boolean; version: string; agreed: boolean; agreedAt: string }>('/api/agreement/agree', {
      method: 'POST',
    }),

  /** 公告版本提示（与门禁独立）：进入后台读一次，决定是否弹出公告更新 */
  announcementUpdate: () =>
    request<{ ok: boolean; hasUpdate: boolean; showVersion: string; seenVersion: string }>(
      '/api/announcement/update',
    ),
  announcementUpdateAck: (version?: string) =>
    request<{ ok: boolean; seenVersion: string }>('/api/announcement/update/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: version ?? '' }),
    }),

  /** 更新检查（GitHub 路线）状态：进入后台读一次，后端本次会话自动检查一次 */
  updateState: () => request<UpdateStateResp>('/api/update/state'),
  /** 手动 ping / 测试访问：不传 mirrorIds = 一键 Ping 全部；传单个 = 测试该镜像 */
  updatePing: (mirrorIds?: string[]) =>
    request<UpdateStateResp>('/api/update/ping', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mirrorIds: mirrorIds ?? null }),
    }),

  /** 在线更新 · 安装此版本：开始下载并暂存选定 tag（不替换现有文件）；acknowledgeRisk=用户确认无签名源码包风险 */
  updateInstall: (tag: string, mirrorId?: string | null, acknowledgeRisk?: boolean) =>
    request<UpdateInstallState>('/api/update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, mirrorId: mirrorId ?? null, acknowledgeRisk: acknowledgeRisk === true }),
    }),
  /** 在线更新 · 安装进度与环境能力 */
  updateInstallState: () => request<UpdateInstallState>('/api/update/install/state'),
  /** 在线更新 · 取消/撤销暂存 */
  updateInstallCancel: () =>
    request<UpdateInstallState>('/api/update/install/cancel', { method: 'POST' }),
  /** 在线更新 · 确定重启（仅受管启动器可用） */
  updateRestart: () =>
    request<UpdateRestartResp>('/api/update/restart', { method: 'POST' }),

  /** 远程公告代理；失败时前端改用本地备用 Markdown */
  announcement: async (signal?: AbortSignal) => {
    const res = await fetch('/api/announcement', {
      credentials: 'include',
      headers: authHeaders(),
      signal,
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      source?: string;
      markdown?: string;
      message?: string;
    };
    if (!res.ok || !data.ok || !data.markdown?.trim()) {
      throw new Error(data.message || `公告加载失败 HTTP ${res.status}`);
    }
    // 来源要透传：后端双源竞速后赢的可能是 GitHub 源，写死 remote 会让来源信息失真
    const source: AnnouncementSource = data.source === 'github' ? 'github' : 'remote';
    return { ok: true as const, source, markdown: data.markdown };
  },

  status: () =>
    request<{
      framework: string;
      version: string;
      connections: ConnectionStatus[];
      plugins: { id: string; loaded: boolean; enable: boolean }[];
    }>('/api/status'),

  systemMetrics: () =>
    request<{
      time: number;
      uptimeSec: number;
      /** 系统开机运行时长（秒），旧版本后端可能没有 */
      systemUptimeSec?: number;
      frameworkVersion: string;
      host: {
        hostname: string;
        platform: string;
        platformLabel: string;
        /** windows / macos / linux / termux / android（旧版本后端可能没有） */
        runtime?: string;
        release: string;
        arch: string;
        type: string;
        nodeVersion: string;
      };
      cpu: {
        processPercent: number;
        /** 整机所有核心的总占用（旧版本后端可能没有） */
        systemPercent?: number;
        /** 每核占用（旧版本后端可能没有） */
        perCore?: number[];
        cores: number;
        /** 当前在线核心数；安卓会下线空闲核（旧版本后端可能没有） */
        coresOnline?: number;
        model: string;
        speedMHz: number;
      };
      memory: {
        processPercent: number;
        processRssBytes: number;
        processHeapUsedBytes: number;
        nodeRssBytes?: number;
        nodePercent?: number;
        nodeHeapUsedBytes?: number;
        systemUsedBytes: number;
        systemTotalBytes: number;
        systemPercent: number;
      };
      disk: {
        usedPercent: number;
        usedBytes: number;
        totalBytes: number;
        freeBytes: number;
        path: string;
      };
      disks?: {
        usedPercent: number;
        usedBytes: number;
        totalBytes: number;
        freeBytes: number;
        path: string;
      }[];
    }>('/api/system/metrics'),

  /** 高频实时 CPU/内存（面积图用，毫秒级轮询）；比 systemMetrics 轻得多，不含磁盘与主机信息 */
  systemMetricsLive: () =>
    request<{
      time: number;
      cpu: {
        systemPercent: number;
        processPercent: number;
      };
      memory: {
        systemPercent: number;
        nodePercent: number;
        systemUsedBytes: number;
        systemTotalBytes: number;
        nodeRssBytes: number;
        nodeHeapUsedBytes: number;
      };
    }>('/api/system/metrics/live'),

  /**
   * 图片引擎环境（sharp）：设置页「图片引擎环境」卡片用。
   * 状态只读探测；安装是手动触发（POST），安装中按 1s 轮询状态接口看 job.lines。
   */
  systemSharp: () => request<SharpEnvState>('/api/system/sharp'),
  systemSharpInstall: () =>
    request<SharpEnvState>('/api/system/sharp/install', { method: 'POST' }),

  settings: {
    get: () =>
      request<{
        config: KakakeConfig;
        defaults: KakakeConfig;
        paths: Record<string, string>;
      }>('/api/settings'),
    save: (config: Partial<KakakeConfig>) =>
      request<{ ok: boolean; config: KakakeConfig }>('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      }),
    reset: () =>
      request<{ ok: boolean; config: KakakeConfig }>('/api/settings/reset', {
        method: 'POST',
      }),
    /** GitHub API Token：直连官方接口时附带，提升匿名限流额度（可选） */
    githubToken: () =>
      request<{ ok: boolean; token: string; configured: boolean }>('/api/settings/github-token'),
    saveGithubToken: (token: string) =>
      request<{
        ok: boolean;
        message?: string;
        token: string;
        configured: boolean;
        verify?: {
          valid: boolean;
          status: number;
          remaining?: number;
          limit?: number;
          message?: string;
        } | null;
      }>('/api/settings/github-token', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      }),
  },

  appearance: {
    get: () =>
      request<{
        ok: boolean;
        appearance: AppearanceState;
        defaults: AppearanceSettings;
      }>('/api/appearance'),
    /** 公开只读：登录页 / 设置密码页在无会话时取同一套外观 */
    getPublic: () =>
      request<{ ok: boolean; appearance: AppearanceState }>('/api/appearance/public'),
    save: (settings: AppearanceSettings) =>
      request<{ ok: boolean; appearance: AppearanceState }>('/api/appearance', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      }),
    /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部品牌字）；空串恢复默认 */
    saveTitle: (title: string) =>
      request<{ ok: boolean; title: string; appearance: AppearanceState }>('/api/appearance/title', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      }),
    /** 页面水印文字：非空即开启、平铺在所有界面最上层；空串即关闭 */
    saveWatermark: (text: string) =>
      request<{ ok: boolean; watermarkText: string; appearance: AppearanceState }>('/api/appearance/watermark', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }),
    /** 背景适配方式：cover 铺满裁切 / stretch 拉伸铺满 / contain 完整显示 */
    saveBackgroundFit: (fit: BackgroundFit) =>
      request<{ ok: boolean; bgFit: BackgroundFit; appearance: AppearanceState }>('/api/appearance/bg-fit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fit }),
      }),
    /** 背景预设：default 出厂氛围底 / waves 波浪；有自定义背景时不生效 */
    saveBackgroundPreset: (preset: BackgroundPreset) =>
      request<{ ok: boolean; bgPreset: BackgroundPreset; appearance: AppearanceState }>(
        '/api/appearance/bg-preset',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ preset }),
        },
      ),
    reset: () =>
      request<{ ok: boolean; appearance: AppearanceState }>('/api/appearance/reset', {
        method: 'POST',
      }),
    uploadBackground: (orientation: BackgroundOrientation, file: File) => {
      // 走 multipart 直传，10MB 图不必先转 base64（会膨胀到 13MB+ 撞 JSON 限制）
      const form = new FormData();
      form.append('file', file, file.name);
      return request<{ ok: boolean; message?: string; appearance?: AppearanceState }>(
        `/api/appearance/background/${orientation}`,
        { method: 'POST', body: form },
      );
    },
    deleteBackground: (orientation: BackgroundOrientation) =>
      request<{ ok: boolean; message?: string; appearance?: AppearanceState }>(
        `/api/appearance/background/${orientation}`,
        { method: 'DELETE' },
      ),
  },

  /** 侧边栏导航自定义：顺序与隐藏项，存后端 data/nav-layout.json */
  navLayout: {
    get: () =>
      request<{
        ok: boolean;
        layout: NavLayout;
        hidable: string[];
        defaults: NavLayout;
        all: string[];
      }>('/api/nav-layout'),
    save: (layout: Partial<NavLayout>) =>
      request<{ ok: boolean; layout: NavLayout }>('/api/nav-layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(layout),
      }),
    reset: () =>
      request<{ ok: boolean; layout: NavLayout }>('/api/nav-layout/reset', { method: 'POST' }),
  },

  /**
   * 控制台语言：实例级设置，存后端 data/language.json。
   * 读用免鉴权端点（登录页也要按同一门语言显示），写需要登录。
   */
  language: {
    get: () => request<{ ok: boolean; lang: 'zh' | 'en'; default: 'zh' | 'en' }>('/api/language/public'),
    save: (lang: 'zh' | 'en') =>
      request<{ ok: boolean; lang: 'zh' | 'en' }>('/api/language', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lang }),
      }),
    reset: () => request<{ ok: boolean; lang: 'zh' | 'en' }>('/api/language/reset', { method: 'POST' }),
  },

  connections: {
    list: () => request<{ connections: ConnectionStatus[] }>('/api/connections'),
    /** 导出连接配置：含密钥与每条连接的插件开关（界面列表里密钥是被抹掉的，只能走这个接口） */
    exportConfig: () =>
      request<{
        format?: string;
        exportedAt?: number;
        connections: Array<Record<string, unknown>>;
      }>('/api/connections/export'),
    /** 导入连接配置：payload 已经过前端 JSON 语法校验，后端按指纹决定覆盖还是新增 */
    importConfig: (payload: unknown) =>
      request<{
        ok: boolean;
        message?: string;
        added?: number;
        updated?: number;
        skipped?: number;
        total?: number;
      }>('/api/connections/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    add: async (body: {
      name?: string;
      type?: ConnectionType;
      mode?: ConnectionMode;
      host?: string;
      port?: number;
      accessToken?: string;
      apiUrl?: string;
      appId?: string;
      appSecret?: string;
      sandbox?: boolean;
      enable?: boolean;
      webhookBaseUrl?: string;
      kookToken?: string;
    }) => {
      const res = await request<{ ok?: boolean; message?: string; connection?: unknown }>(
        '/api/connections',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (res && res.ok === false) {
        throw new Error(res.message || '添加失败');
      }
      return res;
    },
    updateQqOfficial: (
      id: string,
      body: {
        name?: string;
        appId?: string;
        appSecret?: string;
        sandbox?: boolean;
        /** Intents 位标志；0 = 回到内置默认 */
        intents?: number;
        webhookBaseUrl?: string;
        reconnectIntervalMs?: number;
        reconnectMaxAttempts?: number;
      },
    ) =>
      request(`/api/connections/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    update: (
      id: string,
      body: {
        name?: string;
        host?: string;
        port?: number;
        accessToken?: string;
        apiUrl?: string;
        appId?: string;
        appSecret?: string;
        sandbox?: boolean;
        kookToken?: string;
        reconnectIntervalMs?: number;
        reconnectMaxAttempts?: number;
        resetReconnect?: boolean;
      },
    ) =>
      request<{ ok: boolean; message?: string; connection?: unknown }>(`/api/connections/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    toggle: (id: string) =>
      request<{ ok: boolean; message?: string; enable?: boolean }>(`/api/connections/${id}/toggle`, {
        method: 'POST',
      }),
    reconnect: (id: string) => request(`/api/connections/${id}/reconnect`, { method: 'POST' }),
    updateForwardReconnect: (
      id: string,
      body: { reconnectIntervalMs?: number; reconnectMaxAttempts?: number; resetReconnect?: boolean },
    ) =>
      request(`/api/connections/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    remove: (id: string, opts?: { clearData?: boolean }) =>
      request(`/api/connections/${id}${opts?.clearData ? '?clearData=1' : ''}`, { method: 'DELETE' }),
    avatar: (id: string) =>
      request<{ ok: boolean; dataUrl?: string; updatedAt?: string; message?: string }>(
        `/api/connections/${id}/avatar`,
      ),
    refreshBotProfile: (id: string) =>
      request<{
        ok: boolean;
        profile?: ConnectionStatus['botProfile'];
        connections?: ConnectionStatus[];
        message?: string;
      }>(`/api/connections/${id}/refresh-bot-profile`, { method: 'POST' }),
    previewQqOfficial: (body: { appId: string; appSecret: string; sandbox?: boolean }) =>
      request<{ ok: boolean; profile?: ConnectionStatus['botProfile']; message?: string }>(
        '/api/connections/qq-official/preview',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      ),
    weixinQrcode: (id: string) =>
      request<{
        ok: boolean;
        qrcode?: string;
        loginUrl?: string;
        qrcodeImgContent?: string;
        qrImageDataUrl?: string;
        message?: string;
      }>(
        `/api/connections/${id}/weixin/qrcode`,
        { method: 'POST' },
      ),
    weixinQrcodeStatus: (id: string, qrcode: string) =>
      request<{
        ok: boolean;
        status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
        accountId?: string;
        message?: string;
        connections?: ConnectionStatus[];
      }>(`/api/connections/${id}/weixin/qrcode-status?qrcode=${encodeURIComponent(qrcode)}`),
    weixinLogout: (id: string) =>
      request<{ ok: boolean; message?: string; connections?: ConnectionStatus[] }>(
        `/api/connections/${id}/weixin/logout`,
        { method: 'POST' },
      ),
  },

  plugins: {
    list: (connectionId?: string) =>
      request<{
        code: number;
        data: { plugins: PluginItem[]; extensionPages: ExtensionPage[] };
      }>(`/api/Plugin/List${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`),
    setStatus: async (id: string, enable: boolean, connectionId?: string) => {
      const res = await request<{
        code: number;
        message: string;
        data?: { plugin: PluginItem };
      }>('/api/Plugin/SetStatus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, enable, ...(connectionId ? { connectionId } : {}) }),
      });
      if (res.code !== 0) throw new Error(res.message || '操作失败');
      return res;
    },
    getConfig: (id: string) =>
      request<{
        code: number;
        data: {
          schema: ConfigSchemaItem[];
          config: Record<string, unknown>;
          supportReactive: boolean;
        };
      }>(`/api/Plugin/Config?id=${encodeURIComponent(id)}`),
    saveConfig: (id: string, config: Record<string, unknown>) =>
      request('/api/Plugin/Config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, config }),
      }),
    reload: (id: string) => request(`/api/plugins/${id}/reload`, { method: 'POST' }),
    getDocs: (id: string) =>
      request<{
        ok: boolean;
        pluginId?: string;
        name?: string;
        markdown?: string;
        message?: string;
      }>(`/api/plugins/${encodeURIComponent(id)}/docs`),
    rescan: (connectionId?: string) =>
      request<{
        code: number;
        message: string;
        data: {
          count: number;
          plugins: PluginItem[];
          extensionPages: ExtensionPage[];
        };
      }>(`/api/plugins/rescan${connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : ''}`, {
        method: 'POST',
      }),
    uninstall: async (id: string, cleanData = false) => {
      const data = await request<{ ok: boolean; message?: string }>(
        `/api/plugins/${encodeURIComponent(id)}?cleanData=${cleanData ? '1' : '0'}`,
        { method: 'DELETE' },
      );
      if (!data.ok) throw new Error(data.message || '卸载失败');
      return data;
    },
    /** 仅删除连接账号下 plugins_two 副本，不删 plugins/ */
    removeConnectionRuntime: async (
      connectionId: string,
      pluginId: string,
      cleanData = false,
    ) => {
      const data = await request<{ ok: boolean; message?: string }>(
        `/api/connections/${encodeURIComponent(connectionId)}/plugins/${encodeURIComponent(pluginId)}?cleanData=${cleanData ? '1' : '0'}`,
        { method: 'DELETE' },
      );
      if (!data.ok) throw new Error(data.message || '删除运行副本失败');
      return data;
    },
    /**
     * 上传安装插件包。用 XHR 而不是 fetch：只有 XHR 的 upload.onprogress
     * 能拿到「已发送字节 / 总字节」，上传悬浮窗的进度条靠它。
     */
    importZip: (
      file: File,
      timeoutMs = 120_000,
      onProgress?: (loaded: number, total: number) => void,
    ) =>
      new Promise<{
        ok: boolean;
        pluginId?: string;
        kind?: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx';
        message: string;
      }>((resolve, reject) => {
        const fd = new FormData();
        fd.append('file', file, file.name || 'plugin.zip');
        const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 120_000;
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/plugins/import');
        xhr.timeout = ms;
        xhr.withCredentials = true;
        for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded, e.total);
        };
        xhr.onload = () => {
          let data: { ok?: boolean; message?: string; pluginId?: string; kind?: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx' } | null = null;
          try {
            data = JSON.parse(xhr.responseText) as typeof data;
          } catch {
            /* 非 JSON 响应按 HTTP 状态处理 */
          }
          if (xhr.status >= 200 && xhr.status < 300) {
            if (data) resolve(data as { ok: boolean; pluginId?: string; kind?: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx'; message: string });
            else reject(new Error(`HTTP ${xhr.status}`));
          } else {
            reject(new Error(data?.message || `HTTP ${xhr.status}`));
          }
        };
        xhr.onerror = () => reject(new Error('网络连接失败，上传中断'));
        xhr.ontimeout = () => reject(new Error('上传超时'));
        xhr.send(fd);
      }),
  },

  /**
   * 插件分享：免注册临时存储点的上传与链接导入。
   * 上传 / 链接导入是慢操作，走独立的 fetch + 5 分钟超时，不共用 request。
   */
  pluginShare: {
    providers: () =>
      request<{
        ok: boolean;
        providers: Array<{
          id: string;
          name: string;
          host: string;
          maxBytesLabel: string;
          retention: { zh: string; en: string };
          maxBytes: number;
          note?: { zh: string; en: string };
          unavailable?: { zh: string; en: string };
        }>;
        maxUploadBytes: number;
      }>('/api/plugin-share/providers'),
    accounts: (pluginId: string) =>
      request<{
        ok: boolean;
        message?: string;
        accounts: Array<{ key: string; label: string }>;
        single: boolean;
        hasAny: boolean;
      }>(`/api/plugin-share/accounts?id=${encodeURIComponent(pluginId)}`),
    upload: async (
      pluginId: string,
      provider: string,
      mode: 'plugin' | 'plugin_data',
      accounts: string[],
      timeoutMs = 300_000,
    ) => {
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 300_000;
      const res = await fetch('/api/plugin-share/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ pluginId, provider, mode, accounts }),
        signal: AbortSignal.timeout(ms),
      }).catch((e: unknown) => {
        const name = e instanceof Error ? e.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error('上传超时');
        throw e instanceof Error ? e : new Error(String(e));
      });
      const data = await res.json() as { ok: boolean; message?: string; url?: string; provider?: string; size?: number };
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    },
    importFromText: async (text: string, timeoutMs = 300_000, taskId?: string) => {
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 300_000;
      const res = await fetch('/api/plugin-share/import', {
        method: 'POST',
        credentials: 'include',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, taskId: taskId || undefined }),
        signal: AbortSignal.timeout(ms),
      }).catch((e: unknown) => {
        const name = e instanceof Error ? e.name : '';
        if (name === 'TimeoutError' || name === 'AbortError') throw new Error('下载超时');
        throw e instanceof Error ? e : new Error(String(e));
      });
      const data = await res.json() as {
        ok: boolean;
        code?: string;
        message?: string;
        pluginId?: string;
        kind?: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx';
        name?: string;
        hasData?: boolean;
        accounts?: string[];
        token?: string;
      };
      if (!res.ok || !data.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    },
    importData: async (token: string) => {
      const data = await request<{ ok: boolean; message?: string; restored?: string[]; failed?: string[] }>(
        '/api/plugin-share/import-data',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        },
      );
      if (!data.ok) throw new Error(data.message || '数据还原失败');
      return data;
    },
  },

  pluginStore: {
    origin: () =>
      request<{ ok: boolean; origin?: 'kakake' | 'github'; message?: string }>(
        '/api/plugin-store/origin',
      ),
    setOrigin: (origin: 'kakake' | 'github') =>
      request<{ ok: boolean; origin?: 'kakake' | 'github'; message?: string }>(
        '/api/plugin-store/origin',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin }),
        },
      ),
    list: (refresh = false, origin?: 'kakake' | 'github') => {
      const q = new URLSearchParams();
      if (refresh) q.set('refresh', '1');
      if (origin) q.set('origin', origin);
      const mirror = selectedMirrorId();
      if (mirror) q.set('mirror', mirror);
      const qs = q.toString();
      return request<{
        ok: boolean;
        message?: string;
        origin?: 'kakake' | 'github';
        catName?: string;
        catId?: number;
        pinned?: StoreResource[];
        resources?: StoreResource[];
        /** 数据能力：GitHub 源的下载次数依赖本机 GitHub Token */
        capabilities?: { downloadCounts?: boolean };
      }>(`/api/plugin-store/list${qs ? `?${qs}` : ''}`);
    },
    readme: (repo: string, refresh = false) => {
      const q = new URLSearchParams({ repo });
      if (refresh) q.set('refresh', '1');
      const mirror = selectedMirrorId();
      if (mirror) q.set('mirror', mirror);
      return request<{ ok: boolean; markdown?: string; message?: string }>(
        `/api/plugin-store/readme?${q.toString()}`,
      );
    },
    comments: (id: number, limit = 50) =>
      request<{
        ok: boolean;
        message?: string;
        resource_id?: number;
        total?: number;
        comments?: StoreComment[];
      }>(`/api/plugin-store/comments?id=${id}&limit=${limit}`),
    coverUrl: (id: number) => `/api/plugin-store/cover?id=${id}&v=3`,
    install: (id: number, taskId?: string) =>
      request<{
        ok: boolean;
        pluginId?: string;
        kind?: 'kakake' | 'gf';
        /** sha256 校验失败时为 'sha256_mismatch' */
        code?: string;
        message: string;
      }>('/api/plugin-store/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, mirror: selectedMirrorId() || undefined, taskId: taskId || undefined }),
      }),
    /** 安装下载进度轮询（后端凭 install 请求带来的 taskId 记账） */
    installProgress: (taskId: string) =>
      request<{
        ok: boolean;
        downloaded?: number;
        total?: number;
        phase?: 'downloading' | 'installing';
      }>(`/api/plugin-store/install/progress?taskId=${encodeURIComponent(taskId)}`),
    /** 取消下载：后端掐断在途 fetch，install 的 POST 会以 code='cancelled' 收场 */
    cancelInstall: (taskId: string) =>
      request<{ ok: boolean; message?: string }>('/api/plugin-store/install/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId }),
      }),
    /** 刷新重连：安装已结束后取走一次性暂存结果 */
    installResult: (taskId: string) =>
      request<{
        found: boolean;
        result?: { ok: boolean; code?: string; message: string; pluginId?: string; kind?: string };
      }>(`/api/plugin-store/install/result?taskId=${encodeURIComponent(taskId)}`),
    /** 下载配置（设置页「多线程下载」，仅 GitHub/URL 源生效） */
    downloadConfig: () =>
      request<{
        ok: boolean;
        multiThread: boolean;
        mode: 'always' | 'minSize';
        minSizeMB: number;
      }>('/api/plugin-store/download-config'),
    setDownloadConfig: (patch: {
      multiThread?: boolean;
      mode?: 'always' | 'minSize';
      minSizeMB?: number;
    }) =>
      request<{
        ok: boolean;
        multiThread: boolean;
        mode: 'always' | 'minSize';
        minSizeMB: number;
      }>('/api/plugin-store/download-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      }),
  },

  logs: {
    list: (params?: { limit?: number; level?: string; category?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.level) q.set('level', params.level);
      if (params?.category) q.set('category', params.category);
      return request<{ logs: LogEntry[] }>(`/api/logs?${q}`);
    },
    clear: () => request('/api/logs/clear', { method: 'POST' }),
    /** 日志目录下的 .log 文件列表（临时查看用） */
    files: () => request<{ files: LogFileInfo[] }>('/api/logs/files'),
    /** 读取指定日志文件内容（临时查看，不进内存环形缓冲） */
    file: (name: string) =>
      request<{ logs: LogEntry[] }>(`/api/logs/file?name=${encodeURIComponent(name)}`),
    download: async (params?: { limit?: number; level?: string; category?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.level) q.set('level', params.level);
      if (params?.category) q.set('category', params.category);
      const res = await fetch(`/api/logs/download?${q}`, {
        credentials: 'include',
        headers: authHeaders(),
      });
      await downloadBlob(res, `kakake-runtime-${Date.now()}.log`);
    },
  },

  tools: {
    /**
     * 页面内展示用的媒体地址：twimg（X 的媒体 CDN）浏览器直连被墙，
     * 展示统一改走服务端预览端点；其他平台保持原直连地址。
     */
    mediaViewUrl: (params: {
      url: string;
      kind?: 'video' | 'cover';
      platform?: string | null;
    }) => {
      const qs = new URLSearchParams({
        url: params.url,
        kind: params.kind || 'cover',
        ...(params.platform ? { platform: params.platform } : {}),
      });
      return `/api/tools/media-view?${qs.toString()}`;
    },
    mediaParse: (text: string, opts?: { signal?: AbortSignal }) =>
      request<MediaParseResult>('/api/tools/media-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        // 解析一次最长可能几十秒（各平台串行重试），必须能被调用方取消
        signal: opts?.signal,
      }),
    mediaDownload: async (params: {
      url: string;
      kind: 'video' | 'cover';
      platform?: string | null;
      cookie?: string | null;
    }) => {
      // 媒体文件可能很大很慢，刻意不挂超时 signal
      const res = await fetch('/api/tools/media-download', {
        method: 'POST',
        credentials: 'include',
        headers: {
          ...authHeaders({ 'Content-Type': 'application/json' }),
        },
        body: JSON.stringify({
          url: params.url,
          kind: params.kind,
          platform: params.platform || undefined,
          cookie: params.cookie || undefined,
        }),
      });
      await downloadBlob(
        res,
        params.kind === 'cover' ? `cover-${Date.now()}.jpg` : `video-${Date.now()}.mp4`,
      );
    },
  },

  openPlatform: {
    state: () => request<OpenPlatformState>('/api/open-platform/state'),
    qr: () =>
      request<{ ok: boolean; id?: string; url?: string; qrDataUrl?: string; version?: number; message?: string }>(
        '/api/open-platform/qr',
        { method: 'POST' },
      ),
    poll: (id: string) =>
      request<{
        ok: boolean;
        stage: 'pending' | 'done' | 'error';
        message?: string;
        version?: number;
        qrDataUrl?: string;
        appIds?: string[];
        openid?: string;
      }>('/api/open-platform/poll', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }),
    cancelQr: (id: string) =>
      request<{ ok: boolean }>('/api/open-platform/qr/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }),
    probe: (appId: string, appSecret: string, sandbox: boolean) =>
      request<{ ok: boolean; message?: string; appId?: string; profile?: OpenPlatformProfile | null }>(
        '/api/open-platform/probe',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId, appSecret, sandbox }),
        },
      ),
    addPending: (appId: string, name: string) =>
      request<{ ok: boolean; message?: string; duplicated?: boolean }>('/api/open-platform/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId, name }),
      }),
    removePending: (appId: string) =>
      request<{ ok: boolean }>('/api/open-platform/pending/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId }),
      }),
    insight: (id: string) =>
      request<OpenPlatformInsight>(`/api/open-platform/insight?id=${encodeURIComponent(id)}`),
    channels: (id: string, guildId: string) =>
      request<{ ok: boolean; message?: string; channels?: OpenPlatformChannel[] }>(
        `/api/open-platform/channels?id=${encodeURIComponent(id)}&guildId=${encodeURIComponent(guildId)}`,
      ),
    getMenu: (id: string) =>
      request<{ ok: boolean; message?: string; version?: number; items?: MenuItem[] }>(
        `/api/open-platform/menu?id=${encodeURIComponent(id)}`,
      ),
    putMenu: (id: string, items: MenuItem[]) =>
      request<{ ok: boolean; message?: string; version?: number }>('/api/open-platform/menu', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, items }),
      }),
    getPanels: (id: string, scope: PanelScope) =>
      request<{ ok: boolean; message?: string; scope?: string; records?: PanelRecord[] }>(
        `/api/open-platform/panels?id=${encodeURIComponent(id)}&scope=${encodeURIComponent(scope)}`,
      ),
    createPanel: (body: {
      id: string;
      scope: PanelScope;
      targetType: 'all' | 'specific';
      userOpenids?: string[];
      groupOpenids?: string[];
      items: PanelItem[];
      remark?: string;
    }) =>
      request<{ ok: boolean; message?: string; panelId?: string }>('/api/open-platform/panels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    updatePanel: (panelId: string, id: string, items: PanelItem[], remark?: string) =>
      request<{ ok: boolean; message?: string }>(
        `/api/open-platform/panels/${encodeURIComponent(panelId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, items, remark }),
        },
      ),
    deletePanel: (panelId: string, id: string) =>
      request<{ ok: boolean; message?: string }>(
        `/api/open-platform/panels/${encodeURIComponent(panelId)}?id=${encodeURIComponent(id)}`,
        { method: 'DELETE' },
      ),
  },

  simulate: {
    accounts: () =>
      request<{ code: number; data: SimulateAccount[] }>('/api/simulate/accounts'),
    history: (accountKey: string) =>
      request<{ code: number; data: SimulateTranscript }>(
        `/api/simulate/history?accountKey=${encodeURIComponent(accountKey)}`,
      ),
    send: (accountKey: string, input: SimulateSendInput) =>
      request<{ code: number; message?: string; data?: { dispatched: number; captured: number } }>(
        '/api/simulate/send',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountKey, input }),
        },
      ),
    event: (accountKey: string, input: SimulateEventInput) =>
      request<{ code: number; message?: string; data?: { dispatched: number; captured: number } }>(
        '/api/simulate/event',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ accountKey, input }),
        },
      ),
    clear: (accountKey: string) =>
      request<{ code: number; message?: string }>('/api/simulate/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountKey }),
      }),
  },

  tutorials: {
    pluginDev: () =>
      request<{
        code: number;
        message: string;
        data: {
          introMarkdown: string;
          /** 首屏「总览」卡片文案 */
          introCard: { title: string; subtitle: string; description: string };
          tracks: Array<{
            id: string;
            label: string;
            /** 首屏卡片文案 */
            cardTitle: string;
            cardSubtitle: string;
            cardDescription: string;
            dir: string;
            guide: string;
            guideMarkdown: string;
            files: Array<{
              path: string;
              title: string;
              downloadName: string;
              language: string;
              content: string;
              heading?: string;
            }>;
          }>;
        };
      }>('/api/tutorials/plugin-dev'),
  },

  /**
   * 「接口代理」页：一次性拉全部注册表条目（含 examples / impl）。
   * 后端刻意不返回摘要——控制台要点开一条看请求参数与三种返回示例。
   */
  proxyApis: () =>
    request<{ ok: true; count: number; items: Array<Record<string, unknown>> }>('/api/proxy/apis'),

  /**
   * 登录防护：状态与手动解除。
   * 全局冷却触发后管理员要能看懂「为什么登不进来」，并且不用重启就能解封。
   */
  loginGuard: {
    state: () =>
      request<{
        ok: boolean;
        pressure: boolean;
        globalLockedMs: number;
        failsInWindow: number;
        distinctSources: number;
        trackedSources: number;
        trackedNetworks: number;
        trackedKeys: number;
        trustedSources: number;
      }>('/api/security/login-guard'),
    clear: () =>
      request<{ ok: boolean }>('/api/security/login-guard/clear', { method: 'POST' }),
  },
};
