/**
 * src/web/lib/appearance.ts 纯函数回归：APPEARANCE_RANGES 收口、HSV/HSL 与色阶派生、
 * 渐变串白名单、背景槽位解析。
 * 模块内部用 @/ 别名导入，node 下需经 tsx/esm api 以 src/web 的 tsconfig 动态加载；
 * 不用 typeof import 做类型引用，避免把 src/web 文件牵进根 tsconfig 的类型检查。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const appearance: any = await tsImport(new URL('../src/web/lib/appearance.js', import.meta.url).href, {
  tsconfig: fileURLToPath(new URL('../src/web/tsconfig.json', import.meta.url)),
  parentURL: import.meta.url,
});

const { DEFAULT_APPEARANCE, DEFAULT_APPEARANCE_STATE } = appearance;

test('APPEARANCE_RANGES 收口：normalizeAppearance 按区间表逐项夹取', () => {
  assert.equal(appearance.normalizeAppearance({ cardOpacity: 5 }).cardOpacity, 0.85);
  assert.equal(appearance.normalizeAppearance({ cardOpacity: -1 }).cardOpacity, 0.05);
  assert.equal(appearance.normalizeAppearance({ cardBlur: 100 }).cardBlur, 40);
  assert.equal(appearance.normalizeAppearance({ card2Blur: -3 }).card2Blur, 0);
  assert.equal(appearance.normalizeAppearance({ uiSpeed: 0.1 }).uiSpeed, 0.5);
  assert.equal(appearance.normalizeAppearance({ uiSpeed: 10 }).uiSpeed, 2.5);
  assert.equal(appearance.normalizeAppearance({ sidebarWidthPc: 10 }).sidebarWidthPc, 50);
  assert.equal(appearance.normalizeAppearance({ sidebarWidthPc: 999 }).sidebarWidthPc, 264);
  assert.equal(appearance.normalizeAppearance({ sidebarWidthMobile: 0 }).sidebarWidthMobile, 20);
  assert.equal(appearance.normalizeAppearance({ sidebarWidthMobile: 100 }).sidebarWidthMobile, 90);
  assert.equal(appearance.normalizeAppearance({ watermarkAngle: 100 }).watermarkAngle, 60);
  assert.equal(appearance.normalizeAppearance({ watermarkAngle: -100 }).watermarkAngle, -60);
  assert.equal(appearance.normalizeAppearance({ watermarkSize: 0 }).watermarkSize, 8);
  assert.equal(appearance.normalizeAppearance({ watermarkSize: 100 }).watermarkSize, 48);
  assert.equal(appearance.normalizeAppearance({ inkHue: 500 }).inkHue, 360);
  assert.equal(appearance.normalizeAppearance({ inkHue: -20 }).inkHue, 0);
  assert.equal(appearance.normalizeAppearance({ compSat: 120 }).compSat, 100);
  assert.equal(appearance.normalizeAppearance({ cardShadow: 1 }).cardShadow, appearance.CARD_SHADOW_MAX);
  // 数值字符串按 Number() 收口
  assert.equal(appearance.normalizeAppearance({ cardOpacity: '0.5' as unknown as number }).cardOpacity, 0.5);
});

test('APPEARANCE_RANGES 收口：非有限值回落默认值', () => {
  assert.equal(appearance.normalizeAppearance({ uiSpeed: 'abc' as unknown as number }).uiSpeed, DEFAULT_APPEARANCE.uiSpeed);
  assert.equal(appearance.normalizeAppearance({ cardBlur: Number.NaN }).cardBlur, DEFAULT_APPEARANCE.cardBlur);
  assert.equal(appearance.normalizeAppearance({ cardOpacity: null as unknown as number }).cardOpacity, DEFAULT_APPEARANCE.cardOpacity);
});

test('normalizeAppearance：无入参时整体等于出厂默认', () => {
  const out = appearance.normalizeAppearance();
  assert.equal(out.cardOpacity, 0.32);
  assert.equal(out.cardBlur, 22);
  assert.equal(out.uiSpeed, 1);
  assert.equal(out.sidebarWidthPc, 204);
  assert.equal(out.sidebarWidthMobile, 67);
  assert.equal(out.watermarkAngle, -22);
  assert.equal(out.watermarkDensity, 60);
  assert.equal(out.watermarkSize, 16);
  assert.equal(out.inkHue, 215);
  assert.equal(out.compHue, 113);
  assert.equal(out.logoHue, 64);
  assert.equal(out.bgFit, 'cover');
  assert.equal(out.bgPreset, 'default');
  assert.equal(out.inkGradient, '');
});

test('HSV → HSL 派生（色相回绕、黑灰白边界）', () => {
  assert.deepEqual(appearance.hsvToHsl({ h: 0, s: 100, v: 100 }), { h: 0, s: 100, l: 50 });
  assert.deepEqual(appearance.hsvToHsl({ h: -30, s: 50, v: 100 }), { h: 330, s: 100, l: 75 });
  assert.deepEqual(appearance.hsvToHsl({ h: 0, s: 0, v: 0 }), { h: 0, s: 0, l: 0 });
  assert.deepEqual(appearance.hsvToHsl({ h: 200, s: 0, v: 50 }), { h: 200, s: 0, l: 50 });
});

test('HSV → Hex：基础色与出厂色往返', () => {
  assert.equal(appearance.hsvToHex({ h: 0, s: 100, v: 100 }), '#ff0000');
  assert.equal(appearance.hsvToHex({ h: 120, s: 100, v: 100 }), '#00ff00');
  assert.equal(appearance.hsvToHex({ h: 240, s: 100, v: 100 }), '#0000ff');
  assert.equal(appearance.hsvToHex({ h: 0, s: 0, v: 0 }), '#000000');
  assert.equal(appearance.hsvToHex({ h: 0, s: 0, v: 100 }), '#ffffff');
  // 出厂组件色 / Logo 色的注释值（见 DEFAULT_APPEARANCE）必须稳定
  assert.deepEqual(appearance.parseColorToHsv('#2ceb13'), { h: 113, s: 92, v: 92 });
  assert.deepEqual(appearance.parseColorToHsv('#f1ff2e'), { h: 64, s: 82, v: 100 });
});

test('parseColorToHsv：rgb / hsl 写法与非法输入', () => {
  assert.deepEqual(appearance.parseColorToHsv('rgb(255, 8, 68)'), { h: 345, s: 97, v: 100 });
  assert.deepEqual(appearance.parseColorToHsv('hsl(0 100% 50%)'), { h: 0, s: 100, v: 100 });
  assert.deepEqual(appearance.parseColorToHsv('hsl(113, 92%, 92%)'), { h: 113, s: 15, v: 99 });
  assert.equal(appearance.parseColorToHsv('nope'), null);
  assert.equal(appearance.parseColorToHsv(''), null);
  assert.equal(appearance.parseColorToHsv('#12'), null);
  assert.equal(appearance.parseColorToHsv('#12345'), null);
});

test('roleSampleColor / hsvCss：卡片代表色与拾色器纯色', () => {
  assert.equal(appearance.roleSampleColor(DEFAULT_APPEARANCE, 'ink'), 'hsl(215 20% 27%)');
  assert.equal(appearance.roleSampleColor(DEFAULT_APPEARANCE, 'comp'), 'hsl(113 85% 40%)');
  assert.equal(appearance.hsvCss({ h: 113, s: 92, v: 92 }), 'hsl(113 85% 50%)');
});

test('watermarkGap / cardShadowPercent / formatAppearanceValue', () => {
  assert.deepEqual(appearance.watermarkGap(0), { x: 260, y: 208 });
  assert.deepEqual(appearance.watermarkGap(60), { x: 128, y: 102 });
  assert.deepEqual(appearance.watermarkGap(100), { x: 40, y: 32 });
  assert.deepEqual(appearance.watermarkGap(150), { x: 40, y: 32 });
  assert.equal(appearance.cardShadowPercent(0.35), 100);
  assert.equal(appearance.cardShadowPercent(0.14), 40);
  assert.equal(appearance.cardShadowPercent(0), 0);
  assert.equal(appearance.formatAppearanceValue('uiSpeed', 1.5), '1.5×');
  assert.equal(appearance.formatAppearanceValue('cardOpacity', 0.32), '32%');
  assert.equal(appearance.formatAppearanceValue('watermarkAngle', -22), '-22°');
  assert.equal(appearance.formatAppearanceValue('watermarkSize', 16), '16px');
  assert.equal(appearance.formatAppearanceValue('sidebarWidthPc', 204), '204px');
});

test('normalizeWatermark / normalizeCustomTitle：控制字符与码点截断', () => {
  assert.equal(appearance.normalizeWatermark(' a\nb\u0000c '), 'a b c');
  assert.equal(appearance.normalizeWatermark('   '), '');
  assert.equal(appearance.normalizeWatermark(123 as unknown as string), '');
  assert.equal(appearance.normalizeWatermark('中'.repeat(50)).length, appearance.WATERMARK_MAX_LEN);
  assert.equal(appearance.normalizeCustomTitle('  你好🙂世界  '), '你好🙂世界');
  assert.equal(appearance.normalizeCustomTitle('x'.repeat(30)).length, appearance.CUSTOM_TITLE_MAX_LEN);
  assert.equal(appearance.normalizeCustomTitle(42 as unknown as string), '');
});

test('渐变串白名单：parseGradientStops 只认安全色标', () => {
  assert.deepEqual(appearance.parseGradientStops('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'), [
    { color: '#ff0000', percent: 0 },
    { color: '#0000ff', percent: 100 },
  ]);
  // 方向参数剥离 + 位置钳到 [0,100]
  assert.deepEqual(appearance.parseGradientStops('linear-gradient(to right, #ff0000 150%, #0000ff 100%)'), [
    { color: '#ff0000', percent: 100 },
    { color: '#0000ff', percent: 100 },
  ]);
  // 拾色器回传的空格写法（rgb(255 8 68)）必须收
  assert.deepEqual(appearance.parseGradientStops('linear-gradient(90deg, rgb(255 8 68) 0%, #0000ff 100%)'), [
    { color: 'rgb(255 8 68)', percent: 0 },
    { color: '#0000ff', percent: 100 },
  ]);
  // 负百分比位置不匹配数字格式 → 整条拒收
  assert.equal(appearance.parseGradientStops('linear-gradient(90deg, #ff0000 -5%, #0000ff 105%)'), null);
  assert.equal(appearance.parseGradientStops('linear-gradient(90deg, url(x.png) 0%, #0000ff 100%)'), null);
  const tooMany = `linear-gradient(90deg, ${Array.from({ length: 13 }, (_, i) => `#00f ${i}%`).join(', ')})`;
  assert.equal(appearance.parseGradientStops(tooMany), null);
});

test('normalizeGradientCss：合法原样保留（不排序不取整）、非法清空', () => {
  assert.equal(
    appearance.normalizeGradientCss('  linear-gradient(135deg, #ff0000 10%, #0000ff 90%)  '),
    'linear-gradient(135deg, #ff0000 10%, #0000ff 90%)',
  );
  assert.equal(appearance.normalizeGradientCss('linear-gradient(90deg, url(x.png) 0%, #00f 100%)'), '');
  assert.equal(appearance.normalizeGradientCss(''), '');
  assert.equal(appearance.normalizeGradientCss(123 as unknown as string), '');
  // gradientStopsToCss 才负责按位置升序 + 统一 90deg
  assert.equal(
    appearance.gradientStopsToCss([
      { color: '#0000ff', percent: 100 },
      { color: '#ff0000', percent: 0 },
    ]),
    'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)',
  );
});

test('mergeAppearance：渐变字段仅 undefined 才回落，显式空串不复活', () => {
  const grad = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)';
  const base = { ...DEFAULT_APPEARANCE_STATE, inkGradient: grad };
  assert.equal(appearance.mergeAppearance(base, {}).inkGradient, grad);
  assert.equal(appearance.mergeAppearance(base, { inkGradient: '' }).inkGradient, '');
  // 数值字段以 incoming 为准并收口
  assert.equal(appearance.mergeAppearance(base, { cardOpacity: 5 }).cardOpacity, 0.85);
});

test('resolveBackgroundSlot：本方向优先、跨方向借用、同类外借', () => {
  const image = { ext: 'png', mime: 'image/png', kind: 'image' as const, size: 1, updatedAt: 7 };
  const video = { ext: 'mp4', mime: 'video/mp4', kind: 'image' as const, size: 1, updatedAt: 9 };
  const state = { ...DEFAULT_APPEARANCE_STATE };
  // 本方向没有 → 借另一方向
  const borrowed = appearance.resolveBackgroundSlot({ ...state, backgrounds: { portrait: null, landscape: image } }, 'portrait');
  assert.equal(borrowed?.orientation, 'landscape');
  assert.equal(borrowed?.meta.updatedAt, 7);
  // meta 没有 kind 时按扩展名补齐：mp4 → video
  assert.equal(appearance.backgroundKindOf({ ...video, kind: undefined }), 'video');
  assert.equal(appearance.backgroundKindOf({ ...image, kind: undefined }), 'image');
  // 指定 kind 且命中（显式 kind 优先于扩展名）
  const got = appearance.resolveBackgroundSlot({ ...state, backgrounds: { portrait: video, landscape: null } }, 'portrait', 'image');
  assert.equal(got?.kind, 'image');
  assert.equal(got?.orientation, 'portrait');
  // 本方向被另一类占住时不再外借 → null
  assert.equal(appearance.resolveBackgroundSlot({ ...state, backgrounds: { portrait: video, landscape: null } }, 'portrait', 'video'), null);
  assert.equal(appearance.resolveBackgroundSlot({ ...state, backgrounds: { portrait: video, landscape: image } }, 'portrait', 'video'), null);
  // 带 mtime 的公开 URL
  assert.equal(appearance.backgroundUrl('portrait', image), '/api/appearance/public/background/portrait?v=7');
  assert.equal(appearance.hasCustomBackground(state), false);
  assert.equal(appearance.hasCustomBackground({ ...state, backgrounds: { portrait: image, landscape: null } }), true);
});

test('effectiveBackgroundPreset：波浪需「无自定义背景 + 完整特效」同时成立', () => {
  const state = { ...DEFAULT_APPEARANCE_STATE, bgPreset: 'waves' as const };
  assert.equal(appearance.effectiveBackgroundPreset(state, 'low'), 'default');
  assert.equal(appearance.effectiveBackgroundPreset(state, 'normal'), 'waves');
  const image = { ext: 'png', mime: 'image/png', kind: 'image' as const, size: 1, updatedAt: 1 };
  assert.equal(
    appearance.effectiveBackgroundPreset({ ...state, backgrounds: { portrait: image, landscape: null } }, 'normal'),
    'default',
  );
  assert.equal(appearance.effectiveBackgroundPreset({ ...DEFAULT_APPEARANCE_STATE }, 'normal'), 'default');
});

test('readHsv / hsvPatch / gradientFieldOf：角色键位映射', () => {
  assert.deepEqual(appearance.readHsv(DEFAULT_APPEARANCE, 'ink'), { h: 215, s: 33, v: 60 });
  assert.deepEqual(appearance.readHsv(DEFAULT_APPEARANCE, 'logo'), { h: 64, s: 82, v: 100 });
  assert.deepEqual(appearance.hsvPatch('brand', { h: 1, s: 2, v: 3 }), {
    compHue: 1, compSat: 2, compVal: 3, logoHue: 1, logoSat: 2, logoVal: 3,
  });
  assert.deepEqual(appearance.hsvPatch('ink', { h: 1, s: 2, v: 3 }), { inkHue: 1, inkSat: 2, inkVal: 3 });
  assert.equal(appearance.gradientFieldOf('ink'), 'inkGradient');
  assert.equal(appearance.gradientFieldOf('comp'), 'compGradient');
  assert.equal(appearance.gradientFieldOf('logo'), 'logoGradient');
  assert.equal(appearance.gradientOf({ ...DEFAULT_APPEARANCE_STATE, compGradient: 'g' }, 'comp'), 'g');
  assert.equal(appearance.gradientOf(DEFAULT_APPEARANCE_STATE, 'comp'), '');
});
