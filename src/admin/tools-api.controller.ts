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
import {
  obfInDir,
  obfOutDir,
  obfOutFilePath,
  writeObfOut,
  readObfOutMeta,
  clearObfTmpDir,
  isSafeToken,
  isSafeJobId,
} from '../tools/obf-temp.store.js';
import {
  startObfJob,
  getObfJob,
  cancelObfJob,
  clearObfJobs,
  type ObfServerSpec,
} from '../tools/image-obf-server.js';
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
    armUpstreamStallWatchdog(nodeStream, res);
    // 用 pipeline 而不是 pipe：客户端中途取消（关页面、点取消）时，
    // pipe 只会解绑、不会销毁上游流，这条到 CDN 的连接会一直留到自身超时。
    pipeline(nodeStream, res, () => {
      if (!res.writableEnded) res.destroy();
    });
  }

  /**
   * 图片混淆：上传待处理的图片到服务端临时目录，返回 jobId。
   * 之后调 obf-run 用同一个 jobId 启动处理。密码不上传——只上传从密码派生的种子。
   */
  @Post('tools/obf-upload')
  async toolsObfUpload(@Req() req: Request, @Res() res: Response) {
    try {
      const jobId = randomUUID();
      const dir = obfInDir();
      const saved = await saveMultipartFile(req, 'file', dir, { maxFileSize: 200 * 1024 * 1024 });
      if (!saved) {
        res.status(400).json({ ok: false, message: '没有收到文件' });
        return;
      }
      // saveMultipartFile 自己会拼 import_<ts>_<name>，这里改成 <jobId>.<ext> 便于按任务清理
      const ext = (saved.originalname.match(/\.([A-Za-z0-9]+)$/)?.[1] || 'bin').toLowerCase();
      const finalPath = path.join(dir, `${jobId}.${ext}`);
      fs.renameSync(saved.path, finalPath);
      res.json({ ok: true, jobId, name: saved.originalname, size: saved.size, path: finalPath });
    } catch (err) {
      res.status(500).json({ ok: false, message: err instanceof Error ? err.message : '上传失败' });
    }
  }

  /** 启动服务端处理（像素路线） */
  @Post('tools/obf-run')
  async toolsObfRun(
    @Body() body: { jobId?: string } & ObfServerSpec = {} as never,
    @Res() res: Response,
  ) {
    const jobId = String(body.jobId || '');
    if (!isSafeJobId(jobId)) {
      res.status(400).json({ ok: false, message: '无效的任务 ID' });
      return;
    }
    const ext = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'kkobf', 'bin'];
    let inputPath = '';
    for (const e of ext) {
      const p = path.join(obfInDir(), `${jobId}.${e}`);
      if (fs.existsSync(p)) {
        inputPath = p;
        break;
      }
    }
    if (!inputPath) {
      res.status(404).json({ ok: false, message: '找不到待处理的文件，请重新上传' });
      return;
    }
    const spec: ObfServerSpec = {
      op: body.op === 'deobf' ? 'deobf' : 'obf',
      route: (body.route ?? 2) as 2 | 3 | 4 | 5 | 6,
      scheme: Number(body.scheme) || 1,
      blockSize: Number(body.blockSize) || 16,
      preserveAlpha: Boolean(body.preserveAlpha),
      seed: Number(body.seed) >>> 0,
      name: String(body.name || 'image'),
    };
    let id: string;
    try {
      id = startObfJob(spec, inputPath);
    } catch (err) {
      res.status(429).json({ ok: false, message: err instanceof Error ? err.message : '任务已满' });
      return;
    }
    res.json({ ok: true, taskId: id });
  }

  /** 查询处理进度 */
  @Get('tools/obf-run/:taskId')
  async toolsObfRunStatus(@Param('taskId') taskId: string, @Res() res: Response) {
    if (!isSafeJobId(taskId)) {
      res.status(400).json({ ok: false, message: '无效的任务 ID' });
      return;
    }
    const job = getObfJob(taskId);
    if (!job) {
      res.status(404).json({ ok: false, message: '任务不存在（可能已被清空）' });
      return;
    }
    res.json({
      ok: true,
      status: job.status,
      done: job.progress.done,
      total: job.progress.total,
      error: job.error,
      token: job.token,
      name: job.outName,
      size: job.outSize,
      width: job.width,
      height: job.height,
    });
  }

  /** 取消进行中的任务 */
  @Post('tools/obf-run-cancel')
  async toolsObfRunCancel(@Body() body: { taskId?: string } = {}, @Res() res: Response) {
    const taskId = String(body.taskId || '');
    if (!isSafeJobId(taskId)) {
      res.status(400).json({ ok: false, message: '无效的任务 ID' });
      return;
    }
    const ok = cancelObfJob(taskId);
    res.json({ ok });
  }

  /**
   * 清空服务端临时目录 + 任务记录。用 POST 而不是 DELETE：前端刷新/关页面时只有
   * navigator.sendBeacon 能可靠发出，而它只支持 POST。
   */
  @Post('tools/obf-clear')
  async toolsObfClear(@Res() res: Response) {
    clearObfTmpDir();
    clearObfJobs();
    res.json({ ok: true });
  }

  /**
   * 把浏览器端算好的结果存到服务端 out/ 目录，返回下载 token。
   * （浏览器路线：AES / 字节流 / 小图像素路线。大图走 obf-run 那条链。）
   */
  @Post('tools/obf-store')
  async toolsObfStore(@Req() req: Request, @Res() res: Response) {
    try {
      const token = randomUUID();
      const dir = obfOutDir();
      const saved = await saveMultipartFile(req, 'file', dir, { maxFileSize: 200 * 1024 * 1024 });
      if (!saved) {
        res.status(400).json({ ok: false, message: '没有收到文件' });
        return;
      }
      const bytes = fs.readFileSync(saved.path);
      fs.rmSync(saved.path, { force: true });
      // 走 writeObfOut：它会顺带清掉旧结果，只保留最新一个
      writeObfOut(
        token,
        {
          name: saved.originalname,
          mime: saved.mimetype || 'application/octet-stream',
          size: bytes.byteLength,
          createdAt: Date.now(),
        },
        new Uint8Array(bytes),
      );
      res.json({ ok: true, token, name: saved.originalname, size: bytes.byteLength });
    } catch (err) {
      res.status(500).json({ ok: false, message: err instanceof Error ? err.message : '暂存失败' });
    }
  }

  /** 按 token 下载处理结果 */
  @Get('tools/obf-download/:token')
  async toolsObfDownload(@Param('token') token: string, @Res() res: Response) {
    if (!isSafeToken(token)) {
      res.status(400).json({ ok: false, message: '无效的 token' });
      return;
    }
    const meta = readObfOutMeta(token);
    const file = obfOutFilePath(token);
    if (!meta || !fs.existsSync(file)) {
      res.status(404).json({ ok: false, message: '结果已失效，请重新处理' });
      return;
    }
    const safeName = String(meta.name || 'result.bin').replace(/[\r\n"]/g, '_');
    res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`);
    res.setHeader('Content-Length', String(meta.size));
    const stream = fs.createReadStream(file);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).json({ ok: false, message: '读取失败' });
      else res.destroy();
    });
    stream.pipe(res);
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
    armUpstreamStallWatchdog(nodeStream, res);
    pipeline(nodeStream, res, () => {
      if (!res.writableEnded) res.destroy();
    });
  }
}

/**
 * 上游停顿看门狗：拿到响应头之后上游再无数据超过 30s 就掐断整条管道。
 * 防慢速滴流/半开连接按限速额度长期占用 socket 与内存。
 */
function armUpstreamStallWatchdog(
  upstream: import('node:stream').Readable,
  res: Response,
  ms = 30_000,
): void {
  let lastData = Date.now();
  const timer = setInterval(() => {
    if (Date.now() - lastData > ms) {
      clearInterval(timer);
      upstream.destroy();
      if (!res.writableEnded) res.destroy();
    }
  }, 5_000);
  upstream.on('data', () => {
    lastData = Date.now();
  });
  const stop = () => clearInterval(timer);
  upstream.once('close', stop);
  upstream.once('end', stop);
  upstream.once('error', stop);
}
