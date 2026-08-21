import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../core/logger.js';
import type { ActionCaller } from '../connection/onebot.types.js';
import type { ConnectionManager } from '../connection/connection.manager.js';
import { PATHS } from '../paths.js';
import { configService } from '../core/config.service.js';
import { eventBus } from '../event/event-bus.js';
import { NapCatConfig } from './napcat-config.js';
import { PluginLoader } from './plugin.loader.js';
import { createPluginLogger } from '../core/plugin-logger.js';
import { connectionPluginService } from './connection-plugin.service.js';
import { pluginAccountService } from './plugin-account.service.js';
import { pluginRuntimeKey } from './plugin-account-http.js';
import { isWxPluginDir, resolveWxPluginId } from './wx-plugin-id.js';
import { ensurePluginDataLink } from '../core/init-data.js';
import { PluginRouterRegistryImpl } from './router-registry.js';
import { getFrameworkVersion } from '../admin/agreement.service.js';
import type {
  PluginEntry,
  PluginModule,
  NapCatPluginContext,
  KakakeCoreCompat,
  KakakeOneBotCompat,
} from './plugin.types.js';

const ADAPTER_NAME = 'wx_plugin_manager';

interface AccountRuntime {
  accountKey: string;
  pluginId: string;
  /** 该账号下的加载条目（pluginPath 指向 plugins_two） */
  entry: PluginEntry;
  router: PluginRouterRegistryImpl;
}

/**
 * 微信机器人插件管理器（按账号多实例）
 * - 安装源：plugins/（按 WX- 前缀区分）
 * - 运行副本：plugins_two/<微信账号>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 */
export class WxPluginManager {
  config: Record<string, unknown> = {
    name: ADAPTER_NAME,
    enable: true,
    debug: true,
  };

  readonly NapCatConfig = NapCatConfig;

  private readonly loader: PluginLoader;
  /** 安装目录扫描目录（未按账号加载的元数据） */
  private plugins = new Map<string, PluginEntry>();
  /** account::pluginId → 运行时 */
  private runtimes = new Map<string, AccountRuntime>();
  private enabled = false;

  constructor(
    private readonly logger: Logger,
    private readonly connectionManager: ConnectionManager,
    private readonly adminHost: string,
    private readonly adminPort: number,
    private readonly adminAuthRequired = false,
  ) {
    this.loader = new PluginLoader(PATHS.plugins, PATHS.wxPluginsStatus, logger, isWxPluginDir);
  }

  get isActive(): boolean {
    return this.enabled && this.runtimes.size > 0;
  }

  async open(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.logger.info('[WxPluginManager] 打开 微信插件管理器（按账号多实例）...');
    await this.scanAndLoadPlugins();
    this.logger.info(`[WxPluginManager] 运行实例 ${this.runtimes.size} 个`);
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    for (const key of [...this.runtimes.keys()]) {
      await this.unloadRuntime(key);
    }
    this.logger.info('[WxPluginManager] 已关闭');
  }

  bindEvents(): void {
    eventBus.on('weixin_bot/event', (payload) => {
      const p = payload as { connectionId?: string; eventType?: string; event?: Record<string, unknown> };
      if (!p.connectionId || !p.event) return;
      void this.onEvent(p.event, p.connectionId, p.eventType);
    });
    eventBus.on('weixin_bot/action_result', (payload) => {
      const p = payload as { connectionId?: string };
      if (!p.connectionId) return;
      const event = {
        post_type: 'action_result',
        action_result: payload,
        weixin_bot: true,
      } as Record<string, unknown>;
      void this.onEvent(event, p.connectionId, 'action_result');
    });
    eventBus.on('connection/ready', (payload) => {
      const p = payload as { connectionId?: string };
      if (!p.connectionId) return;
      if (pluginAccountService.ensureWeixinAccount(p.connectionId)) {
        void this.syncAllPluginRuntimes();
      }
    });
  }

  async onEvent(
    event: Record<string, unknown>,
    connectionId: string,
    eventType?: string,
  ): Promise<void> {
    if (!this.enabled) return;
    const conn = configService.getConnection(connectionId);
    if (!conn?.enable || (conn.type ?? 'onebot') !== 'weixin_bot') return;

    const accountKey = pluginAccountService.resolveAccountKey(conn);
    if (!accountKey) return;

    const enriched = { ...event, t: eventType ?? event.t, weixin_bot: true };
    const targets: AccountRuntime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.accountKey !== accountKey) continue;
      if (!this.loader.isMasterEnabled(rt.pluginId)) continue;
      if (!connectionPluginService.isEnabled(connectionId, rt.pluginId, 'wx')) continue;
      targets.push(rt);
    }
    if (targets.length === 0) return;

    await Promise.allSettled(
      targets.map((rt) => this.callPluginEventHandler(rt, enriched, connectionId)),
    );
  }

  private async callPluginEventHandler(
    rt: AccountRuntime,
    event: Record<string, unknown>,
    connectionId: string,
  ): Promise<void> {
    const { entry } = rt;
    if (entry.runtime.status !== 'loaded' || !entry.runtime.module || !entry.runtime.context) return;

    const { module, context: baseContext } = entry.runtime;
    const context = this.createEventContext(baseContext, connectionId, entry.id, rt.accountKey);

    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(
        `[WxPluginManager] 插件 ${entry.id}@${rt.accountKey} 事件错误 (${connectionId}):`,
        error,
      );
    }
  }

  private createEventContext(
    base: NapCatPluginContext,
    connectionId: string,
    pluginId: string,
    accountKey: string,
  ): NapCatPluginContext {
    const adapterName = `${ADAPTER_NAME}:${connectionId}:${pluginId}`;
    const dataPath = pluginAccountService.pluginDataDir(pluginId, accountKey);
    const configPath = path.join(dataPath, 'config.json');
    return {
      ...base,
      connectionId,
      adapterName,
      dataPath,
      configPath,
      actions: {
        call: this.connectionManager.createWeixinBotActionCaller(adapterName, connectionId),
      },
      frameworkEnv: base.frameworkEnv
        ? { ...base.frameworkEnv, connectionId, ob11Mode: 'weixin-ilink' }
        : undefined,
    };
  }

  private async scanAndLoadPlugins(): Promise<void> {
    const entries = await this.loader.scanPlugins();
    this.plugins.clear();
    for (const entry of entries) {
      this.plugins.set(entry.id, entry);
    }

    this.logger.info(`[WxPluginManager] 扫描到 ${this.plugins.size} 个 微信插件`);

    for (const entry of this.plugins.values()) {
      await this.syncPluginRuntime(entry.id);
    }
  }

  /** 应加载该插件的全部账号（启用的 weixin_bot 连接 + 插件子开关 + 运行副本） */
  listTargetAccountKeys(pluginId: string): string[] {
    if (!this.loader.isMasterEnabled(pluginId)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'weixin_bot') continue;
      if (!connectionPluginService.isEnabled(conn.id, pluginId, 'wx')) continue;
      const key = pluginAccountService.resolveAccountKey(conn);
      if (!key || seen.has(key)) continue;
      if (!pluginAccountService.hasRuntimeCopy(key, pluginId)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }

  getLoadedAccountKeys(pluginId: string): string[] {
    const id = resolveWxPluginId(pluginId);
    const keys: string[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.pluginId === id) keys.push(rt.accountKey);
    }
    return keys;
  }

  isLoadedForAccount(pluginId: string, accountKey: string): boolean {
    return this.runtimes.has(pluginRuntimeKey(accountKey, resolveWxPluginId(pluginId)));
  }

  private runtimeKeysForPlugin(pluginId: string): string[] {
    const id = resolveWxPluginId(pluginId);
    return [...this.runtimes.keys()].filter((k) => k.endsWith(`::${id}`));
  }

  private async syncPluginRuntime(pluginId: string): Promise<void> {
    const catalog = this.resolvePluginEntryOrScan(pluginId);
    if (!catalog) return;

    const targets = new Set(this.listTargetAccountKeys(catalog.id));
    // 卸载不再需要的账号实例
    for (const rk of this.runtimeKeysForPlugin(catalog.id)) {
      const rt = this.runtimes.get(rk);
      if (!rt) continue;
      if (!targets.has(rt.accountKey)) {
        await this.unloadRuntime(rk);
      }
    }
    // 加载缺失实例
    for (const accountKey of targets) {
      const rk = pluginRuntimeKey(accountKey, catalog.id);
      if (this.runtimes.has(rk)) continue;
      await this.loadRuntime(catalog.id, accountKey);
    }

    this.refreshCatalogLoadedFlag(catalog.id);
  }

  private refreshCatalogLoadedFlag(pluginId: string): void {
    const catalog = this.plugins.get(pluginId);
    if (!catalog) return;
    const keys = this.getLoadedAccountKeys(pluginId);
    catalog.loaded = keys.length > 0;
    catalog.enable = keys.length > 0;
    if (keys.length === 0) {
      catalog.runtime = { status: 'unloaded' };
    } else {
      const rt = this.runtimes.get(pluginRuntimeKey(keys[0]!, pluginId));
      if (rt) {
        catalog.runtime = rt.entry.runtime;
        catalog.pluginPath = rt.entry.pluginPath;
      }
    }
  }

  private cloneCatalogEntry(pluginId: string): PluginEntry | null {
    const installMeta = this.loader.rescanPlugin(
      this.plugins.get(pluginId)?.fileId || pluginId,
    );
    if (!installMeta) return null;
    return { ...installMeta, loaded: false, runtime: { status: 'unloaded' } };
  }

  private prepareRuntimePaths(entry: PluginEntry, accountKey: string): boolean {
    try {
      if (!pluginAccountService.hasRuntimeCopy(accountKey, entry.id)) {
        pluginAccountService.copyPluginToAccount(entry.id, accountKey);
      }
      const runtimeDir = pluginAccountService.runtimePluginDir(accountKey, entry.id);
      const installMeta = this.loader.rescanPlugin(entry.fileId || entry.id);
      if (!installMeta?.entryPath) return false;

      const rel = path.relative(installMeta.pluginPath, installMeta.entryPath);
      entry.pluginPath = runtimeDir;
      entry.entryPath = path.join(runtimeDir, rel);
      if (!fs.existsSync(entry.entryPath)) {
        const baseName = path.basename(installMeta.entryPath);
        const candidates = [
          path.join(runtimeDir, baseName),
          path.join(runtimeDir, 'index.js'),
          path.join(runtimeDir, 'index.mjs'),
          path.join(runtimeDir, 'index.cjs'),
          path.join(runtimeDir, 'main.js'),
        ];
        const found = candidates.find((p) => fs.existsSync(p));
        if (!found) return false;
        entry.entryPath = found;
      }
      return true;
    } catch (e) {
      this.logger.error(`[WxPluginManager] 准备运行副本失败 ${entry.id}@${accountKey}:`, e);
      return false;
    }
  }

  private findConnectionIdForAccount(accountKey: string): string | undefined {
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'weixin_bot') continue;
      if (pluginAccountService.resolveAccountKey(conn) === accountKey) return conn.id;
    }
    return undefined;
  }

  private async loadRuntime(pluginId: string, accountKey: string): Promise<boolean> {
    const rk = pluginRuntimeKey(accountKey, pluginId);
    if (this.runtimes.has(rk)) return true;

    const entry = this.cloneCatalogEntry(pluginId);
    if (!entry || entry.runtime.status === 'error') return false;
    if (!this.prepareRuntimePaths(entry, accountKey)) {
      entry.runtime = { status: 'error', error: '无法准备账号运行副本' };
      return false;
    }

    const module = await this.loader.loadPluginModule(entry);
    if (!module) {
      this.logger.error(`[WxPluginManager] 模块加载失败 ${pluginId}@${accountKey}`);
      return false;
    }

    const router = new PluginRouterRegistryImpl(entry.id, entry.pluginPath);
    const context = this.createPluginContext(entry, accountKey, router);

    try {
      await module.plugin_init(context);
      entry.loaded = true;
      entry.runtime = { status: 'loaded', module, context };
      this.runtimes.set(rk, { accountKey, pluginId: entry.id, entry, router });
      this.logger.info(
        `[WxPluginManager] 初始化: ${entry.id}${entry.version ? ` v${entry.version}` : ''} @${accountKey}`,
      );
      this.refreshCatalogLoadedFlag(entry.id);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '初始化失败';
      router.clear();
      this.loader.clearCache(entry.pluginPath);
      entry.loaded = false;
      entry.runtime = { status: 'error', error: msg };
      this.logger.error(`[WxPluginManager] 初始化失败 ${entry.id}@${accountKey}:`, error);
      return false;
    }
  }

  private async unloadRuntime(runtimeKey: string): Promise<void> {
    const rt = this.runtimes.get(runtimeKey);
    if (!rt) return;

    const { entry, router, accountKey, pluginId } = rt;
    if (entry.runtime.status === 'loaded') {
      const { module, context } = entry.runtime;
      if (module && context && typeof module.plugin_cleanup === 'function') {
        try {
          await module.plugin_cleanup(context);
        } catch (error) {
          this.logger.error(`[WxPluginManager] 清理失败 ${pluginId}@${accountKey}:`, error);
        }
      }
    }

    router.clear();
    this.loader.clearCache(entry.pluginPath);
    entry.loaded = false;
    entry.runtime = { status: 'unloaded' };
    this.runtimes.delete(runtimeKey);
    this.logger.info(`[WxPluginManager] 已卸载: ${pluginId}@${accountKey}（运行实例 ${this.runtimes.size}）`);
    this.refreshCatalogLoadedFlag(pluginId);
  }

  private createPluginContext(
    entry: PluginEntry,
    accountKey: string,
    router: PluginRouterRegistryImpl,
  ): NapCatPluginContext {
    ensurePluginDataLink(entry.id, accountKey);

    const dataPath = pluginAccountService.pluginDataDir(entry.id, accountKey);
    const configPath = path.join(dataPath, 'config.json');
    const pluginLogger = createPluginLogger(`${entry.id}@${accountKey}`);

    const connId = this.findConnectionIdForAccount(accountKey);
    const actions = {
      call: this.connectionManager.createWeixinBotActionCaller(
        `${ADAPTER_NAME}:${accountKey}:${entry.id}`,
        connId,
      ) as ActionCaller,
    };

    const getPluginExports = <T = PluginModule>(pluginId: string): T | undefined => {
      const prefer = this.runtimes.get(pluginRuntimeKey(accountKey, resolveWxPluginId(pluginId)));
      const rt = prefer ?? [...this.runtimes.values()].find((r) => r.pluginId === resolveWxPluginId(pluginId));
      if (!rt || rt.entry.runtime.status !== 'loaded') return undefined;
      return rt.entry.runtime.module as T;
    };

    const coreCompat: KakakeCoreCompat = {
      context: {
        pathWrapper: {
          configPath: path.join(PATHS.root, 'config'),
          pluginPath: PATHS.plugins,
          dataPath: PATHS.data,
        },
      },
    };

    const oneBotCompat: KakakeOneBotCompat = {};

    return {
      core: coreCompat,
      oneBot: oneBotCompat,
      actions,
      pluginName: entry.id,
      pluginPath: entry.pluginPath,
      dataPath,
      configPath,
      NapCatConfig,
      adapterName: `${ADAPTER_NAME}:${accountKey}:${entry.id}`,
      pluginManager: this as unknown as import('./plugin.types.js').IPluginManager,
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
        ob11Mode: 'weixin-ilink',
        connectionId: connId,
      },
    };
  }

  getAllPlugins(): PluginEntry[] {
    return [...this.plugins.values()].map((p) => {
      this.refreshCatalogLoadedFlag(p.id);
      return p;
    });
  }

  getLoadedPlugins(): PluginEntry[] {
    return this.getAllPlugins().filter((p) => p.loaded);
  }

  getPluginInfo(pluginId: string): PluginEntry | undefined {
    const entry = this.resolvePluginEntry(pluginId);
    if (entry) this.refreshCatalogLoadedFlag(entry.id);
    return entry;
  }

  /** @param accountKey 指定账号实例；缺省返回任一已加载实例的路由（列表用） */
  getPluginRouter(pluginId: string, accountKey?: string) {
    const id = resolveWxPluginId(pluginId);
    if (accountKey) {
      return this.runtimes.get(pluginRuntimeKey(accountKey, id))?.router;
    }
    for (const rt of this.runtimes.values()) {
      if (rt.pluginId === id) return rt.router;
    }
    // 兼容未规范化 id 的查找
    const entry = this.resolvePluginEntry(pluginId);
    if (entry && entry.id !== id) {
      if (accountKey) {
        return this.runtimes.get(pluginRuntimeKey(accountKey, entry.id))?.router;
      }
      for (const rt of this.runtimes.values()) {
        if (rt.pluginId === entry.id) return rt.router;
      }
    }
    return undefined;
  }

  getRuntimeEntry(pluginId: string, accountKey: string): PluginEntry | undefined {
    const entry = this.resolvePluginEntry(pluginId);
    const id = entry?.id ?? resolveWxPluginId(pluginId);
    return this.runtimes.get(pluginRuntimeKey(accountKey, id))?.entry;
  }

  private resolvePluginEntry(pluginId: string): PluginEntry | undefined {
    const trimmed = String(pluginId || '').trim();
    if (!trimmed) return undefined;
    const resolved = resolveWxPluginId(trimmed);
    const direct = this.plugins.get(trimmed) ?? this.plugins.get(resolved);
    if (direct) return direct;
    const lower = trimmed.toLowerCase();
    const resolvedLower = resolved.toLowerCase();
    for (const entry of this.plugins.values()) {
      if (entry.id.toLowerCase() === lower || entry.id.toLowerCase() === resolvedLower) return entry;
      if (String(entry.fileId || '').toLowerCase() === lower) return entry;
      if (String(entry.fileId || '').toLowerCase() === resolvedLower) return entry;
      const pkg = entry.packageJson;
      if (pkg?.plugin === trimmed || pkg?.name === trimmed) return entry;
      if (String(pkg?.plugin || '').toLowerCase() === lower) return entry;
      if (String(pkg?.name || '').toLowerCase() === lower) return entry;
    }
    return undefined;
  }

  private resolvePluginEntryOrScan(pluginId: string): PluginEntry | undefined {
    const existing = this.resolvePluginEntry(pluginId);
    if (existing) return existing;
    const dirname = this.loader.findPluginDirById(pluginId);
    if (!dirname) return undefined;
    const newEntry = this.loader.rescanPlugin(dirname);
    if (!newEntry) return undefined;
    this.plugins.set(newEntry.id, newEntry);
    return newEntry;
  }

  async rescanPlugins(): Promise<number> {
    if (!this.enabled) {
      await this.open();
      return this.plugins.size;
    }

    const scanned = await this.loader.scanAllPlugins();
    const scannedMap = new Map(scanned.map((entry) => [entry.id, entry]));

    for (const [id] of Array.from(this.plugins.entries())) {
      if (!scannedMap.has(id)) {
        for (const rk of this.runtimeKeysForPlugin(id)) {
          await this.unloadRuntime(rk);
        }
        this.plugins.delete(id);
        this.logger.info(`[WxPluginManager] 插件目录已移除: ${id}`);
      }
    }

    for (const fresh of scanned) {
      this.plugins.set(fresh.id, { ...fresh, loaded: false });
    }

    for (const id of this.plugins.keys()) {
      await this.syncPluginRuntime(id);
    }

    this.logger.info(`[WxPluginManager] 重新扫描完成，共 ${this.plugins.size} 个插件 / ${this.runtimes.size} 个实例`);
    return this.plugins.size;
  }

  async setConnectionPluginStatus(connectionId: string, pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveWxPluginId(pluginId);
    if (enable) {
      if (!this.loader.isMasterEnabled(resolvedId)) {
        throw new Error('总开关已关闭，无法在连接上启用或复制该插件');
      }
      const conn = configService.getConnection(connectionId);
      const accountKey = pluginAccountService.resolveAccountKey(conn);
      if (!accountKey) {
        throw new Error('微信账号未配置，请先扫码登录');
      }
      pluginAccountService.ensureAccountRuntimeRoot(accountKey);
      pluginAccountService.copyPluginToAccount(resolvedId, accountKey);
    }
    connectionPluginService.setEnabled(connectionId, resolvedId, enable, 'wx');
    await this.syncPluginRuntime(resolvedId);
  }

  /** 导入 zip 后注册：默认打开总开关，不自动打开连接子开关 */
  async registerImportedPlugin(pluginId: string): Promise<boolean> {
    const dirname = this.loader.findPluginDirById(pluginId) ?? pluginId;
    const entry = this.loader.rescanPlugin(dirname);
    if (!entry?.entryPath) {
      this.logger.warn(`[WxPluginManager] 导入后无法扫描插件: ${pluginId}`);
      return false;
    }
    this.plugins.set(entry.id, entry);
    this.loader.setMasterEnabled(entry.id, true);
    await this.syncPluginRuntime(entry.id);
    return true;
  }

  async setMasterPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveWxPluginId(pluginId);
    this.loader.setMasterEnabled(resolvedId, enable);
    await this.syncPluginRuntime(resolvedId);
  }

  isMasterEnabled(pluginId: string): boolean {
    return this.loader.isMasterEnabled(resolveWxPluginId(pluginId));
  }

  async syncAllPluginRuntimes(): Promise<void> {
    for (const entry of this.plugins.values()) {
      await this.syncPluginRuntime(entry.id);
    }
  }

  async reloadPlugin(pluginId: string): Promise<boolean> {
    const entry = this.resolvePluginEntry(pluginId);
    if (!entry) return false;

    const id = entry.id;
    const accounts = this.getLoadedAccountKeys(id);
    for (const rk of this.runtimeKeysForPlugin(id)) {
      await this.unloadRuntime(rk);
    }
    const newEntry = this.loader.rescanPlugin(entry.fileId || id);
    if (!newEntry) return false;
    this.plugins.set(newEntry.id, newEntry);
    for (const accountKey of accounts.length ? accounts : this.listTargetAccountKeys(id)) {
      await this.loadRuntime(id, accountKey);
    }
    return this.getLoadedAccountKeys(id).length > 0;
  }

  async uninstallPlugin(pluginId: string, cleanData = false): Promise<void> {
    const entry = this.resolvePluginEntry(pluginId);
    if (!entry) throw new Error(`插件 ${pluginId} 不存在`);

    for (const rk of this.runtimeKeysForPlugin(entry.id)) {
      await this.unloadRuntime(rk);
    }
    this.plugins.delete(entry.id);
    this.loader.removeMasterStatus(entry.id);
    connectionPluginService.removePluginEverywhere(entry.id, 'wx');
    pluginAccountService.removePluginEverywhere(entry.id, cleanData);

    const installPath = pluginAccountService.installPluginDir(entry.id);
    if (fs.existsSync(installPath)) {
      fs.rmSync(installPath, { recursive: true, force: true });
    }
  }

  /** 仅移除某连接账号下的运行副本，不删 plugins/ 安装目录 */
  async removeConnectionRuntimePlugin(
    connectionId: string,
    pluginId: string,
    cleanData = false,
  ): Promise<void> {
    const resolvedId = resolveWxPluginId(pluginId);
    const conn = configService.getConnection(connectionId);
    if (!conn) throw new Error('连接不存在');
    const accountKey = pluginAccountService.resolveAccountKey(conn);
    connectionPluginService.setEnabled(connectionId, resolvedId, false, 'wx');
    await this.syncPluginRuntime(resolvedId);
    if (accountKey) {
      pluginAccountService.removeRuntimePlugin(accountKey, resolvedId, cleanData);
    }
  }
}
