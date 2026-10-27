import {
  Body, Controller, Delete, Get, Param, Post, Put, Req, Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../paths.js';
import { saveMultipartFile } from './multipart-file.js';
import {
  BACKGROUND_VIDEO_MAX_BYTES,
  DEFAULT_APPEARANCE,
  appearanceService,
  isBackgroundOrientation,
  type AppearanceSaveInput,
  type AppearanceSettings,
  type AppearanceState,
} from './appearance.service.js';

/**
 * 控制台外观：动效速度 / 卡片透明度 / 组件模糊 / 背景模糊 + 竖横两份背景资源（图片或循环视频）。
 *
 * 读写分两条路径：
 * - /api/appearance…        需要登录会话（改参数、传资源、删资源）
 * - /api/appearance/public… 只读，已加入鉴权白名单，供登录页在未登录时套用同一套外观。
 *   该前缀下只挂 GET，任何写操作都不会落到这里。
 */
@Controller('api/appearance')
export class AppearanceApiController {
  private publicCache: { at: number; value: { ok: boolean; appearance: AppearanceState } } | null = null;

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
    const now = Date.now();
    if (!this.publicCache || now - this.publicCache.at >= 1000) {
      this.publicCache = { at: now, value: { ok: true, appearance: appearanceService.getState() } };
    }
    return this.publicCache.value;
  }

  /**
   * 保存外观。数值字段（动效 / 透明度 / 模糊 / 配色）照旧走 RANGES 收口；
   * 渐变色、自定义标题、背景适配 / 预设、页面水印也可以在这里一起带过来
   * （带上才覆盖），设置页因此只需要发一份草稿。
   */
  @Put()
  saveAppearance(@Body() body: AppearanceSaveInput = {}) {
    appearanceService.saveSettings(body ?? {});
    return { ok: true, appearance: appearanceService.getState() };
  }

  @Post('reset')
  resetAppearance() {
    return { ok: true, appearance: appearanceService.reset() };
  }

  /** 自定义标题名（手机置顶栏 / 电脑侧边栏顶部品牌字）：登录会话可改，公开只读接口顺带下发 */
  @Put('title')
  saveCustomTitle(@Body() body: { title?: unknown } = {}) {
    const title = appearanceService.saveCustomTitle(body?.title);
    return { ok: true, title, appearance: appearanceService.getState() };
  }

  /** 页面水印文字：非空即开启、平铺在全部界面的最上层；空串即关闭 */
  @Put('watermark')
  saveWatermark(@Body() body: { text?: unknown } = {}) {
    const text = appearanceService.saveWatermark(body?.text);
    return { ok: true, watermarkText: text, appearance: appearanceService.getState() };
  }

  /** 背景适配方式：cover 铺满裁切 / stretch 拉伸铺满 / contain 完整显示 */
  @Put('bg-fit')
  saveBackgroundFit(@Body() body: { fit?: unknown } = {}) {
    const fit = appearanceService.saveBackgroundFit(body?.fit);
    return { ok: true, bgFit: fit, appearance: appearanceService.getState() };
  }

  /** 背景预设：default 出厂氛围底 / waves 波浪；有自定义背景时不生效 */
  @Put('bg-preset')
  saveBackgroundPreset(@Body() body: { preset?: unknown } = {}) {
    const preset = appearanceService.saveBackgroundPreset(body?.preset);
    return { ok: true, bgPreset: preset, appearance: appearanceService.getState() };
  }

  /** 公开只读的背景资源字节；登录页的 CSS url() / <video> 在未登录时也要取得到 */
  @Get('public/background/:orientation')
  getBackground(@Param('orientation') orientation: string, @Req() req: Request, @Res() res: Response) {
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
    // 视频拖动进度与 Safari 的 <video> 都依赖 Range 请求，必须宣告并实现
    res.setHeader('Accept-Ranges', 'bytes');

    const size = found.meta.size;
    const rangeHeader = req.headers.range;
    const match = typeof rangeHeader === 'string' ? /^bytes=(\d*)-(\d*)\s*$/.exec(rangeHeader) : null;
    if (match && (match[1] !== '' || match[2] !== '')) {
      let start: number;
      let end: number;
      if (match[1] === '') {
        // 后缀区间：bytes=-N 取最后 N 字节
        start = Math.max(0, size - Number(match[2]));
        end = size - 1;
      } else {
        start = Number(match[1]);
        end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      fs.createReadStream(found.path, { start, end }).pipe(res);
      return;
    }

    res.setHeader('Content-Length', String(size));
    fs.createReadStream(found.path).pipe(res);
  }

  @Post('background/:orientation')
  async uploadBackground(@Param('orientation') orientation: string, @Req() req: Request) {
    if (!isBackgroundOrientation(orientation)) {
      return { ok: false, message: '参数错误' };
    }

    let uploaded;
    try {
      // multipart 上限按视频档收（类型落盘后嗅探才知道），图片的超限在 adoptBackground 里再拦
      uploaded = await saveMultipartFile(req, 'file', path.join(PATHS.data, 'tmp'), {
        maxFileSize: BACKGROUND_VIDEO_MAX_BYTES,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg.includes('过大') ? '文件超过 100MB' : `上传失败: ${msg}` };
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