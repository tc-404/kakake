import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { configService } from '../core/config.service.js';
import { buildPublicOverview } from './public-overview.js';

/**
 * 外放 API：仅 HTTP、免登录的只读概览接口，IP + 端口 + 路径即可访问。
 *
 * 访问边界完全落在「设置页的外放 API 开关」上：
 *  - 开关关闭（默认）→ 一律 403，不返回任何数据；
 *  - 开关开启 → 任何能连到本端口的来源都可获取（不校验来源 IP）。
 *    因此当监听地址为 0.0.0.0 时，同一局域网的其它设备也能拿到数据——
 *    这是刻意的公开行为，请自行评估是否暴露到公网。
 *
 * 该路径已加入 auth.middleware.ts 的 PUBLIC_PREFIXES，否则会先被登录中间件拦成 401。
 * 实时推送版见 public-ws.ts（ws://<IP>:<端口>/api/public/ws）。
 */
@Controller('api/public')
export class PublicApiController {
  @Get()
  overview(@Res() res: Response) {
    if (!configService.getConfig().publicApiEnabled) {
      res.status(403).json({
        ok: false,
        code: -1,
        message: '外放 API 未开启（请在设置页开启「外放 API」开关）',
      });
      return;
    }

    res.json(buildPublicOverview());
  }
}
