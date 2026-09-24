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
import { isGfPluginDir, resolveGfPluginId } from './gf-plugin-id.js';
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

const ADAPTER_NAME = 'gf_plugin_manager';

/** 模拟模式下给官方插件的假 API 返回值，尽量贴近真实结构，避免插件 await 后读字段崩溃 */
function officialSimulatedResult(action: string, params: Record<string, unknown>): unknown {
  const a = String(action || '').toLowerCase();
  // 发消息类接口（/v2/groups/.../messages、/v2/users/.../messages、/channels/.../messages）
  if (a.includes('/messages') || (a.includes('message') && !a.startsWith('get'))) {
    return { id: `SIM${Date.now()}`, timestamp: new Date().toISOString(), msg_id: params.msg_id ?? '' };
  }
  return {};
}

/**
 * 取事件的“会话键”：同一会话内的消息必须按到达顺序处理。
 * 官方被动回复依赖 msg_id / msg_seq 的时序，并发处理同一会话的连发消息会答非所问。
 * 不同会话（群 / 私聊 / 频道）之间仍然并发，避免慢插件拖住全站。
 */
function eventConversationKey(event: Record<string, unknown>): string | null {
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  const group = text(event.group_openid) || text(event.group_id);
  if (group) return `group:${group}`;
  const channel = text(event.channel_id);
  if (channel) return `channel:${channel}`;
  const author = (event.author && typeof event.author === 'object')
    ? event.author as Record<string, unknown>
    : null;
  const user = text(event.openid)
    || text(author?.user_openid)
    || text(author?.member_openid)
    || text(author?.id);
  if (user) return `user:${user}`;
  const guild = text(event.guild_id);
  if (guild) return `guild:${guild}`;
  return null;
}

interface AccountRuntime {
  accountKey: string;
  pluginId: string;
  /** 该账号下的加载条目（pluginPath 指向 plugins_two） */
  entry: PluginEntry;
  router: PluginRouterRegistryImpl;
}

/**
 * QQ 官方机器人 GF 插件管理器（按账号多实例）
 * - 安装源：plugins/（按 GF- 前缀区分）
 * - 运行副本：plugins_two/<AppID>/
 * - 每个账号独立 plugin_init / 路由 / dataPath
 */
export class GfPluginManager {
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
  /** 串行化 sync / 总开关重载，避免并发 sync 用旧 targets 卸掉新实例 */
  private syncTail: Promise<void> = Promise.resolve();
  /** 会话键 → 该会话的派发链（同会话串行、跨会话并发） */
  private readonly conversationChains = new Map<string, Promise<void>>();

  constructor(
    private readonly logger: Logger,
    private readonly connectionManager: ConnectionManager,
    private readonly adminHost: string,
    private readonly adminPort: number,
    private readonly adminAuthRequired = false,
  ) {
    this.loader = new PluginLoader(PATHS.plugins, PATHS.gfPluginsStatus, logger, isGfPluginDir);
  }

  get isActive(): boolean {
    return this.enabled && this.runtimes.size > 0;
  }

  async open(): Promise<void> {
    if (this.enabled) return;
    this.enabled = true;
    this.logger.debug('[GfPluginManager] 打开 GF 插件管理器（按账号多实例）...');
    await this.scanAndLoadPlugins();
    // 启动时只留一行；一个插件都没有时完全不打扰控制台
    const summary = `[GfPluginManager] GF 插件 ${this.plugins.size} 个 · 运行实例 ${this.runtimes.size} 个`;
    if (this.plugins.size + this.runtimes.size > 0) this.logger.info(summary);
    else this.logger.debug(summary);
  }

  async close(): Promise<void> {
    if (!this.enabled) return;
    this.enabled = false;
    for (const key of [...this.runtimes.keys()]) {
      await this.unloadRuntime(key);
    }
    this.logger.info('[GfPluginManager] 已关闭');
  }

  bindEvents(): void {
    eventBus.on('qq_official/event', (payload) => {
      const p = payload as { connectionId?: string; eventType?: string; event?: Record<string, unknown> };
      if (!p.connectionId || !p.event) return;
      void this.onEvent(p.event, p.connectionId, p.eventType);
    });
    eventBus.on('qq_official/action_result', (payload) => {
      const p = payload as { connectionId?: string };
      if (!p.connectionId) return;
      const event = {
        post_type: 'action_result',
        action_result: payload,
        qq_official: true,
      } as Record<string, unknown>;
      void this.onEvent(event, p.connectionId, 'action_result');
    });
    eventBus.on('connection/ready', (payload) => {
      const p = payload as { connectionId?: string };
      if (!p.connectionId) return;
      if (pluginAccountService.ensureOfficialAccount(p.connectionId)) {
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
    if (!conn?.enable || (conn.type ?? 'onebot') !== 'qq_official') return;

    const accountKey = pluginAccountService.resolveAccountKey(conn);
    if (!accountKey) return;

    const enriched = { ...event, t: eventType ?? event.t, qq_official: true };
    const targets: AccountRuntime[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.accountKey !== accountKey) continue;
      if (!this.loader.isMasterEnabled(rt.pluginId)) continue;
      if (!connectionPluginService.isEnabled(connectionId, rt.pluginId, 'gf')) continue;
      targets.push(rt);
    }
    if (targets.length === 0) return;

    const ob11Mode = conn.mode === 'https' ? 'qq-official-https' : 'qq-official-ws';
    const dispatch = async (): Promise<void> => {
      await Promise.allSettled(
        targets.map((rt) => this.callPluginEventHandler(rt, enriched, connectionId, ob11Mode)),
      );
    };

    const key = eventConversationKey(enriched);
    if (!key) {
      await dispatch();
      return;
    }
    const prev = this.conversationChains.get(key) ?? Promise.resolve();
    const next = prev.then(dispatch, dispatch);
    this.conversationChains.set(key, next);
    try {
      await next;
    } catch (error) {
      // 保证链本身不残留 rejected 状态，后续同会话事件仍能继续派发
      this.logger.error(`[GfPluginManager] 事件派发失败 (${connectionId}):`, error);
    } finally {
      // 只有自己仍是最新一环时才摘掉，避免清掉后来者的链
      if (this.conversationChains.get(key) === next) this.conversationChains.delete(key);
    }
  }

  /**
   * 模拟派发：把一条官方事件发给该账号已加载的插件，用捕获版 actions.call 拦截输出，
   * 不触发真实官方 API 调用。供「模拟消息」功能调用。
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
    const simConnId = `sim:${rt.accountKey}`;
    const base = this.createEventContext(baseContext, simConnId, entry.id, rt.accountKey, 'qq-official-ws');
    const context: NapCatPluginContext = {
      ...base,
      actions: {
        call: async (action: string, params?: Record<string, unknown>) => {
          const p = (params ?? {}) as Record<string, unknown>;
          try { capture({ pluginId: rt.pluginId, action, params: p }); } catch { /* ignore */ }
          return officialSimulatedResult(action, p);
        },
      },
    };

    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(`[GfPluginManager] 模拟派发插件错误 ${entry.id}@${rt.accountKey}:`, error);
    }
  }

  private async callPluginEventHandler(
    rt: AccountRuntime,
    event: Record<string, unknown>,
    connectionId: string,
    ob11Mode: string,
  ): Promise<void> {
    const { entry } = rt;
    if (entry.runtime.status !== 'loaded' || !entry.runtime.module || !entry.runtime.context) return;

    const { module, context: baseContext } = entry.runtime;
    const context = this.createEventContext(baseContext, connectionId, entry.id, rt.accountKey, ob11Mode);

    try {
      if (typeof module.plugin_onevent === 'function') {
        await module.plugin_onevent(context, event);
      }
      if (typeof module.plugin_onmessage === 'function') {
        await module.plugin_onmessage(context, event);
      }
    } catch (error) {
      this.logger.error(
        `[GfPluginManager] 插件 ${entry.id}@${rt.accountKey} 事件错误 (${connectionId}):`,
        error,
      );
    }
  }

  private createEventContext(
    base: NapCatPluginContext,
    connectionId: string,
    pluginId: string,
    accountKey: string,
    ob11Mode: string,
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
        call: this.connectionManager.createQqOfficialActionCaller(adapterName, connectionId),
      },
      frameworkEnv: base.frameworkEnv
        ? { ...base.frameworkEnv, connectionId, ob11Mode }
        : undefined,
    };
  }

  private async scanAndLoadPlugins(): Promise<void> {
    const entries = await this.loader.scanPlugins();
    this.plugins.clear();
    for (const entry of entries) {
      this.plugins.set(entry.id, entry);
    }

    this.logger.debug(`[GfPluginManager] 扫描到 ${this.plugins.size} 个 GF 插件`);

    for (const entry of this.plugins.values()) {
      await this.syncPluginRuntime(entry.id);
    }
  }

  /** 应加载该插件的全部账号（缺 plugins_two 副本时由 prepareRuntimePaths 自动补齐） */
  listTargetAccountKeys(pluginId: string): string[] {
    if (!this.loader.isMasterEnabled(pluginId)) return [];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'qq_official') continue;
      if (!connectionPluginService.isEnabled(conn.id, pluginId, 'gf')) continue;
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
    const id = resolveGfPluginId(pluginId);
    const keys: string[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.pluginId === id) keys.push(rt.accountKey);
    }
    return keys;
  }

  isLoadedForAccount(pluginId: string, accountKey: string): boolean {
    return this.runtimes.has(pluginRuntimeKey(accountKey, resolveGfPluginId(pluginId)));
  }

  private runtimeKeysForPlugin(pluginId: string): string[] {
    const id = resolveGfPluginId(pluginId);
    return [...this.runtimes.keys()].filter((k) => k.endsWith(`::${id}`));
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
      this.logger.error(`[GfPluginManager] 准备运行副本失败 ${entry.id}@${accountKey}:`, e);
      return false;
    }
  }

  private findConnectionIdForAccount(accountKey: string): string | undefined {
    return this.resolveAccountConnection(accountKey).id;
  }

  /**
   * 该账号对应的连接信息。
   * ob11Mode 必须按连接真实模式给：官方 HTTPS 连接的事件来自 Webhook，
   * 一律写 'qq-official-ws' 会让插件拿到错误的环境标识。
   */
  private resolveAccountConnection(accountKey: string): { id?: string; ob11Mode: string } {
    for (const conn of configService.getConnections().connections) {
      if (!conn.enable || (conn.type ?? 'onebot') !== 'qq_official') continue;
      if (pluginAccountService.resolveAccountKey(conn) !== accountKey) continue;
      return {
        id: conn.id,
        ob11Mode: conn.mode === 'https' ? 'qq-official-https' : 'qq-official-ws',
      };
    }
    return { ob11Mode: 'qq-official-ws' };
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
      this.logger.error(`[GfPluginManager] 模块加载失败 ${pluginId}@${accountKey}`);
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
        `[GfPluginManager] 初始化: ${entry.id}${entry.version ? ` v${entry.version}` : ''} @${accountKey}`,
      );
      this.refreshCatalogLoadedFlag(entry.id);
      return true;
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : '初始化失败';
      router.clear();
      this.loader.clearCache(entry.pluginPath);
      entry.loaded = false;
      entry.runtime = { status: 'error', error: msg };
      this.logger.error(`[GfPluginManager] 初始化失败 ${entry.id}@${accountKey}:`, error);
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
          this.logger.error(`[GfPluginManager] 清理失败 ${pluginId}@${accountKey}:`, error);
        }
      }
    }

    router.clear();
    this.loader.clearCache(entry.pluginPath);
    entry.loaded = false;
    entry.runtime = { status: 'unloaded' };
    this.runtimes.delete(runtimeKey);
    this.logger.info(`[GfPluginManager] 已卸载: ${pluginId}@${accountKey}（运行实例 ${this.runtimes.size}）`);
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
    const pluginLogger = createPluginLogger(`${entry.id}@${accountKey}`, { category: 'gf_plugin' });

    const accountConn = this.resolveAccountConnection(accountKey);
    const connId = accountConn.id;
    const actions = {
      call: this.connectionManager.createQqOfficialActionCaller(
        `${ADAPTER_NAME}:${accountKey}:${entry.id}`,
        connId,
      ) as ActionCaller,
    };

    const getPluginExports = <T = PluginModule>(pluginId: string): T | undefined => {
      const prefer = this.runtimes.get(pluginRuntimeKey(accountKey, resolveGfPluginId(pluginId)));
      const rt = prefer ?? [...this.runtimes.values()].find((r) => r.pluginId === resolveGfPluginId(pluginId));
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
        ob11Mode: accountConn.ob11Mode,
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
    const id = resolveGfPluginId(pluginId);
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
    const id = entry?.id ?? resolveGfPluginId(pluginId);
    return this.runtimes.get(pluginRuntimeKey(accountKey, id))?.entry;
  }

  private resolvePluginEntry(pluginId: string): PluginEntry | undefined {
    const trimmed = String(pluginId || '').trim();
    if (!trimmed) return undefined;
    const resolved = resolveGfPluginId(trimmed);
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
        this.logger.info(`[GfPluginManager] 插件目录已移除: ${id}`);
      }
    }

    for (const fresh of scanned) {
      this.plugins.set(fresh.id, { ...fresh, loaded: false });
    }

    for (const id of this.plugins.keys()) {
      await this.syncPluginRuntime(id);
    }

    this.logger.info(`[GfPluginManager] 重新扫描完成，共 ${this.plugins.size} 个插件 / ${this.runtimes.size} 个实例`);
    return this.plugins.size;
  }

  async setConnectionPluginStatus(connectionId: string, pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveGfPluginId(pluginId);
    if (enable) {
      if (!this.loader.isMasterEnabled(resolvedId)) {
        throw new Error('总开关已关闭，无法在连接上启用或复制该插件');
      }
      const conn = configService.getConnection(connectionId);
      const accountKey = pluginAccountService.resolveAccountKey(conn);
      if (!accountKey) {
        throw new Error('AppID 未配置，无法启用插件');
      }
      pluginAccountService.ensureAccountRuntimeRoot(accountKey);
      pluginAccountService.copyPluginToAccount(resolvedId, accountKey);
    }
    connectionPluginService.setEnabled(connectionId, resolvedId, enable, 'gf');
    await this.syncPluginRuntime(resolvedId);
  }

  /** 导入 zip 后注册：默认打开总开关，不自动打开连接子开关 */
  async registerImportedPlugin(pluginId: string): Promise<boolean> {
    const dirname = this.loader.findPluginDirById(pluginId) ?? pluginId;
    const entry = this.loader.rescanPlugin(dirname);
    if (!entry?.entryPath) {
      this.logger.warn(`[GfPluginManager] 导入后无法扫描插件: ${pluginId}`);
      return false;
    }
    this.plugins.set(entry.id, entry);
    this.loader.setMasterEnabled(entry.id, true);
    await this.syncPluginRuntime(entry.id);
    return true;
  }

  async setMasterPluginStatus(pluginId: string, enable: boolean): Promise<void> {
    const resolvedId = resolveGfPluginId(pluginId);
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
    return this.loader.isMasterEnabled(resolveGfPluginId(pluginId));
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
      // 重载语义 = 吃进新代码：强制覆盖 plugins_two 运行副本再加载
      try {
        pluginAccountService.copyPluginToAccount(id, accountKey);
      } catch (e) {
        this.logger.warn(`[${this.constructor.name}] 覆盖运行副本失败 ${id}@${accountKey}:`, e);
      }
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
    connectionPluginService.removePluginEverywhere(entry.id, 'gf');
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
    const resolvedId = resolveGfPluginId(pluginId);
    const conn = configService.getConnection(connectionId);
    if (!conn) throw new Error('连接不存在');
    const accountKey = pluginAccountService.resolveAccountKey(conn);
    connectionPluginService.setEnabled(connectionId, resolvedId, false, 'gf');
    await this.syncPluginRuntime(resolvedId);
    if (accountKey) {
      pluginAccountService.removeRuntimePlugin(accountKey, resolvedId, cleanData);
    }
  }
}
