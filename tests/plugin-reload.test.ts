import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../src/paths.js';
import { PluginManager } from '../src/plugin/plugin.manager.js';
import { PluginLoader } from '../src/plugin/plugin.loader.js';
import { prepareRuntimeCopy } from '../src/plugin/plugin-manager-shared.js';
import { pluginAccountService } from '../src/plugin/plugin-account.service.js';
import { configService } from '../src/core/config.service.js';
import { connectionPluginService } from '../src/plugin/connection-plugin.service.js';
import { resetProxyRuntimeForTest } from '../src/proxy/runtime/facade.js';
import { Logger } from '../src/core/logger.js';
import type { ConnectionManager } from '../src/connection/connection.manager.js';
import type { ConnectionConfig } from '../src/core/types.js';

const PLUGIN_ID = 'kakake-plugin-reloadtest';
const ACCOUNT = '100001';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-reload-'));
}

function quietLogger(): Logger {
  return new Logger('[test] ', 'error');
}

/** 最小 kakake-plugin-* 插件：入口导出 marker（观察版本）与 plugin_init */
function writePlugin(pluginsRoot: string, marker: string): string {
  const dir = path.join(pluginsRoot, PLUGIN_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PLUGIN_ID, main: 'index.mjs' }));
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ name: PLUGIN_ID, entry: 'index.mjs', logSilentStdout: true }),
  );
  fs.writeFileSync(path.join(dir, 'index.mjs'), `export const marker = '${marker}';\nexport function plugin_init() {}\n`);
  return dir;
}

const FAKE_CONN = {
  id: 'conn-test',
  enable: true,
  type: 'onebot',
  botUin: ACCOUNT,
} as unknown as ConnectionConfig;

type Patch = { target: Record<string, unknown>; key: string; original: unknown };

/** 把 PATHS 与单例服务重定向到临时目录/假数据，测试结束全部还原 */
function isolate(paths: Record<string, string>): { restore: () => void } {
  const patches: Patch[] = [];
  const patch = (target: object, key: string, value: unknown) => {
    const t = target as Record<string, unknown>;
    patches.push({ target: t, key, original: t[key] });
    t[key] = value;
  };
  const mutablePaths = PATHS as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(paths)) patch(mutablePaths, key, value);
  patch(configService as unknown as object, 'getConnections', () => ({ connections: [FAKE_CONN] }));
  patch(configService as unknown as object, 'getConnection', (id: string) =>
    id === FAKE_CONN.id ? FAKE_CONN : undefined);
  patch(configService as unknown as object, 'getConnectionPlugins', () => ({
    [FAKE_CONN.id]: { [PLUGIN_ID]: true },
  }));
  patch(connectionPluginService as unknown as object, 'migrateFromGlobalIfNeeded', () => {});
  return {
    restore() {
      for (const p of patches.reverse()) p.target[p.key] = p.original;
      resetProxyRuntimeForTest();
    },
  };
}

function stubConnectionManager(): ConnectionManager {
  return {
    createActionCaller: () => async () => ({}),
    getOnebotEndpoint: () => null,
    getQqOfficialClient: () => null,
  } as unknown as ConnectionManager;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('prepareRuntimeCopy 在副本已存在时不刷新（reload 必须强制覆盖的原因）', () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const pluginsTwo = path.join(tmp, 'plugins_two');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    plugins: pluginsRoot, pluginsTwo, data,
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    const installDir = writePlugin(pluginsRoot, 'v1');
    pluginAccountService.copyPluginToAccount(PLUGIN_ID, ACCOUNT);
    const copyEntry = path.join(pluginsTwo, ACCOUNT, PLUGIN_ID, 'index.mjs');
    assert.equal(fs.readFileSync(copyEntry, 'utf-8').includes("marker = 'v1'"), true);

    writePlugin(pluginsRoot, 'v2');
    const loader = new PluginLoader(pluginsRoot, path.join(data, 'plugins.json'), quietLogger());
    const entry = loader.rescanPlugin(PLUGIN_ID)!;
    assert.equal(entry.entryPath != null, true);
    // 走 loadRuntime 同款准备路径：副本已存在 → 不重新复制，旧副本原地保留
    const prepared = prepareRuntimeCopy(
      entry, ACCOUNT, (fileId) => loader.rescanPlugin(fileId), 'Test', quietLogger(),
    );
    assert.equal(prepared, true);
    assert.equal(fs.readFileSync(copyEntry, 'utf-8').includes("marker = 'v2'"), false, '副本未被刷新');

    // reload 语义 = 强制覆盖：copyPluginToAccount 后副本内容才跟上安装目录
    pluginAccountService.copyPluginToAccount(PLUGIN_ID, ACCOUNT);
    assert.equal(fs.readFileSync(copyEntry, 'utf-8').includes("marker = 'v2'"), true);
    void installDir;
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reloadPlugin 后运行副本与已加载模块都吃到新代码', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const pluginsTwo = path.join(tmp, 'plugins_two');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    plugins: pluginsRoot, pluginsTwo, data, root: tmp, log: path.join(tmp, 'log'),
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    writePlugin(pluginsRoot, 'v1');
    const manager = new PluginManager(quietLogger(), stubConnectionManager(), '127.0.0.1', 0);
    await manager.open();

    const runtimeKey = `${ACCOUNT}::${PLUGIN_ID}`;
    const moduleOf = (): { marker?: string } => {
      const rt = (manager as unknown as { runtimes: Map<string, { entry: { runtime: { module?: { marker?: string } } } }> })
        .runtimes.get(runtimeKey);
      return rt?.entry.runtime.module ?? {};
    };
    const copyEntry = path.join(pluginsTwo, ACCOUNT, PLUGIN_ID, 'index.mjs');
    assert.equal(moduleOf().marker, 'v1', '首次加载 v1');
    assert.equal(fs.readFileSync(copyEntry, 'utf-8').includes("marker = 'v1'"), true);

    // 改安装目录源码后重载：副本 mtime 若不变会命中 ESM ?v= 旧 URL（回归点）
    writePlugin(pluginsRoot, 'v2');
    await sleep(25); // 保证两次复制的 mtime 落在不同毫秒
    assert.equal(await manager.reloadPlugin(PLUGIN_ID), true);
    assert.equal(fs.readFileSync(copyEntry, 'utf-8').includes("marker = 'v2'"), true, '运行副本已刷新');
    assert.equal(moduleOf().marker, 'v2', '已加载模块更新为 v2');
    assert.equal(manager.getLoadedAccountKeys(PLUGIN_ID).includes(ACCOUNT), true);

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
