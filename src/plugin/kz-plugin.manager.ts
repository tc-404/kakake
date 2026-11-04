import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ActionCaller } from '../connection/onebot.types.js';
import { PATHS } from '../paths.js';
import { NapCatConfig } from './napcat-config.js';
import { PluginLoader } from './plugin.loader.js';
import { PluginRouterRegistryImpl } from './router-registry.js';
import { createPluginLogger } from '../core/plugin-logger.js';
import { ensureExtensionDataLink } from '../core/init-data.js';
import { getFrameworkVersion } from '../admin/agreement.service.js';
import { createTailSerializer } from './plugin-manager-shared.js';
import { isKzPluginDir, resolveKzPluginId } from './kz-plugin-id.js';
import type {
  PluginEntry,
  PluginModule,
  NapCatPluginContext,
  IPluginManager,
  KakakeCoreCompat,
} from './plugin.types.js';

const ADAPTER_NAME = 'kz_plugin_manager';

/**
 * 扩展插件不绑账号，但各管理层（HTTP 账号解析 / Cookie / 清单里的 loadedAccounts）
 * 都按 accountKey 工作，这里给一个固定占位键保持形状一致。
 * 运行副本与数据目录都不经过它——扩展插件没有账号层。
 */
export const KZ_LOCAL_ACCOUNT = 'local';

/**
 * 「扩展」插件管理器（kz-plugin-*）。
 *
 * 与其它五套管理器的根本差别：**扩展插件不属于任何连接**。
 * - 不订阅事件、不收上报、没有连接级子开关，只有插件列表上的总开关；
 * - 不做 plugins_two 运行副本（没有账号可隔离），直接跑 plugins/<id>；
 * - 数据目录直接是 data/<pluginId>（不是 data/<账号>/<pluginId>）；
 * - 配置 Schema / WebUI 后台与其它插件完全一致（ctx.router + 配置钩子照旧）。
 *
 * 因此这里没有账号同步、没有事件派发，只有「扫描 → 按总开关装载 / 卸载」。
 */
export class KzPluginManager implements IPluginManager {
  config: Record<string, unknown> = {
    name: ADAPTER_NAME,
    messagePostFormat: 'array',
    reportSelfMessage: false,
    enable: true,
    debug: true,
  };

  readonly NapCatConfig = NapCatConfig;

  private readonly loader: PluginLoader;
  private readonly plugins = new Map<string, PluginEntry>();
  private readonly routers = new Map<string, PluginRouterRegistryImpl>();
  private enabled = false;
  /** 串行化装载 / 卸载，避免并发 rescan 用旧快照互相覆盖 */
  private readonly tail = createTailSerializer();

  constructor(
    private readonly logger: Logger,
    private readonly adminHost: string,
    private readonly adminPort: number,
    private readonly adminAuthRequired = false,
  ) {
    this.loader = new PluginLoader(PATHS.plugins, PATHS.kzPluginsStatus, logger, isKzPluginDir);
  }

  get isActive(): boolean {
    return this.enabled && this.plugins.size > 0;
  }

  async open(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.logger.debug('[KzPluginManager] 打开扩展插件管理器...');
    await this.scanAndLoad();
    if (this.plugins.size > 0) {
      this.logger.info(`[KzPluginManager] 扩展插件 ${this.plugins.size} 个 · 已加载 ${this.getLoadedPlugins().length} 个`);
    }
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    for (const entry of this.plugins.values()) {
      await this.unloadEntry(entry);
    }
    this.logger.info('[KzPluginManager] 已关闭');
  }

  async reload(): Promise<void> {
    await this.close();
    await this.open();
  }

  /** 扩展插件不接事件：保留空实现，让 main.ts 的初始化流程与其它管理器一致 */
  bindEvents(): void {
    /* 无事件可绑 */
  }

  private async scanAndLoad(): Promise<void> {
    const entries = await this.loader.scanPlugins();
    this.plugins.clear();
    for (const entry of entries) this.plugins.set(entry.id, entry);
    for (const id of [...this.plugins.keys()]) {
      await this.syncPlugin(id);
    }
  }

  async rescanPlugins(): Promise<number> {
    if (!this.enabled) {
      await this.open();
      return this.plugins.size;
    }

    let count = 0;
    await this.tail.run(async () => {
      const scanned = await this.loader.scanAllPlugins();
      const next = new Map(scanned.map((e) => [e.id, e]));

      // 目录被删：卸掉实例并遗忘
      for (const [id, old] of [...this.plugins]) {
        if (next.has(id)) continue;
        await this.unloadEntry(old);
        this.plugins.delete(id);
        this.logger.info(`[KzPluginManager] 插件目录已移除: ${id}`);
      }

      for (const [id, fresh] of next) {
        const old = this.plugins.get(id);
        // 已装载的实例不因一次刷新被重建（重载请用 reloadPlugin）
        if (old?.loaded) continue;
        this.plugins.set(id, fresh);
      }

      for (const id of [...this.plugins.keys()]) {
        await this.syncPluginInner(id);
      }

      count = this.plugins.size;
      this.logger.info(`[KzPluginManager] 重新扫描完成，共 ${count} 个扩展插件`);
    });
    return count;
  }

  /** 按总开关对齐一个插件的运行状态 */
  private async syncPlugin(pluginId: string): Promise<void> {
    return this.tail.run(() => this.syncPluginInner(pluginId));
  }

  /** 已在串行链内时调用（rescan 持锁期间不能再进锁，否则自锁） */
  private async syncPluginInner(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    const masterOn = this.loader.isMasterEnabled(entry.id);
    entry.enable = masterOn;

    if (!masterOn) {
      if (entry.loaded) await this.unloadEntry(entry);
      return;
    }
    if (entry.loaded) return;
    await this.loadEntry(entry);
  }

  private async loadEntry(entry: PluginEntry): Promise<boolean> {
    if (entry.loaded) return true;
    if (!entry.entryPath) {
      entry.runtime = { status: 'error', error: '无入口文件' };
      return false;
    }

    const module = await this.loader.loadPluginModule(entry);
    if (!module) {
      this.logger.error(`[KzPluginManager] 模块加载失败 ${entry.id}`);
      return false;
    }

    const router = new PluginRouterRegistryImpl(entry.id, entry.pluginPath);
    const context = this.createPluginContext(entry, router);

    try {
      await module.plugin_init(context);
      entry.loaded = true;
      entry.runtime = { status: 'loaded', module, context };
      this.routers.set(entry.id, router);
      this.logger.info(
        `[KzPluginManager] 初始化: ${entry.id}${entry.version ? ` v${entry.version}` : ''}（扩展）`,
      );
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '初始化失败';
      router.clear();
      this.loader.clearCache(entry.pluginPath);
      entry.loaded = false;
      entry.runtime = { status: 'error', error: msg };
      this.logger.error(`[KzPluginManager] 初始化失败 ${entry.id}:`, error);
      return false;
    }
  }

  private async unloadEntry(entry: PluginEntry): Promise<void> {
    if (entry.runtime.status === 'loaded') {
      const { module, context } = entry.runtime;
      if (module && context && typeof module.plugin_cleanup === 'function') {
        try {
          await module.plugin_cleanup(context);
        } catch (error) {
          this.logger.error(`[KzPluginManager] 清理失败 ${entry.id}:`, error);
        }
      }
    }
    this.routers.get(entry.id)?.clear();
    this.routers.delete(entry.id);
    this.loader.clearCache(entry.pluginPath);
    entry.loaded = false;
    entry.runtime = { status: 'unloaded' };
  }

  private createPluginContext(
    entry: PluginEntry,
    router: PluginRouterRegistryImpl,
  ): NapCatPluginContext {
    // 扩展插件的数据目录没有账号层：data/<pluginId>
    const dataPath = path.join(PATHS.data, entry.id);
    fs.mkdirSync(dataPath, { recursive: true });
    ensureExtensionDataLink(entry.id);

    const configPath = path.join(dataPath, 'config.json');
    const pluginLogger = createPluginLogger(`${entry.id}@extension`, {
      silentStdout: entry.pluginJson?.logSilentStdout === true,
    });

    const coreCompat: KakakeCoreCompat = {
      context: {
        pathWrapper: {
          configPath: path.join(PATHS.root, 'config'),
          pluginPath: PATHS.plugins,
          dataPath: PATHS.data,
        },
      },
    };

    // 没有连接就没有可调用的 action；给出能直接定位原因的报错，别让插件等一个永远不来的回包
    const actions = {
      call: (async (action: string) => {
        throw new Error(
          `扩展插件「${entry.id}」不绑定任何连接，无法调用 actions.call（${action}）；`
          + '扩展插件不发送消息、不走上报，请改用自身的 WebUI / 本地能力。',
        );
      }) as ActionCaller,
    };

    const getPluginExports = <T = PluginModule>(pluginId: string): T | undefined => {
      const hit = this.getPluginInfo(pluginId);
      if (!hit || hit.runtime.status !== 'loaded') return undefined;
      return hit.runtime.module as T;
    };

    return {
      core: coreCompat,
      oneBot: {},
      actions,
      pluginName: entry.id,
      pluginPath: entry.pluginPath,
      dataPath,
      configPath,
      NapCatConfig,
      adapterName: `${ADAPTER_NAME}:${entry.id}`,
      pluginManager: this,
      logger: pluginLogger,
      router,
      getPluginExports,
      frameworkEnv: {
        frameworkId: 'kakake',
        frameworkVersion: getFrameworkVersion(),
        projectRoot: PATHS.root,
        adminHost: this.adminHost,
        adminPort: this.adminPort,
        adminAuthRequired: this.adminAuthRequired,
        // 不绑连接：ob11Mode 置 none，协议字段留空
        ob11Mode: 'none',
      },
    };
  }

  getPluginPath(): string { return PATHS.plugins; }
  getPluginConfig() { return this.loader.loadPluginStatusConfig(); }

  getAllPlugins(): PluginEntry[] {
    return [...this.plugins.values()];
  }

  getLoadedPlugins(): PluginEntry[] {
    return this.getAllPlugins().filter((p) => p.loaded);
  }

  getPluginInfo(pluginId: string): PluginEntry | undefined {
    return this.plugins.get(pluginId) ?? this.plugins.get(resolveKzPluginId(pluginId));
  }

  /**
   * 扩展插件只有一个实例，accountKey 只是调用方（HTTP 层）的形状占位，这里刻意忽略。
   */
  getPluginRouter(pluginId: string, _accountKey?: string): PluginRouterRegistryImpl | undefined {
    return this.routers.get(resolveKzPluginId(pluginId)) ?? this.routers.get(pluginId);
  }

  getRuntimeEntry(pluginId: string, _accountKey?: string): PluginEntry | undefined {
    const hit = this.getPluginInfo(pluginId);
    return hit?.runtime.status === 'loaded' ? hit : undefined;
  }

  /** 扩展插件的「账号」恒为一个占位值；未加载时为空数组 */
  getLoadedAccountKeys(pluginId: string): string[] {
    const hit = this.getPluginInfo(pluginId);
    return hit?.loaded ? [KZ_LOCAL_ACCOUNT] : [];
  }

  isLoadedForAccount(pluginId: string, _accountKey: string): boolean {
    return this.getPluginInfo(pluginId)?.loaded === true;
  }

  isMasterEnabled(pluginId: string): boolean {
    return this.loader.isMasterEnabled(resolveKzPluginId(pluginId));
  }

  async setMasterPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    const id = resolveKzPluginId(pluginId);
    this.loader.setMasterEnabled(id, enable);
    const entry = this.plugins.get(id) ?? this.adoptEntry(id);
    if (entry) await this.syncPlugin(entry.id);
  }

  /** 与 setMasterPluginStatus 同义：扩展插件只有总开关这一个开关 */
  async setPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    await this.setMasterPluginStatus(pluginId, enable);
  }

  /**
   * 扩展插件不挂连接：连接面板上的子开关对它没有意义。
   * 明确抛错，而不是静默成功让用户以为已经生效。
   */
  async setConnectionPluginStatus(_connectionId: string, pluginId: string, _enable: boolean): Promise<void> {
    throw new Error(`扩展插件 ${pluginId} 不绑定连接，请在插件列表用总开关启停`);
  }

  /** 同上：扩展插件没有 plugins_two 运行副本可删 */
  async removeConnectionRuntimePlugin(_connectionId: string, pluginId: string, _cleanData = false): Promise<void> {
    throw new Error(`扩展插件 ${pluginId} 不绑定连接，没有连接级运行副本可删除`);
  }

  async loadPluginById(pluginId: string): Promise<boolean> {
    const id = resolveKzPluginId(pluginId);
    const entry = this.plugins.get(id) ?? this.adoptEntry(id);
    if (!entry) return false;
    await this.syncPlugin(entry.id);
    return entry.loaded;
  }

  /** 总开关打开 / 导入后从磁盘补登记（不经过一次全量扫描） */
  private adoptEntry(pluginId: string): PluginEntry | null {
    const entry = this.loader.rescanPlugin(pluginId);
    if (!entry) return null;
    this.plugins.set(entry.id, entry);
    return entry;
  }

  async registerImportedPlugin(pluginId: string): Promise<boolean> {
    const id = resolveKzPluginId(pluginId);
    const entry = this.loader.rescanPlugin(id);
    if (!entry?.entryPath) {
      this.logger.warn(`[KzPluginManager] 导入后无法扫描插件: ${pluginId}`);
      return false;
    }
    this.plugins.set(entry.id, entry);
    this.loader.setMasterEnabled(entry.id, true);
    await this.syncPlugin(entry.id);
    return entry.loaded;
  }

  async reloadPlugin(pluginId: string): Promise<boolean> {
    const id = resolveKzPluginId(pluginId);
    const old = this.plugins.get(id);
    if (!old) return false;
    await this.unloadEntry(old);

    const fresh = this.loader.rescanPlugin(old.fileId || id);
    if (!fresh) return false;
    this.plugins.set(fresh.id, fresh);
    await this.syncPlugin(fresh.id);
    return fresh.loaded;
  }

  async syncAllPluginRuntimes(): Promise<void> {
    for (const id of [...this.plugins.keys()]) {
      await this.syncPlugin(id);
    }
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    const entry = this.getPluginInfo(pluginId);
    if (!entry) return;
    await this.unloadEntry(entry);
  }

  async uninstallPlugin(pluginId: string, cleanData = false): Promise<void> {
    const entry = this.getPluginInfo(pluginId);
    if (!entry) throw new Error(`插件 ${pluginId} 不存在`);

    await this.unloadEntry(entry);
    this.plugins.delete(entry.id);
    this.loader.removeMasterStatus(entry.id);

    const installDir = path.join(PATHS.plugins, entry.id);
    if (fs.existsSync(installDir)) fs.rmSync(installDir, { recursive: true, force: true });

    if (cleanData) {
      const dataDir = path.join(PATHS.data, entry.id);
      if (fs.existsSync(dataDir)) fs.rmSync(dataDir, { recursive: true, force: true });
    }

    // config/plugins/<id> 联接一并摘掉，避免指向已删除的数据目录
    const link = path.join(PATHS.root, 'config', 'plugins', entry.id);
    try {
      const st = fs.lstatSync(link);
      if (st.isSymbolicLink() || st.isDirectory()) fs.rmSync(link, { recursive: true, force: true });
    } catch { /* 不存在 */ }
  }

  getPluginDataPath(pluginId: string): string {
    return path.join(PATHS.data, resolveKzPluginId(pluginId));
  }

  getPluginConfigPath(pluginId: string): string {
    return path.join(this.getPluginDataPath(pluginId), 'config.json');
  }
}
