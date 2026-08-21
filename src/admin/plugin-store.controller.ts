import {
  Controller, Get, Post, Body, Query, Param, Res, ParseIntPipe,
} from '@nestjs/common';
import type { Response } from 'express';
import fs from 'node:fs';
import { kakakeApp } from '../kakake-app.js';
import { pluginStoreService, PLUGIN_STORE_CAT_NAME } from '../plugin/plugin-store.service.js';

@Controller('api/plugin-store')
export class PluginStoreController {
  @Get('list')
  async list(@Query('refresh') refresh?: string) {
    try {
      const force = refresh === '1' || refresh === 'true';
      const data = await pluginStoreService.fetchList(force);
      return {
        ok: true,
        catName: PLUGIN_STORE_CAT_NAME,
        catId: data.catId,
        categories: data.categories,
        pinned: data.pinned,
        resources: data.resources,
      };
    } catch (e: unknown) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '获取商城列表失败',
      };
    }
  }

  @Get('comments')
  async comments(
    @Query('id', ParseIntPipe) id: number,
    @Query('limit') limitRaw?: string,
  ) {
    try {
      const limit = limitRaw ? Number.parseInt(limitRaw, 10) : 50;
      const data = await pluginStoreService.fetchComments(id, Number.isFinite(limit) ? limit : 50);
      return { ok: true, ...data };
    } catch (e: unknown) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '获取评论失败',
      };
    }
  }

  @Get('cover')
  async cover(@Query('id', ParseIntPipe) id: number, @Res() res: Response) {
    try {
      const { buffer, contentType } = await pluginStoreService.fetchCoverBuffer(id);
      res.status(200);
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', String(buffer.length));
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // 用 end 发送原始二进制，避免 send 对部分 PNG 缓冲处理异常
      res.end(buffer);
    } catch (e: unknown) {
      res.status(404).json({
        ok: false,
        message: e instanceof Error ? e.message : '封面不可用',
      });
    }
  }

  @Post('install')
  async install(@Body() body: { id?: number }) {
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, message: '缺少有效的资源 id' };
    }

    let zipPath = '';
    try {
      const { zipPath: downloaded } = await pluginStoreService.downloadToTemp(id);
      zipPath = downloaded;

      const result = await kakakeApp.pluginImporter.importFromZip(zipPath);
      if (result.ok && result.pluginId) {
        const registered = result.kind === 'gf'
          ? await kakakeApp.gfPluginManager.registerImportedPlugin(result.pluginId)
          : result.kind === 'wx'
            ? await kakakeApp.wxPluginManager.registerImportedPlugin(result.pluginId)
            : await kakakeApp.pluginManager.registerImportedPlugin(result.pluginId);
        if (!registered) {
          return {
            ok: false,
            pluginId: result.pluginId,
            kind: result.kind,
            message: '插件已解压，但注册到管理器失败，请到插件页点刷新重试',
          };
        }
      }
      return result;
    } catch (e: unknown) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '安装失败',
      };
    } finally {
      if (zipPath && fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch { /* ignore */ }
      }
    }
  }

  /** 兼容路径参数形式的封面 */
  @Get('cover/:id')
  async coverByParam(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    return this.cover(id, res);
  }
}
