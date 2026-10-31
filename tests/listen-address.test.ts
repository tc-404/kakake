import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeListenHost,
  normalizeListenPort,
  PRIVILEGED_PORT_MAX,
} from '../src/core/listen-address.js';

test('normalizeListenHost: 合法 IPv4 / IPv6 / 主机名原样收下', () => {
  assert.equal(normalizeListenHost('0.0.0.0', 'fb'), '0.0.0.0');
  assert.equal(normalizeListenHost('192.168.1.10', 'fb'), '192.168.1.10');
  assert.equal(normalizeListenHost('127.0.0.1', 'fb'), '127.0.0.1');
  assert.equal(normalizeListenHost('::', 'fb'), '::');
  assert.equal(normalizeListenHost('::1', 'fb'), '::1');
  assert.equal(normalizeListenHost('localhost', 'fb'), 'localhost');
  assert.equal(normalizeListenHost('myhost.local', 'fb'), 'myhost.local');
});

test('normalizeListenHost: 首尾空白剔除，主机名转小写', () => {
  assert.equal(normalizeListenHost(' 127.0.0.1 ', 'fb'), '127.0.0.1');
  assert.equal(normalizeListenHost(' MyHost.LOCAL ', 'fb'), 'myhost.local');
});

test('normalizeListenHost: 空串 / 非字符串 / 非法值退回 fallback', () => {
  assert.equal(normalizeListenHost('', 'fb'), 'fb');
  assert.equal(normalizeListenHost('   ', 'fb'), 'fb');
  assert.equal(normalizeListenHost(undefined, 'fb'), 'fb');
  assert.equal(normalizeListenHost(123, 'fb'), 'fb');
  assert.equal(normalizeListenHost('192.168.1.', 'fb'), 'fb');
  assert.equal(normalizeListenHost('999.999.999.999', 'fb'), 'fb');
  assert.equal(normalizeListenHost('abc!', 'fb'), 'fb');
  assert.equal(normalizeListenHost('-bad-.example.com', 'fb'), 'fb');
  // 纯数字标签：多半是打错的 IP，按非法退回
  assert.equal(normalizeListenHost('123', 'fb'), 'fb');
  assert.equal(normalizeListenHost('256.1.1.1', 'fb'), 'fb');
  // 超长主机名（>253）退回
  assert.equal(normalizeListenHost(`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(60)}`, 'fb'), 'fb');
});

test('normalizeListenPort: 常规高位端口收下，含数字字符串', () => {
  assert.equal(normalizeListenPort(8787, 1), 8787);
  assert.equal(normalizeListenPort('8787', 1), 8787);
  assert.equal(normalizeListenPort(1024, 1), 1024);
  assert.equal(normalizeListenPort(65535, 1), 65535);
});

test('normalizeListenPort: 特权端口 / 越界 / 非整数退回 fallback', () => {
  assert.equal(normalizeListenPort(80, 1), 1);
  assert.equal(normalizeListenPort(443, 1), 1);
  assert.equal(normalizeListenPort(1023, 1), 1);
  assert.equal(normalizeListenPort(65536, 1), 1);
  assert.equal(normalizeListenPort(0, 1), 1);
  assert.equal(normalizeListenPort(-1, 1), 1);
  assert.equal(normalizeListenPort(Number.NaN, 1), 1);
  assert.equal(normalizeListenPort('abc', 1), 1);
  assert.equal(normalizeListenPort(1.5, 1), 1);
  assert.equal(normalizeListenPort(undefined, 1), 1);
  assert.equal(PRIVILEGED_PORT_MAX, 1024);
});

test('normalizeListenPort: 弱端口与常见服务端口退回 fallback', () => {
  for (const weak of [1080, 3306, 6379, 8080, 8888, 1111, 1234, 12345, 54321, 27017]) {
    assert.equal(normalizeListenPort(weak, 1), 1, `port ${weak} should be blocked`);
  }
});
