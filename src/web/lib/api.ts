import type {
  ConnectionMode,
  ConnectionStatus,
  ConnectionType,
  KakakeConfig,
  LogEntry,
  PluginItem,
  ExtensionPage,
  ConfigSchemaItem,
  StoreResource,
  StoreComment,
  MediaParseResult,
  ZeppStepsState,
} from './types';
import type {
  AppearanceSettings,
  AppearanceState,
  BackgroundOrientation,
} from './appearance';
import type {
  SimulateAccount,
  SimulateEventInput,
  SimulateSendInput,
  SimulateTranscript,
} from './simulate-types';

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

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const h: Record<string, string> = { ...(extra as Record<string, string>) };
  const t = getStoredToken();
  if (t) h.Authorization = `Bearer ${t}`;
  return h;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...authHeaders(),
      ...(init?.headers as Record<string, string>),
    },
  });
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

export type UpdateVersionInfo = {
  version: string;
  tag: string;
  name: string;
  url: string;
  publishedAt: string;
};

export type UpdateStateResp = {
  ok: boolean;
  status: 'idle' | 'checking' | 'latest' | 'update' | 'unreachable';
  checkedThisSession: boolean;
  currentVersion: string;
  remoteVersion: string;
  hasUpdate: boolean;
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

  /** 在线更新 · 安装此版本：开始下载并暂存选定 tag（不替换现有文件） */
  updateInstall: (tag: string, mirrorId?: string | null) =>
    request<UpdateInstallState>('/api/update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, mirrorId: mirrorId ?? null }),
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
    return { ok: true as const, source: 'remote' as const, markdown: data.markdown };
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

  connections: {
    list: () => request<{ connections: ConnectionStatus[] }>('/api/connections'),
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
    toggle: (id: string) => request(`/api/connections/${id}/toggle`, { method: 'POST' }),
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
    importZip: async (file: File, timeoutMs = 120_000) => {
      const fd = new FormData();
      fd.append('file', file, file.name || 'plugin.zip');
      const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 120_000;
      let res: Response;
      try {
        res = await fetch('/api/plugins/import', {
          method: 'POST',
          credentials: 'include',
          headers: authHeaders(),
          body: fd,
          signal: AbortSignal.timeout(ms),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : '';
        const msg = e instanceof Error ? e.message : String(e);
        if (
          name === 'TimeoutError'
          || name === 'AbortError'
          || /timeout|aborted/i.test(msg)
        ) {
          throw new Error('上传超时');
        }
        throw e instanceof Error ? e : new Error(String(e));
      }
      const data = (await res.json()) as {
        ok: boolean;
        pluginId?: string;
        kind?: 'kakake' | 'gf' | 'wx' | 'ss';
        message: string;
      };
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
      return data;
    },
  },

  pluginStore: {
    list: (refresh = false) =>
      request<{
        ok: boolean;
        message?: string;
        catName?: string;
        catId?: number;
        pinned?: StoreResource[];
        resources?: StoreResource[];
      }>(`/api/plugin-store/list${refresh ? '?refresh=1' : ''}`),
    comments: (id: number, limit = 50) =>
      request<{
        ok: boolean;
        message?: string;
        resource_id?: number;
        total?: number;
        comments?: StoreComment[];
      }>(`/api/plugin-store/comments?id=${id}&limit=${limit}`),
    coverUrl: (id: number) => `/api/plugin-store/cover?id=${id}&v=3`,
    install: (id: number) =>
      request<{
        ok: boolean;
        pluginId?: string;
        kind?: 'kakake' | 'gf';
        message: string;
      }>('/api/plugin-store/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
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
    download: async (params?: { limit?: number; level?: string; category?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.level) q.set('level', params.level);
      if (params?.category) q.set('category', params.category);
      const res = await fetch(`/api/logs/download?${q}`, {
        credentials: 'include',
        headers: authHeaders(),
      });
      if (!res.ok) {
        let msg = res.statusText;
        try {
          const j = await res.json();
          msg = j.message || msg;
        } catch { /* ignore */ }
        throw new Error(msg || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const dispo = res.headers.get('Content-Disposition') || '';
      const match = dispo.match(/filename="?([^"]+)"?/);
      const filename = match?.[1] || `kakake-runtime-${Date.now()}.log`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
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
      const match = dispo.match(/filename="?([^"]+)"?/i);
      const filename =
        match?.[1]
        || (params.kind === 'cover' ? `cover-${Date.now()}.jpg` : `video-${Date.now()}.mp4`);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    },
    zeppSteps: {
      get: () => request<ZeppStepsState>('/api/tools/zepp-steps'),
      saveSettings: (minStep: number, maxStep: number) =>
        request<ZeppStepsState>('/api/tools/zepp-steps/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minStep, maxStep }),
        }),
      addAccount: (body: { user: string; password: string; enabled?: boolean }) =>
        request<ZeppStepsState>('/api/tools/zepp-steps/accounts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      updateAccount: (
        id: string,
        body: { user?: string; password?: string; enabled?: boolean },
      ) =>
        request<ZeppStepsState>(`/api/tools/zepp-steps/accounts/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      deleteAccount: (id: string) =>
        request<ZeppStepsState>(`/api/tools/zepp-steps/accounts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        }),
      run: (body: { id?: string; step?: number } = {}) =>
        request<ZeppStepsState>('/api/tools/zepp-steps/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
    },
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
};
