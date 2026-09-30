import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { kakakeApp } from '../kakake-app.js';
import { isTrustedLocalAddress, remoteAddressOf } from '../core/net-address.js';
import { rootLogger } from '../core/logger.js';
import { buildLocalConnectionsPayload } from './local-connections.js';

/**
 * 仅本机 / 内网可访问的运维接口（不要求登录）。
 *
 * 安全模型：这类接口不进登录流程，所以边界完全落在**来源地址**上。
 * 1. 必须把路径加进 auth.middleware.ts 的 PUBLIC_PREFIXES，否则会先被登录
 *    中间件拦成 401；
 * 2. 而白名单里的路径对公网是放行的，因此这里**必须**自己按来源 IP 放行——
 *    白名单 + 不做来源校验 = 对公网裸奔。
 *
 * 同理，来源只认 TCP 对端地址（remoteAddressOf 不读 X-Forwarded-For），
 * 挂反代时所有请求都会看起来来自代理本机，此时要么别把反代挂在公网，
 * 要么另加 token。
 */
@Controller('api/local')
export class LocalApiController {
  @Get('connections')
  connections(@Req() req: Request, @Res() res: Response) {
    const from = remoteAddressOf(req);
    if (!isTrustedLocalAddress(from)) {
      rootLogger.warn(`[本地接口] 拒绝非本地来源: ${req.path} · ${from || '未知来源'}`);
      res.status(403).json({
        ok: false,
        code: -1,
        message: '该接口仅允许本机 / 内网访问',
        from,
      });
      return;
    }

    const payload = buildLocalConnectionsPayload(kakakeApp.connectionManager.getStatusList());
    res.json({ ok: true, time: Date.now(), ...payload });
  }
}
