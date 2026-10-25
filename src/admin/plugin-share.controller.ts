import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import fs from 'node:fs';
import path from 'node:path';
import { kakakeApp } from '../kakake-app.js';
import { logAction } from '../core/log-store.js';
import { resolvePluginManager } from './admin-api.shared.js';
import type { PluginEntry } from '../plugin/plugin.types.js';
import {
  SHARE_PROVIDERS,
  SHARE_UPLOAD_MAX_BYTES,
  buildAndUploadSharePackage,
  downloadSharePackage,
  listShareAccounts,
  restoreStagedData,
  stageDataZip,
  type ShareProviderId,
} from '../plugin/plugin-share.service.js';

/**
 * 插件分享：免注册临时存储点的上传 / 链接导入。
 *
 * 上传端：A 用户选存储源 →（可选带数据、选账号）→ 后端打包 zip → 传到存储点 → 回公开链接。
 * 导入端：B 用户粘贴链接 → 后端下载 → share.json 识别分享包 / 普通插件 zip 都认 →
 *         先装插件本体；包内有 data.zip 时先暂存，前端再询问是否一并还原。
 *
 * 边界：
 * - 上传体积硬上限 200MB（SHARE_UPLOAD_MAX_BYTES），插件包远用不到这么大；
 * - 暂存的数据 2 小时无人认领自动清理（见 service 的 pruneStaging）；
 * - 只收录有官方公开 API 的存储点，非官方接口一律不接。
 */
@Controller('api/plugin-share')
export class PluginShareController {
  @Get('providers')
  providers() {
    return { ok: true, providers: SHARE_PROVIDERS, maxUploadBytes: SHARE_UPLOAD_MAX_BYTES };
  }

  @Get('accounts')
  accounts(@Query('id') id?: string) {
    const pluginId = String(id || '').trim();
    if (!pluginId) return { ok: false, message: '缺少插件 ID' };
    return { ok: true, ...listShareAccounts(pluginId) };
  }

  @Post('upload')
  async upload(@Body() body: {
    pluginId?: string;
    provider?: string;
    mode?: 'plugin' | 'plugin_data';
    accounts?: string[];
  }) {
    const pluginId = String(body?.pluginId || '').trim();
    if (!pluginId) return { ok: false, message: '缺少插件 ID' };
    const mode = body?.mode === 'plugin_data' ? 'plugin_data' : 'plugin';
    const providerId = String(body?.provider || '') as ShareProviderId;

    const { manager, kind } = resolvePluginManager(pluginId);
    const entry: PluginEntry | undefined = manager.getPluginInfo(pluginId);
    if (!entry?.pluginPath || !require_exists(entry.pluginPath)) {
      return { ok: false, message: '插件安装目录不存在' };
    }

    const result = await buildAndUploadSharePackage({
      pluginPath: entry.pluginPath,
      meta: {
        pluginId,
        name: entry.pluginJson?.displayName || entry.name || pluginId,
        version: entry.version || entry.pluginJson?.version,
        kind,
      },
      providerId,
      mode,
      accounts: Array.isArray(body?.accounts) ? body!.accounts!.map(String) : [],
    });

    if (result.ok && result.url) {
      logAction(
        '【插件分享】',
        `${pluginId} 已通过 ${SHARE_PROVIDERS.find((p) => p.id === result.provider)?.name ?? result.provider} 分享`
          + `${mode === 'plugin_data' ? '（含数据）' : ''}，大小 ${((result.size ?? 0) / 1024 / 1024).toFixed(2)} MB`,
        result.url,
      );
    }
    return result;
  }

  @Post('import')
  async importFromLink(@Body() body: { text?: string }) {
    const text = String(body?.text || '');
    if (!text.trim()) return { ok: false, message: '请粘贴分享链接' };

    let downloaded;
    try {
      downloaded = await downloadSharePackage(text);
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : '下载失败' };
    }

    try {
      const result = await kakakeApp.pluginImporter.importFromZip(downloaded.pluginZipPath);
      if (!result.ok || !result.pluginId) {
        return { ok: false, message: result.message || '导入失败' };
      }
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
          message: '插件已解压，但注册到管理器失败，请到插件页点刷新重试',
        };
      }

      // 分享包且带数据：把 data.zip 暂存，等用户确认是否还原
      let token: string | undefined;
      let accounts: string[] = [];
      if (downloaded.isShare && downloaded.shareInfo?.hasData) {
        const info = downloaded.shareInfo!;
        try {
          const rel = relativeShareDir(downloaded.extractedDir);
          token = stageDataZip(downloaded.extractedDir, rel);
          accounts = info.accounts;
        } catch (e: unknown) {
          logAction('【插件分享】', `数据暂存失败：${e instanceof Error ? e.message : String(e)}`, undefined, 'warn');
        }
        logAction(
          '【插件分享】',
          `通过链接安装插件 ${result.pluginId}（${info.name}），包内含 ${accounts.length} 个账号的数据`,
        );
      } else {
        logAction('【插件分享】', `通过链接安装插件 ${result.pluginId}`);
      }

      return {
        ok: true,
        pluginId: result.pluginId,
        kind: result.kind,
        name: downloaded.shareInfo?.name || result.pluginId,
        hasData: !!token,
        accounts,
        token,
      };
    } finally {
      // 暂存发生在 extractedDir 内的文件已被复制走，这里整体清场
      cleanupDir(downloaded.extractedDir);
    }
  }

  @Post('import-data')
  async importData(@Body() body: { token?: string }) {
    try {
      const r = await restoreStagedData(String(body?.token || ''));
      return { ok: true, ...r };
    } catch (e: unknown) {
      return { ok: false, message: e instanceof Error ? e.message : '数据还原失败' };
    }
  }
}

function require_exists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** share.json / data.zip 所在子目录相对 extractedDir 的路径（'' = 根目录） */
function relativeShareDir(extractedDir: string): string {
  try {
    if (fs.existsSync(path.join(extractedDir, 'share.json'))) return '';
    const subs = fs.readdirSync(extractedDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const s of subs) {
      if (fs.existsSync(path.join(extractedDir, s.name, 'share.json'))) return s.name;
    }
  } catch { /* ignore */ }
  return '';
}

function cleanupDir(dir: string): void {
  try {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}
