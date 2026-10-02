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
import { getGithubToken, setGithubToken, verifyGithubToken } from '../core/github-token.js';
import { pluginStoreService } from '../plugin/plugin-store.service.js';
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

import { warnProxyDenied, resolveConnectionPluginKindFromConn, resolvePluginManager } from './admin-api.shared.js';

@Controller('api')
export class AdminApiController {
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
      publicApiEnabled: typeof body.publicApiEnabled === 'boolean'
        ? body.publicApiEnabled
        : current.publicApiEnabled,
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

  /** GitHub API Token：仅内存 + data/github-auth.json，不走主配置 */
  @Get('settings/github-token')
  githubToken() {
    const token = getGithubToken();
    return { ok: true, token, configured: !!token };
  }

  /**
   * 保存 GitHub API Token（空串 = 清空）并即时打官方接口校验。
   * 校验失败**仍保存**：可能是网络不通而非 Token 错，交由前端提示，用户可自行决定去留。
   */
  @Put('settings/github-token')
  async saveGithubToken(@Body() body: { token?: string } = {}) {
    const token = setGithubToken(body?.token === undefined ? '' : body.token);
    // Token 变了 → 下载次数能力可能随之开关，丢掉商店缓存让下次拉取重新补齐
    pluginStoreService.invalidateGithub();
    if (!token) {
      return { ok: true, token: '', configured: false, verify: null };
    }
    const verify = await verifyGithubToken(token);
    return { ok: true, token, configured: true, verify };
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
          : result.kind === 'ss'
            ? await kakakeApp.ssPluginManager.registerImportedPlugin(result.pluginId)
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
      const d = await kakakeApp.ssPluginManager.rescanPlugins();
      return {
        code: 0,
        message: 'ok',
        data: { count: a + b + c + d, ...buildPluginListPayload() },
      };
    }
    const kind = resolveConnectionPluginKindFromConn(connectionId);
    const count = kind === 'gf'
      ? await kakakeApp.gfPluginManager.rescanPlugins()
      : kind === 'wx'
        ? await kakakeApp.wxPluginManager.rescanPlugins()
        : kind === 'ss'
          ? await kakakeApp.ssPluginManager.rescanPlugins()
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
}
