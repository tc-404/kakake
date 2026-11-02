import {
  Controller, Get, Post, Body, Res, Req, Sse, MessageEvent, Param, Query,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { open as fsOpen } from 'node:fs/promises';
import { Observable } from 'rxjs';
import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { getLogs, subscribeLogs, clearLogs, formatLogsAsText, type LogEntry, type LogCategory } from '../core/log-store.js';
import { parseLogFile } from '../core/log-file-reader.js';
import { PATHS } from '../paths.js';
import { eventBus } from '../event/event-bus.js';
import { isRequestAuthed } from './auth.middleware.js';
import { globalBlockedMs } from './login-throttle.js';
import { isInitialAuthKey } from './auth-key.js';
import { getAgreementState, markAgreementAccepted, getFrameworkVersion } from './agreement.service.js';
import { getAnnouncementUpdateState, acknowledgeAnnouncementUpdate } from './announcement-update.service.js';
import { ANNOUNCEMENT_FETCH_WINDOW_MS, raceAnnouncementSources, type AnnouncementHit } from './announcement-source.js';
import { triggerAutoCheck, pingSession, getSessionUpdateView } from './update-check.service.js';
import { startInstall, getInstallView, cancelInstall } from './update-install.service.js';
import { getSharpEnvView, startSharpInstall } from './sharp-install.service.js';
import { requestRestart } from './restart.service.js';
import { collectSystemMetrics, collectLiveMetrics } from '../core/system-monitor.js';
import { SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, getSessionRecord, isValidSession, readSessionId } from './auth.middleware.js';
import {
  resolvePluginIconPath,
  buildPluginListItem,
  DEFAULT_PLUGIN_ICON_DATA_URI,
} from '../plugin/plugin-meta.js';
import { connectionPluginService } from '../plugin/connection-plugin.service.js';
import { buildPluginListPayload, resolveConnectionPluginKind } from '../plugin/plugin-list.service.js';
import { resolvePluginManager } from './admin-api.shared.js';
import type { PluginEntry } from '../plugin/plugin.types.js';
import { languageService } from './language.service.js';

/**
 * 各类插件管理器在「启停」接口里用到的公共能力。
 * 用结构类型而不是具体类，省得为 kakake / gf / wx / ss / sssx 五份管理器各写一遍分支。
 */
interface ToggleManager {
  getPluginInfo(id: string): PluginEntry | undefined;
  setMasterPluginStatus(id: string, enable: boolean): Promise<void>;
  setConnectionPluginStatus(connectionId: string, id: string, enable: boolean): Promise<void>;
  getPluginRouter(id: string): { hasPages(): boolean } | undefined;
  isMasterEnabled(id: string): boolean;
}

type ToggleResult = { code: number; message: string; data?: { plugin: Record<string, unknown> } };

/** 切总开关并回一份统一的插件视图 */
async function toggleMaster(
  manager: ToggleManager,
  pluginId: string,
  enable: boolean,
  kind: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx',
): Promise<ToggleResult> {
  await manager.setMasterPluginStatus(pluginId, enable);
  const entry = manager.getPluginInfo(pluginId);
  if (!entry) return { code: -1, message: 'plugin not found' };
  const router = manager.getPluginRouter(entry.id);
  const hasPages = (router?.hasPages() ?? false) || !!entry.packageJson?.webui;
  const masterEnabled = manager.isMasterEnabled(entry.id);
  return {
    code: 0,
    message: 'ok',
    data: {
      plugin: {
        ...buildPluginListItem(entry, { hasPages, masterEnabled }),
        kind,
        masterEnabled,
      },
    },
  };
}

function checkApiAuth(req: Request): boolean {
  return isRequestAuthed(req);
}

/* ─────────── 日志文件读取辅助 ─────────── */

/** 尾读单块大小与总上限：日志行通常很短，8MB 足够覆盖 2000 行的尾部 */
const TAIL_CHUNK_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 从文件末尾回读，返回「完整行」组成的尾部文本（不整读大文件进内存）。
 * 以块为单位向前读、只统计换行数，最后一次性 Buffer.concat + utf8 解码，
 * 避免逐块 toString 把多字节汉字从中间截断。
 */
async function readTailText(file: string, maxLines: number): Promise<string> {
  const fh = await fsOpen(file, 'r');
  try {
    const st = await fh.stat();
    const parts: Buffer[] = [];
    let pos = st.size;
    let newlines = 0;
    let total = 0;
    while (pos > 0 && newlines <= maxLines && total < TAIL_MAX_BYTES) {
      const len = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      if (bytesRead <= 0) break;
      const chunk = buf.subarray(0, bytesRead);
      parts.unshift(chunk);
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) newlines += 1;
      }
      total += bytesRead;
    }
    let text = Buffer.concat(parts).toString('utf8');
    const arr = text.split('\n');
    // 没读到文件头（pos > 0）说明首元素是被截断的半行，丢弃
    if (pos > 0 && arr.length > 1) arr.shift();
    return arr.slice(-maxLines).join('\n');
  } finally {
    await fh.close();
  }
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

const ANNOUNCEMENT_TTL_MS = 30_000;
const ANNOUNCEMENT_FAIL_TTL_MS = 10_000;
let announcementCache: { at: number; hit: AnnouncementHit | null } | null = null;
let announcementInflight: Promise<AnnouncementHit | null> | null = null;

async function loadAnnouncement(): Promise<AnnouncementHit | null> {
  if (announcementCache) {
    const ttl = announcementCache.hit ? ANNOUNCEMENT_TTL_MS : ANNOUNCEMENT_FAIL_TTL_MS;
    if (Date.now() - announcementCache.at < ttl) return announcementCache.hit;
  }
  if (!announcementInflight) {
    announcementInflight = raceAnnouncementSources(ANNOUNCEMENT_FETCH_WINDOW_MS).finally(() => {
      announcementInflight = null;
    });
  }
  const hit = await announcementInflight;
  announcementCache = { at: Date.now(), hit };
  return hit;
}

@Controller('api')
export class ApiController {
  /**
   * 代理拉取远程公告，避免浏览器 CORS；失败由前端改用本地备用文案。
   *
   * 双源竞速：自有站点与 GitHub 源同时发，谁先返回可用正文就用谁的；
   * 窗口内两个都没拿到 → 502，前端落到本地备份。
   */
  @Get('announcement')
  async announcement(@Res() res: Response) {
    const hit = await loadAnnouncement();
    if (!hit) {
      res.status(502).json({ ok: false, message: '远程公告暂不可用（双源均未取到）' });
      return;
    }
    res.json({ ok: true, source: hit.id, markdown: hit.markdown });
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
      /** 初始密钥时需进入设密页；自定义密码则跳过。密钥形态只在已登录后可见，匿名者无权探测 */
      needsPasswordSetup: authed ? isInitialAuthKey() : false,
      authKeyKind: authed ? (isInitialAuthKey() ? 'initial' : 'custom') : undefined,
      retryAfterMs: globalBlockedMs(),
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
        ...kakakeApp.sssxPluginManager.getAllPlugins().map(mapPlugin),
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

  /**
   * 高频实时 CPU/内存（总览页面积图用，毫秒级轮询）。
   * 只采 CPU/内存、不含磁盘与主机枚举，开销远低于 /system/metrics；
   * 用独立的增量基线，不与 2s 全量采集互相干扰。
   */
  @Get('system/metrics/live')
  systemMetricsLive(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json(collectLiveMetrics());
  }

  /**
   * 图片引擎环境（sharp）状态：设置页「图片引擎环境」卡片读它。
   * 只读探测（不安装）：包在不在、能不能真的 import、npm 可用性与缺失依赖清单。
   * 安装进行中时，job 里带尾部日志，前端按 1s 轮询这个接口看进度。
   */
  @Get('system/sharp')
  async systemSharp(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json(await getSharpEnvView());
  }

  /**
   * 手动安装 / 修复图片引擎依赖（执行 npm install，单飞）。
   * 立即返回当前状态，前端轮询 GET /api/system/sharp 看进度。
   * 为什么是手动：服务器上跑 npm install 属于会动 node_modules 的重操作，
   * 而 sharp 已是按需加载（缺它只影响图片混淆，框架照常启动），交给用户决定何时执行。
   */
  @Post('system/sharp/install')
  async systemSharpInstall(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const r = await startSharpInstall();
    if (!r.ok) {
      res.status(400).json({ ok: false, message: r.message || '无法开始安装' });
      return;
    }
    res.json(await getSharpEnvView());
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
   * 更新检查（GitHub 路线）状态。进入后台 / 刷新页面 / 切回前台时前端读一次：
   * 距离上次自动检查超过 10 分钟就在后台异步 ping 全部镜像取最新版本对比（非阻塞），
   * TTL 内直接复用已有结果。响应立即返回当前已知状态，前端可轮询几次拿到结果。
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
   * 用户手动触发，随时可用，不受自动检查的 10 分钟 TTL 限制；
   * 同时会把 remoteVersion 向上修正，手动查到新版本立刻点亮侧边栏 NEW。
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
   * 在线更新 · 安装此版本：下载选定 tag 的包 → 校验 → 暂存（不替换现有文件）。
   * 立即返回；前端轮询 /api/update/install/state 看进度。
   */
  @Post('update/install')
  updateInstall(
    @Req() req: Request,
    @Res() res: Response,
    @Body() body: { tag?: string; mirrorId?: string; acknowledgeRisk?: boolean },
  ) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const r = startInstall(String(body?.tag || ''), body?.mirrorId ?? null, {
      acknowledgeRisk: body?.acknowledgeRisk === true,
    });
    if (!r.ok) {
      res.status(400).json({ ok: false, message: r.message || '无法开始安装' });
      return;
    }
    res.json(getInstallView());
  }

  /** 在线更新 · 进度与环境能力（启动方式是否可重启、版本形态、是否已暂存等） */
  @Get('update/install/state')
  updateInstallState(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    res.json(getInstallView());
  }

  /** 在线更新 · 取消 / 撤销暂存 */
  @Post('update/install/cancel')
  updateInstallCancel(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    cancelInstall();
    res.json(getInstallView());
  }

  /**
   * 在线更新 · 确定重启：仅受管启动器（KAKAKE_MANAGED_RELAUNCH=1）可用。
   * 有暂存更新则重启时应用之，否则为普通重启。未受管时返回 canRestart=false 并提示手动重启。
   */
  @Post('update/restart')
  updateRestart(@Req() req: Request, @Res() res: Response) {
    if (!checkApiAuth(req)) {
      res.status(401).json({ code: -1, message: 'Unauthorized' });
      return;
    }
    const r = requestRestart();
    res.status(r.ok ? 200 : 400).json(r);
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

      // 建流即同步一次当前语言：连接建立前的那次切换收不到广播，靠这一发对齐
      send('language', { lang: languageService.getState() });

      const offConn = eventBus.on('connection/status', (payload) => {
        send('status', payload);
      });

      // 语言是实例级设置：别人在设置里切了语言，在线的会话要一起变，
      // 否则各人各看一门语言，重启前都对不上。
      const offLang = eventBus.on('language', (payload) => {
        send('language', payload);
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
        offLang();
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

  /** 日志文件列表缓存：3 秒 TTL，列表页频繁刷新时避免每个请求都全目录 readdir+stat */
  private logFilesCache: { at: number; files: Array<{ name: string; size: number; mtime: number }> } | null = null;

  /** 列出日志目录下的 .log 文件，供控制台临时选择查看（最新的排在最前） */
  @Get('logs/files')
  async logFiles() {
    try {
      if (!fs.existsSync(PATHS.log)) return { files: [] };
      const now = Date.now();
      if (this.logFilesCache && now - this.logFilesCache.at < 3000) {
        return { files: this.logFilesCache.files };
      }
      const dirents = await fs.promises.readdir(PATHS.log, { withFileTypes: true });
      const files = (await Promise.all(dirents
        .filter((d) => d.isFile() && d.name.endsWith('.log'))
        .map(async (d) => {
          const st = await fs.promises.stat(path.join(PATHS.log, d.name));
          return { name: d.name, size: st.size, mtime: st.mtimeMs };
        })))
        .sort((a, b) => b.mtime - a.mtime);
      this.logFilesCache = { at: now, files };
      return { files };
    } catch {
      return { files: [] };
    }
  }

  /**
   * 读取指定日志文件并还原成条目，仅供前端临时查看：
   * 不写入内存环形缓冲、不参与计数、不推送 SSE，刷新页面即回到实时机制。
   * 大文件用「从尾部回读」代替整读，数百 MB 的日志不再阻塞事件循环。
   */
  @Get('logs/file')
  async logFile(@Query('name') name: string) {
    // 只取文件名，杜绝 ../ 目录穿越
    const safe = path.basename(String(name || '')).trim();
    if (!safe.endsWith('.log')) return { logs: [] };
    const file = path.join(PATHS.log, safe);
    if (!fs.existsSync(file)) return { logs: [] };
    try {
      const text = await readTailText(file, 2000);
      // 只回传末尾若干条，避免超大文件把界面拖垮
      return { logs: parseLogFile(text).slice(-2000) };
    } catch {
      return { logs: [] };
    }
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
      const e = await kakakeApp.sssxPluginManager.rescanPlugins();
      return {
        code: 0,
        message: 'ok',
        data: { count: a + b + c + d + e, ...buildPluginListPayload() },
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
    // 双生插件在受支持的连接上同样要重扫
    const twinCount = await kakakeApp.sssxPluginManager.rescanPlugins();
    return {
      code: 0,
      message: 'ok',
      data: { count: count + twinCount, ...buildPluginListPayload(connectionId) },
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
      ?? kakakeApp.sssxPluginManager.getPluginInfo(id)
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
      // 按插件 ID 路由管理器（双生插件 sssx-plugin-* 也在这里被认出来）
      const { kind, manager } = resolvePluginManager(body.id) as unknown as {
        kind: 'kakake' | 'gf' | 'wx' | 'ss' | 'sssx';
        manager: ToggleManager;
      };
      return toggleMaster(manager, body.id, body.enable, kind);
    }

    if (!configService.getConnection(body.connectionId)) {
      return { code: -1, message: 'connection not found' };
    }
    try {
      // 双生插件自带双路由：按插件 ID 选管理器，而不是按连接类型
      const { manager } = resolvePluginManager(body.id) as unknown as { manager: ToggleManager };
      await manager.setConnectionPluginStatus(body.connectionId, body.id, body.enable);
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
