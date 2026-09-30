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
export class AuthApiController {
  @Post('auth/login')
  login(
    @Body() body: { token?: string; key?: string } = {},
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const clientIp = remoteAddressOf(req);
    const blockedMs = loginBlockedFor(clientIp);
    if (blockedMs > 0) {
      res.status(429).json({
        ok: false,
        message: `登录尝试过于频繁，请在${describeBlockedFor(blockedMs)}后重试`,
      });
      return;
    }

    const input = (body.token ?? body.key ?? '').trim();
    if (!input || !matchesAuthKey(input)) {
      recordLoginFailure(clientIp, '后台登录');
      res.status(401).json({ ok: false, message: '登录密钥错误' });
      return;
    }
    recordLoginSuccess(clientIp);
    const session = createSession();
    const rec = getSessionRecord(session);
    res.setHeader('Set-Cookie', sessionCookieValue(session, rec?.createdAt));
    // 公告版本提示：先把上一轮后台探测到的新版本「提升」为本次可弹出，
    // 再异步（后台线程，fire-and-forget）拉取远程公告——本次探测结果只在
    // 下一次登录时才会生效，因此新版本永远在「下一次进入后台」才提示。
    try {
      promotePendingOnLogin();
    } catch { /* 提示机制不应影响登录 */ }
    checkRemoteAnnouncementInBackground();
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
}
