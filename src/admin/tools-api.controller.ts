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
  connectionAvatarDataUrl,
  fetchAndStoreAvatarFromUrl,
  getConnectionAvatarMeta,
  removeConnectionAvatar,
} from '../connection/connection-avatar.store.js';

import { warnProxyDenied, resolveConnectionPluginKindFromConn, resolvePluginManager } from './admin-api.shared.js';

@Controller('api')
export class ToolsApiController {
  @Post('tools/media-parse')
  async toolsMediaParse(@Body() body: { text?: string } = {}, @Req() req: Request) {
    const bucket = mediaThrottleBucketOf(req);
    const blockedMs = mediaThrottleBlockedFor('parse', bucket);
    if (blockedMs > 0) {
      return failedResult(`解析过于频繁，请${describeBlockedFor(blockedMs)}后再试`);
    }

    const result = await parseMedia(String(body.text || ''));
    logAction(
      '【视频解析】',
      result.ok
        ? `${result.platform ?? '未知平台'} 解析成功：${result.title || '（无标题）'}`
        : `解析失败：${result.message || '未知原因'}（${result.platform ?? '平台未识别'}）`,
      undefined,
      result.ok ? 'info' : 'warn',
    );
    return result;
  }

  /**
   * 工具：代理下载封面/视频（服务端带 Referer，规避浏览器 403）
   */

  @Post('tools/media-download')
  async toolsMediaDownload(
    @Body() body: { url?: string; kind?: MediaDownloadKind; platform?: string; cookie?: string } = {},
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const kind: MediaDownloadKind = body.kind === 'cover' ? 'cover' : 'video';
    const label = kind === 'cover' ? '封面' : '视频';

    // 下载同样吃服务端带宽，必须一起限速
    const blockedMs = mediaThrottleBlockedFor('download', mediaThrottleBucketOf(req));
    if (blockedMs > 0) {
      res.status(429).json({ ok: false, message: `下载过于频繁，请${describeBlockedFor(blockedMs)}后再试` });
      return;
    }

    const fetched = await fetchMediaForDownload({
      url: String(body.url || ''),
      kind,
      platform: body.platform,
      cookie: body.cookie,
    });
    if (!fetched.ok) {
      warnProxyDenied(fetched.message);
      logAction('【视频解析】', `${label}下载失败：${fetched.message}`, undefined, 'warn');
      res.status(fetched.status).json({ ok: false, message: fetched.message });
      return;
    }
    logAction('【视频解析】', `${label}下载：${fetched.filename} · ${fetched.contentType}`);
    res.setHeader('Content-Type', fetched.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fetched.filename}"`,
    );
    const len = fetched.response.headers.get('content-length');
    if (len) res.setHeader('Content-Length', len);

    const nodeStream = upstreamBodyToNodeStream(fetched.response.body!);
    // 用 pipeline 而不是 pipe：客户端中途取消（关页面、点取消）时，
    // pipe 只会解绑、不会销毁上游流，这条到 CDN 的连接会一直留到自身超时。
    pipeline(nodeStream, res, () => {
      if (!res.writableEnded) res.destroy();
    });
  }

  /**
   * 工具：媒体在线预览（GET 流式输出）。
   * X（Twitter）的 twimg 媒体域名浏览器直连被墙，前端 <img>/<video> 的展示统一走这里；
   * 需登录会话（不在公开路径白名单内），透传 Range 以支持视频拖动进度条。
   * 不接受 Cookie：展示地址由浏览器直接取字节，无需凭据，也不该由请求方指定。
   * 只放行 image/*、video/* 等媒体类型（见 isMediaContentType），
   * 否则同源渲染上游 HTML 等于把后台交出去。
   */

  @Get('tools/media-view')
  async toolsMediaView(
    @Query() query: { url?: string; kind?: string; platform?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const kind: MediaDownloadKind = query.kind === 'video' ? 'video' : 'cover';

    // 图集是一张图一个请求，额度要比解析宽松，但同样必须有上限
    const blockedMs = mediaThrottleBlockedFor('view', mediaThrottleBucketOf(req));
    if (blockedMs > 0) {
      res.status(429).json({ ok: false, message: `预览请求过于频繁，请${describeBlockedFor(blockedMs)}后再试` });
      return;
    }

    const fetched = await fetchMediaForView({
      url: String(query.url || ''),
      kind,
      platform: query.platform,
      range: typeof req.headers.range === 'string' ? req.headers.range : null,
    });
    if (!fetched.ok) {
      // 预览是逐张图片请求的，白名单告警按主机去重，避免图集刷屏
      warnProxyDenied(fetched.message);
      res.status(fetched.status).json({ ok: false, message: fetched.message });
      return;
    }
    res.status(fetched.status);
    res.setHeader('Content-Type', fetched.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=600');
    // 上游没声明支持 Range 时不要替它答应，否则浏览器会按可拖动处理
    if (fetched.acceptRanges) res.setHeader('Accept-Ranges', fetched.acceptRanges);
    if (fetched.contentLength) res.setHeader('Content-Length', fetched.contentLength);
    if (fetched.contentRange) res.setHeader('Content-Range', fetched.contentRange);

    const nodeStream = upstreamBodyToNodeStream(fetched.response.body!);
    pipeline(nodeStream, res, () => {
      if (!res.writableEnded) res.destroy();
    });
  }
}
