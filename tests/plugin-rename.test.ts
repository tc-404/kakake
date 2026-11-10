import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PATHS } from '../src/paths.js';
import { PluginManager } from '../src/plugin/plugin.manager.js';
import { KzPluginManager } from '../src/plugin/kz-plugin.manager.js';
import { configService } from '../src/core/config.service.js';
import { connectionPluginService } from '../src/plugin/connection-plugin.service.js';
import { updatePluginMeta, readPluginMeta } from '../src/plugin/plugin-rename.service.js';
import { buildPluginDirName, validatePluginDirName } from '../src/plugin/plugin-rename.js';
import { toKakakePluginDirName } from '../src/plugin/plugin-id.js';
import { resetProxyRuntimeForTest } from '../src/proxy/runtime/facade.js';
import { writeJsonAtomic } from '../src/storage/atomic-file.js';
import { Logger } from '../src/core/logger.js';
import type { ConnectionManager } from '../src/connection/connection.manager.js';

const ACCOUNT = '100001';
const OLD_ID = 'kakake-plugin-renametest';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kakake-rename-'));
}

function quietLogger(): Logger {
  return new Logger('[test] ', 'error');
}

type Patch = { target: Record<string, unknown>; key: string; original: unknown };

function isolate(paths: Record<string, string>): { restore: () => void } {
  const patches: Patch[] = [];
  const patch = (target: object, key: string, value: unknown) => {
    const t = target as Record<string, unknown>;
    patches.push({ target: t, key, original: t[key] });
    t[key] = value;
  };
  const mutablePaths = PATHS as unknown as Record<string, string>;
  for (const [key, value] of Object.entries(paths)) patch(mutablePaths, key, value);
  patch(configService as unknown as object, 'getConnections', () => ({ connections: [] }));
  patch(configService as unknown as object, 'getConnection', () => undefined);
  patch(configService as unknown as object, 'getConnectionPlugins', () => ({}));
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

function writePlugin(pluginsRoot: string, id: string, meta: Record<string, unknown>): string {
  const dir = path.join(pluginsRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: id,
    plugin: '旧名字',
    main: 'index.mjs',
    version: '1.0.0',
    author: 'old-author',
    description: 'desc',
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name: id,
    displayName: '旧名字',
    entry: 'index.mjs',
    logSilentStdout: true,
    version: '1.0.0',
    author: 'old-author',
    icon: 'icon.png',
    ...meta,
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'index.mjs'), 'export function plugin_init() {}\n');
  return dir;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
}

test('目录名规范化：缺前缀补回原类型前缀', () => {
  assert.equal(buildPluginDirName('kakake', 'foo'), 'kakake-plugin-foo');
  assert.equal(buildPluginDirName('tg', '我的插件'), 'TG-plugin-我的插件');
  assert.equal(buildPluginDirName('tg', 'tg-plugin-x'), 'TG-plugin-x');
  assert.equal(buildPluginDirName('sssx', 'bar'), 'sssx-plugin-bar');
  assert.equal(buildPluginDirName('kz', 'baz'), 'kz-plugin-baz');
  assert.equal(buildPluginDirName('gf', 'qux'), 'GF-plugin-qux');
  assert.equal(buildPluginDirName('wx', 'quux'), 'WX-plugin-quux');
  assert.equal(buildPluginDirName('ss', 'corge'), 'ss-plugin-corge');
  assert.equal(
    buildPluginDirName('kakake', buildPluginDirName('kakake', 'foo')),
    buildPluginDirName('kakake', 'foo'),
  );
});

test('状态键归一化：其它类型的前缀不会被改成 kakake-', () => {
  assert.equal(toKakakePluginDirName('sssx-plugin-x'), 'sssx-plugin-x');
  assert.equal(toKakakePluginDirName('GF-plugin-x'), 'GF-plugin-x');
  assert.equal(toKakakePluginDirName('WX-plugin-x'), 'WX-plugin-x');
  assert.equal(toKakakePluginDirName('kz-plugin-x'), 'kz-plugin-x');
  assert.equal(toKakakePluginDirName('TG-plugin-x'), 'TG-plugin-x');
  assert.equal(toKakakePluginDirName('napcat-plugin-x'), 'kakake-plugin-x');
});

test('目录名校验：非法字符、保留名、超长、跨类型', () => {
  assert.equal(validatePluginDirName('kakake', '').ok, false);
  assert.equal(validatePluginDirName('kakake', '   ').ok, false);
  assert.equal(validatePluginDirName('kakake', 'a/b').ok, false);
  assert.equal(validatePluginDirName('kakake', 'a:b').ok, false);
  assert.equal(validatePluginDirName('kakake', 'a..b').ok, false);
  assert.equal(validatePluginDirName('kakake', 'tail.').ok, false);
  assert.equal(validatePluginDirName('kakake', 'con').ok, false);
  assert.equal(validatePluginDirName('kakake', 'LPT9').ok, false);
  assert.equal(validatePluginDirName('kakake', 'a'.repeat(101)).ok, false);

  const crossKind = validatePluginDirName('tg', 'kz-plugin-x');
  assert.equal(crossKind.ok, false);
  if (!crossKind.ok) assert.equal(crossKind.code, 'KIND_MISMATCH');

  const crossedSs = validatePluginDirName('ss', 'sssx-plugin-x');
  assert.equal(crossedSs.ok, false);

  const good = validatePluginDirName('tg', '我的插件');
  assert.equal(good.ok, true);
  if (good.ok) assert.equal(good.dirName, 'TG-plugin-我的插件');
});

test('改名：目录、双清单、状态键、运行副本、数据目录全部联动', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const pluginsTwo = path.join(tmp, 'plugins_two');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    root: tmp,
    plugins: pluginsRoot,
    pluginsTwo,
    data,
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    writePlugin(pluginsRoot, OLD_ID, {});
    writeJsonAtomic(path.join(data, 'plugins.json'), { [OLD_ID]: false });

    const copyDir = path.join(pluginsTwo, ACCOUNT, OLD_ID);
    fs.mkdirSync(copyDir, { recursive: true });
    fs.writeFileSync(path.join(copyDir, 'index.mjs'), 'export function plugin_init() {}\n');

    const dataDir = path.join(data, ACCOUNT, OLD_ID);
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{}');

    const manager = new PluginManager(quietLogger(), stubConnectionManager(), '127.0.0.1', 0);
    await manager.open();

    const metaBefore = readPluginMeta(OLD_ID, manager);
    assert.equal(metaBefore?.name, OLD_ID);
    assert.equal(metaBefore?.displayName, '旧名字');
    assert.equal(metaBefore?.version, '1.0.0');
    assert.equal(metaBefore?.author, 'old-author');

    const result = await updatePluginMeta(
      OLD_ID,
      { name: 'renamed', displayName: '新昵称', version: '2.0.0', author: 'new-author' },
      'kakake',
      manager,
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const newId = result.pluginId;
    assert.equal(newId, 'kakake-plugin-renamed');
    assert.equal(result.renamed, true);

    assert.equal(fs.existsSync(path.join(pluginsRoot, OLD_ID)), false);
    assert.equal(fs.existsSync(path.join(pluginsRoot, newId)), true);

    const pkg = readJson(path.join(pluginsRoot, newId, 'package.json'));
    assert.equal(pkg.name, newId);
    assert.equal(pkg.plugin, '新昵称');
    assert.equal(pkg.version, '2.0.0');
    assert.equal(pkg.author, 'new-author');
    assert.equal(pkg.description, 'desc');

    const manifest = readJson(path.join(pluginsRoot, newId, 'plugin.json'));
    assert.equal(manifest.name, newId);
    assert.equal(manifest.displayName, '新昵称');
    assert.equal(manifest.version, '2.0.0');
    assert.equal(manifest.author, 'new-author');
    assert.equal(manifest.icon, 'icon.png');

    const status = readJson(path.join(data, 'plugins.json'));
    assert.equal(status[newId], false);
    assert.equal(OLD_ID in status, false);

    assert.equal(fs.existsSync(path.join(pluginsTwo, ACCOUNT, OLD_ID)), false);
    assert.equal(fs.existsSync(path.join(pluginsTwo, ACCOUNT, newId, 'index.mjs')), true);
    assert.equal(fs.existsSync(path.join(data, ACCOUNT, OLD_ID)), false);
    assert.equal(fs.existsSync(path.join(data, ACCOUNT, newId, 'config.json')), true);

    assert.equal(manager.getPluginInfo(newId) != null, true);
    assert.equal(manager.isMasterEnabled(newId), false);

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('只改标识名时显示名保持不变', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    root: tmp,
    plugins: pluginsRoot,
    pluginsTwo: path.join(tmp, 'plugins_two'),
    data,
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    writePlugin(pluginsRoot, OLD_ID, {});
    writeJsonAtomic(path.join(data, 'plugins.json'), { [OLD_ID]: false });

    const manager = new PluginManager(quietLogger(), stubConnectionManager(), '127.0.0.1', 0);
    await manager.open();

    const result = await updatePluginMeta(OLD_ID, { name: 'renamed2' }, 'kakake', manager);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const pkg = readJson(path.join(pluginsRoot, result.pluginId, 'package.json'));
    const manifest = readJson(path.join(pluginsRoot, result.pluginId, 'plugin.json'));
    assert.equal(pkg.name, result.pluginId);
    assert.equal(manifest.name, result.pluginId);
    assert.equal(pkg.plugin, '旧名字');
    assert.equal(manifest.displayName, '旧名字');

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('版本与作者留空：从两个清单中删除对应键', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    root: tmp,
    plugins: pluginsRoot,
    pluginsTwo: path.join(tmp, 'plugins_two'),
    data,
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    writePlugin(pluginsRoot, OLD_ID, {});
    writeJsonAtomic(path.join(data, 'plugins.json'), { [OLD_ID]: false });

    const manager = new PluginManager(quietLogger(), stubConnectionManager(), '127.0.0.1', 0);
    await manager.open();

    const result = await updatePluginMeta(OLD_ID, { name: OLD_ID, version: '', author: '' }, 'kakake', manager);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.renamed, false);

    const pkg = readJson(path.join(pluginsRoot, OLD_ID, 'package.json'));
    assert.equal('version' in pkg, false);
    assert.equal('author' in pkg, false);
    assert.equal(pkg.plugin, '旧名字');

    const manifest = readJson(path.join(pluginsRoot, OLD_ID, 'plugin.json'));
    assert.equal('version' in manifest, false);
    assert.equal('author' in manifest, false);
    assert.equal(manifest.displayName, '旧名字');

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('同名冲突、总开关未关闭、清单损坏都会被拒绝且不改盘', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    root: tmp,
    plugins: pluginsRoot,
    pluginsTwo: path.join(tmp, 'plugins_two'),
    data,
    pluginsStatus: path.join(data, 'plugins.json'),
  });
  try {
    writePlugin(pluginsRoot, OLD_ID, {});
    writePlugin(pluginsRoot, 'kakake-plugin-taken', {});
    writeJsonAtomic(path.join(data, 'plugins.json'), { [OLD_ID]: false });

    const manager = new PluginManager(quietLogger(), stubConnectionManager(), '127.0.0.1', 0);
    await manager.open();

    const conflict = await updatePluginMeta(OLD_ID, { name: 'taken' }, 'kakake', manager);
    assert.equal(conflict.ok, false);
    if (!conflict.ok) assert.equal(conflict.code, 'NAME_CONFLICT');
    assert.equal(fs.existsSync(path.join(pluginsRoot, OLD_ID)), true);

    writeJsonAtomic(path.join(data, 'plugins.json'), {});
    const busy = await updatePluginMeta(OLD_ID, { name: 'other' }, 'kakake', manager);
    assert.equal(busy.ok, false);
    if (!busy.ok) assert.equal(busy.code, 'PLUGIN_META_MASTER_ON');

    writeJsonAtomic(path.join(data, 'plugins.json'), { [OLD_ID]: false });
    fs.writeFileSync(path.join(pluginsRoot, OLD_ID, 'plugin.json'), '{ broken');
    const broken = await updatePluginMeta(OLD_ID, { name: 'other' }, 'kakake', manager);
    assert.equal(broken.ok, false);
    if (!broken.ok) assert.equal(broken.code, 'PLUGIN_META_MANIFEST_INVALID');
    assert.equal(fs.existsSync(path.join(pluginsRoot, OLD_ID)), true);

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('扩展插件改名：数据目录在 data 根下，且不产生运行副本', async () => {
  const tmp = tmpDir();
  const pluginsRoot = path.join(tmp, 'plugins');
  const pluginsTwo = path.join(tmp, 'plugins_two');
  const data = path.join(tmp, 'data');
  const undo = isolate({
    root: tmp,
    plugins: pluginsRoot,
    pluginsTwo,
    data,
    kzPluginsStatus: path.join(data, 'kz-plugins.json'),
  });
  try {
    const kzId = 'kz-plugin-kztest';
    writePlugin(pluginsRoot, kzId, {});
    writeJsonAtomic(path.join(data, 'kz-plugins.json'), { [kzId]: false });
    const kzData = path.join(data, kzId);
    fs.mkdirSync(kzData, { recursive: true });
    fs.writeFileSync(path.join(kzData, 'state.json'), '{}');

    const manager = new KzPluginManager(quietLogger(), '127.0.0.1', 0);
    await manager.open();

    const result = await updatePluginMeta(kzId, { name: 'kztest2' }, 'kz', manager);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.pluginId, 'kz-plugin-kztest2');
    assert.equal(fs.existsSync(path.join(data, 'kz-plugin-kztest2', 'state.json')), true);
    assert.equal(fs.existsSync(path.join(data, kzId)), false);

    const status = readJson(path.join(data, 'kz-plugins.json'));
    assert.equal(status['kz-plugin-kztest2'], false);
    assert.equal(kzId in status, false);

    if (fs.existsSync(pluginsTwo)) {
      assert.deepEqual(fs.readdirSync(pluginsTwo), []);
    }

    await manager.close();
  } finally {
    undo.restore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
