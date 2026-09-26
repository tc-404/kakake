import {
  Controller, Get, Post, Body, Query, Req, Res, Sse, MessageEvent,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Observable } from 'rxjs';
import { PATHS } from '../paths.js';
import { eventBus } from '../event/event-bus.js';
import { isRequestAuthed, isValidSession, readSessionId } from './auth.middleware.js';
import {
  listSimulateAccounts,
  runSimulate,
  runSimulateEvent,
  getHistory,
  clearHistory,
} from '../tools/simulate/simulate.service.js';
import type { SimulateEventInput, SimulateInput } from '../tools/simulate/simulate.types.js';

/** 允许 asset 代理读取的根目录（防目录穿越/任意文件读取） */
const ASSET_ROOTS = [PATHS.data, PATHS.plugins, PATHS.pluginsTwo, fs.realpathSync(os.tmpdir())];

function isUnderAllowedRoot(abs: string): boolean {
  const target = path.resolve(abs);
  return ASSET_ROOTS.some((root) => {
    const r = path.resolve(root);
    return target === r || target.startsWith(r + path.sep);
  });
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
};

@Controller('api/simulate')
export class SimulateController {
  /** 可模拟的 OneBot 账号列表 */
  @Get('accounts')
  accounts() {
    return { code: 0, data: listSimulateAccounts() };
  }

  /** 某账号历史对话 */
  @Get('history')
  history(@Query('accountKey') accountKey?: string) {
    if (!accountKey) return { code: -1, message: 'accountKey required' };
    return { code: 0, data: getHistory(accountKey) };
  }

  /** 提交一条模拟消息 */
  @Post('send')
  async send(@Body() body: { accountKey?: string; input?: SimulateInput }) {
    const accountKey = String(body?.accountKey || '').trim();
    const input = body?.input;
    if (!accountKey || !input || !Array.isArray(input.message)) {
      return { code: -1, message: 'accountKey 与 input.message 必填' };
    }
    if (input.chatType === 'group' && !input.groupId) {
      return { code: -1, message: '群聊需提供 groupId' };
    }
    try {
      const r = await runSimulate(accountKey, input);
      return { code: 0, data: r };
    } catch (e) {
      return { code: -1, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 提交一次事件上报（notice / request） */
  @Post('event')
  async event(@Body() body: { accountKey?: string; input?: SimulateEventInput }) {
    const accountKey = String(body?.accountKey || '').trim();
    const input = body?.input;
    if (!accountKey || !input || !input.eventType) {
      return { code: -1, message: 'accountKey 与 input.eventType 必填' };
    }
    try {
      const r = await runSimulateEvent(accountKey, input);
      return { code: 0, data: r };
    } catch (e) {
      return { code: -1, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 清空某账号历史（清空缓存） */
  @Post('clear')
  clear(@Body() body: { accountKey?: string }) {
    const accountKey = String(body?.accountKey || '').trim();
    if (!accountKey) return { code: -1, message: 'accountKey required' };
    clearHistory(accountKey);
    return { code: 0 };
  }

  /** 实时推送某账号的模拟输出 */
  @Sse('stream')
  stream(@Req() req: Request, @Query('accountKey') accountKey?: string): Observable<MessageEvent> {
    if (!isRequestAuthed(req)) {
      throw new UnauthorizedException('Unauthorized');
    }
    const key = String(accountKey || '').trim();
    const sessionId = readSessionId(req);
    const watchSession = isValidSession(sessionId) ? sessionId : undefined;

    return new Observable((subscriber) => {
      const send = (type: string, data: unknown) => {
        subscriber.next({ data: JSON.stringify({ type, data, time: Date.now() }) });
      };
      send('ready', { accountKey: key });

      const off = eventBus.on('simulate/output', (payload) => {
        const p = payload as { accountKey?: string; entry?: unknown };
        if (!key || p.accountKey === key) send('output', p.entry);
      });

      const timer = setInterval(() => {
        if (watchSession && !isValidSession(watchSession)) {
          subscriber.complete();
          return;
        }
        // 心跳，保持连接
        subscriber.next({ data: JSON.stringify({ type: 'ping', time: Date.now() }) });
      }, 15000);

      return () => {
        off();
        clearInterval(timer);
      };
    });
  }

  /** 本地文件回显代理（带鉴权 + 路径白名单） */
  @Get('asset')
  asset(@Query('p') p: string, @Res() res: Response) {
    const raw = String(p || '').trim();
    if (!raw) {
      res.status(400).json({ code: -1, message: 'p required' });
      return;
    }
    let abs = raw;
    if (abs.startsWith('file://')) {
      try { abs = new URL(abs).pathname; } catch { /* keep */ }
      if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(abs)) abs = abs.slice(1);
    }
    abs = path.resolve(abs);
    if (!isUnderAllowedRoot(abs)) {
      res.status(403).json({ code: -1, message: 'path not allowed' });
      return;
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      res.status(404).json({ code: -1, message: 'file missing' });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    const mime = MIME[ext];
    if (mime) res.type(mime);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.sendFile(abs);
  }
}
