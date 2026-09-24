import {
  Controller, Get, Post, Body, Res, Req, Sse, MessageEvent, Param, Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { Observable } from 'rxjs';
import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { getLogs, subscribeLogs, clearLogs, formatLogsAsText, type LogEntry, type LogCategory } from '../core/log-store.js';
import { eventBus } from '../event/event-bus.js';
import { isRequestAuthed } from './auth.middleware.js';
import { isInitialAuthKey } from './auth-key.js';
import { getAgreementState, markAgreementAccepted, getFrameworkVersion } from './agreement.service.js';
import { getAnnouncementUpdateState, acknowledgeAnnouncementUpdate } from './announcement-update.service.js';
import { triggerAutoCheck, pingSession, getSessionUpdateView } from './update-check.service.js';
import { collectSystemMetrics } from '../core/system-monitor.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, getSessionRecord, isValidSession, readSessionId } from './auth.middleware.js';
import {
  resolvePluginIconPath,
  buildPluginListItem,
  DEFAULT_PLUGIN_ICON_DATA_URI,
} from '../plugin/plugin-meta.js';
import { connectionPluginService } from '../plugin/connection-plugin.service.js';
import { buildPluginListPayload, resolveConnectionPluginKind } from '../plugin/plugin-list.service.js';

/** 咔咔框架专属公告（原生 Markdown） */
const ANNOUNCEMENT_REMOTE_URL =
  'https://xn--mk-ub3cl61ae1v.xn--c5w857b.xn--fiqs8s/mkbot/%E5%92%94%E5%92%94%E5%85%AC%E5%91%8A.md';

function checkApiAuth(req: Request): boolean {
  return isRequestAuthed(req);
}

/**
 * 更新检查的会话键：优先用登录会话 id（本次登录），
 * Bearer 密钥登录没有会话则退回客户端 IP。用于「本次/本设备/本 IP 仅自动检查一次」。
 */
function updateSessionKey(req: Request): string {
  const sid = readSessionId(req);
  if (sid) return `sid:${sid}`;
  const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
  return `ip:${ip}`;
}

@Controller('api')
export class ApiController {
  /** 代理拉取远程公告，避免浏览器 CORS；失败由前端改用本地备用 */
  @Get('announcement')
  async announcement(@Res() res: Response) {
    try {
      const upstream = await fetch(ANNOUNCEMENT_REMOTE_URL, {
        headers: {
          Accept: 'text/markdown, text/plain, */*',
          'User-Agent': 'Kakake/0.2',
        },
        // 与前端 7s 策略对齐，避免代理长时间挂起
        signal: AbortSignal.timeout(7_000),
      });
      if (!upstream.ok) {
        res.status(502).json({
          ok: false,
          message: `远程公告 HTTP ${upstream.status}`,
        });
        return;
      }
      const markdown = await upstream.text();
      if (!markdown.trim()) {
        res.status(502).json({ ok: false, message: '远程公告为空' });
        return;
      }
      res.json({ ok: true, source: 'remote', markdown });
    } catch (e) {
      res.status(502).json({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  @Get('test')
  test(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json({ code: 0, message: 'ok' });
  }

  @Get('auth/state')
  authState(@Req() req: Request) {
    const authed = checkApiAuth(req);
    const rec = authed ? getSessionRecord(readSessionId(req)) : undefined;
    const now = Date.now();
    return {
      authed,
      authRequired: true,
      sessionTtlMs: SESSION_IDLE_MS,
      idleTimeoutMs: SESSION_IDLE_MS,
      absoluteTimeoutMs: SESSION_ABSOLUTE_MS,
      idleRemainingMs: rec ? Math.max(0, SESSION_IDLE_MS - (now - rec.lastActiveAt)) : 0,
      absoluteRemainingMs: rec ? Math.max(0, SESSION_ABSOLUTE_MS - (now - rec.createdAt)) : 0,
      /** 初始密钥时需进入设密页；自定义密码则跳过 */
      needsPasswordSetup: isInitialAuthKey(),
      authKeyKind: isInitialAuthKey() ? 'initial' : 'custom',
    };
  }

  @Get('status')
  status() {
    const mapPlugin = (p: { id: string; loaded: boolean; enable: boolean }) => ({
      id: p.id,
      loaded: p.loaded,
      enable: p.enable,
    });
    return {
      framework: 'kakake',
      version: getFrameworkVersion(),
      connections: kakakeApp.connectionManager.getStatusList(),
      plugins: [
        ...kakakeApp.pluginManager.getAllPlugins().map(mapPlugin),
        ...kakakeApp.gfPluginManager.getAllPlugins().map(mapPlugin),
        ...kakakeApp.wxPluginManager.getAllPlugins().map(mapPlugin),
        ...kakakeApp.ssPluginManager.getAllPlugins().map(mapPlugin),
      ],
    };
  }

  /** 本进程 CPU/内存 + 项目所在卷磁盘 */
  @Get('system/metrics')
  async systemMetrics(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json(await collectSystemMetrics());
  }

  @Get('agreement/state')
  agreementState() {
    return getAgreementState();
  }

  @Post('agreement/agree')
  agreementAgree(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const record = markAgreementAccepted();
    res.json({ ok: true, ...record });
  }

  /**
   * 公告「版本提示」状态（与协议门禁独立）。进入后台时读取，决定是否弹出
   * 公告更新——只读本地状态，不发起网络请求；远程探测由登录后台任务负责。
   */
  @Get('announcement/update')
  announcementUpdate(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json({ ok: true, ...getAnnouncementUpdateState() });
  }

  /** 用户已阅读当前公告更新提示：记录已读版本，清除待弹标记 */
  @Post('announcement/update/ack')
  announcementUpdateAck(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { version?: string } = {},
  ) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json(acknowledgeAnnouncementUpdate(body?.version));
  }

  /**
   * 更新检查（GitHub 路线）状态。进入后台时前端读一次：
   * 若本次会话尚未自动检查过，则在后台异步 ping 全部镜像取最新版本对比（非阻塞），
   * 本次会话仅自动一次。响应立即返回当前已知状态，前端可轮询几次拿到结果。
   */
  @Get('update/state')
  updateState(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const key = updateSessionKey(req);
    triggerAutoCheck(key);
    res.json(getSessionUpdateView(key));
  }

  /**
   * 手动 ping / 测试访问：用户在悬浮窗里点击时触发。
   * body.mirrorIds 为空 = 一键 Ping 全部；传单个 id = 测试访问该镜像。
   * 用户手动触发，随时可用，不受「本次仅自动一次」限制。
   */
  @Post('update/ping')
  async updatePing(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { mirrorIds?: string[] | null } = {},
  ) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const key = updateSessionKey(req);
    const ids = Array.isArray(body?.mirrorIds) ? body.mirrorIds.filter((x) => typeof x === 'string') : null;
    await pingSession(key, ids);
    res.json(getSessionUpdateView(key));
  }

  /**
   * 运行日志与连接状态实时流。
   *
   * 这条流会把后台「运行日志」页的全部内容（含上报消息正文）持续推出去，
   * 所以：
   * 1. 建流前必须鉴权——外层中间件已拦，这里再挡一层，防止以后有人把
   *    /api/events 加进免鉴权白名单就直接漏出去；
   * 2. 会话登录的连接要随会话失效一起断开。/api/events 不参与「互动续期」，
   *    若不主动检查，一条建流时合法的连接会在会话过期后继续推日志。
   */
  @Sse('events')
  events(@Req() req: Request): Observable<MessageEvent> {
    if (!checkApiAuth(req)) {
      throw new UnauthorizedException('Unauthorized');
    }

    // Bearer 密钥登录没有会话概念，不做过期检查
    const sessionId = readSessionId(req);
    const watchSession = isValidSession(sessionId) ? sessionId : undefined;

    return new Observable((subscriber) => {
      const send = (type: string, data: unknown) => {
        subscriber.next({ data: JSON.stringify({ type, data, time: Date.now() }) });
      };

      send('status', {
        connections: kakakeApp.connectionManager.getStatusList(),
        plugins: kakakeApp.pluginManager.getLoadedPlugins().length,
      });

      const offConn = eventBus.on('connection/status', (payload) => {
        send('status', payload);
      });

      const offLog = subscribeLogs((entry) => {
        const { raw: _raw, ...safe } = entry;
        send('log', safe);
      });

      const timer = setInterval(() => {
        if (watchSession && !isValidSession(watchSession)) {
          subscriber.complete();
          return;
        }
        send('status', { connections: kakakeApp.connectionManager.getStatusList() });
      }, 3000);

      return () => {
        offConn();
        offLog();
        clearInterval(timer);
      };
    });
  }

  @Get('logs')
  logs(@Req() req: Request) {
    const limit = Number(req.query.limit) || 500;
    const level = req.query.level as LogEntry['level'] | undefined;
    const category = req.query.category as LogCategory | undefined;
    return { logs: getLogs(limit, level, category) };
  }

  @Post('logs/clear')
  clearLogsApi() {
    clearLogs();
    return { ok: true };
  }

  @Get('logs/download')
  downloadLogs(@Req() req: Request, @Res() res: Response) {
    const limit = Number(req.query.limit) || 5000;
    const level = req.query.level as LogEntry['level'] | undefined;
    const category = req.query.category as LogCategory | undefined;
    const text = formatLogsAsText(limit, level, category);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="kakake-runtime-${stamp}.log"`);
    res.send(text || '(empty)');
  }
}

@Controller('api/Plugin')
export class PluginApiController {
  @Get('List')
  list(@Query('connectionId') connectionId?: string) {
    return { code: 0, data: buildPluginListPayload(connectionId) };
  }

  @Post('Rescan')
  async rescan(@Query('connectionId') connectionId?: string) {
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
    const kind = resolveConnectionPluginKind(connectionId);
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

  @Get('DefaultIcon')
  defaultIcon(@Res() res: Response) {
    const prefix = 'data:image/jpeg;base64,';
    const raw = DEFAULT_PLUGIN_ICON_DATA_URI.startsWith(prefix)
      ? DEFAULT_PLUGIN_ICON_DATA_URI.slice(prefix.length)
      : DEFAULT_PLUGIN_ICON_DATA_URI;
    res
      .type('image/jpeg')
      .setHeader('Cache-Control', 'public, max-age=86400')
      .send(Buffer.from(raw, 'base64'));
  }

  @Get('Asset')
  asset(@Query('id') id: string, @Query('file') file: string, @Res() res: Response) {
    if (!id || !file) {
      res.status(400).json({ code: -1, message: 'id and file required' });
      return;
    }
    const entry = kakakeApp.pluginManager.getPluginInfo(id)
      ?? kakakeApp.gfPluginManager.getPluginInfo(id)
      ?? kakakeApp.wxPluginManager.getPluginInfo(id)
      ?? kakakeApp.ssPluginManager.getPluginInfo(id);
    if (!entry) {
      res.status(404).json({ code: -1, message: 'plugin not found' });
      return;
    }
    const rel = resolvePluginIconPath(entry);
    if (!rel || rel !== file.replace(/\\/g, '/')) {
      res.status(404).json({ code: -1, message: 'asset not found' });
      return;
    }
    const abs = path.join(entry.pluginPath, rel);
    if (!fs.existsSync(abs)) {
      res.status(404).json({ code: -1, message: 'file missing' });
      return;
    }
    res.sendFile(abs);
  }

  @Get('Config')
  async getConfig(@Req() req: Request, @Res() res: Response) {
    const id = String(req.query.id || '');
    if (!id) return res.status(400).json({ code: -1, message: 'id required' });

    const view = kakakeApp.pluginConfigService.getConfigView(id);
    if (!view) return res.status(404).json({ code: -1, message: 'Plugin not found' });

    const config = await kakakeApp.pluginConfigService.readConfigAsync(id);
    view.config = kakakeApp.pluginConfigService.mergeDefaults(view.schema, config);

    return res.json({
      code: 0,
      data: {
        schema: view.schema,
        config: view.config,
        supportReactive: view.supportReactive,
      },
    });
  }

  @Post('Config')
  async setConfig(@Body() body: { id: string; config: Record<string, unknown> }, @Res() res: Response) {
    if (!body.id || !body.config) return res.status(400).json({ code: -1, message: 'id and config required' });
    try {
      await kakakeApp.pluginConfigService.saveConfig(body.id, body.config);
      return res.json({ code: 0, message: 'Config updated' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Error';
      return res.status(500).json({ code: -1, message: msg });
    }
  }

  @Post('SetStatus')
  async setStatus(@Body() body: { id: string; enable: boolean; connectionId?: string }) {
    // 无 connectionId → 插件总开关；有 → 连接子开关
    if (!body.connectionId) {
      const wxEntry = kakakeApp.wxPluginManager.getPluginInfo(body.id);
      if (wxEntry) {
        await kakakeApp.wxPluginManager.setMasterPluginStatus(body.id, body.enable);
        const entry = kakakeApp.wxPluginManager.getPluginInfo(body.id);
        if (!entry) return { code: -1, message: 'plugin not found' };
        const router = kakakeApp.wxPluginManager.getPluginRouter(entry.id);
        const hasPages = (router?.hasPages() ?? false) || !!entry.packageJson?.webui;
        const masterEnabled = kakakeApp.wxPluginManager.isMasterEnabled(entry.id);
        return {
          code: 0,
          message: 'ok',
          data: {
            plugin: {
              ...buildPluginListItem(entry, { hasPages, masterEnabled }),
              kind: 'wx' as const,
              masterEnabled,
            },
          },
        };
      }

      const ssEntry = kakakeApp.ssPluginManager.getPluginInfo(body.id);
      if (ssEntry) {
        await kakakeApp.ssPluginManager.setMasterPluginStatus(body.id, body.enable);
        const entry = kakakeApp.ssPluginManager.getPluginInfo(body.id);
        if (!entry) return { code: -1, message: 'plugin not found' };
        const router = kakakeApp.ssPluginManager.getPluginRouter(entry.id);
        const hasPages = (router?.hasPages() ?? false) || !!entry.packageJson?.webui;
        const masterEnabled = kakakeApp.ssPluginManager.isMasterEnabled(entry.id);
        return {
          code: 0,
          message: 'ok',
          data: {
            plugin: {
              ...buildPluginListItem(entry, { hasPages, masterEnabled }),
              kind: 'ss' as const,
              masterEnabled,
            },
          },
        };
      }

      const gfEntry = kakakeApp.gfPluginManager.getPluginInfo(body.id);
      if (gfEntry) {
        await kakakeApp.gfPluginManager.setMasterPluginStatus(body.id, body.enable);
        const entry = kakakeApp.gfPluginManager.getPluginInfo(body.id);
        if (!entry) return { code: -1, message: 'plugin not found' };
        const router = kakakeApp.gfPluginManager.getPluginRouter(entry.id);
        const hasPages = (router?.hasPages() ?? false) || !!entry.packageJson?.webui;
        const masterEnabled = kakakeApp.gfPluginManager.isMasterEnabled(entry.id);
        return {
          code: 0,
          message: 'ok',
          data: {
            plugin: {
              ...buildPluginListItem(entry, { hasPages, masterEnabled }),
              kind: 'gf' as const,
              masterEnabled,
            },
          },
        };
      }

      await kakakeApp.pluginManager.setMasterPluginStatus(body.id, body.enable);
      const entry = kakakeApp.pluginManager.getPluginInfo(body.id);
      if (!entry) return { code: -1, message: 'plugin not found' };
      const router = kakakeApp.pluginManager.getPluginRouter(entry.id);
      const hasPages = (router?.hasPages() ?? false) || !!entry.packageJson?.webui;
      const masterEnabled = kakakeApp.pluginManager.isMasterEnabled(entry.id);
      return {
        code: 0,
        message: 'ok',
        data: {
          plugin: {
            ...buildPluginListItem(entry, { hasPages, masterEnabled }),
            kind: 'kakake' as const,
            masterEnabled,
          },
        },
      };
    }

    if (!configService.getConnection(body.connectionId)) {
      return { code: -1, message: 'connection not found' };
    }
    try {
      const kind = resolveConnectionPluginKind(body.connectionId);
      if (kind === 'gf') {
        await kakakeApp.gfPluginManager.setConnectionPluginStatus(body.connectionId, body.id, body.enable);
      } else if (kind === 'wx') {
        await kakakeApp.wxPluginManager.setConnectionPluginStatus(body.connectionId, body.id, body.enable);
      } else if (kind === 'ss') {
        await kakakeApp.ssPluginManager.setConnectionPluginStatus(body.connectionId, body.id, body.enable);
      } else {
        await kakakeApp.pluginManager.setConnectionPluginStatus(body.connectionId, body.id, body.enable);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '操作失败';
      return { code: -1, message: msg };
    }

    const payload = buildPluginListPayload(body.connectionId);
    const plugin = payload.plugins.find((p) => p.id === body.id || (p as { id?: string }).id === body.id);
    if (!plugin) {
      const all = payload.plugins;
      const hit = all.find((p) => String(p.id).toLowerCase() === String(body.id).toLowerCase());
      if (!hit) return { code: -1, message: 'plugin not found' };
      return { code: 0, message: 'ok', data: { plugin: hit } };
    }
    return { code: 0, message: 'ok', data: { plugin } };
  }
}
