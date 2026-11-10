/**
 * Telegram Bot 插件目录 ID（TG-plugin-*）：识别、规范化，
 * 以及与 kakake- / 其它前缀互不误伤。
 *
 * 风格对齐 tests/plugin-loader-status.test.ts（node:test + node:assert/strict）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTgPluginDir,
  toTgPluginDirName,
  resolveTgPluginId,
  TG_PLUGIN_DIR_PREFIX,
} from '../src/plugin/tg-plugin-id.js';
import {
  toKakakePluginDirName,
  isKakakePluginDir,
} from '../src/plugin/plugin-id.js';

test('TG_PLUGIN_DIR_PREFIX 与 isTgPluginDir 基本识别', () => {
  assert.equal(TG_PLUGIN_DIR_PREFIX, 'TG-plugin-');
  assert.equal(isTgPluginDir('TG-plugin-hello'), true);
  assert.equal(isTgPluginDir('tg-plugin-hello'), true);   // 大小写不敏感
  assert.equal(isTgPluginDir('TG-plugin-a'), true);
  assert.equal(isTgPluginDir('tgbot-plugin-hello'), true); // tgbot- 别名
  assert.equal(isTgPluginDir('kakake-plugin-x'), false);
  assert.equal(isTgPluginDir('GF-plugin-hello'), false);
  assert.equal(isTgPluginDir('sssx-plugin-hello'), false);
  assert.equal(isTgPluginDir('kz-plugin-hello'), false);
  assert.equal(isTgPluginDir(''), false);
});

test('toTgPluginDirName：任意写法统一规范为 TG-plugin-*', () => {
  assert.equal(toTgPluginDirName('TG-plugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('tg-plugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('TGPlugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('TG_plugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('tgbot-plugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName('plugin-hello'), 'TG-plugin-hello');
  assert.equal(toTgPluginDirName(''), 'TG-plugin-unknown');
  // 规范化结果仍能被识别
  assert.equal(isTgPluginDir(toTgPluginDirName('tg-plugin-hello')), true);
  assert.equal(resolveTgPluginId('tg-plugin-hello'), 'TG-plugin-hello');
});

test('toKakakePluginDirName：TG-plugin-foo 不被误加 kakake 前缀', () => {
  assert.equal(toKakakePluginDirName('TG-plugin-hello'), 'TG-plugin-hello');
  assert.notEqual(toKakakePluginDirName('TG-plugin-hello'), 'kakake-plugin-TG-plugin-hello');
  assert.equal(isKakakePluginDir('TG-plugin-hello'), false);
  // 其它已是规范目录名的类型同样短路，行为不回归
  assert.equal(toKakakePluginDirName('ss-plugin-hello'), 'ss-plugin-hello');
  assert.equal(toKakakePluginDirName('kz-plugin-hello'), 'kz-plugin-hello');
  assert.equal(toKakakePluginDirName('kakake-plugin-hello'), 'kakake-plugin-hello');
  assert.equal(toKakakePluginDirName('tg-plugin-hello'), 'tg-plugin-hello'); // 短路：原样保留
  // 普通名字仍按老规则加 kakake-plugin- 前缀
  assert.equal(toKakakePluginDirName('hello'), 'kakake-plugin-hello');
  assert.equal(toKakakePluginDirName('plugin-hello'), 'kakake-plugin-hello');
});

test('TG 与 kakake 前缀互不串号：规范化结果不交叉', () => {
  const tg = toTgPluginDirName('tg-plugin-hello');
  const ob = toKakakePluginDirName('hello');
  assert.equal(isTgPluginDir(tg), true);
  assert.equal(isKakakePluginDir(tg), false);
  assert.equal(isTgPluginDir(ob), false);
  assert.equal(isKakakePluginDir(ob), true);
  assert.notEqual(tg, ob);
});
