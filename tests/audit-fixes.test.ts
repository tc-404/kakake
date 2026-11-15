import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafePluginDirName,
} from '../src/plugin/plugin-dir-safety.js';
import { toKakakePluginDirName } from '../src/plugin/plugin-id.js';
import { toGfPluginDirName } from '../src/plugin/gf-plugin-id.js';
import { toSsPluginDirName } from '../src/plugin/ss-plugin-id.js';
import {
  isPrivateIpLiteral,
  assertPublicHttpUrl,
} from '../src/core/public-url.js';

/**
 * 本轮安全审计修复的回归：插件 ID 目录穿越、IP 字面量 SSRF 绕过。
 */

test('插件 ID 消毒：路径分隔/上跳/盘符/控制字符一律拒绝', () => {
  for (const bad of [
    'kakake-../../etc',
    'kakake-plugin-..',
    'ss-plugin-a\\..\\..\\windows',
    'GF-plugin-x/y',
    'WX-plugin-C:',
    'kakake-plugin-a\u0000b',
    '..',
    'a/../b',
  ]) {
    assert.throws(() => assertSafePluginDirName(bad), `应拒绝：${bad}`);
  }
  for (const good of ['kakake-plugin-mkbot', 'GF-plugin-foo', 'ss-plugin-bar', 'WX-plugin-wx', 'sssx-plugin-twin', 'mkbot']) {
    assert.doesNotThrow(() => assertSafePluginDirName(good), `应放行：${good}`);
  }
});

test('五个 to*PluginDirName：包内 package.json 声明的穿越名走不到目录拼接', () => {
  assert.throws(() => toKakakePluginDirName('kakake-../../../Users/Public/pwn'));
  assert.throws(() => toKakakePluginDirName('kakake-..\\..\\data'));
  assert.throws(() => toGfPluginDirName('GF-plugin-../../x'));
  assert.throws(() => toSsPluginDirName('ss-plugin-..'));
});

test('IP 字面量：IPv4 映射 IPv6 的十六进制形态也被判内网', () => {
  assert.equal(isPrivateIpLiteral('127.0.0.1'), true);
  assert.equal(isPrivateIpLiteral('10.1.2.3'), true);
  assert.equal(isPrivateIpLiteral('::1'), true);
  assert.equal(isPrivateIpLiteral('::ffff:127.0.0.1'), true);
  // WHATWG 归一化后的十六进制映射形态（此前唯一的绕过口）
  assert.equal(isPrivateIpLiteral('::ffff:7f00:1'), true);
  assert.equal(isPrivateIpLiteral('fe80::1'), true);
  assert.equal(isPrivateIpLiteral('2130706433'), true);   // 未归一化的十进制写法按不可信处理
  assert.equal(isPrivateIpLiteral('127.1'), true);         // 短格式同理
  // 公网地址与正常域名放行
  assert.equal(isPrivateIpLiteral('8.8.8.8'), false);
  assert.equal(isPrivateIpLiteral('1.2.3.4'), false);
  assert.equal(isPrivateIpLiteral('example.com'), false);
});

test('assertPublicHttpUrl：映射 IPv6 主机被拒，公网域名通过', () => {
  assert.throws(() => assertPublicHttpUrl('http://[::ffff:7f00:1]/x.zip'));
  assert.throws(() => assertPublicHttpUrl('http://2130706433/x.zip'));
  assert.throws(() => assertPublicHttpUrl('http://localhost/x.zip'));
  const u = assertPublicHttpUrl('https://example.com/a.zip');
  assert.equal(u.hostname, 'example.com');
});
