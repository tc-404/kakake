import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { PATHS } from '../paths.js';
import { createSession, destroySession, isRequestAuthed, sessionCookieValue, clearSessionCookie, clearAllSessions, touchSession, readSessionId, getSessionRecord, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from './auth.middleware.js';
import { ensureAuthKey, getAuthKey, isInitialAuthKey, setCustomAuthKey } from './auth-key.js';
import { validateCustomPassword } from './password-rules.js';
import { DEFAULT_CONFIG, normalizeApiTimeoutMs, parseConnectionMode, isReconnectableOnebotMode, type KakakeConfig, type ConnectionMode } from '../core/types.js';
import { isOnebotConnection } from '../core/types.js';
import { fetchQqOfficialBotProfile, appendQqOfficialAuthHint } from '../connection/qq-official-api.js';
import { buildPluginListPayload } from '../plugin/plugin-list.service.js';
import { connectionPluginService } from '../plugin/connection-plugin.service.js';
import { saveMultipartFile } from './multipart-file.js';
import { pluginAccountService } from '../plugin/plugin-account.service.js';
import { isGfPluginDir } from '../plugin/gf-plugin-id.js';
import { isWxPluginDir } from '../plugin/wx-plugin-id.js';
import { weixinBotLoggedIn } from '../core/types.js';
import { resolveInstalledPluginDocs } from '../plugin/plugin-meta.js';
import { parseMedia } from '../tools/media/parse-media.js';
import {
  fetchMediaForDownload,
  upstreamBodyToNodeStream,
  type MediaDownloadKind,
} from '../tools/media/media-proxy-download.js';
import {
  createAccount,
  findAccount,
  loadZeppSteps,
  saveZeppSteps,
  toPublic,
} from '../tools/zepp-steps/store.js';
import { runZeppSteps } from '../tools/zepp-steps/runner.js';
import {
  connectionAvatarDataUrl,
  fetchAndStoreAvatarFromUrl,
  getConnectionAvatarMeta,
  removeConnectionAvatar,
} from '../connection/connection-avatar.store.js';

function resolveConnectionPluginKindFromConn(connectionId: string): 'kakake' | 'gf' | 'wx' {
  const type = configService.getConnection(connectionId)?.type ?? 'onebot';
  if (type === 'qq_official') return 'gf';
  if (type === 'weixin_bot') return 'wx';
  return 'kakake';
}

/** 按 ID 路由到 GF / 微信 / 普通插件管理器 */
function resolvePluginManager(id: string) {
  const trimmed = String(id || '').trim();
  if (
    kakakeApp.wxPluginManager?.getPluginInfo(trimmed)
    || isWxPluginDir(trimmed)
    || /^wx-plugin-/i.test(trimmed)
    || /^wxbot/i.test(trimmed)
  ) {
    return { kind: 'wx' as const, manager: kakakeApp.wxPluginManager };
  }
  if (
    kakakeApp.gfPluginManager.getPluginInfo(trimmed)
    || isGfPluginDir(trimmed)
    || /^gf-plugin-/i.test(trimmed)
  ) {
    return { kind: 'gf' as const, manager: kakakeApp.gfPluginManager };
  }
  return { kind: 'kakake' as const, manager: kakakeApp.pluginManager };
}

@Controller('api')
export class AdminApiController {
  @Post('auth/login')
  login(@Body() body: { token?: string; key?: string } = {}, @Res() res: Response) {
    const input = (body.token ?? body.key ?? '').trim();
    if (!input || input !== getAuthKey()) {
      res.status(401).json({ ok: false, message: '登录密钥错误' });
      return;
    }
    const session = createSession();
    const rec = getSessionRecord(session);
    res.setHeader('Set-Cookie', sessionCookieValue(session, rec?.createdAt));
    res.json({
      ok: true,
      authRequired: true,
      expiresInMs: SESSION_ABSOLUTE_MS,
      idleTimeoutMs: SESSION_IDLE_MS,
      absoluteTimeoutMs: SESSION_ABSOLUTE_MS,
    });
  }

  /** 前端互动续期：重置 30 分钟空闲计时 */
  @Post('auth/touch')
  touch(@Req() req: Request, @Res() res: Response) {
    const sid = readSessionId(req);
    if (!touchSession(sid)) {
      res.status(401).json({ ok: false, message: '会话已失效，请重新登录' });
      return;
    }
    const rec = getSessionRecord(sid);
    if (sid && rec) {
      res.setHeader('Set-Cookie', sessionCookieValue(sid, rec.createdAt));
    }
    const now = Date.now();
    res.json({
      ok: true,
      idleTimeoutMs: SESSION_IDLE_MS,
      absoluteTimeoutMs: SESSION_ABSOLUTE_MS,
      idleRemainingMs: rec ? Math.max(0, SESSION_IDLE_MS - (now - rec.lastActiveAt)) : 0,
      absoluteRemainingMs: rec ? Math.max(0, SESSION_ABSOLUTE_MS - (now - rec.createdAt)) : 0,
    });
  }

  @Post('auth/logout')
  logout(@Req() req: Request, @Res() res: Response) {
    const session = readSessionId(req);
    if (session) destroySession(session);
    res.setHeader('Set-Cookie', clearSessionCookie());
    res.json({ ok: true });
  }

  /**
   * 首次登录设密（仅 initial 密钥可调用）。
   * 写入 custom 标签后刷新会话，避免改密后仍用旧会话。
   */
  @Post('auth/setup-password')
  setupPassword(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { password?: string; confirm?: string } = {},
  ) {
    if (!isRequestAuthed(req)) {
      res.status(401).json({ ok: false, message: 'Unauthorized' });
      return;
    }
    if (!isInitialAuthKey()) {
      res.status(400).json({ ok: false, message: '当前已是自定义密码，无需再次设置' });
      return;
    }
    const password = (body.password ?? '').trim();
    const confirm = (body.confirm ?? '').trim();
    if (password !== confirm) {
      res.status(400).json({ ok: false, message: '两次输入的密码不一致' });
      return;
    }
    const ruleError = validateCustomPassword(password);
    if (ruleError) {
      res.status(400).json({ ok: false, message: ruleError });
      return;
    }
    setCustomAuthKey(password);
    clearAllSessions();
    const session = createSession();
    const rec = getSessionRecord(session);
    res.setHeader('Set-Cookie', sessionCookieValue(session, rec?.createdAt));
    res.json({ ok: true, needsPasswordSetup: false });
  }

  @Get('settings')
  settings() {
    const config = configService.getConfig();
    return {
      config: {
        ...config,
        // 登录密钥改由首次设密流程管理，设置页不再展示/修改
        token: '',
      },
      defaults: DEFAULT_CONFIG,
      paths: {
        root: PATHS.root,
        data: PATHS.data,
        plugins: PATHS.plugins,
        gfPlugins: PATHS.gfPlugins,
        log: PATHS.log,
        authKey: PATHS.authKey,
      },
    };
  }

  @Put('settings')
  saveSettings(@Body() body: Partial<KakakeConfig> = {}) {
    const current = configService.getConfig();
    const next: KakakeConfig = {
      host: body.host?.trim() || '0.0.0.0',
      port: Number(body.port) || current.port,
      token: '',
      logLevel: body.logLevel || current.logLevel,
      apiTimeoutMs: normalizeApiTimeoutMs(body.apiTimeoutMs ?? current.apiTimeoutMs),
    };
    // 忽略 body.token：密码仅能通过首次设密接口修改
    configService.saveConfig(next);
    return {
      ok: true,
      config: {
        ...next,
        token: '',
      },
    };
  }

  @Post('settings/reset')
  resetSettings() {
    configService.saveConfig(DEFAULT_CONFIG);
    ensureAuthKey();
    return {
      ok: true,
      config: {
        ...DEFAULT_CONFIG,
        token: '',
      },
    };
  }

  @Get('connections')
  listConnections() {
    return { connections: kakakeApp.connectionManager.getStatusList() };
  }

  @Get('connections/:id/avatar')
  getConnectionAvatar(@Param('id') id: string) {
    const conn = configService.getConnection(id);
    if (!conn) return { ok: false, message: 'not found' };
    const dataUrl = connectionAvatarDataUrl(id);
    if (!dataUrl) return { ok: false, message: 'no avatar' };
    const meta = getConnectionAvatarMeta(id);
    return {
      ok: true,
      dataUrl,
      updatedAt: meta.avatarUpdatedAt,
    };
  }

  @Post('connections/qq-official/preview')
  async previewQqOfficialBot(
    @Body() body: { appId?: string; appSecret?: string; sandbox?: boolean } = {},
  ) {
    const appId = (body.appId ?? '').trim();
    const appSecret = (body.appSecret ?? '').trim();
    if (!appId || !appSecret) {
      return { ok: false, message: '请填写 AppID 与 AppSecret' };
    }
    try {
      const profile = await fetchQqOfficialBotProfile(appId, appSecret, body.sandbox !== false);
      return { ok: true, profile };
    } catch (e: unknown) {
      const raw = e instanceof Error ? e.message : String(e);
      return { ok: false, message: appendQqOfficialAuthHint(raw, body.sandbox !== false) };
    }
  }

  @Post('connections/:id/refresh-bot-profile')
  async refreshQqOfficialBotProfile(@Param('id') id: string) {
    const profile = await kakakeApp.connectionManager.refreshQqOfficialBotProfile(id);
    if (!profile) {
      return { ok: false, message: '无法获取机器人资料，请检查凭证或连接状态' };
    }
    return {
      ok: true,
      profile,
      connections: kakakeApp.connectionManager.getStatusList(),
    };
  }

  @Post('connections')
  async addConnection(
    @Body() body: {
      name?: string;
      type?: 'onebot' | 'qq_official' | 'weixin_bot';
      mode?: ConnectionMode;
      host?: string;
      port?: number;
      accessToken?: string;
      apiUrl?: string;
      appId?: string;
      appSecret?: string;
      sandbox?: boolean;
      webhookBaseUrl?: string;
      reconnectIntervalMs?: number;
      reconnectMaxAttempts?: number;
    } = {},
  ) {
    const data = configService.getConnections();
    const type = body.type === 'qq_official'
      ? 'qq_official'
      : body.type === 'weixin_bot'
        ? 'weixin_bot'
        : 'onebot';

    if (type === 'weixin_bot') {
      const conn = {
        id: randomUUID().slice(0, 8),
        name: (body.name ?? '').trim() || '微信 AI×BOT',
        type: 'weixin_bot' as const,
        host: '',
        port: 0,
        enable: false,
        createdAt: Date.now(),
      };
      data.connections.push(conn);
      configService.saveConnections(data);
      return { ok: true, connection: conn };
    }

    if (type === 'qq_official') {
      const appId = (body.appId ?? '').trim();
      const appSecret = (body.appSecret ?? '').trim();
      if (!appId || !appSecret) {
        return { ok: false, message: '请填写 AppID 与 AppSecret' };
      }
      let botProfile;
      let name = (body.name ?? '').trim();
      try {
        botProfile = await fetchQqOfficialBotProfile(appId, appSecret, body.sandbox !== false);
        name = botProfile.username || name || 'QQ 官方机器人';
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e);
        const msg = appendQqOfficialAuthHint(raw, body.sandbox !== false);
        return { ok: false, message: `无法获取机器人资料: ${msg}` };
      }
      const isHttps = body.mode === 'https';
      const webhookBase = (body.webhookBaseUrl ?? '').trim().replace(/\/+$/, '');
      const conn = {
        id: randomUUID().slice(0, 8),
        name,
        type: 'qq_official' as const,
        mode: isHttps ? ('https' as const) : undefined,
        host: '',
        port: 0,
        enable: false,
        appId,
        appSecret,
        sandbox: body.sandbox !== false,
        botProfile,
        webhookBaseUrl: isHttps && webhookBase ? webhookBase : undefined,
        reconnectIntervalMs: Number(body.reconnectIntervalMs) || 5000,
        reconnectMaxAttempts: Number.isFinite(Number(body.reconnectMaxAttempts))
          ? Math.max(0, Math.floor(Number(body.reconnectMaxAttempts)))
          : 15,
        createdAt: Date.now(),
      };
      data.connections.push(conn);
      configService.saveConnections(data);
      if (botProfile?.avatar) {
        void fetchAndStoreAvatarFromUrl(conn.id, botProfile.avatar, appId);
      }
      return { ok: true, connection: conn };
    }

    const mode = parseConnectionMode(body.mode);
    const defaultPort =
      mode === 'forward' ? 3001
        : mode === 'http' || mode === 'http_sse' ? 6701
          : mode === 'http_client' ? 3000
            : 6700;
    const reconnectable = isReconnectableOnebotMode(mode);
    const needsApiUrl = mode === 'http' || mode === 'http_sse';
    const conn = {
      id: randomUUID().slice(0, 8),
      name: body.name || '未命名连接',
      type: 'onebot' as const,
      mode,
      host: body.host || '127.0.0.1',
      port: Number(body.port) || defaultPort,
      accessToken: body.accessToken ?? '',
      apiUrl: needsApiUrl
        ? ((body.apiUrl ?? '').trim() || 'http://127.0.0.1:3000')
        : (body.apiUrl?.trim() || undefined),
      enable: false,
      reconnectIntervalMs: reconnectable ? Number(body.reconnectIntervalMs) || 5000 : undefined,
      reconnectMaxAttempts: reconnectable
        ? (Number.isFinite(Number(body.reconnectMaxAttempts))
          ? Math.max(0, Math.floor(Number(body.reconnectMaxAttempts)))
          : 15)
        : undefined,
      createdAt: Date.now(),
    };
    data.connections.push(conn);
    configService.saveConnections(data);
    return { ok: true, connection: conn };
  }

  @Put('connections/:id')
  async updateConnection(
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      host?: string;
      port?: number;
      accessToken?: string;
      apiUrl?: string;
      appId?: string;
      appSecret?: string;
      sandbox?: boolean;
      webhookBaseUrl?: string;
      reconnectIntervalMs?: number;
      reconnectMaxAttempts?: number;
      resetReconnect?: boolean;
    },
  ) {
    const conn = configService.getConnection(id);
    if (!conn) return { ok: false, message: 'not found' };

    if ((conn.type ?? 'onebot') === 'qq_official') {
      try {
        const updated = await kakakeApp.connectionManager.updateQqOfficialConnection(id, {
          name: body.name,
          appId: body.appId,
          appSecret: body.appSecret,
          sandbox: body.sandbox,
          webhookBaseUrl: body.webhookBaseUrl,
          reconnectIntervalMs: body.reconnectIntervalMs !== undefined
            ? Math.max(500, Math.floor(Number(body.reconnectIntervalMs) || 5000))
            : undefined,
          reconnectMaxAttempts: body.reconnectMaxAttempts !== undefined
            ? Math.max(0, Math.floor(Number(body.reconnectMaxAttempts) || 0))
            : undefined,
        });
        return { ok: true, connection: updated };
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : String(e);
        const sandbox = body.sandbox !== undefined ? body.sandbox : conn.sandbox;
        return { ok: false, message: appendQqOfficialAuthHint(raw, sandbox) };
      }
    }

    if ((conn.type ?? 'onebot') === 'weixin_bot') {
      try {
        const updated = await kakakeApp.connectionManager.updateWeixinBotConnection(id, {
          name: body.name,
        });
        return { ok: true, connection: updated };
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }

    // OneBot：可改名称/地址/端口/Token/apiUrl（运行中保存后自动重连）；可重连模式还可改重连参数
    const wantsProfileEdit =
      body.name !== undefined
      || body.host !== undefined
      || body.port !== undefined
      || body.accessToken !== undefined
      || body.apiUrl !== undefined;

    if (wantsProfileEdit) {
      try {
        const updated = kakakeApp.connectionManager.updateOnebotConnectionProfile(id, {
          name: body.name,
          host: body.host,
          port: body.port,
          accessToken: body.accessToken,
          apiUrl: body.apiUrl,
        });
        return { ok: true, connection: updated };
      } catch (e: unknown) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) };
      }
    }

    if (!isOnebotConnection(conn) || !isReconnectableOnebotMode(conn.mode)) {
      return { ok: false, message: '仅正向 WS / HTTP 客户端连接支持重连设置' };
    }

    const data = configService.getConnections();
    const stored = data.connections.find((c) => c.id === id);
    if (!stored) return { ok: false, message: 'not found' };

    const intervalMs = body.reconnectIntervalMs !== undefined
      ? Math.max(500, Math.floor(Number(body.reconnectIntervalMs) || 5000))
      : undefined;
    const maxAttempts = body.reconnectMaxAttempts !== undefined
      ? Math.max(0, Math.floor(Number(body.reconnectMaxAttempts) || 0))
      : undefined;

    const patch: {
      reconnectIntervalMs?: number;
      reconnectMaxAttempts?: number;
    } = {};
    if (intervalMs !== undefined) patch.reconnectIntervalMs = intervalMs;
    if (maxAttempts !== undefined) patch.reconnectMaxAttempts = maxAttempts;

    if (patch.reconnectIntervalMs !== undefined || patch.reconnectMaxAttempts !== undefined) {
      kakakeApp.connectionManager.applyForwardReconnectSettings(id, patch);
    }

    if (body.resetReconnect && stored.enable) {
      kakakeApp.connectionManager.reconnect(id);
    }

    const updated = configService.getConnection(id);
    return { ok: true, connection: updated };
  }

  /** @deprecated merged into updateConnection — kept for forward compat */
  @Put('connections/:id/forward')
  updateForwardConnection(
    @Param('id') id: string,
    @Body() body: {
      reconnectIntervalMs?: number;
      reconnectMaxAttempts?: number;
      resetReconnect?: boolean;
    },
  ) {
    return this.updateConnection(id, body);
  }

  @Post('connections/:id/toggle')
  toggleConnection(@Param('id') id: string) {
    const data = configService.getConnections();
    const conn = data.connections.find(c => c.id === id);
    if (!conn) return { ok: false, message: 'not found' };
    if (!conn.enable && (conn.type ?? 'onebot') === 'weixin_bot' && !weixinBotLoggedIn(conn)) {
      return { ok: false, message: '请先扫码登录微信 AI×BOT' };
    }
    conn.enable = !conn.enable;
    configService.saveConnections(data);
    if (conn.enable) kakakeApp.connectionManager.start(conn);
    else kakakeApp.connectionManager.stop(conn.id);
    void kakakeApp.pluginManager.syncAllPluginRuntimes();
    void kakakeApp.gfPluginManager.syncAllPluginRuntimes();
    void kakakeApp.wxPluginManager.syncAllPluginRuntimes();
    return { ok: true, enable: conn.enable };
  }

  @Post('connections/:id/weixin/qrcode')
  async startWeixinQr(@Param('id') id: string) {
    try {
      const qr = await kakakeApp.connectionManager.startWeixinQrLogin(id);
      return { ok: true, ...qr };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  @Get('connections/:id/weixin/qrcode-status')
  async pollWeixinQr(@Param('id') id: string, @Query('qrcode') qrcode?: string) {
    const code = String(qrcode || '').trim();
    if (!code) return { ok: false, message: '缺少 qrcode' };
    try {
      const result = await kakakeApp.connectionManager.pollWeixinQrLogin(id, code);
      return { ok: true, ...result };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  @Post('connections/:id/weixin/logout')
  logoutWeixin(@Param('id') id: string) {
    try {
      kakakeApp.connectionManager.clearWeixinCredentials(id);
      void kakakeApp.wxPluginManager.syncAllPluginRuntimes();
      return { ok: true, connections: kakakeApp.connectionManager.getStatusList() };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  @Post('connections/:id/reconnect')
  reconnectConnection(@Param('id') id: string) {
    kakakeApp.connectionManager.reconnect(id);
    return { ok: true };
  }

  @Delete('connections/:id')
  deleteConnection(
    @Param('id') id: string,
    @Query('clearData') clearData?: string,
  ) {
    const data = configService.getConnections();
    const conn = data.connections.find(c => c.id === id);
    if (!conn) return { ok: false, message: 'not found' };

    const wipeData = clearData === '1' || clearData === 'true';
    kakakeApp.connectionManager.stop(id);
    data.connections = data.connections.filter(c => c.id !== id);
    configService.saveConnections(data);
    connectionPluginService.removeConnection(id);
    pluginAccountService.cleanupConnectionAccount(conn, wipeData);
    removeConnectionAvatar(id);

    void kakakeApp.pluginManager.syncAllPluginRuntimes();
    void kakakeApp.gfPluginManager.syncAllPluginRuntimes();
    void kakakeApp.wxPluginManager.syncAllPluginRuntimes();
    return { ok: true, clearData: wipeData };
  }

  @Post('plugins/import')
  async importPlugin(@Req() req: Request) {
    let uploaded;
    try {
      uploaded = await saveMultipartFile(req, 'file', path.join(PATHS.data, 'tmp'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg.includes('过大') ? msg : `上传失败: ${msg}` };
    }
    if (!uploaded?.path || !fs.existsSync(uploaded.path)) {
      return { ok: false, message: '未收到文件' };
    }
    const result = await kakakeApp.pluginImporter.importFromZip(uploaded.path);
    if (result.ok && result.pluginId) {
      const registered = result.kind === 'gf'
        ? await kakakeApp.gfPluginManager.registerImportedPlugin(result.pluginId)
        : result.kind === 'wx'
          ? await kakakeApp.wxPluginManager.registerImportedPlugin(result.pluginId)
          : await kakakeApp.pluginManager.registerImportedPlugin(result.pluginId);
      if (!registered) {
        return {
          ok: false,
          pluginId: result.pluginId,
          kind: result.kind,
          message: '插件已解压，但注册到管理器失败，请点刷新重试',
        };
      }
    }
    return result;
  }

  @Post('plugins/rescan')
  async rescanPlugins(@Req() req: Request) {
    const connectionId = typeof req.query.connectionId === 'string' ? req.query.connectionId : undefined;
    if (!connectionId) {
      const a = await kakakeApp.pluginManager.rescanPlugins();
      const b = await kakakeApp.gfPluginManager.rescanPlugins();
      const c = await kakakeApp.wxPluginManager.rescanPlugins();
      return {
        code: 0,
        message: 'ok',
        data: { count: a + b + c, ...buildPluginListPayload() },
      };
    }
    const kind = resolveConnectionPluginKindFromConn(connectionId);
    const count = kind === 'gf'
      ? await kakakeApp.gfPluginManager.rescanPlugins()
      : kind === 'wx'
        ? await kakakeApp.wxPluginManager.rescanPlugins()
        : await kakakeApp.pluginManager.rescanPlugins();
    return {
      code: 0,
      message: 'ok',
      data: { count, ...buildPluginListPayload(connectionId) },
    };
  }

  @Post('plugins/:id/reload')
  async reloadPlugin(@Param('id') id: string) {
    const { manager } = resolvePluginManager(id);
    const ok = await manager.reloadPlugin(id);
    return { ok };
  }

  /** 读取 plugins/<id>/插件文档.md（原生 Markdown） */
  @Get('plugins/:id/docs')
  getPluginDocs(@Param('id') id: string) {
    const trimmed = String(id || '').trim();
    if (!trimmed) {
      return { ok: false, message: '缺少插件 ID' };
    }
    const { manager } = resolvePluginManager(trimmed);
    const entry = manager.getPluginInfo(trimmed);
    const docsPath = resolveInstalledPluginDocs(
      trimmed,
      entry?.pluginPath ? [entry.pluginPath] : [],
    );
    if (!docsPath) {
      return { ok: false, message: '该插件没有说明文档' };
    }
    try {
      const markdown = fs.readFileSync(docsPath, 'utf-8');
      return {
        ok: true,
        pluginId: entry?.id || trimmed,
        name: entry ? (entry.pluginJson?.displayName || entry.name || trimmed) : trimmed,
        markdown,
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '读取说明文档失败',
      };
    }
  }

  @Delete('plugins/:id')
  async uninstallPlugin(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const cleanData = req.query.cleanData === '1' || req.query.cleanData === 'true';
    try {
      const { manager } = resolvePluginManager(id);
      await manager.uninstallPlugin(id, cleanData);
      res.json({ ok: true });
    } catch (e: unknown) {
      res.status(400).json({
        ok: false,
        message: e instanceof Error ? e.message : '卸载失败',
      });
    }
  }

  /** 仅删除某连接账号下 plugins_two 运行副本，不影响 plugins/ 安装目录 */
  @Delete('connections/:connectionId/plugins/:pluginId')
  async removeConnectionPlugin(
    @Param('connectionId') connectionId: string,
    @Param('pluginId') pluginId: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const cleanData = req.query.cleanData === '1' || req.query.cleanData === 'true';
    try {
      const conn = configService.getConnection(connectionId);
      if (!conn) {
        res.status(404).json({ ok: false, message: '连接不存在' });
        return;
      }
      const { manager } = resolvePluginManager(pluginId);
      await manager.removeConnectionRuntimePlugin(connectionId, pluginId, cleanData);
      res.json({
        ok: true,
        accountKey: pluginAccountService.resolveAccountKey(conn),
        cleanData,
      });
    } catch (e: unknown) {
      res.status(400).json({
        ok: false,
        message: e instanceof Error ? e.message : '删除运行副本失败',
      });
    }
  }

  /** 工具：视频/图文链接解析（无缓存、不落盘） */
  @Post('tools/media-parse')
  async toolsMediaParse(@Body() body: { text?: string } = {}) {
    const result = await parseMedia(String(body.text || ''));
    return result;
  }

  /**
   * 工具：代理下载封面/视频（服务端带 Referer，规避浏览器 403）
   */
  @Post('tools/media-download')
  async toolsMediaDownload(
    @Body() body: { url?: string; kind?: MediaDownloadKind; platform?: string } = {},
    @Res() res: Response,
  ) {
    const kind: MediaDownloadKind = body.kind === 'cover' ? 'cover' : 'video';
    const fetched = await fetchMediaForDownload({
      url: String(body.url || ''),
      kind,
      platform: body.platform,
    });
    if (!fetched.ok) {
      res.status(fetched.status).json({ ok: false, message: fetched.message });
      return;
    }
    res.setHeader('Content-Type', fetched.contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fetched.filename}"`,
    );
    const len = fetched.response.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const nodeStream = upstreamBodyToNodeStream(fetched.response.body!);
    nodeStream.on('error', () => {
      if (!res.headersSent) res.status(502).end();
      else res.destroy();
    });
    nodeStream.pipe(res);
  }

  /** 工具：Zepp 步数（账号持久化在 data/tools/zepp-steps.json） */
  @Get('tools/zepp-steps')
  toolsZeppStepsGet() {
    return { ok: true, ...toPublic(loadZeppSteps()) };
  }

  @Put('tools/zepp-steps/settings')
  toolsZeppStepsSettings(@Body() body: { minStep?: number; maxStep?: number } = {}) {
    const file = loadZeppSteps();
    const minStep = body.minStep == null ? file.minStep : Number(body.minStep);
    const maxStep = body.maxStep == null ? file.maxStep : Number(body.maxStep);
    if (!Number.isFinite(minStep) || !Number.isFinite(maxStep)) {
      return { ok: false, message: '步数范围必须是数字', ...toPublic(file) };
    }
    if (minStep > maxStep) {
      return { ok: false, message: '最小步数不能大于最大步数', ...toPublic(file) };
    }
    file.minStep = minStep;
    file.maxStep = maxStep;
    saveZeppSteps(file);
    return { ok: true, ...toPublic(loadZeppSteps()) };
  }

  @Post('tools/zepp-steps/accounts')
  toolsZeppStepsAddAccount(
    @Body() body: { user?: string; password?: string; enabled?: boolean } = {},
  ) {
    const user = String(body.user || '').trim();
    const password = String(body.password || '');
    if (!user || !password) {
      return { ok: false, message: '请填写账号和密码' };
    }
    const file = loadZeppSteps();
    file.accounts.push(createAccount({ user, password, enabled: body.enabled }));
    saveZeppSteps(file);
    return { ok: true, ...toPublic(loadZeppSteps()) };
  }

  @Put('tools/zepp-steps/accounts/:id')
  toolsZeppStepsUpdateAccount(
    @Param('id') id: string,
    @Body() body: { user?: string; password?: string; enabled?: boolean } = {},
  ) {
    const file = loadZeppSteps();
    const account = findAccount(file, String(id || '').trim());
    if (!account) return { ok: false, message: '找不到该账号' };
    if (body.user != null) {
      const user = String(body.user).trim();
      if (!user) return { ok: false, message: '账号不能为空' };
      if (user !== account.user) {
        account.user = user;
        account.tokens = {};
      }
    }
    if (typeof body.password === 'string' && body.password.length > 0) {
      account.password = body.password;
      account.tokens = {};
    }
    if (typeof body.enabled === 'boolean') account.enabled = body.enabled;
    saveZeppSteps(file);
    return { ok: true, ...toPublic(loadZeppSteps()) };
  }

  @Delete('tools/zepp-steps/accounts/:id')
  toolsZeppStepsDeleteAccount(@Param('id') id: string) {
    const file = loadZeppSteps();
    const before = file.accounts.length;
    file.accounts = file.accounts.filter((a) => a.id !== String(id || '').trim());
    if (file.accounts.length === before) return { ok: false, message: '找不到该账号' };
    saveZeppSteps(file);
    return { ok: true, ...toPublic(loadZeppSteps()) };
  }

  @Post('tools/zepp-steps/run')
  async toolsZeppStepsRun(@Body() body: { id?: string; step?: number } = {}) {
    const id = String(body.id || '').trim() || undefined;
    const stepNum = body.step == null ? Number.NaN : Number(body.step);
    const result = await runZeppSteps({
      id,
      step: Number.isFinite(stepNum) ? stepNum : undefined,
    });
    return { ...result, ...toPublic(loadZeppSteps()) };
  }
}
