import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { Logger } from '../core/logger.js';
import type {
  PluginEntry,
  PluginModule,
  PluginPackageJson,
  PluginStatusConfig,
  KakakePluginManifest,
} from './plugin.types.js';
import { mergePluginMetadata, readPluginManifest } from './plugin-meta.js';
import {
  isKakakePluginDir,
  KAKAKE_BUILTIN_PLUGIN_ID,
  resolveKakakePluginId,
  toKakakePluginDirName,
} from './plugin-id.js';

const require = createRequire(import.meta.url);

/** 插件加载器：扫描、验证与动态 import 插件模块 */
export class PluginLoader {
  /** 入口绝对路径 → 最近一次成功 import 的 URL / mtime（用于稳定复用，避免 ?t= 堆积） */
  private readonly loadedMetaByEntry = new Map<string, { url: string; mtimeMs: number }>();

  constructor(
    private readonly pluginPath: string,
    private readonly statusConfigPath: string,
    private readonly logger: Logger,
    private readonly isAllowedDir: (dirName: string) => boolean = isKakakePluginDir,
  ) {}

  loadPluginStatusConfig(): PluginStatusConfig {
    if (fs.existsSync(this.statusConfigPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.statusConfigPath, 'utf-8')) as PluginStatusConfig;
        return this.migratePluginStatusConfig(raw);
      } catch (e) {
        this.logger.warn('[PluginLoader] 解析 plugins.json 失败', e);
      }
    }
    return {};
  }

  /** 将旧版插件 ID 启停配置迁移为 kakake-plugin-* 命名 */
  private migratePluginStatusConfig(config: PluginStatusConfig): PluginStatusConfig {
    let changed = false;
    const next: PluginStatusConfig = { ...config };

    for (const [key, enabled] of Object.entries(config)) {
      const migrated = toKakakePluginDirName(key);
      if (migrated === key || migrated in next) continue;
      next[migrated] = enabled;
      delete next[key];
      changed = true;
    }

    if (changed) {
      this.savePluginStatusConfig(next);
      this.logger.info('[PluginLoader] 已迁移 plugins.json 中的 NapCat 插件 ID');
    }

    return next;
  }

  savePluginStatusConfig(config: PluginStatusConfig): void {
    const dir = path.dirname(this.statusConfigPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.statusConfigPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * 插件总开关：plugins.json / gf-plugins.json
   * - 显式 false → 总关
   * - true 或缺失 → 总开（默认开启，由连接子开关决定是否真正跑）
   */
  isMasterEnabled(pluginId: string, aliases: string[] = []): boolean {
    const config = this.loadPluginStatusConfig();
    if (config[pluginId] === false) return false;
    for (const a of aliases) {
      if (a && config[a] === false) return false;
    }
    return true;
  }

  setMasterEnabled(pluginId: string, enable: boolean): void {
    const config = this.loadPluginStatusConfig();
    config[pluginId] = enable;
    this.savePluginStatusConfig(config);
  }

  /** 卸载插件时从总开关配置里删掉该键 */
  removeMasterStatus(pluginId: string): void {
    const config = this.loadPluginStatusConfig();
    if (!(pluginId in config)) return;
    delete config[pluginId];
    this.savePluginStatusConfig(config);
  }

  async scanPlugins(): Promise<PluginEntry[]> {
    const entries: PluginEntry[] = [];

    if (!fs.existsSync(this.pluginPath)) {
      this.logger.warn(`插件目录不存在: ${this.pluginPath}`);
      fs.mkdirSync(this.pluginPath, { recursive: true });
      return entries;
    }

    const items = fs.readdirSync(this.pluginPath, { withFileTypes: true });
    const statusConfig = this.loadPluginStatusConfig();

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (!this.isAllowedDir(item.name)) {
        this.logger.debug(`[PluginLoader] 跳过非插件目录: ${item.name}`);
        continue;
      }

      const entry = this.scanDirectoryPlugin(item.name, statusConfig);
      if (!entry?.entryPath) {
        if (entry) this.logger.warn(`跳过 ${item.name}: 无入口文件`);
        continue;
      }

      if (!entry.enable) {
        entries.push(entry);
        continue;
      }

      const validation = await this.validatePluginEntry(entry.entryPath);
      if (!validation.valid) {
        this.logger.warn(`跳过 ${item.name}: ${validation.error}`);
        continue;
      }

      entries.push(entry);
    }

    return entries;
  }

  /** 全量扫描（刷新用）：包含损坏/无效插件，验证失败写入 runtime.error 而非跳过 */
  async scanAllPlugins(): Promise<PluginEntry[]> {
    const entries: PluginEntry[] = [];

    if (!fs.existsSync(this.pluginPath)) {
      this.logger.warn(`插件目录不存在: ${this.pluginPath}`);
      fs.mkdirSync(this.pluginPath, { recursive: true });
      return entries;
    }

    const items = fs.readdirSync(this.pluginPath, { withFileTypes: true });
    const statusConfig = this.loadPluginStatusConfig();

    for (const item of items) {
      if (!item.isDirectory()) continue;
      if (!this.isAllowedDir(item.name)) {
        this.logger.debug(`[PluginLoader] 跳过非插件目录: ${item.name}`);
        continue;
      }

      const entry = this.scanDirectoryPlugin(item.name, statusConfig);
      if (!entry) continue;

      if (!entry.entryPath) {
        this.logger.warn(`[PluginLoader] ${item.name}: ${entry.runtime.error ?? '无入口文件'}`);
        entries.push(entry);
        continue;
      }

      const validation = await this.validatePluginEntry(entry.entryPath);
      if (!validation.valid) {
        entry.runtime = { status: 'error', error: validation.error ?? '插件验证失败' };
        this.logger.warn(`[PluginLoader] ${item.name} 验证失败: ${entry.runtime.error}`);
      } else {
        entry.runtime = { status: 'unloaded' };
      }

      entries.push(entry);
    }

    return entries;
  }

  private scanDirectoryPlugin(dirname: string, statusConfig: PluginStatusConfig): PluginEntry | null {
    const pluginDir = path.join(this.pluginPath, dirname);

    try {
      let packageJson: PluginPackageJson | undefined;
      const packageJsonPath = path.join(pluginDir, 'package.json');

      if (fs.existsSync(packageJsonPath)) {
        try {
          packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        } catch (error) {
          this.logger.warn(`无效的 package.json: ${dirname}`, error);
        }
      }

      let pluginJson: KakakePluginManifest | undefined = readPluginManifest(pluginDir);

      const manifestId = packageJson?.name || pluginJson?.name;
      const pluginId = this.isAllowedDir(dirname) ? dirname : (manifestId || dirname);
      const entryFile = this.findEntryFile(pluginDir, packageJson, pluginJson);
      const entryPath = entryFile ? path.join(pluginDir, entryFile) : undefined;
      const enable = !(
        statusConfig[pluginId] === false
        || (manifestId ? statusConfig[manifestId] === false : false)
      );

      const meta = mergePluginMetadata(dirname, pluginDir, packageJson, pluginJson);

      const entry: PluginEntry = {
        id: meta.id,
        fileId: dirname,
        name: meta.name,
        version: meta.version,
        description: meta.description,
        author: meta.author,
        pluginPath: pluginDir,
        entryPath,
        packageJson,
        pluginJson,
        enable,
        loaded: false,
        runtime: { status: 'unloaded' },
      };

      if (!entryPath) {
        entry.runtime = { status: 'error', error: `无有效入口: ${dirname}` };
      }

      return entry;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      return {
        id: dirname,
        fileId: dirname,
        pluginPath: pluginDir,
        enable: statusConfig[dirname] !== false,
        loaded: false,
        runtime: { status: 'error', error: msg },
      };
    }
  }

  private findEntryFile(
    pluginDir: string,
    packageJson?: PluginPackageJson,
    pluginJson?: KakakePluginManifest,
  ): string | null {
    const candidates = [
      pluginJson?.entry,
      packageJson?.main,
      'index.mjs',
      'index.js',
      'main.mjs',
      'main.js',
    ].filter(Boolean) as string[];
    for (const entry of candidates) {
      const p = path.join(pluginDir, entry);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return entry;
    }
    return null;
  }

  /**
   * 动态加载插件 ESM。
   * 使用 `?v=<mtimeMs>`（文件内容版本）而非 `?t=Date.now()`，
   * 同一文件未改时复用同一 URL，避免关开插件时 ESM 图线性堆积。
   * Node 仍无法真正驱逐已加载的 ESM；此策略只保证「同版本只占一份」。
   */
  async importModule(filePath: string): Promise<PluginModule> {
    const abs = path.resolve(filePath);
    const mtimeMs = Math.round(fs.statSync(abs).mtimeMs);
    const prev = this.loadedMetaByEntry.get(abs);
    const href = prev && prev.mtimeMs === mtimeMs
      ? prev.url
      : `${pathToFileURL(abs).href}?v=${mtimeMs}`;
    const mod = await import(href) as PluginModule;
    this.loadedMetaByEntry.set(abs, { url: href, mtimeMs });
    return mod;
  }

  async loadPluginModule(entry: PluginEntry): Promise<PluginModule | null> {
    if (!entry.entryPath) {
      entry.runtime = { status: 'error', error: '无入口路径' };
      return null;
    }

    try {
      const module = await this.importModule(entry.entryPath);
      if (!this.isValidPluginModule(module)) {
        entry.runtime = { status: 'error', error: '缺少 plugin_init' };
        return null;
      }
      return module;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'import 失败';
      entry.runtime = { status: 'error', error: msg };
      return null;
    }
  }

  isValidPluginModule(module: unknown): module is PluginModule {
    return !!module && typeof (module as PluginModule).plugin_init === 'function';
  }

  /** 文本启发式：入口是否像导出了 plugin_init（避免扫描期完整 import） */
  private looksLikePluginInitExport(source: string): boolean | 'unknown' {
    const s = source;
    if (
      /\bexport\s+(?:async\s+)?function\s+plugin_init\b/.test(s)
      || /\bexport\s*\{[^}]*\bplugin_init\b[^}]*\}/.test(s)
      || /\bexports\.plugin_init\s*=/.test(s)
      || /\bmodule\.exports\s*=\s*\{[^}]*\bplugin_init\b/.test(s)
      || /\bplugin_init\s*:\s*(?:async\s*)?(?:function|\()/.test(s)
    ) {
      return true;
    }
    // 明显没有 plugin_init 字样
    if (!/\bplugin_init\b/.test(s)) return false;
    // 有字样但形态不明（高度压缩/重命名导出等）→ 交给 import 兜底
    return 'unknown';
  }

  async validatePluginEntry(entryPath: string): Promise<{ valid: boolean; error?: string }> {
    try {
      if (!fs.existsSync(entryPath) || !fs.statSync(entryPath).isFile()) {
        return { valid: false, error: '入口文件不存在' };
      }
      // 启发式：读文件头+尾（打包入口的 export 常在末尾）。整文件未命中才可判定 false；
      // 大文件截断未命中则走 import 兜底，避免误报「缺少 plugin_init」。
      const st = fs.statSync(entryPath);
      const headSize = Math.min(512 * 1024, st.size);
      const tailSize = Math.min(128 * 1024, st.size);
      const fd = fs.openSync(entryPath, 'r');
      try {
        const headBuf = Buffer.alloc(headSize);
        const headN = fs.readSync(fd, headBuf, 0, headSize, 0);
        let text = headBuf.slice(0, headN).toString('utf-8');
        if (st.size > headSize) {
          const tailBuf = Buffer.alloc(tailSize);
          const tailPos = Math.max(0, st.size - tailSize);
          const tailN = fs.readSync(fd, tailBuf, 0, tailSize, tailPos);
          text += `\n${tailBuf.slice(0, tailN).toString('utf-8')}`;
        }
        const look = this.looksLikePluginInitExport(text);
        if (look === true) return { valid: true };
        // 已覆盖整文件且明确没有 → 直接失败；否则交给动态 import
        if (look === false && st.size <= headSize) {
          return { valid: false, error: '缺少 plugin_init' };
        }
      } finally {
        fs.closeSync(fd);
      }

      const module = await this.importModule(entryPath);
      if (this.isValidPluginModule(module)) return { valid: true };
      return { valid: false, error: '缺少 plugin_init' };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'import 失败';
      return { valid: false, error: msg };
    }
  }

  rescanPlugin(dirname: string): PluginEntry | null {
    return this.scanDirectoryPlugin(dirname, this.loadPluginStatusConfig());
  }

  findPluginDirById(pluginId: string): string | null {
    if (!fs.existsSync(this.pluginPath)) return null;

    const candidates = new Set([
      pluginId,
      resolveKakakePluginId(pluginId),
    ]);

    for (const item of fs.readdirSync(this.pluginPath, { withFileTypes: true })) {
      if (!item.isDirectory() || !this.isAllowedDir(item.name)) continue;
      const pkgPath = path.join(this.pluginPath, item.name, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (candidates.has(pkg.name)) return item.name;
        } catch { /* ignore */ }
      }
      const pluginJsonPath = path.join(this.pluginPath, item.name, 'plugin.json');
      if (fs.existsSync(pluginJsonPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8')) as KakakePluginManifest;
          if (manifest.name && candidates.has(manifest.name)) return item.name;
        } catch { /* ignore */ }
      }
      if (candidates.has(item.name)) return item.name;
    }
    return null;
  }

  /**
   * 清理插件目录相关缓存。
   * - CJS：删除 require.cache 中落在 pluginPath 下的条目
   * - ESM：Node 无法驱逐已 import 的模块图；此处仅清除 loadedMetaByEntry，
   *   以便下次按新 mtime 选择 URL（同 mtime 仍复用旧 URL，避免无意义堆积）
   */
  clearCache(pluginPath: string): void {
    try {
      const normalized = path.resolve(pluginPath);
      for (const id of Object.keys(require.cache)) {
        if (id.startsWith(normalized)) delete require.cache[id];
      }
      for (const abs of [...this.loadedMetaByEntry.keys()]) {
        if (abs === normalized || abs.startsWith(normalized + path.sep)) {
          this.loadedMetaByEntry.delete(abs);
        }
      }
    } catch (e) {
      this.logger.error('[PluginLoader] 清理缓存失败', e);
    }
  }
}
