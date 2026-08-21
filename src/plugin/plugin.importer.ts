import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { PATHS } from '../paths.js';
import type { Logger } from '../core/logger.js';
import { PluginLoader } from './plugin.loader.js';
import { toKakakePluginDirName } from './plugin-id.js';
import { isGfPluginDir, toGfPluginDirName } from './gf-plugin-id.js';
import { isWxPluginDir, toWxPluginDirName } from './wx-plugin-id.js';

export type ImportPluginKind = 'kakake' | 'gf' | 'wx';

export interface ImportResult {
  ok: boolean;
  pluginId?: string;
  kind?: ImportPluginKind;
  message: string;
  installPath?: string;
}

/**
 * 导入 zip 插件包。
 * 根据包名/目录名自动识别：
 * - GF- / gf-plugin- → 官方机器人插件
 * - WX- / wx-plugin- / wxbot → 微信机器人插件
 * - 其余 → OneBot 插件
 */
export class PluginImporter {
  private readonly kakakeLoader: PluginLoader;
  private readonly gfLoader: PluginLoader;
  private readonly wxLoader: PluginLoader;

  constructor(private readonly logger: Logger) {
    this.kakakeLoader = new PluginLoader(PATHS.plugins, PATHS.pluginsStatus, logger);
    this.gfLoader = new PluginLoader(PATHS.plugins, PATHS.gfPluginsStatus, logger, isGfPluginDir);
    this.wxLoader = new PluginLoader(PATHS.plugins, PATHS.wxPluginsStatus, logger, isWxPluginDir);
  }

  async importFromZip(zipPath: string): Promise<ImportResult> {
    const tempDir = path.join(PATHS.data, 'tmp', `_extract_${Date.now()}`);

    try {
      fs.mkdirSync(tempDir, { recursive: true });

      const zip = new AdmZip(zipPath);
      zip.extractAllTo(tempDir, true);

      const { pluginId: rawId, sourceDir } = this.resolvePluginRoot(tempDir);
      const kind = this.detectKind(rawId, sourceDir);
      const pluginId = kind === 'gf'
        ? toGfPluginDirName(rawId)
        : kind === 'wx'
          ? toWxPluginDirName(rawId)
          : toKakakePluginDirName(rawId);
      const pluginsRoot = PATHS.plugins;
      const loader = kind === 'gf'
        ? this.gfLoader
        : kind === 'wx'
          ? this.wxLoader
          : this.kakakeLoader;
      const targetDir = path.join(pluginsRoot, pluginId);

      fs.mkdirSync(pluginsRoot, { recursive: true });

      await this.movePluginDir(sourceDir, targetDir);
      this.syncPluginManifestIds(targetDir, pluginId);

      if (sourceDir !== tempDir && fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }

      const entry = loader.rescanPlugin(pluginId);
      if (!entry?.entryPath) {
        return {
          ok: false,
          pluginId,
          kind,
          message: '插件结构无效：缺少入口文件或 plugin_init',
          installPath: targetDir,
        };
      }

      const validation = await loader.validatePluginEntry(entry.entryPath);
      if (!validation.valid) {
        return {
          ok: false,
          pluginId,
          kind,
          message: validation.error ?? '插件验证失败',
          installPath: targetDir,
        };
      }

      const kindLabel = kind === 'gf' ? '官方机器人' : kind === 'wx' ? '微信机器人' : 'OneBot';
      return {
        ok: true,
        pluginId,
        kind,
        message: `导入成功（已识别为${kindLabel}插件，已安装到 plugins/）`,
        installPath: targetDir,
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '导入失败';
      this.logger.error('[PluginImporter]', error);
      return { ok: false, message: msg };
    } finally {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      if (fs.existsSync(zipPath)) {
        try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
      }
    }
  }

  /** 根据包名 / 目录名判断插件类型 */
  private detectKind(rawId: string, sourceDir: string): ImportPluginKind {
    const name = rawId.trim();
    const base = path.basename(sourceDir);
    if (
      isWxPluginDir(name)
      || isWxPluginDir(base)
      || /^wx[-_]?plugin/i.test(name)
      || /^wx[-_]?plugin/i.test(base)
      || /^wxbot/i.test(name)
      || /^wxbot/i.test(base)
      || name.toLowerCase().startsWith('wx-')
      || base.toLowerCase().startsWith('wx-')
    ) {
      return 'wx';
    }
    if (
      isGfPluginDir(name)
      || isGfPluginDir(base)
      || /^gf[-_]?plugin/i.test(name)
      || /^gf[-_]?plugin/i.test(base)
      || name.toLowerCase().startsWith('gf-')
      || base.toLowerCase().startsWith('gf-')
    ) {
      return 'gf';
    }
    try {
      const manifestPath = path.join(sourceDir, 'plugin.json');
      if (fs.existsSync(manifestPath)) {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
          type?: string;
          platform?: string;
          runtime?: string;
        };
        const t = `${m.type ?? ''} ${m.platform ?? ''} ${m.runtime ?? ''}`.toLowerCase();
        if (t.includes('wx') || t.includes('weixin') || t.includes('wechat')) return 'wx';
        if (t.includes('gf') || t.includes('qq_official') || t.includes('qq-official')) return 'gf';
      }
    } catch { /* ignore */ }
    return 'kakake';
  }

  /** Windows 上 rename 目录常遇 EPERM（杀软/句柄未释放）；失败则 cp + rm，并短重试 */
  private async movePluginDir(sourceDir: string, targetDir: string): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const isRetryable = (e: unknown) => {
      const code = e && typeof e === 'object' && 'code' in e ? String((e as { code?: string }).code) : '';
      return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
    };

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        break;
      } catch (e) {
        if (attempt === 5 || !isRetryable(e)) throw e;
        await sleep(120 * (attempt + 1));
      }
    }

    try {
      fs.renameSync(sourceDir, targetDir);
      return;
    } catch (renameErr) {
      // EXDEV（跨盘）或 Windows EPERM：改为复制
      try {
        fs.cpSync(sourceDir, targetDir, { recursive: true, force: true });
      } catch (cpErr) {
        throw renameErr instanceof Error ? renameErr : cpErr;
      }
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          if (fs.existsSync(sourceDir)) {
            fs.rmSync(sourceDir, { recursive: true, force: true });
          }
          return;
        } catch (e) {
          if (attempt === 5) {
            // 目标已就位，源目录清不掉不阻断导入
            this.logger.warn('[PluginImporter] 已安装到目标，清理临时目录失败', e);
            return;
          }
          if (!isRetryable(e)) {
            this.logger.warn('[PluginImporter] 清理临时目录失败', e);
            return;
          }
          await sleep(120 * (attempt + 1));
        }
      }
    }
  }

  private resolvePluginRoot(extractDir: string): { pluginId: string; sourceDir: string } {
    const junk = new Set(['__macosx', '.ds_store', 'thumbs.db']);
    const items = fs.readdirSync(extractDir).filter((n) => !junk.has(n.toLowerCase()));
    const hasEntry = (dir: string) => {
      const pkg = path.join(dir, 'package.json');
      if (fs.existsSync(pkg)) {
        try {
          const p = JSON.parse(fs.readFileSync(pkg, 'utf-8'));
          if (p.name) return p.name as string;
        } catch { /* ignore */ }
      }
      for (const f of ['index.mjs', 'index.js', 'main.mjs', 'main.js']) {
        if (fs.existsSync(path.join(dir, f))) return path.basename(dir);
      }
      return null;
    };

    const direct = hasEntry(extractDir);
    if (direct) {
      return { pluginId: direct, sourceDir: extractDir };
    }

    const dirs = items
      .map((n) => path.join(extractDir, n))
      .filter((p) => {
        try { return fs.statSync(p).isDirectory(); } catch { return false; }
      });

    if (dirs.length === 1) {
      const id = hasEntry(dirs[0]!);
      if (id) return { pluginId: id, sourceDir: dirs[0]! };
    }

    // zip 里夹杂无关文件/多层目录时，找第一个有效插件根
    for (const sub of dirs) {
      const id = hasEntry(sub);
      if (id) return { pluginId: id, sourceDir: sub };
      // 再下一层（例如 outer/kakake-plugin-mkbot/）
      try {
        const nested = fs.readdirSync(sub)
          .filter((n) => !junk.has(n.toLowerCase()))
          .map((n) => path.join(sub, n))
          .filter((p) => {
            try { return fs.statSync(p).isDirectory(); } catch { return false; }
          });
        for (const n2 of nested) {
          const id2 = hasEntry(n2);
          if (id2) return { pluginId: id2, sourceDir: n2 };
        }
      } catch { /* ignore */ }
    }

    throw new Error('无效的插件包结构');
  }

  private syncPluginManifestIds(pluginDir: string, pluginId: string): void {
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
        pkg.name = pluginId;
        fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2), 'utf-8');
      } catch (error) {
        this.logger.warn('[PluginImporter] 更新 package.json 失败', error);
      }
    }

    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8')) as Record<string, unknown>;
        manifest.name = pluginId;
        fs.writeFileSync(pluginJsonPath, JSON.stringify(manifest, null, 2), 'utf-8');
      } catch (error) {
        this.logger.warn('[PluginImporter] 更新 plugin.json 失败', error);
      }
    }
  }
}
