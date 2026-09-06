import {
  Body, Controller, Delete, Get, Param, Post, Put, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { saveMultipartFile } from './multipart-file.js';
import {
  BACKGROUND_MAX_BYTES,
  DEFAULT_APPEARANCE,
  appearanceService,
  isBackgroundOrientation,
  type AppearanceSettings,
} from './appearance.service.js';

/**
 * 控制台外观：动效速度 / 卡片透明度 / 组件模糊 / 背景模糊 + 竖横两张背景图。
 *
 * 读写分两条路径：
 * - /api/appearance…        需要登录会话（改参数、传图、删图）
 * - /api/appearance/public… 只读，已加入鉴权白名单，供登录页在未登录时套用同一套外观。
 *   该前缀下只挂 GET，任何写操作都不会落到这里。
 */
@Controller('api/appearance')
export class AppearanceApiController {
  @Get()
  getAppearance() {
    return {
      ok: true,
      appearance: appearanceService.getState(),
      defaults: DEFAULT_APPEARANCE,
    };
  }

  /** 公开只读：登录页 / 设置密码页在无会话时也要能套上同一套外观 */
  @Get('public')
  getPublicAppearance() {
    return { ok: true, appearance: appearanceService.getState() };
  }

  @Put()
  saveAppearance(@Body() body: Partial<AppearanceSettings> = {}) {
    appearanceService.saveSettings(body ?? {});
    return { ok: true, appearance: appearanceService.getState() };
  }

  @Post('reset')
  resetAppearance() {
    return { ok: true, appearance: appearanceService.reset() };
  }

  /** 公开只读的背景图字节；登录页的 CSS url() 在未登录时也要取得到 */
  @Get('public/background/:orientation')
  getBackground(@Param('orientation') orientation: string, @Res() res: Response) {
    if (!isBackgroundOrientation(orientation)) {
      res.status(400).json({ ok: false, message: 'bad orientation' });
      return;
    }
    const found = appearanceService.findBackgroundFile(orientation);
    if (!found) {
      res.status(404).json({ ok: false, message: 'no background' });
      return;
    }
    // 用户上传的原始字节：显式声明类型并禁止嗅探，避免被当成可执行文档打开
    res.setHeader('Content-Type', found.meta.mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', `"${found.meta.updatedAt}-${found.meta.size}"`);
    fs.createReadStream(found.path).pipe(res);
  }

  @Post('background/:orientation')
  async uploadBackground(@Param('orientation') orientation: string, @Req() req: Request) {
    if (!isBackgroundOrientation(orientation)) {
      return { ok: false, message: '参数错误' };
    }

    let uploaded;
    try {
      uploaded = await saveMultipartFile(req, 'file', path.join(PATHS.data, 'tmp'), {
        maxFileSize: BACKGROUND_MAX_BYTES,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg.includes('过大') ? '图片超过 10MB' : `上传失败: ${msg}` };
    }
    if (!uploaded?.path || !fs.existsSync(uploaded.path)) {
      return { ok: false, message: '未收到文件' };
    }

    const result = appearanceService.adoptBackground(orientation, uploaded.path);
    if (!result.ok) return { ok: false, message: result.message };
    return { ok: true, appearance: appearanceService.getState() };
  }

  @Delete('background/:orientation')
  deleteBackground(@Param('orientation') orientation: string) {
    if (!isBackgroundOrientation(orientation)) {
      return { ok: false, message: '参数错误' };
    }
    appearanceService.removeBackground(orientation);
    return { ok: true, appearance: appearanceService.getState() };
  }
}