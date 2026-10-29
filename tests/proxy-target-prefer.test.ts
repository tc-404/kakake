import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxyTargetResolver, preferProtocolFromParams } from '../src/proxy/resolve/target.js';
import type { ProxyConnectionView } from '../src/proxy/resolve/target.js';

function view(partial: Partial<ProxyConnectionView>): ProxyConnectionView {
  return { id: 'x', name: 'x', isConnected: true, enable: true, ...partial };
}

test('preferProtocolFromParams：官方 ID 空间参数指向 official', () => {
  const entry = { params: [{ key: 'openid', idSpace: 'openid' }, { key: 'message', idSpace: undefined }] };
  assert.equal(preferProtocolFromParams(entry, { openid: 'A', message: 'hi' }), 'official');
});

test('preferProtocolFromParams：QQ 号参数指向野生', () => {
  const entry = { params: [{ key: 'user_id', idSpace: 'qq_number' }] };
  assert.equal(preferProtocolFromParams(entry, { user_id: 123 }), 'napcat');
});

test('preferProtocolFromParams：两类并存或都没有时不表态', () => {
  const both = { params: [{ key: 'user_id', idSpace: 'qq_number' }, { key: 'openid', idSpace: 'openid' }] };
  assert.equal(preferProtocolFromParams(both, { user_id: 1, openid: 'A' }), undefined);
  const none = { params: [{ key: 'message', idSpace: undefined }] };
  assert.equal(preferProtocolFromParams(none, { message: 'hi' }), undefined);
  assert.equal(preferProtocolFromParams(none, {}), undefined);
});

test('preferProtocolFromParams：未传参数不参与推断', () => {
  const entry = { params: [{ key: 'openid', idSpace: 'openid' }, { key: 'user_id', idSpace: 'qq_number' }] };
  assert.equal(preferProtocolFromParams(entry, { user_id: 1 }), 'napcat');
});

function setup(conns: ProxyConnectionView[]) {
  const ports = {
    listConnections: () => conns,
    detectOnebotImpl: async () => 'napcat' as const,
  };
  return createProxyTargetResolver(ports);
}

test('无 conn：openid 请求在混合连接下优先官方连接', async () => {
  const resolve = setup([
    view({ id: 'ob', name: '野生', type: 'onebot' }),
    view({ id: 'off', name: '官方', type: 'qq_official' }),
  ]);
  const r = await resolve(undefined, 'official');
  assert.ok(r.ok && r.target.connectionId === 'off');
});

test('无 conn：QQ 号请求优先野生连接', async () => {
  const resolve = setup([
    view({ id: 'off', name: '官方', type: 'qq_official' }),
    view({ id: 'ob', name: '野生', type: 'onebot' }),
  ]);
  const r = await resolve(undefined, 'napcat');
  assert.ok(r.ok && r.target.connectionId === 'ob');
});

test('无 conn：无偏好时维持原规则（第一条 OneBot）', async () => {
  const resolve = setup([
    view({ id: 'off', name: '官方', type: 'qq_official' }),
    view({ id: 'ob', name: '野生', type: 'onebot' }),
  ]);
  const r = await resolve(undefined, undefined);
  assert.ok(r.ok && r.target.connectionId === 'ob');
});

test('无 conn：偏好协议无在线连接时回落原规则', async () => {
  const resolve = setup([
    view({ id: 'ob', name: '野生', type: 'onebot' }),
    view({ id: 'off', name: '官方', type: 'qq_official', isConnected: false }),
  ]);
  const r = await resolve(undefined, 'official');
  assert.ok(r.ok && r.target.connectionId === 'ob');
});

test('显式 conn：精确寻址不受偏好影响', async () => {
  const resolve = setup([
    view({ id: 'ob', name: '野生', type: 'onebot' }),
    view({ id: 'off', name: '官方', type: 'qq_official' }),
  ]);
  const r = await resolve('野生', 'official');
  assert.ok(r.ok && r.target.connectionId === 'ob');
  const r2 = await resolve('不存在的连接', 'official');
  assert.ok(!r2.ok);
});
