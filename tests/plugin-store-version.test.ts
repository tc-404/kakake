import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersion } from '../src/web/lib/plugin-store-origin.js';

// compareVersion 是商店前端的两个判定来源：
//   1. 详情弹窗的 min_kakake「最低版本要求」是否满足；
//   2. resolveInstallState 的「可更新」判定（本地版本 vs 商店版本）。
// 旧实现把 `beta.N` 的 N 并进基础数字段，导致 `1.2.0-beta.3 > 1.2.0`、
// `rc.1 < beta.9` 这类反直觉结论，本文件把这批用例固化下来防回归。

test('compareVersion：预发布版低于同号正式版（回归旧 bug）', () => {
  assert.ok(compareVersion('0.6.10-beta.3', '0.6.10') < 0);
  assert.ok(compareVersion('0.6.10-beta.2', '0.6.10') < 0);
  assert.ok(compareVersion('1.2.0-beta.1', '1.2.0') < 0);
  assert.ok(compareVersion('1.2.3-alpha.1', '1.2.3') < 0);
  assert.ok(compareVersion('0.6.10', '0.6.10-beta.2') > 0);
  assert.ok(compareVersion('1.2.0', '1.2.0-beta.1') > 0);
});

test('compareVersion：rc 高于 beta，且与构建号大小无关', () => {
  assert.ok(compareVersion('1.2.0-rc.1', '1.2.0-beta.9') > 0);
  assert.ok(compareVersion('1.2.0-beta.9', '1.2.0-rc.1') < 0);
  assert.ok(compareVersion('1.2.0-rc.1', '1.2.0-beta.1') > 0);
});

test('compareVersion：预发布数字尾巴按数字比较（beta.10 > beta.9）', () => {
  assert.ok(compareVersion('0.7.0-beta.10', '0.7.0-beta.9') > 0);
  assert.ok(compareVersion('1.2.0-beta.10', '1.2.0-beta.9') > 0);
  assert.ok(compareVersion('1.2.0-beta.2', '1.2.0-beta.1') > 0);
  assert.ok(compareVersion('1.2.0-beta.3', '1.2.0-beta.3') === 0);
  // 无尾巴的 beta 低于带尾巴的 beta.1（语义化版本：字段多者大）
  assert.ok(compareVersion('1.2.0-beta', '1.2.0-beta.1') < 0);
});

test('compareVersion：跨段比较与正式版行为保持不变', () => {
  assert.ok(compareVersion('0.6.10-beta.3', '0.6.9') > 0);
  assert.ok(compareVersion('1.2.3', '1.2.2') > 0);
  assert.ok(compareVersion('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersion('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersion('1.2', '1.2.0'), 0);
  assert.equal(compareVersion('v1.2.3', '1.2.3'), 0);
});

test('compareVersion：min_kakake 场景（beta 宿主不满足要求正式版的插件）', () => {
  // 当前 0.6.10-beta.2，插件要求 ≥ 0.6.10 → 不满足（旧实现误判为满足）
  assert.ok(compareVersion('0.6.10-beta.2', '0.6.10') < 0);
  // 当前 0.6.10 正式版，插件要求 ≥ 0.6.10-beta.2 → 满足（旧实现误报"版本偏低"）
  assert.ok(compareVersion('0.6.10', '0.6.10-beta.2') > 0);
});
