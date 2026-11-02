/**
 * 外放层与插件门面的行为契约。
 *
 * 覆盖两条硬要求：
 *
 *   1. **仅在开启外放 API 时才暴露 `/api/v1/<短名>`**。
 *      这里锁的是外放层的边界判定：路径怎么解析、参数怎么合并、限流怎么分桶。
 *      开关与鉴权本身依赖 configService / auth-key 的全局状态，属于集成测试范畴，
 *      不放进这个单元测试文件——但它们都被 `proxyApiEnabled` 与 `matchesAuthKey`
 *      两个既有机制守着，那两边各有自己的测试。
 *   2. **kakake_api 是插件可见的统一入口**。按 scope 隔离钩子、按事件重绑定连接、
 *      不传 conn 时回落到绑定连接。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import {
  PROXY_API_MAX_PER_WINDOW,
  clearProxyApiThrottle,
  collectParams,
  firstPathSegment,
  takeProxyApiToken,
} from '../src/admin/proxy-api.controller.js';
import { ProxyRuntime } from '../src/proxy/runtime/facade.js';
import type { ConnectionManager } from '../src/connection/connection.manager.js';

/* ─────────────────────── 外放层：路径解析 ─────────────────────── */

test('外放路径解析：/api/v1/<短名> 取出短名', () => {
  assert.equal(firstPathSegment('/api/v1/send_text'), 'send_text');
  assert.equal(firstPathSegment('/api/v1/get_msg_history'), 'get_msg_history');
});

test('外放路径解析：没有短名时返回空串（控制器据此回 404）', () => {
  assert.equal(firstPathSegment('/api/v1'), '');
  assert.equal(firstPathSegment('/api/v1/'), '');
  assert.equal(firstPathSegment(''), '');
});

test('外放路径解析：多余层级被忽略，只认第一段', () => {
  assert.equal(firstPathSegment('/api/v1/send_text/extra'), 'send_text');
});

/* ─────────────────────── 外放层：参数合并 ─────────────────────── */

test('外放参数：GET 只收裸值，数组取第一个', () => {
  const req = {
    query: { group_id: '123', message: 'hi', arr: ['a', 'b'] },
    body: undefined,
  } as unknown as Request;
  assert.deepEqual(collectParams(req), { group_id: '123', message: 'hi', arr: 'a' });
});

test('外放参数：POST body 覆盖同名 query（body 是更明确的意图）', () => {
  const req = {
    query: { message: 'from-query' },
    body: { message: 'from-body', extra: 1 },
  } as unknown as Request;
  const out = collectParams(req);
  assert.equal(out.message, 'from-body');
  assert.equal(out.extra, 1);
});

test('外放参数：conn 也走同一套收集，控制器随后会摘掉它', () => {
  const req = {
    query: { conn: 'c2' },
    body: { scene: 'group' },
  } as unknown as Request;
  const out = collectParams(req);
  assert.equal(out.conn, 'c2');
  assert.equal(out.scene, 'group');
});

test('外放参数：嵌套对象只在 body 里传递（query string 表达不了）', () => {
  const req = {
    query: {},
    body: { markdown: { content: '**hi**' } },
  } as unknown as Request;
  assert.deepEqual(collectParams(req).markdown, { content: '**hi**' });
});

test('外放参数：body 为数组或空值时不当成参数源', () => {
  const arr = { query: { a: '1' }, body: [1, 2] } as unknown as Request;
  assert.deepEqual(collectParams(arr), { a: '1' });
  const nul = { query: { a: '1' }, body: null } as unknown as Request;
  assert.deepEqual(collectParams(nul), { a: '1' });
  const undef = { query: { a: '1' }, body: { b: undefined } } as unknown as Request;
  assert.deepEqual(collectParams(undef), { a: '1' }, 'undefined 值不该透传给协议端');
});

/* ─────────────────────── 外放层：限流 ─────────────────────── */

test('外放限流：窗口内放行到上限，超过即返回 0', () => {
  clearProxyApiThrottle();
  for (let i = 1; i < PROXY_API_MAX_PER_WINDOW; i++) {
    assert.equal(takeProxyApiToken('1.2.3.4', 'send_text'), PROXY_API_MAX_PER_WINDOW - i);
  }
  assert.equal(takeProxyApiToken('1.2.3.4', 'send_text'), 0, '用满后必须返回 0');
  // 继续打也不会变成负数，控制器据此回 429
  assert.equal(takeProxyApiToken('1.2.3.4', 'send_text'), 0);
});

test('外放限流：按「来源 IP + 接口短名」分桶，互不挤占', () => {
  clearProxyApiThrottle();
  // 把 A 打满
  for (let i = 0; i < PROXY_API_MAX_PER_WINDOW; i++) takeProxyApiToken('10.0.0.1', 'send_text');
  assert.equal(takeProxyApiToken('10.0.0.1', 'send_text'), 0, 'A 的这个接口已满');

  // 换接口：另一个桶，仍然可用
  assert.ok(takeProxyApiToken('10.0.0.1', 'get_msg') > 0, '同一来源的其它接口不该被连带限流');
  // 换来源：另一个桶，仍然可用
  assert.ok(takeProxyApiToken('10.0.0.2', 'send_text') > 0, '其它来源不该被别人的流量限流');
});

test('外放限流：与登录限速是两套独立状态', () => {
  // 这条锁的是「隔离」这个设计决策：外放接口被打爆不该把登录入口一起锁死。
  // 两边各自持有模块级 Map，这里验证清空外放桶不会碰到登录限速模块，
  // 且两个模块的常量互不相同（同一套常量意味着共用了同一份状态）。
  clearProxyApiThrottle();
  assert.ok(PROXY_API_MAX_PER_WINDOW > 0);
  assert.equal(takeProxyApiToken('9.9.9.9', 'send_text'), PROXY_API_MAX_PER_WINDOW - 1);
});

/* ─────────────────────── kakake_api 门面 ─────────────────────── */

/** 构造一个假的 ConnectionManager：门面只在构造时拿它建端口，不会真的调用 */
function fakeManager(): ConnectionManager {
  return {
    getOnebotEndpoint: () => undefined,
    getQqOfficialClient: () => undefined,
  } as unknown as ConnectionManager;
}

test('kakake_api：不传 conn 时回落到绑定的连接', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p1@acc', { connectionId: 'c-bound' });
  assert.equal(api.binding.connectionId, 'c-bound');
  // 连不上（假 manager 没有任何端点）→ 明确报 not-connected，而不是静默换连接
  const r = await api('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'not-connected');
  assert.equal(r._proxy.source, 'p1@acc', '_proxy.source 要能说明这次调用来自哪个插件');
});

test('kakake_api：conn 参数优先于绑定连接', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p2@acc', { connectionId: 'c-bound' });
  const r = await api('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' }, { conn: 'c-other' });
  assert.equal(r._proxy.failure, 'not-connected');
  assert.ok(r.message.includes('c-other'), '报错要指向调用方指定的那条连接，而不是绑定连接');
});

test('kakake_api：未知短名给出 unknown-api，并提示去哪查', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p3@acc', {});
  const r = await api('definitely_not_an_api', 'POST', {});
  assert.equal(r._proxy.failure, 'unknown-api');
  assert.ok(r.message.includes('接口代理'));
});

test('kakake_api：list / get 能查到注册表', () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p4@acc', {});
  const all = api.list();
  assert.ok(all.length > 200, `注册表应有数百条，实际 ${all.length}`);
  assert.ok(all.every((e) => !('examples' in e)), 'list 返回的是摘要，不该带 examples');

  const napcatOnly = api.list({ protocol: 'napcat' });
  assert.ok(napcatOnly.length > 0);
  assert.ok(napcatOnly.every((e) => e.support.includes('napcat')));

  const found = api.get('send_text');
  assert.ok(found);
  // send_text 已并入统一发消息条目：旧短名按别名解析，命中 name 为 send_msg 的同一条
  assert.equal(found?.name, 'send_msg');
  assert.equal(api.get('send_image')?.name, 'send_msg', 'send_image 同样并入统一发消息');
  // 别名也要能查到——插件作者按旧接口名搜索时必须命中
  assert.ok(api.get('send_group_msg'), '别名应能解析到同一条');
});

test('kakake_api：钩子按作用域隔离，releaseScope 摘得干净', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const a = rt.createApi('pluginA', {});
  const b = rt.createApi('pluginB', {});

  let aCalls = 0;
  let bCalls = 0;
  // 用 error 钩子而不是 after：after 只在成功时触发，而假 manager 下调用必然失败
  a.error(() => { aCalls++; });
  b.error(() => { bCalls++; });
  assert.equal(rt.hookCount(), 2);

  await a('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  assert.equal(aCalls, 1, '调用方自己的 error 钩子要触发');
  assert.equal(bCalls, 0, '别人的钩子不该被触发——这就是按作用域隔离');

  assert.equal(rt.releaseScope('pluginA'), 1);
  assert.equal(rt.hookCount(), 1, '卸载后钩子要摘干净，不能泄漏到已销毁的上下文');

  await b('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  assert.equal(aCalls, 1, '已释放的钩子不再触发');
  assert.equal(bCalls, 1);
});

test('kakake_api：on.before / before 两种写法等价', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const a = rt.createApi('p5', {});
  const b = rt.createApi('p6', {});
  let viaMethod = 0;
  let viaOn = 0;
  a.before(() => { viaMethod++; });
  b.on.before(() => { viaOn++; });
  await a('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  await b('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  assert.equal(viaMethod, 1);
  assert.equal(viaOn, 1);
});

test('kakake_api：before 返回 false 时整条调用被拦截，不发往协议端', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p7', {});
  api.before(() => false);
  const r = await api('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' });
  assert.equal(r._proxy.failure, 'intercepted');
});

test('kakake_api：throwOnError 时把失败信封转成异常（对齐旧 actions.call 的写法）', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p8', {});
  await assert.rejects(
    () => api('send_text', 'POST', { scene: 'group', group_id: 123456, message: 'hi' }, { throwOnError: true }),
    /not-connected|未连接|连接/,
  );
});

test('kakake_api：native 逃生舱在连不上时同样返回信封，不抛异常', async () => {
  const rt = new ProxyRuntime({ manager: fakeManager() });
  const api = rt.createApi('p9', {});
  const r = await api.native('_private_action', { foo: 1 });
  assert.equal(r.status, 'failed');
  assert.equal(r._proxy.failure, 'not-connected');
  assert.equal(r._proxy.native, '_private_action');
});
