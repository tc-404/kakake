import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/storage/atomic-file.js';
import { PATHS } from '../src/paths.js';
import { DEFAULT_CONFIG } from '../src/core/types.js';
import { configService } from '../src/core/config.service.js';
import { checkHttpEventAuth } from '../src/connection/onebot-http.shared.js';
import {
  clearLoginThrottle,
  globalBlockedMs,
  recordLoginFailure,
  sourceBlockedMs,
} from '../src/admin/login-throttle.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-guard-'));
const realConfig = PATHS.config;
(PATHS as unknown as { config: string }).config = path.join(tmpDir, 'config.json');

function setGuard(on: boolean): void {
  configService.saveConfig({ ...DEFAULT_CONFIG, inboundGuard: on });
}

function req(ip: string, headers: Record<string, string> = {}) {
  return { headers, socket: { remoteAddress: ip } } as never;
}

test.beforeEach(() => {
  clearLoginThrottle();
});

test.after(() => {
  (PATHS as unknown as { config: string }).config = realConfig;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('入站防护开启：外站错 token 计数，6 次后该来源被临时拒绝', () => {
  setGuard(true);
  const ip = '203.0.113.61';
  for (let i = 0; i < 6; i++) {
    checkHttpEventAuth(req(ip, { authorization: 'Bearer wrong' }), 'right-token', '');
  }
  assert.ok(sourceBlockedMs(ip) > 0);
});

test('入站防护关闭：外站错 token 不计数、不拒绝，但公网无 token 仍拒', () => {
  setGuard(false);
  const ip = '203.0.113.62';
  for (let i = 0; i < 12; i++) {
    checkHttpEventAuth(req(ip, { authorization: 'Bearer wrong' }), 'right-token', '');
  }
  assert.equal(sourceBlockedMs(ip), 0);
  assert.equal(checkHttpEventAuth(req(ip), undefined, '').ok, false);
  assert.equal(
    checkHttpEventAuth(req(ip, { authorization: 'Bearer right-token' }), 'right-token', '').ok,
    true,
  );
});

test('入站防护关闭时，全局封禁不再影响未配 token 的连接', () => {
  setGuard(false);
  for (let i = 0; i < 30; i++) recordLoginFailure(`198.51.100.${i + 1}`, '后台登录', `g-${i}`);
  assert.ok(globalBlockedMs() > 0);
  assert.equal(checkHttpEventAuth(req('127.0.0.1'), undefined, '').ok, true);

  setGuard(true);
  assert.equal(checkHttpEventAuth(req('127.0.0.1'), undefined, '').ok, false);
});
