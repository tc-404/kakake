import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream';
import path from 'node:path';
import fs from 'node:fs';
import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { PATHS } from '../paths.js';
import { createSession, destroySession, isRequestAuthed, sessionCookieValue, clearSessionCookie, clearAllSessions, touchSession, readSessionId, getSessionRecord, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from './auth.middleware.js';
import { ensureAuthKey, isInitialAuthKey, matchesAuthKey, setCustomAuthKey } from './auth-key.js';
import { remoteAddressOf } from '../core/net-address.js';
import { logAction } from '../core/log-store.js';
import {
  describeBlockedFor,
  loginBlockedFor,
  recordLoginFailure,
  recordLoginSuccess,
} from './login-throttle.js';
import { validateCustomPassword } from './password-rules.js';
import { promotePendingOnLogin, checkRemoteAnnouncementInBackground } from './announcement-update.service.js';
import { DEFAULT_CONFIG, normalizeApiTimeoutMs, parseConnectionMode, isReconnectableOnebotMode, type KakakeConfig, type ConnectionMode } from '../core/types.js';
import { isOnebotConnection } from '../core/types.js';
import {
  normalizeConnection,
  type ConnectionConfig,
} from '../core/types.js';
import { matchExistingConnection, mergePluginSwitches } from '../core/connection-import.js';
import { fetchQqOfficialBotProfile, appendQqOfficialAuthHint } from '../connection/qq-official-api.js';
import { buildPluginListPayload } from '../plugin/plugin-list.service.js';
import { connectionPluginService } from '../plugin/connection-plugin.service.js';
import { saveMultipartFile } from './multipart-file.js';
import { pluginAccountService } from '../plugin/plugin-account.service.js';
import { isGfPluginDir } from '../plugin/gf-plugin-id.js';
import { isWxPluginDir } from '../plugin/wx-plugin-id.js';
import { isSsPluginDir } from '../plugin/ss-plugin-id.js';
import { weixinBotLoggedIn } from '../core/types.js';
import { resolveInstalledPluginDocs } from '../plugin/plugin-meta.js';
import { parseMedia, failedResult } from '../tools/media/parse-media.js';
import { mediaThrottleBlockedFor, mediaThrottleBucketOf } from '../tools/media/media-throttle.js';
import {
  fetchMediaForDownload,
  fetchMediaForView,
  upstreamBodyToNodeStream,
  type MediaDownloadKind,
} from '../tools/media/media-proxy-download.js';
import {
  connectionAvatarDataUrl,
  fetchAndStoreAvatarFromUrl,
  getConnectionAvatarMeta,
  removeConnectionAvatar,
} from '../connection/connection-avatar.store.js';

import { warnProxyDenied, resolveConnectionPluginKindFromConn, resolvePluginManager, syncAllPluginManagers } from './admin-api.shared.js';

/** 拉起一条连接，并同步各插件运行时——与手动点「启用」走同一条路径 */
function startConnection(conn: Parameters<typeof kakakeApp.connectionManager.start>[0]): void {
  kakakeApp.connectionManager.start(conn);
  syncAllPluginManagers();
}

/** 连接配置导出文件的格式标记：导入时靠它确认「这是一份咔咔珂连接配置」 */
const CONNECTIONS_EXPORT_FORMAT = 'kakake-connections-v1';

/** 导出 / 导入的单条连接：配置字段之外，多挂一份该连接的插件开关 */
type ExportedConnection = ConnectionConfig & { pluginSwitches?: Record<string, boolean> };

type ConnectionsImportBody = {
  format?: string;
  connections?: unknown;
};

@Controller('api')
export class ConnectionsApiController {
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
      type?: 'onebot' | 'qq_official' | 'weixin_bot' | 'kook';
      mode?: ConnectionMode;
      host?: string;
      port?: number;
      accessToken?: string;
      apiUrl?: string;
      appId?: string;
      appSecret?: string;
      sandbox?: boolean;
      /** 创建后是否直接启用并拉起连接；开放平台扫码/登记接入会传 true */
      enable?: boolean;
      webhookBaseUrl?: string;
      kookToken?: string;
      reconnectIntervalMs?: number;
      reconnectMaxAttempts?: number;
    } = {},
  ) {
    const data = configService.getConnections();
    const type = body.type === 'qq_official'
      ? 'qq_official'
      : body.type === 'weixin_bot'
        ? 'weixin_bot'
        : body.type === 'kook'
          ? 'kook'
          : 'onebot';

    if (type === 'kook') {
      const token = (body.kookToken ?? '').trim();
      if (!token) {
        return { ok: false, message: '请填写 KOOK 机器人 Token' };
      }
      const conn = {
        id: randomUUID().slice(0, 8),
        name: (body.name ?? '').trim() || 'KOOK 机器人',
        type: 'kook' as const,
        host: '',
        port: 0,
        enable: false,
        kookToken: token,
        reconnectIntervalMs: Number(body.reconnectIntervalMs) || 5000,
        reconnectMaxAttempts: Number.isFinite(Number(body.reconnectMaxAttempts))
          ? Math.max(0, Math.floor(Number(body.reconnectMaxAttempts)))
          : 15,
        createdAt: Date.now(),
      };
      data.connections.push(conn);
      configService.saveConnections(data);
      return { ok: true, connection: conn };
    }

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
        enable: body.enable === true,
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
      if (conn.enable) startConnection(conn);
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
      kookToken?: string;
      /** QQ 官方：Intents 位标志；0/不传 = 内置默认 */
      intents?: number;
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
          intents: body.intents !== undefined ? Math.max(0, Math.floor(Number(body.intents) || 0)) : undefined,
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

    if ((conn.type ?? 'onebot') === 'kook') {
      try {
        const updated = await kakakeApp.connectionManager.updateKookConnection(id, {
          name: body.name,
          kookToken: body.kookToken,
          reconnectIntervalMs: body.reconnectIntervalMs,
          reconnectMaxAttempts: body.reconnectMaxAttempts,
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
    syncAllPluginManagers();
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

    syncAllPluginManagers();
    return { ok: true, clearData: wipeData };
  }

  /**
   * 导出连接配置（含每条连接的插件开关）。
   *
   * 走 `configService` 拿原始配置，不用 `getStatusList`——后者为了界面安全把
   * appSecret / accessToken / kookToken 抹成了 `hasAccessToken` 布尔，拿它导出就等于
   * 导一份缺密钥的废文件，导到另一台机器根本连不上。
   */
  @Get('connections/export')
  exportConnections() {
    const data = configService.getConnections();
    const plugins = configService.getConnectionPlugins();
    const connections: ExportedConnection[] = data.connections.map((c) => ({
      ...c,
      // 关着的也要写（false 而不是省略），否则导入时会被当成「这份里没提这个插件」
      pluginSwitches: { ...(plugins[c.id] || {}) },
    }));
    return {
      format: CONNECTIONS_EXPORT_FORMAT,
      exportedAt: Date.now(),
      connections,
    };
  }

  /**
   * 导入连接配置：既是叠加也是覆盖。
   *
   * 判重按 `connectionFingerprint()`——OneBot 要「账号 + 地址 + 端口 + 密钥」四要素全同
   * 才算同一条（同账号换个端口就是另一个接入点，算新增）；其余三种协议按账号 id。
   *
   * 命中已有连接时：**连接字段整条替换，但保留原来的 id**（插件开关是按 connectionId
   * 存的，换了 id 就等于把人家开关全丢了）；**插件开关做合并**——这份文件里写了的
   * 一律以它为准，没写到的保留原状，不会因为导入而把某个插件关掉。
   */
  @Post('connections/import')
  importConnections(@Body() body: ConnectionsImportBody = {}) {
    const rawList = body?.connections;
    if (!Array.isArray(rawList)) {
      return { ok: false, message: '数据格式不对：缺少 connections 数组' };
    }
    if (rawList.length === 0) {
      return { ok: false, message: '这份文件里没有任何连接' };
    }

    const data = configService.getConnections();
    const plugins = configService.getConnectionPlugins();
    const existing = data.connections;

    let added = 0;
    let updated = 0;
    let skipped = 0;
    const touchedIds: string[] = [];

    for (const item of rawList) {
      if (!item || typeof item !== 'object') { skipped += 1; continue; }
      const rec = item as Partial<ExportedConnection>;
      if (!rec.name && !rec.id && !rec.host && !rec.appId && !rec.kookToken && !rec.weixinToken) {
        skipped += 1;
        continue;
      }

      // pluginSwitches 不是连接字段，先摘出来，别让它被 normalize 吃掉
      const { pluginSwitches, ...fields } = rec;
      const incoming = normalizeConnection({
        ...fields,
        id: String(fields.id || '').trim(),
        name: String(fields.name || '').trim(),
      } as Parameters<typeof normalizeConnection>[0]);
      if (!incoming.name) incoming.name = incoming.type === 'onebot' ? 'OneBot 连接' : '导入的连接';

      // ① 严格指纹；② OneBot 且这份没账号（导出时还没连上过）时，退化成地址+端口+密钥
      const target = matchExistingConnection(existing, incoming);

      if (target) {
        // 覆盖：整条替换，但 id 用原来那个
        const idx = existing.indexOf(target);
        const keepId = target.id;
        existing[idx] = { ...incoming, id: keepId };
        updated += 1;
        touchedIds.push(keepId);
        plugins[keepId] = mergePluginSwitches(plugins[keepId], pluginSwitches);
      } else {
        // 新增：id 冲突就换一个，绝不覆盖别的连接
        let newId = String(incoming.id || '').trim();
        if (!newId || existing.some((c) => c.id === newId)) {
          newId = randomUUID().slice(0, 8);
        }
        existing.push({ ...incoming, id: newId });
        added += 1;
        touchedIds.push(newId);
        plugins[newId] = mergePluginSwitches(undefined, pluginSwitches);
      }
    }

    if (added === 0 && updated === 0) {
      return { ok: false, message: `没有可导入的连接（跳过 ${skipped} 条无效数据）` };
    }

    configService.saveConnections(data);
    configService.saveConnectionPlugins(plugins);

    // 动了的连接按当前 enable 重启一遍：配置换了，老的运行实例得换掉
    for (const id of touchedIds) {
      const conn = existing.find((c) => c.id === id);
      if (!conn) continue;
      kakakeApp.connectionManager.stop(id);
      if (conn.enable) kakakeApp.connectionManager.start(conn);
    }
    syncAllPluginManagers();

    return {
      ok: true,
      added,
      updated,
      skipped,
      total: existing.length,
    };
  }

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

  /** 工具：视频/图文链接解析（无缓存、不落盘；按会话/密钥/来源分桶限速） */
}
