import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchExistingConnection,
  mergePluginSwitches,
} from '../src/core/connection-import.js';
import {
  connectionFingerprint,
  hasResolvedAccount,
  type ConnectionConfig,
} from '../src/core/types.js';

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'a1b2c3d4',
    name: '测试',
    type: 'onebot',
    mode: 'reverse',
    host: '0.0.0.0',
    port: 6700,
    accessToken: '',
    enable: true,
    ...over,
  };
}

test('OneBot：账号+地址+端口+密钥 四要素全同 → 判定为同一条（覆盖）', () => {
  const existing = [conn({ botUin: '10001', host: '0.0.0.0', port: 6700, accessToken: 'tok' })];
  const incoming = conn({ id: 'zzzz', name: '改名了', botUin: '10001', host: '0.0.0.0', port: 6700, accessToken: 'tok' });
  assert.ok(matchExistingConnection(existing, incoming), '四要素全同应命中');
});

test('OneBot：同账号但端口不同 → 不算同一条（新增，另一个接入点）', () => {
  const existing = [conn({ botUin: '10001', host: '0.0.0.0', port: 6700 })];
  const incoming = conn({ botUin: '10001', host: '0.0.0.0', port: 6701 });
  assert.equal(matchExistingConnection(existing, incoming), null, '换端口应算新连接');
});

test('OneBot：同账号但地址不同 → 不算同一条（新增）', () => {
  const existing = [conn({ botUin: '10001', host: '0.0.0.0', port: 6700 })];
  const incoming = conn({ botUin: '10001', host: '127.0.0.1', port: 6700 });
  assert.equal(matchExistingConnection(existing, incoming), null, '换地址应算新连接');
});

test('OneBot：同地址同端口但密钥不同 → 不算同一条', () => {
  const existing = [conn({ botUin: '10001', host: '0.0.0.0', port: 6700, accessToken: 'AAA' })];
  const incoming = conn({ botUin: '10001', host: '0.0.0.0', port: 6700, accessToken: 'BBB' });
  assert.equal(matchExistingConnection(existing, incoming), null);
});

test('OneBot：导入项还没账号时，退化成 地址+端口+密钥 匹配', () => {
  // 本机这条已连上、回填了 botUin；导入的那份导出时还没连上，botUin 是空的
  const existing = [conn({ botUin: '10001', host: '0.0.0.0', port: 6700, accessToken: 'tok' })];
  const incoming = conn({ id: 'new', host: '0.0.0.0', port: 6700, accessToken: 'tok' });
  assert.ok(matchExistingConnection(existing, incoming), '没账号时应按地址+端口+密钥兜底命中');
});

test('OneBot：两边都没账号且地址不同 → 不命中', () => {
  const existing = [conn({ host: '0.0.0.0', port: 6700 })];
  const incoming = conn({ host: '127.0.0.1', port: 6700 });
  assert.equal(matchExistingConnection(existing, incoming), null);
});

test('官方 / KOOK / 微信：按账号 id 判定', () => {
  const official = conn({ id: 'x', type: 'qq_official', appId: '1905617227' });
  assert.ok(matchExistingConnection([official], conn({ id: 'y', type: 'qq_official', appId: '1905617227' })));
  assert.equal(matchExistingConnection([official], conn({ type: 'qq_official', appId: '999999' })), null);

  const kook = conn({ id: 'k', type: 'kook', kookBotUserId: 'bot-1' });
  assert.ok(matchExistingConnection([kook], conn({ type: 'kook', kookBotUserId: 'bot-1' })));
  assert.equal(matchExistingConnection([kook], conn({ type: 'kook', kookBotUserId: 'bot-2' })), null);

  const wx = conn({ id: 'w', type: 'weixin_bot', weixinAccountId: 'ilink-1' });
  assert.ok(matchExistingConnection([wx], conn({ type: 'weixin_bot', weixinAccountId: 'ilink-1' })));
  assert.equal(matchExistingConnection([wx], conn({ type: 'weixin_bot', weixinAccountId: 'ilink-2' })), null);
});

test('不同协议不会互相命中', () => {
  const official = conn({ id: 'o', type: 'qq_official', appId: '123' });
  // 同样的数字串，但一个是 onebot 的 botUin、一个是官方的 appId
  assert.equal(matchExistingConnection([official], conn({ type: 'onebot', botUin: '123' })), null);
});

test('插件开关合并：写了的以新为准，没写到的保留原状', () => {
  const current = { 'GF-plugin-a': true, 'GF-plugin-b': true };
  const incoming = { 'GF-plugin-a': false, 'GF-plugin-c': true };
  const merged = mergePluginSwitches(current, incoming);
  assert.equal(merged['GF-plugin-a'], false, '文件里写了的以文件为准（开→关）');
  assert.equal(merged['GF-plugin-b'], true, '文件里没提到的保持原状，不能被关掉');
  assert.equal(merged['GF-plugin-c'], true, '新增的开关要写进去');
});

test('插件开关合并：空 / 非法输入不炸', () => {
  assert.deepEqual(mergePluginSwitches(undefined, undefined), {});
  assert.deepEqual(mergePluginSwitches({ a: true }, undefined), { a: true });
  assert.deepEqual(mergePluginSwitches(undefined, { '': true }), {}, '空插件名应跳过');
});

test('hasResolvedAccount：OneBot 看 botUin，其余看各自账号字段', () => {
  assert.equal(hasResolvedAccount(conn({ botUin: '10001' })), true);
  assert.equal(hasResolvedAccount(conn({})), false);
  assert.equal(hasResolvedAccount(conn({ botUin: '   ' })), false);
  assert.equal(hasResolvedAccount(conn({ type: 'qq_official', appId: '1' })), true);
  assert.equal(hasResolvedAccount(conn({ type: 'kook', kookBotUserId: 'x' })), true);
  assert.equal(hasResolvedAccount(conn({ type: 'weixin_bot', weixinAccountId: 'y' })), true);
});

test('connectionFingerprint：四要素任一不同，指纹就不同', () => {
  const base = conn({ botUin: '1', host: 'h', port: 1, accessToken: 't' });
  const fpBase = connectionFingerprint(base);
  assert.notEqual(fpBase, connectionFingerprint(conn({ botUin: '2', host: 'h', port: 1, accessToken: 't' })));
  assert.notEqual(fpBase, connectionFingerprint(conn({ botUin: '1', host: 'h2', port: 1, accessToken: 't' })));
  assert.notEqual(fpBase, connectionFingerprint(conn({ botUin: '1', host: 'h', port: 2, accessToken: 't' })));
  assert.notEqual(fpBase, connectionFingerprint(conn({ botUin: '1', host: 'h', port: 1, accessToken: 't2' })));
  assert.equal(fpBase, connectionFingerprint(conn({ botUin: '1', host: 'h', port: 1, accessToken: 't', name: '改名不影响' })));
});
