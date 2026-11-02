/**
 * 登录限速回归测试：分布式爆破必须被拦住。
 *
 * 这些用例锁的是「只按来源 IP 计数」这个老设计的漏洞——旧实现里攻击者每个
 * IP 只试一次就换，单来源计数永远停在 1，限速形同虚设。所以这里每一条都从
 * **换来源**的角度打，而不是重复打同一个 IP。
 *
 * 判定规则：这个文件任何一条挂了，先怀疑是不是有人把多层守卫改回了单一
 * IP 维度，**不要改断言迁就实现**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import '../src/storage/atomic-file.js';
import { banGate, createSession } from '../src/admin/auth.middleware.js';
import { ensureAuthKey, getAuthKeyKind } from '../src/admin/auth-key.js';
import {
  clearLoginThrottle,
  globalBlockedMs,
  inspectLoginGuard,
  isBannedSource,
  loginGuardSnapshot,
  onGlobalLock,
  recordLoginFailure,
  recordLoginSuccess,
  sourceBlockedMs,
} from '../src/admin/login-throttle.js';
import { PATHS } from '../src/paths.js';

/** 造一批不同来源：模拟「每个 IP 只用一次」的分布式撞库 */
function spreadIps(count: number, start = 1): string[] {
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = 11 + Math.floor((start + i) / 65536) % 200;
    const b = Math.floor(((start + i) % 65536) / 256);
    const c = (start + i) % 256;
    ips.push(`${a}.${b}.${c}.${(i % 254) + 1}`);
  }
  return ips;
}

test.beforeEach(() => {
  clearLoginThrottle();
});

test.after(() => {
  // 可信来源会持久化到 data/login-guard.json，测试结束清掉，别污染本机数据
  clearLoginThrottle();
  try {
    if (fs.existsSync(PATHS.loginGuard)) fs.rmSync(PATHS.loginGuard, { force: true });
  } catch {
    /* 清理失败不致命 */
  }
});

test('同一来源连续失败仍会被锁（单来源死磕的老场景不能丢）', () => {
  // 每次提交的密钥都不同（模拟反复打错不同的字符）：
  // 否则会先撞到「同一错误密钥 6 次」的指纹层，锁的是密钥而不是来源
  for (let i = 0; i < 5; i++) {
    recordLoginFailure('203.0.113.9', '后台登录', `wrong-key-${i}`);
  }
  assert.equal(inspectLoginGuard('203.0.113.9', 'wrong-key-5').blockedMs, 0);

  recordLoginFailure('203.0.113.9', '后台登录', 'wrong-key-5');
  const verdict = inspectLoginGuard('203.0.113.9', 'wrong-key-6');
  assert.ok(verdict.blockedMs > 0, '第 6 次失败后应锁定该来源');
  assert.equal(verdict.reason, 'source');
});

test('每个来源只用一次的分布式撞库：会被全局层拦下', () => {
  // 30 个不同来源各失败一次：单来源计数全是 1，旧实现完全无感
  const ips = spreadIps(30);
  ips.forEach((ip, i) => {
    recordLoginFailure(ip, '后台登录', `guess-${ip}`);
    // 最后一个来源会把「不同来源数」顶到阈值并开启全局冷却，故只验前 29 个
    if (i < 29) {
      assert.equal(inspectLoginGuard(ip).blockedMs, 0, '单个来源只用一次，本不该被锁');
    }
  });

  const snap = loginGuardSnapshot();
  assert.ok(snap.distinctSources >= 30, `应统计到多个不同来源，实际 ${snap.distinctSources}`);
  assert.ok(snap.globalLockedMs > 0, '来源数达阈值后应进入全局冷却');

  // 换一个全新的来源继续打：必须被拒，否则换 IP 就绕过了
  const verdict = inspectLoginGuard('198.51.100.77', 'another-guess');
  assert.ok(verdict.blockedMs > 0, '全局冷却期间新来源必须被拒');
  assert.equal(verdict.reason, 'global');
});

test('来源数未达阈值时不误伤：少量不同来源不进入全局冷却', () => {
  const ips = spreadIps(5);
  for (const ip of ips) {
    recordLoginFailure(ip, '后台登录', `guess-${ip}`);
  }
  const snap = loginGuardSnapshot();
  assert.equal(snap.globalLockedMs, 0, '5 个来源不该触发全局冷却');
  assert.equal(inspectLoginGuard('198.51.100.200').blockedMs, 0);
});

test('同一错误密钥跨来源提交：命中密钥指纹层', () => {
  const ips = spreadIps(6);
  for (let i = 0; i < 5; i++) {
    recordLoginFailure(ips[i]!, '后台登录', 'same-wrong-key');
  }
  // 前 5 次（<6）还不锁
  assert.equal(inspectLoginGuard(ips[5]!, 'same-wrong-key').blockedMs, 0);

  recordLoginFailure(ips[5]!, '后台登录', 'same-wrong-key');
  // 第 6 次起，这个「错误密钥」本身被锁：换任何来源都不好使
  const verdict = inspectLoginGuard('198.51.100.31', 'same-wrong-key');
  assert.ok(verdict.blockedMs > 0, '同一错误密钥跨来源累计应被锁');
  assert.equal(verdict.reason, 'key');

  // 换个密钥（比如正确密钥）不受牵连
  assert.equal(inspectLoginGuard('198.51.100.31', 'a-different-key').blockedMs, 0);
});

test('IPv6 换地址（同一 /64）会被网段层聚合', () => {
  // 一台机器握着一整个 /64，换接口地址不要钱
  const base = '2001:db8:abcd:1234';
  let last = '';
  for (let i = 0; i < 25; i++) {
    const ip = `${base}:${(i % 65535).toString(16)}:${(i * 7 % 65535).toString(16)}`;
    last = ip;
    recordLoginFailure(ip, '后台登录', `guess-${i}`);
  }
  const verdict = inspectLoginGuard(`${base}:dead:beef`, 'guess-x');
  assert.ok(verdict.blockedMs > 0, 'IPv6 同前缀换地址应被网段层拦下');
  assert.equal(verdict.reason, 'network');
  assert.ok(last.includes(':'));
});

test('成功登录过的来源在全局冷却期间仍可登录（不被反锁在门外）', () => {
  // 先把管理员的来源登记为可信
  recordLoginSuccess('203.0.113.55');

  const ips = spreadIps(30);
  for (const ip of ips) {
    recordLoginFailure(ip, '后台登录', `guess-${ip}`);
  }
  assert.ok(loginGuardSnapshot().globalLockedMs > 0, '应已进入全局冷却');

  // 新来源被拒，但可信来源放行
  assert.ok(inspectLoginGuard('198.51.100.91').blockedMs > 0);
  assert.equal(inspectLoginGuard('203.0.113.55').blockedMs, 0, '可信来源不应被全局冷却挡住');
});

test('成功登录会清掉全局账（自己打错几次不该叠加成攻击）', () => {
  const ips = spreadIps(20);
  for (const ip of ips) {
    recordLoginFailure(ip, '后台登录', `guess-${ip}`);
  }
  assert.ok(loginGuardSnapshot().distinctSources >= 20);
  assert.ok(inspectLoginGuard('198.51.100.99').delayMs > 0, '高压期间应有响应延迟');

  recordLoginSuccess('203.0.113.55');
  const snap = loginGuardSnapshot();
  assert.equal(snap.failsInWindow, 0);
  assert.equal(snap.distinctSources, 0);
  assert.equal(snap.globalLockedMs, 0);
  assert.equal(inspectLoginGuard('198.51.100.99').delayMs, 0);
});

test('失败越多响应越慢：延迟随失败次数递增', () => {
  assert.equal(inspectLoginGuard('203.0.113.70').delayMs, 0);
  recordLoginFailure('203.0.113.70', '后台登录', 'k1');
  assert.equal(inspectLoginGuard('203.0.113.70').delayMs, 0, '首次失败不该有延迟');
  recordLoginFailure('203.0.113.70', '后台登录', 'k2');
  const two = inspectLoginGuard('203.0.113.70').delayMs;
  recordLoginFailure('203.0.113.70', '后台登录', 'k3');
  const three = inspectLoginGuard('203.0.113.70').delayMs;
  assert.ok(two > 0 && three > two, `延迟应递增，实际 ${two} → ${three}`);
});

test('清空限速状态后一切归零', () => {
  for (let i = 0; i < 10; i++) {
    recordLoginFailure('203.0.113.80', '后台登录', 'k');
  }
  assert.ok(inspectLoginGuard('203.0.113.80').blockedMs > 0);
  clearLoginThrottle();
  assert.equal(inspectLoginGuard('203.0.113.80').blockedMs, 0);
  assert.equal(loginGuardSnapshot().failsInWindow, 0);
});

function fakeReq(ip: string, pathname: string, headers: Record<string, string> = {}): Request {
  return { ip, socket: { remoteAddress: ip }, path: pathname, headers } as unknown as Request;
}

function fakeRes() {
  const out = { status: 0, body: undefined as unknown, type: '' };
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body; return res; },
    setHeader() { return res; },
    type(t: string) { out.type = t; return res; },
    send(body: unknown) { out.body = body; return res; },
  };
  return { res: res as unknown as Response, out };
}

test('单 IP 触发后整站封禁 30 分钟，其它 IP 不受影响', () => {
  const ip = '203.0.113.201';
  for (let i = 0; i < 8; i++) recordLoginFailure(ip, '后台登录', `wrong-${i}`);
  const remain = sourceBlockedMs(ip);
  assert.ok(remain > 29 * 60 * 1000 && remain <= 30 * 60 * 1000, `锁定时长应为 30 分钟，实际 ${remain}`);
  assert.equal(isBannedSource(ip, {}), true);
  assert.equal(isBannedSource('198.51.100.201', {}), false);
});

test('全局触发后 60 分钟内谁也不信任：整站不可达，本机与内网仍可自救', () => {
  for (const ip of spreadIps(30)) recordLoginFailure(ip, '后台登录', `guess-${ip}`);
  const remain = globalBlockedMs();
  assert.ok(remain > 59 * 60 * 1000 && remain <= 60 * 60 * 1000, `全局封禁应为 60 分钟，实际 ${remain}`);
  assert.equal(isBannedSource('198.51.100.202', {}), true, '全局冷却期间公网来源整站不可达');
  const verdict = inspectLoginGuard('198.51.100.202', 'correct-key');
  assert.ok(verdict.blockedMs > 0, '全局冷却期间任何来源的凭证都不被接受');
  assert.equal(verdict.reason, 'global');
  assert.equal(isBannedSource('127.0.0.1', {}), false);
  assert.equal(inspectLoginGuard('127.0.0.1', 'any-key').blockedMs, 0);
  assert.equal(isBannedSource('192.168.1.9', {}), false, '内网来源不参与整站封禁');
  assert.equal(isBannedSource('10.0.0.7', {}), false);
  assert.equal(inspectLoginGuard('192.168.1.9', 'any-key').blockedMs, 0, '内网来源的凭证仍被接受');
  assert.equal(isBannedSource('192.168.1.9', { 'x-forwarded-for': '1.2.3.4' }), true, '带代理头的内网来源不再豁免');
});

test('全局封禁触发时通知监听器（用于踢掉全部在线会话）', () => {
  let fired = 0;
  onGlobalLock(() => { fired += 1; });
  for (const ip of spreadIps(30)) recordLoginFailure(ip, '后台登录', `guess-${ip}`);
  assert.equal(fired, 1);
  onGlobalLock(() => undefined);
});

test('banGate：封禁期间页面 404、接口 401、登录入口伪装成密码错误', () => {
  const gate = banGate();

  const clean = fakeRes();
  let passed = false;
  gate(fakeReq('198.51.100.203', '/login'), clean.res, () => { passed = true; });
  assert.equal(passed, true);

  const ip = '203.0.113.202';
  for (let i = 0; i < 8; i++) recordLoginFailure(ip, '后台登录', `wrong-${i}`);

  const page = fakeRes();
  let nexted = false;
  gate(fakeReq(ip, '/login'), page.res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(page.out.status, 404);

  const api = fakeRes();
  gate(fakeReq(ip, '/api/status'), api.res, () => undefined);
  assert.equal(api.out.status, 401);

  const login = fakeRes();
  gate(fakeReq(ip, '/api/auth/login'), login.res, () => undefined);
  assert.equal(login.out.status, 401);
  assert.deepEqual(login.out.body, { ok: false, message: '登录密钥错误' });
});

test('banGate：全局冷却期间所有人（除本机）连壳都打不开', () => {
  const gate = banGate();
  for (const ip of spreadIps(30)) recordLoginFailure(ip, '后台登录', `guess-${ip}`);

  for (const pathname of ['/login', '/assets/index.js', '/announcement', '/']) {
    const { res, out } = fakeRes();
    let nexted = false;
    gate(fakeReq('198.51.100.208', pathname), res, () => { nexted = true; });
    assert.equal(nexted, false, `${pathname} 在全局冷却期间不应放行`);
    assert.equal(out.status, 404);
  }

  const local = fakeRes();
  let localNext = false;
  gate(fakeReq('127.0.0.1', '/login'), local.res, () => { localNext = true; });
  assert.equal(localNext, true, '本机回环仍可自救');
});

test('全局冷却期间登录入口伪装成密码错误，不暴露封禁状态', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-mask-'));
  const keyFile = path.join(tmpDir, 'auth-key.json');
  const originalKey = PATHS.authKey;
  (PATHS as unknown as { authKey: string }).authKey = keyFile;
  try {
    const { AuthApiController } = await import('../src/admin/auth-api.controller.js');
    ensureAuthKey('Mask-Test-Key-123');
    for (const ip of spreadIps(30)) recordLoginFailure(ip, '后台登录', `guess-${ip}`);

    const controller = new AuthApiController();
    const out = { status: 0, body: undefined as unknown };
    const res = {
      status(code: number) { out.status = code; return res; },
      json(body: unknown) { out.body = body; return res; },
      setHeader() { return res; },
    };
    const req = { ip: '198.51.100.77', socket: { remoteAddress: '198.51.100.77' }, headers: {} };
    await controller.login({ token: 'Mask-Test-Key-123' }, req as never, res as never);

    assert.equal(out.status, 401);
    assert.deepEqual(out.body, { ok: false, message: '登录密钥错误' });
  } finally {
    (PATHS as unknown as { authKey: string }).authKey = originalKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('首次设置密码时不能沿用初始密钥', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kk-setup-'));
  const keyFile = path.join(tmpDir, 'auth-key.json');
  const originalKey = PATHS.authKey;
  (PATHS as unknown as { authKey: string }).authKey = keyFile;
  try {
    ensureAuthKey();
    // v2 哈希存储拿不回明文：初始密钥用固定种子生成，供「不能沿用初始密钥」用例比对
    const initial = 'Mask-Test-Key-123';
    ensureAuthKey(initial);
    const { AuthApiController } = await import('../src/admin/auth-api.controller.js');
    const controller = new AuthApiController();
    const session = createSession();
    const req = {
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
      headers: { cookie: `kakake_session=${session}` },
    };

    const same = fakeRes();
    controller.setupPassword(req as never, same.res, { password: initial, confirm: initial });
    assert.equal(same.out.status, 400);
    assert.deepEqual(same.out.body, { ok: false, message: '新密码不能与初始密码相同' });
    assert.equal(getAuthKeyKind(), 'initial');

    const different = fakeRes();
    controller.setupPassword(req as never, different.res, {
      password: 'Abcdefgh1!23',
      confirm: 'Abcdefgh1!23',
    });
    assert.deepEqual(different.out.body, { ok: true, needsPasswordSetup: false });
    assert.equal(getAuthKeyKind(), 'custom');
  } finally {
    (PATHS as unknown as { authKey: string }).authKey = originalKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
