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
  StoreFetchError,
  StoreInstallCancelledError,
  withInstallSlot,
  type StoreOrigin,
} from '../plugin/plugin-store.service.js';
import { mirrorPrefixFor, getActiveMirrorId } from './update-check.service.js';
import { readSessionId } from './auth.middleware.js';

/**
 * 错误码透传：商城的超时 / 网络失败 / HTTP 状态码都带 code，
 * 控制台按码翻译，不再直接把后端的中文（或底层英文）原样上屏。
 */
function storeErrorPayload(e: unknown, fallback: string): { ok: false; code?: string; message: string } {
  if (e instanceof Sha256MismatchError) return { ok: false, code: e.code, message: e.message };
  if (e instanceof StoreFetchError) return { ok: false, code: e.code, message: e.message };
  return { ok: false, message: e instanceof Error ? e.message : fallback };
}

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
        /** 数据能力：GitHub 源的「下载次数」依赖本机配置的 Token，没配就没有 */
        capabilities: {
          downloadCounts: pluginStoreService.downloadCountsAvailable(data.origin),
        },
      };
    } catch (e: unknown) {
      return storeErrorPayload(e, '获取商城列表失败');
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
      return storeErrorPayload(e, '获取文档失败');
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
      return storeErrorPayload(e, '获取评论失败');
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
  async install(@Req() req: Request, @Body() body: { id?: number; mirror?: string; taskId?: string }) {
    const id = Number(body?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false, message: '缺少有效的资源 id' };
    }
    const taskId = typeof body?.taskId === 'string' ? body.taskId.slice(0, 128) : '';

    const mirrorPrefix = resolveMirrorPrefix(req, body?.mirror);
    let result: { ok: boolean; code?: string; message: string; pluginId?: string; kind?: string };
    try {
      result = await withInstallSlot(() => this.runInstall(id, mirrorPrefix, taskId));
    } catch (e) {
      // 信号量满等前置失败：不进暂存，直接给友好文案
      result = { ok: false, message: e instanceof Error ? e.message : '安装失败' };
    }
    // 结果先入暂存再清进度账：刷新后的页面要凭它收尾，顺序反了会有取不到的竞态
    if (taskId) pluginStoreService.finishInstall(taskId, result);
    return result;
  }

  /** install 主体：无论成败都归一成 InstallOutcome 交给调用方入暂存 */
  private async runInstall(
    id: number,
    mirrorPrefix: string,
    taskId: string,
  ): Promise<{ ok: boolean; code?: string; message: string; pluginId?: string; kind?: string }> {
    let zipPath = '';
    try {
      const { zipPath: downloaded } = await pluginStoreService.downloadToTemp(id, mirrorPrefix, taskId || undefined);
      zipPath = downloaded;
      if (taskId) pluginStoreService.setInstallPhase(taskId, 'installing');

      const result = await kakakeApp.pluginImporter.importFromZip(zipPath);
      if (result.ok && result.pluginId) {
        const registered = result.kind === 'sssx'
          ? await kakakeApp.sssxPluginManager.registerImportedPlugin(result.pluginId)
          : result.kind === 'gf'
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
      return {
        ok: result.ok,
        pluginId: result.pluginId,
        kind: result.kind,
        message: result.message,
      };
    } catch (e: unknown) {
      if (e instanceof Sha256MismatchError) {
        return { ok: false, code: e.code, message: e.message };
      }
      if (e instanceof StoreInstallCancelledError) {
        return { ok: false, code: 'cancelled', message: e.message };
      }
      return storeErrorPayload(e, '安装失败');
    } finally {
      if (zipPath && fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch { /* ignore */ }
      }
    }
  }

  /** 用户取消下载：掐断在途 fetch，install 的 POST 会以 code='cancelled' 收场 */
  @Post('install/cancel')
  cancelInstall(@Body() body: { taskId?: string }) {
    const t = typeof body?.taskId === 'string' ? body.taskId.trim() : '';
    if (!t) return { ok: false, message: '缺少 taskId' };
    return pluginStoreService.cancelInstall(t);
  }

  /** 刷新重连：进度账已清（安装已结束）时，取走一次性暂存结果 */
  @Get('install/result')
  installResult(@Query('taskId') taskId?: string) {
    const t = (taskId || '').trim();
    if (!t) return { found: false };
    const r = pluginStoreService.popInstallResult(t);
    if (!r) return { found: false };
    return { found: true, result: r };
  }

  /** 安装下载进度轮询：POST /install 仍在途时，前端凭 taskId 读真实字节数 */
  @Get('install/progress')
  installProgress(@Query('taskId') taskId?: string) {
    const t = (taskId || '').trim();
    if (!t) return { ok: false };
    const p = pluginStoreService.getInstallProgress(t);
    if (!p) return { ok: false };
    return { ok: true, downloaded: p.downloaded, total: p.total, phase: p.phase };
  }

  @Get('download-config')
  downloadConfig() {
    return { ok: true, ...pluginStoreService.getDownloadConfig() };
  }

  @Post('download-config')
  setDownloadConfig(@Body() body: { multiThread?: boolean; mode?: string; minSizeMB?: number }) {
    const next = pluginStoreService.setDownloadConfig({
      multiThread: typeof body?.multiThread === 'boolean' ? body.multiThread : undefined,
      mode: body?.mode === 'always' || body?.mode === 'minSize' ? body.mode : undefined,
      minSizeMB: typeof body?.minSizeMB === 'number' ? body.minSizeMB : undefined,
    });
    return { ok: true, ...next };
  }

  /** 兼容路径参数形式的封面 */
  @Get('cover/:id')
  async coverByParam(@Param('id', ParseIntPipe) id: number, @Res() res: Response) {
    return this.cover(id, res);
  }
}
