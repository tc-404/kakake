import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PluginLoader } from '../src/plugin/plugin.loader.js';

/**
 * 多文件插件的重载回归（客户实报：漫画下载插件 index.mjs + app.mjs + src/* + vendor/*.cjs）。
 *
 * 旧实现的缺陷：入口 URL 只带 `?v=<入口 mtime>`——只改子文件（src/*、vendor/*.cjs）
 * 不动入口时，URL 不变 → 整棵子模块图命中 Node 按 URL 的 ESM 缓存 → 重载后跑的还是
 * 首次加载的代码，只能靠重启进程。现在：入口 URL 带 `?kkg=<代次>`，且解析钩子把代次
 * 传播给同插件子树内的相对 import；clearCache 时代次 +1 → 整棵图随代次失效。
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kk-multifile-'));
}

function writePlugin(root: string, esmTag: string, cjsTag: string): string {
  const dir = path.join(root, 'kakake-plugin-multi');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'vendor'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kakake-plugin-multi', main: 'index.mjs', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'kakake-plugin-multi', entry: 'index.mjs' }));
  // 注意 vendor 是 .cjs：ESM 里只能默认导入，命名导入会被 cjs-module-lexer 拒掉
  fs.writeFileSync(path.join(dir, 'vendor', 'engine.cjs'), `module.exports = { tag: '${cjsTag}' };\n`);
  fs.writeFileSync(path.join(dir, 'src', 'logic.mjs'), `export const esmTag = '${esmTag}';\n`);
  fs.writeFileSync(
    path.join(dir, 'index.mjs'),
    "import vendor from './vendor/engine.cjs';\nimport { esmTag } from './src/logic.mjs';\n"
      + "export const tags = { esm: esmTag, cjs: vendor.tag };\nexport function plugin_init() {}\n",
  );
  return dir;
}

test('多文件插件：只改 ESM 子文件，clearCache + 重载后必须吃到新代码', async () => {
  const root = tmpRoot();
  const plugins = path.join(root, 'plugins');
  const dir = writePlugin(plugins, 'ESM-A', 'CJS-A');
  const loader = new PluginLoader(plugins, path.join(root, 'plugins.json'), { warn() {}, error() {}, info() {} } as never);

  const entry = path.join(dir, 'index.mjs');
  const m1 = await loader.importModule(entry, dir) as unknown as { tags: { esm: string; cjs: string } };
  assert.equal(m1.tags.esm, 'ESM-A');
  assert.equal(m1.tags.cjs, 'CJS-A');

  // 只改子文件（入口 index.mjs 一个字都不动——旧实现在这里失效）
  fs.writeFileSync(path.join(dir, 'src', 'logic.mjs'), "export const esmTag = 'ESM-B';\n");

  // 模拟重载：卸载路径会调用 clearCache（代次 +1）
  loader.clearCache(dir);
  const m2 = await loader.importModule(entry, dir) as unknown as { tags: { esm: string; cjs: string } };
  assert.equal(m2.tags.esm, 'ESM-B', 'ESM 子文件的新代码必须在重载后生效');
  void m2;
});

test('多文件插件：只改 CJS 子文件，clearCache + 重载后必须吃到新代码', async () => {
  const root = tmpRoot();
  const plugins = path.join(root, 'plugins');
  const dir = writePlugin(plugins, 'ESM-A', 'CJS-A');
  const loader = new PluginLoader(plugins, path.join(root, 'plugins.json'), { warn() {}, error() {}, info() {} } as never);

  const entry = path.join(dir, 'index.mjs');
  await loader.importModule(entry, dir);

  fs.writeFileSync(path.join(dir, 'vendor', 'engine.cjs'), "module.exports = { tag: 'CJS-B' };\n");
  loader.clearCache(dir);
  const m2 = await loader.importModule(entry, dir) as unknown as { tags: { cjs: string } };
  assert.equal(m2.tags.cjs, 'CJS-B', 'CJS 子文件的新代码必须在重载后生效（vendor CJS 是旧实现重载不掉的重灾区）');
});

test('多文件插件：跨兄弟目录 import 不裂成双实例（顶层 const 不触发 TDZ）', async () => {
  const root = tmpRoot();
  const plugins = path.join(root, 'plugins');
  const dir = path.join(plugins, 'kakake-plugin-crossdir');
  fs.mkdirSync(path.join(dir, 'lib', 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'game'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kakake-plugin-crossdir', main: 'index.mjs', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'kakake-plugin-crossdir', entry: 'index.mjs' }));
  const probe = '__kk_crossdir_probe__';
  (globalThis as unknown as Record<string, number>)[probe] = 0;
  fs.writeFileSync(path.join(dir, 'lib', 'core', 'base.mjs'), `globalThis['${probe}'] = (globalThis['${probe}'] || 0) + 1;\nexport const 表 = { x: 1 };\n`);
  fs.writeFileSync(path.join(dir, 'lib', 'game', 'dungeon.mjs'), "import { 表 } from '../core/base.mjs';\nexport const 首项 = 表.x;\n");
  fs.writeFileSync(path.join(dir, 'lib', 'ui', 'card.mjs'), "import { 首项 } from '../game/dungeon.mjs';\nexport const 展示 = 首项;\n");
  fs.writeFileSync(path.join(dir, 'lib', 'game', 'equip.mjs'), "import { 展示 } from '../ui/card.mjs';\nexport const 说明 = 展示;\n");
  fs.writeFileSync(path.join(dir, 'index.mjs'), `export * from './lib/core/base.mjs';\nexport * from './lib/game/equip.mjs';\nexport * from './lib/game/dungeon.mjs';\nexport function plugin_init() {}\n`);

  const loader = new PluginLoader(plugins, path.join(root, 'plugins.json'), { warn() {}, error() {}, info() {} } as never);
  const entry = path.join(dir, 'index.mjs');
  const mod = await loader.importModule(entry, dir) as unknown as { 说明: number; 首项: number };
  assert.equal(mod.说明, 1);
  assert.equal(mod.首项, 1);
  assert.equal((globalThis as unknown as Record<string, number>)[probe], 1, '同一模块经入口直达与跨兄弟目录两条路径引用，只允许求值一次（不能裂成带 kkg / 不带 kkg 两份实例）');
});

test('多文件插件：跨兄弟目录子文件改动，clearCache + 重载后必须吃到新代码', async () => {
  const root = tmpRoot();
  const plugins = path.join(root, 'plugins');
  const dir = path.join(plugins, 'kakake-plugin-crossdir-reload');
  fs.mkdirSync(path.join(dir, 'lib', 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'lib', 'game'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'kakake-plugin-crossdir-reload', main: 'index.mjs', type: 'module' }));
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({ name: 'kakake-plugin-crossdir-reload', entry: 'index.mjs' }));
  fs.writeFileSync(path.join(dir, 'lib', 'core', 'base.mjs'), "export const tag = 'A';\n");
  fs.writeFileSync(path.join(dir, 'lib', 'game', 'farm.mjs'), "import { tag } from '../core/base.mjs';\nexport const got = tag;\n");
  fs.writeFileSync(path.join(dir, 'index.mjs'), "export * from './lib/game/farm.mjs';\nexport function plugin_init() {}\n");

  const loader = new PluginLoader(plugins, path.join(root, 'plugins.json'), { warn() {}, error() {}, info() {} } as never);
  const entry = path.join(dir, 'index.mjs');
  const m1 = await loader.importModule(entry, dir) as unknown as { got: string };
  assert.equal(m1.got, 'A');

  fs.writeFileSync(path.join(dir, 'lib', 'core', 'base.mjs'), "export const tag = 'B';\n");
  loader.clearCache(dir);
  const m2 = await loader.importModule(entry, dir) as unknown as { got: string };
  assert.equal(m2.got, 'B', '跨兄弟目录的子模块必须随代次失效并重新求值');
});

test('多文件插件：代次不变时同 URL 复用（不堆积模块图）', async () => {
  const root = tmpRoot();
  const plugins = path.join(root, 'plugins');
  const dir = writePlugin(plugins, 'ESM-A', 'CJS-A');
  const loader = new PluginLoader(plugins, path.join(root, 'plugins.json'), { warn() {}, error() {}, info() {} } as never);

  const entry = path.join(dir, 'index.mjs');
  const href = `${pathToFileURL(entry).href}?kkg=${loader.generationOf(dir)}`;
  const a = await import(href);
  const b = await import(href);
  assert.equal(a.tags.esm, 'ESM-A');
  // 同代次同 URL：Node 返回同一个模块命名空间（不重复求值，模块图不线性堆积）
  assert.equal(a, b);
});
