import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_CATEGORY_LABEL,
  LOG_CATEGORY_ORDER,
  logKookAction,
  logKookEvent,
  logWxAction,
  logWxEvent,
  logTelegramAction,
  logSimEvent,
  getLogs,
  type LogCategory,
} from '../src/core/log-store.js';
import { createPluginLogger } from '../src/core/plugin-logger.js';
import { CATEGORY_LABEL_KEY, CATEGORY_ORDER } from '../src/web/lib/types.js';

const PROTOCOL_CATEGORIES: LogCategory[] = [
  'gf_plugin',
  'sssx_plugin',
  'tg_event', 'tg_action', 'tg_plugin',
  'kook_event', 'kook_action', 'kook_plugin',
  'wx_event', 'wx_action', 'wx_plugin',
  'extension',
];

test('新协议分类都在标签表、顺序表与前端类型表中齐全', () => {
  for (const cat of PROTOCOL_CATEGORIES) {
    assert.ok(LOG_CATEGORY_LABEL[cat], `后端标签缺 ${cat}`);
    assert.ok(LOG_CATEGORY_ORDER.includes(cat), `后端顺序缺 ${cat}`);
    assert.ok(CATEGORY_LABEL_KEY[cat], `前端标签键缺 ${cat}`);
    assert.ok(CATEGORY_ORDER.includes(cat), `前端顺序缺 ${cat}`);
  }
});

test('前后端分类顺序完全一致', () => {
  assert.deepEqual(CATEGORY_ORDER, LOG_CATEGORY_ORDER);
});

test('KOOK / 微信 上报输出日志写入后可按分类读到', () => {
  logKookEvent('[测试KOOK上报]', 'kook-in');
  logKookAction('[测试KOOK输出]', 'kook-out');
  logWxEvent('[测试微信上报]', 'wx-in');
  logWxAction('[测试微信输出]', 'wx-out');
  logTelegramAction('[测试TG输出]', 'tg-out');

  assert.ok(getLogs(500, undefined, 'kook_event').some((e) => e.message === 'kook-in'));
  assert.ok(getLogs(500, undefined, 'kook_action').some((e) => e.message === 'kook-out'));
  assert.ok(getLogs(500, undefined, 'wx_event').some((e) => e.message === 'wx-in'));
  assert.ok(getLogs(500, undefined, 'wx_action').some((e) => e.message === 'wx-out'));
  assert.ok(getLogs(500, undefined, 'tg_action').some((e) => e.message === 'tg-out'));
});

test('写入旧分类不会串到新分类', () => {
  logSimEvent('[测试模拟]', 'sim-only');
  const wildPlugin = getLogs(500, undefined, 'plugin').some((e) => e.message === 'sim-only');
  assert.equal(wildPlugin, false);
});

test('双生插件日志落到 sssx_plugin，不再混进野鸡插件', () => {
  // 双生管理器此前 loggerCategory 写的是 'plugin'，日志被算成野鸡插件
  const logger = createPluginLogger('sssx-plugin-demo@twin', {
    category: 'sssx_plugin',
    silentStdout: true,
  });
  logger.info('twin-only');
  assert.ok(getLogs(500, undefined, 'sssx_plugin').some((e) => e.message === 'twin-only'));
  assert.equal(
    getLogs(500, undefined, 'plugin').some((e) => e.message === 'twin-only'),
    false,
  );
});
