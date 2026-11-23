/** 侧栏窄栏切换：编辑模式多出的工具按钮必须算进宽度，宁可降级也不显示半截字。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mobileNavMode,
  pcNavMode,
  NAV_COMPACT_PX,
  NAV_EDIT_COST_PX,
  NAV_NO_ICON_PX,
  NAV_NO_TEXT_PX,
  NAV_COMPACT_VW,
  NAV_EDIT_COST_VW,
  NAV_NO_TEXT_VW,
} from '../src/web/lib/nav-shape.js';

test('电脑端普通模式：四字 → 两字 → 纯文字 → 图标', () => {
  assert.equal(pcNavMode(NAV_COMPACT_PX), 'full');
  assert.equal(pcNavMode(NAV_COMPACT_PX - 1), 'short');
  assert.equal(pcNavMode(NAV_NO_ICON_PX), 'short');
  assert.equal(pcNavMode(NAV_NO_ICON_PX - 1), 'text');
  assert.equal(pcNavMode(NAV_NO_TEXT_PX), 'text');
  assert.equal(pcNavMode(NAV_NO_TEXT_PX - 1), 'icon');
});

test('编辑模式提前降级：刚好够四字的宽度改显两字', () => {
  const justFull = NAV_COMPACT_PX;
  assert.equal(pcNavMode(justFull, false), 'full');
  assert.equal(pcNavMode(justFull, true), 'short', '编辑模式不能把四字全称砍成两三个字');
  assert.equal(pcNavMode(justFull + NAV_EDIT_COST_PX, true), 'full', '宽度补回额外占用后仍显示全称');
});

test('编辑模式：两字也放不下时直接显示图标', () => {
  const justText = NAV_NO_TEXT_PX;
  assert.equal(pcNavMode(justText, false), 'text');
  assert.equal(pcNavMode(justText, true), 'icon', '两字被工具按钮挤掉时只剩图标，不显示半个汉字');
  assert.equal(pcNavMode(NAV_NO_ICON_PX - 1, true), 'icon');
  assert.equal(pcNavMode(NAV_NO_ICON_PX - 1, false), 'text');
});

test('手机端按屏宽百分比，编辑模式同样提前降级', () => {
  assert.equal(mobileNavMode(NAV_COMPACT_VW), 'full');
  assert.equal(mobileNavMode(NAV_COMPACT_VW, true), 'text');
  assert.equal(mobileNavMode(NAV_NO_TEXT_VW), 'text');
  assert.equal(mobileNavMode(NAV_NO_TEXT_VW, true), 'icon');
  assert.equal(mobileNavMode(NAV_NO_TEXT_VW + NAV_EDIT_COST_VW, true), 'text');
  assert.equal(mobileNavMode(10), 'icon');
});
