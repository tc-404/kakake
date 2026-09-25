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
import { PluginRouteMount } from './plugin-route.mount.js';
import { PluginRouterRegistryImpl } from './router-registry.js';
import { ensurePluginDataLink } from '../core/init-data.js';
import { connectionPluginService } from './connection-plugin.service.js';
import { pluginAccountService } from './plugin-account.service.js';
import { pluginRuntimeKey } from './plugin-account-http.js';
import { resolveKakakePluginId } from './plugin-id.js';
import { kakakeApp } from '../kakake-app.js';
import { getFrameworkVersion } from '../admin/agreement.service.js';
import type {
  PluginEntry,
  PluginModule,
  NapCatPluginContext,
  IPluginManager,
  KakakeCoreCompat,
  KakakeOneBotCompat,
} from './plugin.types.js';
import type express from 'express';

const ADAPTER_NAME = 'plugin_manager';

/** 模拟模式下给插件的假 action 返回值：尽量贴近真实结构，避免插件 await 后读字段崩溃 */
function simulatedActionResult(action: string): unknown {
  const a = String(action || '').toLowerCase();
  if (a.includes('send') && a.includes('msg')) {
    // send_group_msg / send_private_msg / send_msg 等
    return { message_id: Math.floor(Math.random() * 2_000_000_000) };
  }
  if (a.includes('forward')) {
    return { message_id: Math.floor(Math.random() * 2_000_000_000), forward_id: '' };
  }
  if (a === 'get_login_info') {
    return { user_id: 0, nickname: '模拟账号' };
  }
  // get_* 及其它：返回空对象，兼容多数插件的可选读取
  return {};
}

interface AccountRuntime {
  accountKey: string;
  pluginId: string;
  /** 该账号下的加载条目（pluginPath 指向 plugins_two） */
  entry: PluginEntry;
  router: PluginRouterRegistryImpl;
}

/**
 * 插件管理器（按账号多实例）
 * - 安装源：plugins/
 * - 运行副本：plugins_two/<QQ>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 */
export class PluginManager implements IPluginManager {
  config: Record<string, unknown> = {
    name: ADAPTER_NAME,
    messagePostFormat: 'array',
    reportSelfMessage: true,
    enable: true,
    debug: true,
  };

  readonly NapCatConfig = NapCatConfig;

  private readonly loader: PluginLoader;
  /** 安装目录扫描目录（未按账号加载的元数据） */
  private plugins = new Map<string, PluginEntry>();
  /** account::pluginId → 运行时 */
  private runtimes = new Map<string, AccountRuntime>();
  private readonly routeMount = new PluginRouteMount();
  private enabled = false;
  /** 串行化 sync / 总开关重载，避免并发 sync 用旧 targets 卸掉新实例 */
  private syncTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly connectionManager: ConnectionManager,
    private readonly adminHost: string,
    private readonly adminPort: number,
    private readonly adminAuthRequired = false,
  ) {
    this.loader = new PluginLoader(PATHS.plugins, PATHS.pluginsStatus, logger);
  }

  get isActive(): boolean {
    return this.enabled && this.runtimes.size > 0;
  }

  async open(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.logger.debug('[PluginManager] 打开插件管理器（按账号多实例）...');
    await this.scanAndLoadPlugins();
    // 启动时只留一行；一个插件都没有时完全不打扰控制台
    const summary = `[PluginManager] 插件 ${this.plugins.size} 个 · 运行实例 ${this.runtimes.size} 个`;
    if (this.plugins.size + this.runtimes.size > 0) this.logger.info(summary);
    else this.logger.debug(summary);
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    for (const key of [...this.runtimes.keys()]) {
      await this.unloadRuntime(key);
    }
    this.logger.info('[PluginManager] 已关闭');
  }

  async reload(): Promise<void> {
    await this.close();
    await this.open();
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
        this.logger.info(`[PluginManager] 插件目录已移除: ${id}`);
      }
    }

    for (const fresh of scanned) {
      this.plugins.set(fresh.id, { ...fresh, loaded: false });
    }

    for (const id of this.plugins.keys()) {
      await this.syncPluginRuntime(id);
    }

    if (typeof kakakeApp.expressApp?.use === 'function') {
      this.mountPluginRoutesIfReady();
    }

    this.logger.info(`[PluginManager] 重新扫描完成，共 ${this.plugins.size} 个插件 / ${this.runtimes.size} 个实例`);
    return this.plugins.size;
  }

  mountRoutes(app: express.Application): void {
    const registries = new Map<string, PluginRouterRegistryImpl>();
    for (const rt of this.runtimes.values()) {
      // 路由键：pluginId/a/accountKey → PluginRouteMount 会挂 /plugin/{key}/...
      registries.set(`${rt.pluginId}/a/${rt.accountKey}`, rt.router);
    }
    this.routeMount.remount(app, registries);
  }

  private mountPluginRoutesIfReady(): void {
    if (kakakeApp.expressApp) {
      this.mountRoutes(kakakeApp.expressApp);
    }
  }

  getRouteMount(): PluginRouteMount {
    return this.routeMount;
  }

  async onEvent(event: Record<string, unknown>, connectionId: string): Promise<void> {
    if (!this.enabled) return;

    const selfId = event.self_id;
    if (selfId !== undefined && selfId !== null && String(selfId).trim()) {
      const changed = pluginAccountService.lockOnebotAccount(connectionId, selfId as string | number);
      if (changed) void this.syncAllPluginRuntimes();
    }

    const conn = configService.getConnection(connectionId);
    if (!conn?.enable) return;
    const accountKey = pluginAccountService.resolveAccountKey(conn);
    if (!accountKey) return;

    const targets: AccountRuntime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.accountKey !== accountKey) continue;
      if (!this.loader.isMasterEnabled(rt.pluginId)) continue;
      if (!connectionPluginService.isEnabled(connectionId, rt.pluginId)) continue;
      targets.push(rt);
    }
    if (targets.length === 0) return;

    await Promise.allSettled(
      targets.map((rt) => this.callPluginEventHandler(rt, event, connectionId)),
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
      if (event.message_type && typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(
        `[PluginManager] 插件 ${entry.id}@${rt.accountKey} 事件错误 (${connectionId}):`,
        error,
      );
    }
  }

  /**
   * 模拟派发：不经真实连接，把构造好的事件直接投给「某账号下已加载的插件实例」，
   * 并用捕获版 actions.call 拦截插件的发消息 / 事件 API（不触发真实网络发送）。
   * 插件读写的 dataPath / config 仍为该账号真实目录；插件自身的第三方 fetch 不受影响。
   */
  async dispatchSimulated(
    accountKey: string,
    event: Record<string, unknown>,
    capture: (call: { pluginId: string; action: string; params: Record<string, unknown> }) => void,
  ): Promise<{ dispatched: number }> {
    const key = String(accountKey || '').trim();
    if (!key) return { dispatched: 0 };

    const targets: AccountRuntime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.accountKey !== key) continue;
      if (!this.loader.isMasterEnabled(rt.pluginId)) continue;
      targets.push(rt);
    }
    if (targets.length === 0) return { dispatched: 0 };

    await Promise.allSettled(
      targets.map((rt) => this.callSimulatedHandler(rt, event, capture)),
    );
    return { dispatched: targets.length };
  }

  private async callSimulatedHandler(
    rt: AccountRuntime,
    event: Record<string, unknown>,
    capture: (call: { pluginId: string; action: string; params: Record<string, unknown> }) => void,
  ): Promise<void> {
    const { entry } = rt;
    if (entry.runtime.status !== 'loaded' || !entry.runtime.module || !entry.runtime.context) return;

    const { module, context: baseContext } = entry.runtime;
    // 用虚拟 connectionId 造上下文，再把 actions.call 换成捕获版
    const simConnId = `sim:${rt.accountKey}`;
    const base = this.createEventContext(baseContext, simConnId, entry.id, rt.accountKey);
    const context: NapCatPluginContext = {
      ...base,
      actions: { call: this.createCaptureCaller(rt.pluginId, capture) },
    };

    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (event.message_type && typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(`[PluginManager] 模拟派发插件错误 ${entry.id}@${rt.accountKey}:`, error);
    }
  }

  /** 捕获版 action caller：记录调用并返回可信假结果，不触发真实网络发送 */
  private createCaptureCaller(
    pluginId: string,
    capture: (call: { pluginId: string; action: string; params: Record<string, unknown> }) => void,
  ): ActionCaller {
    return async (action, params) => {
      const p = (params ?? {}) as Record<string, unknown>;
      try {
        capture({ pluginId, action, params: p });
      } catch { /* 记录失败不应影响插件 */ }
      return simulatedActionResult(action);
    };
  }

  bindEvents(): void {
    eventBus.on('onebot/event', (payload) => {
      const p = payload as { connectionId?: string; event: Record<string, unknown> };
      if (!p.connectionId) return;
      void this.onEvent(p.event, p.connectionId);
    });
    eventBus.on('onebot/action_result', (payload) => {
      const p = payload as { connectionId?: string; adapter?: string; action?: string; ok?: boolean };
      if (!p.connectionId) return;
      const event = {
        post_type: 'action_result',
        action_result: payload,
      } as Record<string, unknown>;
      void this.onEvent(event, p.connectionId);
    });

    eventBus.on('connection/ready', (payload) => {
      const p = payload as { connectionId?: string };
      if (!p.connectionId) return;
      void this.onConnectionReady(p.connectionId);
    });
  }

  private async onConnectionReady(connectionId: string): Promise<void> {
    const conn = configService.getConnection(connectionId);
    if (!conn || (conn.type ?? 'onebot') !== 'onebot') return;

    try {
      const info = await this.connectionManager.createActionCaller(ADAPTER_NAME, connectionId)(
        'get_login_info',
        {},
      ) as { user_id?: number | string } | undefined;
      if (info?.user_id !== undefined) {
        pluginAccountService.lockOnebotAccount(connectionId, info.user_id);
      }
    } catch { /* 等 self_id */ }

    const fresh = configService.getConnection(connectionId);
    if (fresh?.botUin) {
      pluginAccountService.ensureAccountRuntimeRoot(fresh.botUin);
      void import('../connection/connection-avatar.store.js').then(async ({ fetchAndStoreOnebotQlogoAvatar }) => {
        const wrote = await fetchAndStoreOnebotQlogoAvatar(connectionId, fresh.botUin!);
        if (wrote) this.connectionManager.notifyStatus();
      }).catch(() => undefined);
    }
    await this.syncAllPluginRuntimes();
  }

  private async scanAndLoadPlugins(): Promise<void> {
    connectionPluginService.migrateFromGlobalIfNeeded();

    const entries = await this.loader.scanPlugins();
    this.plugins.clear();
    for (const entry of entries) {
      this.plugins.set(entry.id, entry);
    }

    this.logger.debug(`[PluginManager] 扫描到 ${this.plugins.size} 个插件`);

    for (const entry of this.plugins.values()) {
      await this.syncPluginRuntime(entry.id);
    }

    this.mountPluginRoutesIfReady();
  }

  /** 应加载该插件的全部账号（缺 plugins_two 副本时由 prepareRuntimePaths 自动补齐） */
  listTargetAccountKeys(pluginId: string): string[] {
    if (!this.loader.isMasterEnabled(pluginId)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'onebot') continue;
      if (!connectionPluginService.isEnabled(conn.id, pluginId, 'kakake')) continue;
      const key = pluginAccountService.resolveAccountKey(conn);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  }

  private runSerialized(fn: () => Promise<void>): Promise<void> {
    const run = this.syncTail.then(fn, fn);
    this.syncTail = run.then(() => undefined, () => undefined);
    return run;
  }

  getLoadedAccountKeys(pluginId: string): string[] {
    const id = resolveKakakePluginId(pluginId);
    const keys: string[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.pluginId === id) keys.push(rt.accountKey);
    }
    return keys;
  }

  isLoadedForAccount(pluginId: string, accountKey: string): boolean {
    return this.runtimes.has(pluginRuntimeKey(accountKey, resolveKakakePluginId(pluginId)));
  }

  private runtimeKeysForPlugin(pluginId: string): string[] {
    const id = resolveKakakePluginId(pluginId);
    return [...this.runtimes.keys()].filter((k) => k.endsWith(`::${id}`));
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
        call: this.connectionManager.createActionCaller(adapterName, connectionId),
      },
      frameworkEnv: base.frameworkEnv
        ? { ...base.frameworkEnv, connectionId }
        : undefined,
    };
  }

  private async syncPluginRuntime(pluginId: string): Promise<void> {
    return this.runSerialized(() => this.syncPluginRuntimeInner(pluginId));
  }

  private async syncPluginRuntimeInner(pluginId: string): Promise<void> {
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
    // enable 对齐总开关意图，勿用「是否已加载」冒充，否则未加载会被标成「已禁用」
    catalog.enable = this.loader.isMasterEnabled(pluginId);
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
      this.logger.error(`[PluginManager] 准备运行副本失败 ${entry.id}@${accountKey}:`, e);
      return false;
    }
  }

  private findConnectionIdForAccount(accountKey: string): string | undefined {
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'onebot') continue;
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
      this.logger.error(`[PluginManager] 模块加载失败 ${pluginId}@${accountKey}`);
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
        `[PluginManager] 初始化: ${entry.id}${entry.version ? ` v${entry.version}` : ''} @${accountKey}`,
      );
      this.refreshCatalogLoadedFlag(entry.id);
      this.mountPluginRoutesIfReady();
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '初始化失败';
      router.clear();
      this.loader.clearCache(entry.pluginPath);
      entry.loaded = false;
      entry.runtime = { status: 'error', error: msg };
      this.logger.error(`[PluginManager] 初始化失败 ${entry.id}@${accountKey}:`, error);
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
          this.logger.error(`[PluginManager] 清理失败 ${pluginId}@${accountKey}:`, error);
        }
      }
    }

    router.clear();
    this.loader.clearCache(entry.pluginPath);
    // 掐断 module/context 引用，避免 catalog 间接握住插件图
    entry.loaded = false;
    entry.runtime = { status: 'unloaded' };
    this.runtimes.delete(runtimeKey);
    this.logger.info(`[PluginManager] 已卸载: ${pluginId}@${accountKey}（运行实例 ${this.runtimes.size}）`);
    this.refreshCatalogLoadedFlag(pluginId);
    this.mountPluginRoutesIfReady();
  }

  private createPluginContext(
    entry: PluginEntry,
    accountKey: string,
    router: PluginRouterRegistryImpl,
  ): NapCatPluginContext {
    ensurePluginDataLink(entry.id, accountKey);

    const dataPath = pluginAccountService.pluginDataDir(entry.id, accountKey);
    const configPath = path.join(dataPath, 'config.json');
    const pluginLogger = createPluginLogger(`${entry.id}@${accountKey}`, {
      silentStdout: entry.pluginJson?.logSilentStdout === true,
    });

    const connId = this.findConnectionIdForAccount(accountKey);
    const actions = {
      call: this.connectionManager.createActionCaller(
        `${ADAPTER_NAME}:${accountKey}:${entry.id}`,
        connId,
      ) as ActionCaller,
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

    const getPluginExports = <T = PluginModule>(pluginId: string): T | undefined => {
      // 同账号优先，否则任意已加载
      const prefer = this.runtimes.get(pluginRuntimeKey(accountKey, resolveKakakePluginId(pluginId)));
      const rt = prefer ?? [...this.runtimes.values()].find((r) => r.pluginId === resolveKakakePluginId(pluginId));
      if (!rt || rt.entry.runtime.status !== 'loaded') return undefined;
      return rt.entry.runtime.module as T;
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
      adapterName: `${ADAPTER_NAME}:${accountKey}:${entry.id}`,
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
        ob11Mode: 'ws-server',
        connectionId: connId,
      },
    };
  }

  getPluginPath(): string { return PATHS.plugins; }
  getPluginConfig() { return this.loader.loadPluginStatusConfig(); }

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
    const id = resolveKakakePluginId(pluginId);
    if (accountKey) {
      return this.runtimes.get(pluginRuntimeKey(accountKey, id))?.router;
    }
    for (const rt of this.runtimes.values()) {
      if (rt.pluginId === id) return rt.router;
    }
    return undefined;
  }

  getRuntimeEntry(pluginId: string, accountKey: string): PluginEntry | undefined {
    return this.runtimes.get(pluginRuntimeKey(accountKey, resolveKakakePluginId(pluginId)))?.entry;
  }

  private resolvePluginEntry(pluginId: string): PluginEntry | undefined {
    return this.plugins.get(pluginId) ?? this.plugins.get(resolveKakakePluginId(pluginId));
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

  async registerImportedPlugin(pluginId: string): Promise<boolean> {
    const dirname = this.loader.findPluginDirById(pluginId) ?? pluginId;
    const entry = this.loader.rescanPlugin(dirname);
    if (!entry?.entryPath) {
      this.logger.warn(`[PluginManager] 导入后无法扫描插件: ${pluginId}`);
      return false;
    }
    this.plugins.set(entry.id, entry);
    this.loader.setMasterEnabled(entry.id, true);
    await this.syncPluginRuntime(entry.id);
    return true;
  }

  async setConnectionPluginStatus(connectionId: string, pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveKakakePluginId(pluginId);
    if (enable) {
      if (!this.loader.isMasterEnabled(resolvedId)) {
        throw new Error('总开关已关闭，无法在连接上启用或复制该插件');
      }
      const conn = configService.getConnection(connectionId);
      const accountKey = pluginAccountService.resolveAccountKey(conn);
      if (!accountKey) {
        throw new Error('账号尚未上报，请等待连接成功后再启用插件');
      }
      pluginAccountService.copyPluginToAccount(resolvedId, accountKey);
    }
    connectionPluginService.setEnabled(connectionId, resolvedId, enable, 'kakake');
    await this.syncPluginRuntime(resolvedId);
  }

  async setMasterPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveKakakePluginId(pluginId);
    this.loader.setMasterEnabled(resolvedId, enable);
    if (!enable) {
      await this.syncPluginRuntime(resolvedId);
      return;
    }
    // 总开：与连接子开关一致——覆盖复制 plugins_two 并强制重载，避免内存残留旧实例
    await this.runSerialized(async () => {
      const catalog = this.resolvePluginEntryOrScan(resolvedId);
      if (!catalog) return;
      const targets = this.listTargetAccountKeys(catalog.id);
      for (const rk of this.runtimeKeysForPlugin(catalog.id)) {
        await this.unloadRuntime(rk);
      }
      for (const accountKey of targets) {
        pluginAccountService.copyPluginToAccount(catalog.id, accountKey);
        await this.loadRuntime(catalog.id, accountKey);
      }
      this.refreshCatalogLoadedFlag(catalog.id);
    });
  }

  isMasterEnabled(pluginId: string): boolean {
    return this.loader.isMasterEnabled(resolveKakakePluginId(pluginId));
  }

  async syncAllPluginRuntimes(): Promise<void> {
    for (const entry of this.plugins.values()) {
      await this.syncPluginRuntime(entry.id);
    }
  }

  async setPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    await this.setMasterPluginStatus(pluginId, enable);
  }

  async loadPluginById(pluginId: string): Promise<boolean> {
    await this.syncPluginRuntime(resolveKakakePluginId(pluginId));
    return this.getLoadedAccountKeys(pluginId).length > 0;
  }

  async unregisterPlugin(pluginId: string): Promise<void> {
    for (const rk of this.runtimeKeysForPlugin(pluginId)) {
      await this.unloadRuntime(rk);
    }
  }

  async uninstallPlugin(pluginId: string, cleanData = false): Promise<void> {
    const entry = this.resolvePluginEntry(pluginId);
    if (!entry) throw new Error(`插件 ${pluginId} 不存在`);

    await this.unregisterPlugin(entry.id);
    this.plugins.delete(entry.id);
    this.loader.removeMasterStatus(entry.id);
    connectionPluginService.removePluginEverywhere(entry.id, 'kakake');
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
    const resolvedId = resolveKakakePluginId(pluginId);
    const conn = configService.getConnection(connectionId);
    if (!conn) throw new Error('连接不存在');
    const accountKey = pluginAccountService.resolveAccountKey(conn);
    connectionPluginService.setEnabled(connectionId, resolvedId, false, 'kakake');
    await this.syncPluginRuntime(resolvedId);
    if (accountKey) {
      pluginAccountService.removeRuntimePlugin(accountKey, resolvedId, cleanData);
    }
  }

  async reloadPlugin(pluginId: string): Promise<boolean> {
    const id = resolveKakakePluginId(pluginId);
    const accounts = this.getLoadedAccountKeys(id);
    for (const rk of this.runtimeKeysForPlugin(id)) {
      await this.unloadRuntime(rk);
    }
    const newEntry = this.loader.rescanPlugin(this.plugins.get(id)?.fileId || id);
    if (!newEntry) return false;
    this.plugins.set(newEntry.id, newEntry);
    for (const accountKey of accounts.length ? accounts : this.listTargetAccountKeys(id)) {
      await this.loadRuntime(id, accountKey);
    }
    return this.getLoadedAccountKeys(id).length > 0;
  }

  getPluginDataPath(pluginId: string, accountKey?: string | null): string {
    return pluginAccountService.pluginDataDir(pluginId, accountKey);
  }

  getPluginConfigPath(pluginId: string, accountKey?: string | null): string {
    return pluginAccountService.pluginConfigPath(pluginId, accountKey);
  }
}
