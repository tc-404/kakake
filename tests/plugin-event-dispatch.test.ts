import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../src/paths.js';
import { AccountPluginManagerBase, type AccountPluginManagerOptions } from '../src/plugin/account-plugin.manager.base.js';
import { PluginManager } from '../src/plugin/plugin.manager.js';
import { PLUGIN_EVENT_QUEUE_LIMIT } from '../src/plugin/plugin-manager-shared.js';
import { configService } from '../src/core/config.service.js';
import { connectionPluginService } from '../src/plugin/connection-plugin.service.js';
import { resetProxyRuntimeForTest } from '../src/proxy/runtime/facade.js';
import type { Logger } from '../src/core/logger.js';
import type { ConnectionManager } from '../src/connection/connection.manager.js';
import type { ConnectionConfig } from '../src/core/types.js';
import type { PluginModule } from '../src/plugin/plugin.types.js';

const ACCOUNT = '100001';
const PLUGIN_ID = 'p1';
const CONN_ID = 'c1';

const FAKE_CONN = {
  id: CONN_ID,
  enable: true,
  type: 'onebot',
  botUin: ACCOUNT,
} as unknown as ConnectionConfig;

type Patch = { target: Record<string, unknown>; key: string; original: unknown };

/** 记录 warn/error 的哑日志器 */
function recordingLogger(): { logger: Logger; warns: string[]; errors: string[] } {
  const warns: string[] = [];
  const errors: string[] = [];
  const fmt = (args: unknown[]) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
  const logger = {
    debug: () => {},
    info: () => {},
    log: () => {},
    warn: (...args: unknown[]) => { warns.push(fmt(args)); },
    error: (...args: unknown[]) => { errors.push(fmt(args)); },
    logDebug: () => {},
    logWarn: (...args: unknown[]) => { warns.push(fmt(args)); },
    logError: (...args: unknown[]) => { errors.push(fmt(args)); },
  };
  return { logger: logger as unknown as Logger, warns, errors };
}

function stubConnectionManager(): ConnectionManager {
  return {
    createActionCaller: () => async () => ({}),
    getOnebotEndpoint: () => null,
    getQqOfficialClient: () => null,
  } as unknown as ConnectionManager;
}

function baseOptions(overrides: Partial<AccountPluginManagerOptions>, tmp: string): AccountPluginManagerOptions {
  return {
    adapterName: 'test',
    logLabel: 'TestMgr',
    managerNoun: '测试管理器',
    pluginNoun: '测试插件',
    statusPath: path.join(tmp, 'plugins.json'),
    connType: 'onebot',
    // 基类 pluginKind 只收平台种类； isEnabled 已在测试里整只替换，取值不影响断言
    pluginKind: 'gf',
    eventName: 'test/event',
    actionResultName: 'test/action_result',
    enrichFlagKey: 'test_flag',
    ob11Mode: 'ws-server',
    accountNotReadyError: '账号未就绪',
    dirFilter: () => true,
    resolveId: (id) => id,
    ensureAccount: () => false,
    createActionCaller: () => async () => ({}),
    ...overrides,
  };
}

/** 注入一个已加载的假运行实例，绕开真实插件安装/加载 */
function injectRuntime(manager: AccountPluginManagerBase | PluginManager, module: PluginModule): void {
  const runtimes = (manager as unknown as {
    runtimes: Map<string, {
      accountKey: string; pluginId: string;
      entry: { id: string; fileId: string; pluginPath: string; enable: boolean; loaded: boolean; runtime: { status: string; module: PluginModule; context: object } };
      router: { clear: () => void };
    }>;
  }).runtimes;
  runtimes.set(`${ACCOUNT}::${PLUGIN_ID}`, {
    accountKey: ACCOUNT,
    pluginId: PLUGIN_ID,
    entry: {
      id: PLUGIN_ID, fileId: PLUGIN_ID, pluginPath: '/tmp/nonexistent', enable: true, loaded: true,
      runtime: { status: 'loaded', module, context: {} },
    },
    router: { clear() {} },
  });
}

/** 重定向 PATHS 与配置/子开关单例，测试结束全部还原 */
function isolate(tmp: string, paths: Record<string, string> = {}): { restore: () => void } {
  const patches: Patch[] = [];
  const patch = (target: object, key: string, value: unknown) => {
    const t = target as Record<string, unknown>;
    patches.push({ target: t, key, original: t[key] });
    t[key] = value;
  };
  const mutablePaths = PATHS as unknown as Record<string, string>;
  patch(mutablePaths, 'data', tmp);
  for (const [key, value] of Object.entries(paths)) patch(mutablePaths, key, value);
  patch(configService as unknown as object, 'getConnections', () => ({ connections: [FAKE_CONN] }));
  patch(configService as unknown as object, 'getConnection', (id: string) =>
    id === CONN_ID ? FAKE_CONN : undefined);
  patch(configService as unknown as object, 'getConnectionPlugins', () => ({ [CONN_ID]: { [PLUGIN_ID]: true } }));
  return {
    restore() {
      for (const p of patches.reverse()) p.target[p.key] = p.original;
      resetProxyRuntimeForTest();
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function makeBaseManager(
  logger: Logger,
  tmp: string,
  overrides: Partial<AccountPluginManagerOptions>,
): AccountPluginManagerBase {
  const manager = new AccountPluginManagerBase(
    logger, stubConnectionManager(), '127.0.0.1', 0, false, baseOptions(overrides, tmp),
  );
  (manager as unknown as { enabled: boolean }).enabled = true;
  return manager;
}

test('基类：handler 永不返回时派发按注入超时继续，后续事件不丢', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-dispatch-'));
  const { logger, warns } = recordingLogger();
  const manager = makeBaseManager(logger, tmp, {
    eventHandlerTimeoutMs: 60,
    conversationKey: (event) => (typeof event.conv === 'string' ? `conv:${event.conv}` : null),
  });
  const undo = isolate(tmp);
  try {
    let fastHandled = 0;
    injectRuntime(manager, {
      plugin_init: async () => {},
      plugin_onevent: () => new Promise<void>(() => {}), // 永不 resolve
    });
    const started = Date.now();
    await manager.onEvent({ conv: 'g1', post_type: 'message' }, CONN_ID);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 40 && elapsed < 2000, `应在超时后返回（实际 ${elapsed}ms）`);

    const warnText = warns.join('\n');
    assert.match(warnText, /p1@100001/);
    assert.match(warnText, /plugin_onevent/);

    // 会话串行链没有卡死：同会话后续事件照常派发
    (manager as unknown as { runtimes: Map<string, { entry: { runtime: { module: PluginModule } } }> })
      .runtimes.get(`${ACCOUNT}::${PLUGIN_ID}`)!.entry.runtime.module = {
      plugin_init: async () => {},
      plugin_onevent: async () => { fastHandled += 1; },
    } as unknown as PluginModule;
    await manager.onEvent({ conv: 'g1', post_type: 'message' }, CONN_ID);
    assert.equal(fastHandled, 1);
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('基类：超时后 handler 再 reject 不会变成 unhandledRejection', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-dispatch-'));
  const { logger } = recordingLogger();
  const manager = makeBaseManager(logger, tmp, { eventHandlerTimeoutMs: 60 });
  const undo = isolate(tmp);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    injectRuntime(manager, {
      plugin_init: async () => {},
      plugin_onevent: () => new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error('late-boom')), 150);
      }),
    });
    await manager.onEvent({ post_type: 'message' }, CONN_ID); // ~60ms 返回
    await sleep(300); // 等 150ms 的迟到 reject 落地
    assert.equal(unhandled.length, 0);
  } finally {
    process.off('unhandledRejection', onUnhandled);
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('基类：窗口内抛错仍走原错误日志，链不残留 rejected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-dispatch-'));
  const { logger, errors } = recordingLogger();
  const manager = makeBaseManager(logger, tmp, { eventHandlerTimeoutMs: 60 });
  const undo = isolate(tmp);
  try {
    let handled = 0;
    injectRuntime(manager, {
      plugin_init: async () => {},
      plugin_onevent: async () => { throw new Error('boom'); },
    });
    await manager.onEvent({ post_type: 'message' }, CONN_ID);
    assert.equal(errors.join('\n').includes('boom'), true);

    (manager as unknown as { runtimes: Map<string, { entry: { runtime: { module: PluginModule } } }> })
      .runtimes.get(`${ACCOUNT}::${PLUGIN_ID}`)!.entry.runtime.module = {
      plugin_init: async () => {},
      plugin_onevent: async () => { handled += 1; },
    } as unknown as PluginModule;
    await manager.onEvent({ post_type: 'message' }, CONN_ID);
    assert.equal(handled, 1);
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('基类：会话串行链在途事件超过上限时丢弃新事件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-dispatch-'));
  const { logger, warns } = recordingLogger();
  const manager = makeBaseManager(logger, tmp, {
    eventHandlerTimeoutMs: 60,
    conversationKey: () => 'conv:fixed',
  });
  const undo = isolate(tmp);
  try {
    let processed = 0;
    injectRuntime(manager, {
      plugin_init: async () => {},
      plugin_onevent: async () => {
        await sleep(5);
        processed += 1;
      },
    });

    const fired = PLUGIN_EVENT_QUEUE_LIMIT + 6;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < fired; i++) pending.push(manager.onEvent({ post_type: 'message' }, CONN_ID));
    await Promise.all(pending);

    assert.equal(processed, PLUGIN_EVENT_QUEUE_LIMIT, '只处理上限以内的事件');
    assert.match(warns.join('\n'), /在途事件已达上限/);
    const state = manager as unknown as { conversationChainDepth: Map<string, number>; conversationChains: Map<string, unknown> };
    assert.equal(state.conversationChainDepth.size, 0, '全部完成后背压计数清零');
    assert.equal(state.conversationChains.size, 0);
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PluginManager：handler 永不返回时 onEvent 按注入超时返回并继续', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-dispatch-'));
  const { logger, warns } = recordingLogger();
  const undo = isolate(tmp, { pluginsStatus: path.join(tmp, 'plugins.json') });
  try {
    const manager = new PluginManager(logger, stubConnectionManager(), '127.0.0.1', 0, false, 60);
    (manager as unknown as { enabled: boolean }).enabled = true;
    let fastHandled = 0;
    injectRuntime(manager, {
      plugin_init: async () => {},
      plugin_onevent: () => new Promise<void>(() => {}),
    });

    const started = Date.now();
    await manager.onEvent({ post_type: 'message' }, CONN_ID);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 40 && elapsed < 2000, `应在超时后返回（实际 ${elapsed}ms）`);
    assert.match(warns.join('\n'), /p1@100001/);
    assert.match(warns.join('\n'), /plugin_onevent/);

    (manager as unknown as { runtimes: Map<string, { entry: { runtime: { module: PluginModule } } }> })
      .runtimes.get(`${ACCOUNT}::${PLUGIN_ID}`)!.entry.runtime.module = {
      plugin_init: async () => {},
      plugin_onevent: async () => { fastHandled += 1; },
    } as unknown as PluginModule;
    await manager.onEvent({ post_type: 'message' }, CONN_ID);
    assert.equal(fastHandled, 1);
    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
