import { Controller, Get, Post, Put, Body, Req, Res, Query } from '@nestjs/common';
import type { Request, Response } from 'express';
import { rootLogger } from '../core/logger.js';
import { isRequestAuthed } from './auth.middleware.js';
import { browserService } from './browser.service.js';
import { cancelInstall, detectBrowsers, getInstallBlocks, getInstallJob, startInstall, uninstall } from './browser-install.service.js';
import { BROWSER_IDS, type BrowserId } from '../tools/browser-defs.js';

function guard(req: Request, res: Response): boolean {
  if (isRequestAuthed(req)) return true;
  res.status(401).json({ ok: false, message: 'Unauthorized' });
  return false;
}

function isBrowserId(v: unknown): v is BrowserId {
  return typeof v === 'string' && (BROWSER_IDS as readonly string[]).includes(v);
}

/** 渲染工具：浏览器安装管理 + 进程控制（控制台内部接口） */
@Controller('api/browser')
export class BrowserApiController {
  /** 总览：三浏览器探测结果 + 运行状态 + 安装进度 + 安装前置校验事实 */
  @Get('status')
  async status(@Req() req: Request, @Res() res: Response, @Query('refresh') refresh?: string) {
    if (!guard(req, res)) return;
    const force = refresh === '1';
    const installBlocks = await getInstallBlocks(force);
    const runtimes = browserService.getAllStatus();
    const browsers = detectBrowsers(force).map((b) => {
      const rt = runtimes.find((r) => r.id === b.id);
      // 运行中判定以 browserService 的精确 runtime 为准（按 id 隔离）。
      // 进程名探测在 chrome/chromium 共用 chrome.exe 时会互相误判，仅当 runtime 未运行、
      // 且该浏览器有独立进程名（Edge 的 msedge.exe）时才采信进程名结果。
      const hasUniqueProcName = b.id === 'edge';
      const runningProcess = !!rt?.running || (hasUniqueProcName && b.runningProcess);
      return { ...b, runningProcess, verified: b.found || runningProcess, installBlock: installBlocks[b.id] };
    });
    res.json({
      ok: true,
      browsers,
      installBlocks,
      runtimes,
      settings: browserService.getSettings(),
      job: getInstallJob(),
    });
  }

  @Get('config')
  getConfig(@Req() req: Request, @Res() res: Response) {
    if (!guard(req, res)) return;
    res.json({ ok: true, settings: browserService.getSettings() });
  }

  @Put('config')
  saveConfig(@Req() req: Request, @Res() res: Response, @Body() body: unknown) {
    if (!guard(req, res)) return;
    const settings = browserService.saveSettings(body);
    res.json({ ok: true, settings });
  }

  @Post('install')
  async install(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    const r = await startInstall(body.browserId);
    res.json(r);
  }

  /** 取消正在进行的下载/解析阶段安装（真实 abort，不是假按钮） */
  @Post('cancel')
  cancel(@Req() req: Request, @Res() res: Response) {
    if (!guard(req, res)) return;
    res.json(cancelInstall());
  }

  @Post('uninstall')
  uninstall(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    const id = body.browserId;
    browserService.stop(id);
    const r = uninstall(id);
    res.json(r);
  }

  @Post('start')
  async start(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    const r = await browserService.start(body.browserId, 'manual');
    res.json(r);
  }

  @Post('stop')
  stop(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    const ok = browserService.stop(body.browserId);
    res.json({ ok, message: ok ? '已停止' : '浏览器未运行' });
  }

  @Post('restart')
  async restart(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    const r = await browserService.restart(body.browserId);
    res.json(r);
  }

  @Post('touch')
  touch(@Req() req: Request, @Res() res: Response, @Body() body: { browserId?: string } = {}) {
    if (!guard(req, res)) return;
    if (!isBrowserId(body?.browserId)) {
      res.status(400).json({ ok: false, message: 'browserId 无效' });
      return;
    }
    browserService.markActive(body.browserId);
    res.json({ ok: true });
  }
}
