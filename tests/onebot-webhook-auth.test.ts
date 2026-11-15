import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/storage/atomic-file.js';
import { checkHttpEventAuth, checkHttpStreamAuth } from '../src/connection/onebot-http.shared.js';
import {
  clearLoginThrottle,
  globalBlockedMs,
  recordLoginFailure,
  sourceBlockedMs,
} from '../src/admin/login-throttle.js';

function req(ip: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: ip } } as never;
}

test.beforeEach(() => {
  clearLoginThrottle();
});

test('本机未配 token 时照常上报与取流', () => {
  assert.equal(checkHttpEventAuth(req('127.0.0.1'), undefined, '').ok, true);
  assert.equal(checkHttpStreamAuth(req('127.0.0.1'), undefined).ok, true);
});

test('公网未配 token 时一律拒绝', () => {
  assert.equal(checkHttpEventAuth(req('203.0.113.7'), undefined, '').ok, false);
  assert.equal(checkHttpStreamAuth(req('203.0.113.7'), undefined).ok, false);
});

test('全局冷却期间未配 token 的连接失效（含本机），配了 token 的照常', () => {
  for (let i = 0; i < 30; i++) recordLoginFailure(`198.51.100.${i + 1}`, '后台登录', `g-${i}`);
  assert.ok(globalBlockedMs() > 0);

  assert.equal(checkHttpEventAuth(req('127.0.0.1'), undefined, '').ok, false);
  assert.equal(checkHttpStreamAuth(req('127.0.0.1'), undefined).ok, false);
  assert.equal(checkHttpEventAuth(req('203.0.113.7'), undefined, '').ok, false);

  const withToken = { authorization: 'Bearer right-token' };
  assert.equal(checkHttpEventAuth(req('203.0.113.8', withToken), 'right-token', '').ok, true);
  assert.equal(checkHttpStreamAuth(req('203.0.113.8', withToken), 'right-token').ok, true);
});

test('外站错 token 计入失败，6 次后该来源被临时拒绝', () => {
  const ip = '203.0.113.9';
  for (let i = 0; i < 5; i++) {
    checkHttpEventAuth(req(ip, { authorization: 'Bearer wrong' }), 'right-token', '');
  }
  assert.equal(sourceBlockedMs(ip), 0);

  checkHttpEventAuth(req(ip, { authorization: 'Bearer wrong' }), 'right-token', '');
  assert.ok(sourceBlockedMs(ip) > 0);
  assert.equal(
    checkHttpEventAuth(req(ip, { authorization: 'Bearer right-token' }), 'right-token', '').ok,
    false,
  );
});

test('本机错 token 不计数也不被拒绝', () => {
  for (let i = 0; i < 12; i++) {
    checkHttpEventAuth(req('127.0.0.1', { authorization: 'Bearer wrong' }), 'right-token', '');
  }
  assert.equal(sourceBlockedMs('127.0.0.1'), 0);
  assert.equal(
    checkHttpEventAuth(req('127.0.0.1', { authorization: 'Bearer right-token' }), 'right-token', '').ok,
    true,
  );
});
