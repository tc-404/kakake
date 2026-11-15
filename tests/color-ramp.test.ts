import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gradientSampler,
  gradientShadeHues,
  parseCssColor,
  rgbToHsl,
  SHADES,
} from '../src/web/lib/color-ramp.js';
import { normalizeGradientCss, normalizeWatermark, parseGradientCss, WATERMARK_MAX_LEN } from '../src/admin/appearance.service.js';
import { buildWatermarkSnippet } from '../src/admin/watermark-snippet.js';

/**
 * 配色收口与色阶派生的回归测试。
 * 这些逻辑同时被「设置页实时预览」「服务端落库」「Tailwind 色阶」三处消费，
 * 一旦格式判断不一致，表现就是「渐变选完一刷新就没了」或「某几处颜色不跟主题」。
 */

test('页面水印收口：空白即关闭、单行、按码点截断', () => {
  assert.equal(normalizeWatermark(''), '');
  assert.equal(normalizeWatermark('   '), '');
  assert.equal(normalizeWatermark('\n\t  \r'), '');
  assert.equal(normalizeWatermark(undefined), '');
  assert.equal(normalizeWatermark(123), '');
  // 换行压成空格，首尾去空白，中间空格保留
  assert.equal(normalizeWatermark('  Kakake\n水印  '), 'Kakake 水印');
  assert.equal(normalizeWatermark('a  b'), 'a  b');
  // 上限按码点算：emoji 不会被截成半个
  const long = normalizeWatermark('🙂'.repeat(60));
  assert.equal(Array.from(long).length, WATERMARK_MAX_LEN);
});

test('插件页水印：角度 / 字号 / 密度写进注入片段，文字按纯文本转义', () => {
  const base = { text: 'Kakake水印', angle: -22, density: 60, size: 16 };
  const snippet = buildWatermarkSnippet(base);
  assert.match(snippet, /rotate\(-22 /);
  assert.match(snippet, /font-size:16px/);
  // 水印层必须在最上层、不拦点击
  assert.match(snippet, /z-index:2147483000/);
  assert.match(snippet, /pointer-events:none/);

  // 字号变大、角度变正，格子（pattern）随之变大
  const bigger = buildWatermarkSnippet({ ...base, angle: 35, size: 40 });
  const tileOf = (html: string) => /width="(\d+)" height="(\d+)"/.exec(html)!.slice(1).map(Number);
  const [w1, h1] = tileOf(snippet);
  const [w2, h2] = tileOf(bigger);
  assert.ok(w2 > w1 && h2 > h1, `字号变大后格子应更大: ${w1}x${h1} → ${w2}x${h2}`);
  assert.match(bigger, /rotate\(35 /);

  // 密集度拉满时间距变小，格子随之收缩
  const dense = tileOf(buildWatermarkSnippet({ ...base, density: 100 }));
  const sparse = tileOf(buildWatermarkSnippet({ ...base, density: 0 }));
  assert.ok(dense[0] < sparse[0] && dense[1] < sparse[1]);

  // 水印文字永远只能是文本，不能带出标签
  const escaped = buildWatermarkSnippet({ ...base, text: '<img src=x onerror=1>' });
  assert.ok(!escaped.includes('<img'));
  assert.ok(escaped.includes('&lt;img'));
});

test('渐变白名单同时接受逗号与空格两种颜色写法', () => {
  const variants = [
    'linear-gradient(90deg, #36d1dc 0%, #5b86e5 100%)',
    'linear-gradient(90deg, rgb(54, 209, 220) 0%, rgb(91, 134, 229) 100%)',
    'linear-gradient(90deg, rgb(54 209 220) 0%, rgb(91 134 229) 100%)',
    'linear-gradient(90deg, rgb(54 209 220 / 0.8) 0%, rgba(91, 134, 229, 0.4) 100%)',
    'linear-gradient(90deg, hsl(184 70% 54%) 0%, hsl(221 73% 63%) 100%)',
    'linear-gradient(to right, #fa709a 0%, #fee140 50%, #30cfd0 100%)',
  ];
  for (const css of variants) {
    const stops = parseGradientCss(css);
    assert.ok(stops, `应被接受: ${css}`);
    assert.ok(stops.length >= 2);
    // 收口后的串必须仍然合法（能再次解析），否则存回去之后前端会读不出来
    const normalized = normalizeGradientCss(css);
    assert.ok(normalized, `收口后应保持合法: ${css}`);
    assert.ok(parseGradientCss(normalized));
  }
});

test('渐变白名单拒绝函数注入与非法色标', () => {
  const bad = [
    'linear-gradient(90deg, url(javascript:alert(1)) 0%, #fff 100%)',
    'linear-gradient(90deg, var(--x) 0%, #fff 100%)',
    'linear-gradient(90deg, red 0%, blue 100%)',
    'linear-gradient(90deg, #fff 0%)',
    'radial-gradient(#fff 0%, #000 100%)',
    'linear-gradient(90deg, #fff 0%, #000 100%); background: red',
  ];
  for (const css of bad) {
    assert.equal(normalizeGradientCss(css), '', `应被拒绝: ${css}`);
  }
});

test('颜色解析覆盖 hex / rgb / hsl 三种写法', () => {
  assert.deepEqual(parseCssColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor('rgb(10 20 30 / 0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.deepEqual(parseCssColor('hsl(120 50% 40%)'), { r: 51, g: 153, b: 51, a: 1 });
  assert.equal(parseCssColor('not-a-color'), null);
});

test('渐变采样按位置线性插值', () => {
  const sample = gradientSampler([
    { color: '#000000', percent: 0 },
    { color: '#ffffff', percent: 100 },
  ]);
  assert.ok(sample);
  assert.equal(Math.round(sample(0.5).r), 128);
  assert.equal(Math.round(sample(1).r), 255);
});

test('逐档色相覆盖全部色阶档位，且随渐变位置推进', () => {
  const shades = gradientShadeHues([
    { color: '#fa709a', percent: 0 },
    { color: '#30cfd0', percent: 100 },
  ]);
  assert.equal(shades.length, SHADES.length);
  assert.deepEqual(shades.map((s) => s.shade), [...SHADES]);
  // 起点是粉（#fa709a ≈ 342°），终点是青（#30cfd0 ≈ 180°），必须整条都在变
  assert.ok(Math.abs(shades[0].h - 342) < 3, `首档色相异常: ${shades[0].h}`);
  assert.ok(Math.abs(shades[shades.length - 1].h - 180) < 3, `末档色相异常: ${shades[shades.length - 1].h}`);
  const hues = new Set(shades.map((s) => s.h));
  assert.ok(hues.size > 4, '整条色阶应有多档不同色相');
});

test('rgbToHsl 与已知取值一致', () => {
  const hsl = rgbToHsl({ r: 255, g: 0, b: 0, a: 1 });
  assert.equal(Math.round(hsl.h), 0);
  assert.equal(Math.round(hsl.s), 100);
  assert.equal(Math.round(hsl.l), 50);
});
