import {
  Controller, Get, Post, Body, Query, Param, Req, Res, ParseIntPipe,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import fs from 'node:fs';
import { kakakeApp } from '../kakake-app.js';
import {
  pluginStoreService,
  PLUGIN_STORE_CAT_NAME,
  Sha256MismatchError,
  type StoreOrigin,
} from '../plugin/plugin-store.service.js';
import { mirrorPrefixFor, getActiveMirrorId } from './update-check.service.js';
import { readSessionId } from './auth.middleware.js';

function parseOrigin(raw?: string): StoreOrigin | undefined {
  if (raw === 'github' || raw === 'kakake') return raw;
  return undefined;
}

function updateSessionKey(req: Request): string {
  const sid = readSessionId(req);
  if (sid) return `sid:${sid}`;
  const ip = (req.ip || req.socket?.remoteAddress || 'unknown').toString();
  return `ip:${ip}`;
}

/**
 * 解析本次请求应使用的镜像前缀：优先用前端传来的镜像 id（用户在更新中心的选择），
 * 缺省时回退到本会话自动选定的镜像——与在线更新共用同一个源。
 */
function resolveMirrorPrefix(req: Request, mirrorRaw?: string): string {
  const explicit = (mirrorRaw || '').trim();
  const id = explicit || getActiveMirrorId(updateSessionKey(req));
  return mirrorPrefixFor(id);
}

@Controller('api/plugin-store')
export class PluginStoreController {
  @Get('origin')
  origin() {
    return { ok: true, origin: pluginStoreService.getOrigin() };
  }

  @Post('origin')
  setOrigin(@Body() body: { origin?: string }) {
    const next = parseOrigin(body?.origin);
    if (!next) {
      return { ok: false, message: '无效的来源（仅 kakake / github）' };
    }
    const saved = pluginStoreService.setOrigin(next);
    return { ok: true, origin: saved };
  }

  @Get('list')
  async list(
    @Req() req: Request,
    @Query('refresh') refresh?: string,
    @Query('origin') originRaw?: string,
    @Query('mirror') mirror?: string,
  ) {
    try {
      const force = refresh === '1' || refresh === 'true';
      const origin = parseOrigin(originRaw);
      const mirrorPrefix = resolveMirrorPrefix(req, mirror);
      const data = await pluginStoreService.fetchList(force, origin, mirrorPrefix);
      return {
        ok: true,
        origin: data.origin,
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

  @Get('readme')
  async readme(
    @Req() req: Request,
    @Query('repo') repo?: string,
    @Query('refresh') refresh?: string,
    @Query('mirror') mirror?: string,
  ) {
    try {
      const r = (repo || '').trim();
      if (!r) return { ok: false, message: '缺少 repo 参数' };
      const force = refresh === '1' || refresh === 'true';
      const mirrorPrefix = resolveMirrorPrefix(req, mirror);
      const markdown = await pluginStoreService.fetchReadme(r, force, mirrorPrefix);
      if (markdown == null) return { ok: false, message: '未找到文档' };
      return { ok: true, markdown };
    } catch (e: unknown) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : '获取文档失败',
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
      res.end(buffer);
    } catch (e: unknown) {
      res.status(404).json({
        ok: false,
        message: e instanceof Error ? e.message : '封面不可用',
      });
    }
  }

  @Post('install')
  async install(@Req() req: Request, @Body() body: { id?: number; mirror?: string }) {
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, message: '缺少有效的资源 id' };
    }

    const mirrorPrefix = resolveMirrorPrefix(req, body?.mirror);
    let zipPath = '';
    try {
      const { zipPath: downloaded } = await pluginStoreService.downloadToTemp(id, mirrorPrefix);
      zipPath = downloaded;

      const result = await kakakeApp.pluginImporter.importFromZip(zipPath);
      if (result.ok && result.pluginId) {
        const registered = result.kind === 'gf'
          ? await kakakeApp.gfPluginManager.registerImportedPlugin(result.pluginId)
          : result.kind === 'wx'
            ? await kakakeApp.wxPluginManager.registerImportedPlugin(result.pluginId)
            : result.kind === 'ss'
              ? await kakakeApp.ssPluginManager.registerImportedPlugin(result.pluginId)
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
      if (e instanceof Sha256MismatchError) {
        return { ok: false, code: e.code, message: e.message };
      }
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
