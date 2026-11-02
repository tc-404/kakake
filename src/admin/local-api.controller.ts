import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { kakakeApp } from '../kakake-app.js';
import { remoteAddressOf, tokenlessSourceVerdict } from '../core/net-address.js';
import { rootLogger } from '../core/logger.js';
import { buildLocalConnectionsPayload } from './local-connections.js';

/**
 * 仅本机 / 内网可访问的运维接口（不要求登录）。
 * 路径必须在 auth.middleware 的 PUBLIC_PREFIXES 里，且这里必须自己按来源 IP 放行；
 * remoteAddressOf 不读 X-Forwarded-For，挂公网反代时需另加 token。
 * 无 token 判定收窄到 tokenlessSourceVerdict：检测到反代头一律拒绝。
 */
const WARN_INTERVAL_MS = 60_000;
const WARN_MAX_TRACKED = 512;
const lastWarnAt = new Map<string, number>();

function shouldWarn(key: string, now: number): boolean {
  const last = lastWarnAt.get(key) ?? 0;
  if (now - last < WARN_INTERVAL_MS) return false;
  if (lastWarnAt.size >= WARN_MAX_TRACKED && !lastWarnAt.has(key)) {
    const oldest = lastWarnAt.keys().next().value;
    if (oldest !== undefined) lastWarnAt.delete(oldest);
  }
  lastWarnAt.set(key, now);
  return true;
}

@Controller('api/local')
export class LocalApiController {
  @Get('connections')
  connections(@Req() req: Request, @Res() res: Response) {
    const from = remoteAddressOf(req);
    const verdict = tokenlessSourceVerdict(req.headers, from);
    if (!verdict.ok) {
      if (shouldWarn(from || 'unknown', Date.now())) {
        rootLogger.warn(`[本地接口] 拒绝不可信来源: ${req.path} · ${from || '未知来源'} · ${verdict.reason}`);
      }
      res.status(403).json({
        ok: false,
        code: -1,
        message: '该接口仅允许本机 / 内网直连访问',
        from,
      });
      return;
    }

    const payload = buildLocalConnectionsPayload(kakakeApp.connectionManager.getStatusList());
    res.json({ ok: true, time: Date.now(), ...payload });
  }
}
