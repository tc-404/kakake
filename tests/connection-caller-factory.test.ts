/**
 * ConnectionManager 四类 create*ActionCaller 的行为契约（makeActionCaller 工厂化的守护网）：
 * - 未就绪文案逐字一致，且保留历史差异：OneBot 用 adapterName、其余用 adapter || adapterName
 * - 成功只回 data、失败透传异常
 * - action_result 事件四协议命名空间各自正确、payload 形状一致
 */
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionManager } from '../src/connection/connection.manager.js';
import { QqOfficialWsClient } from '../src/connection/qq-official-ws.client.js';
import { WeixinBotClient } from '../src/connection/weixin-bot.client.js';
import { KookGatewayClient } from '../src/connection/kook-gateway.client.js';
import { eventBus } from '../src/event/event-bus.js';
import { Logger } from '../src/core/logger.js';
import type { ConnectionConfig } from '../src/core/types.js';
import type { ActionCaller } from '../src/connection/onebot.types.js';

const logger = new Logger('[test] ', 'error', 'system');

/** eventBus.emit 是异步派发，读断言前先冲掉微任务 */
const flush = () => new Promise<void>((r) => setImmediate(r));

function collect(event: string): { payloads: Record<string, unknown>[]; off: () => void } {
  const payloads: Array<Record<string, unknown>> = [];
  const off = eventBus.on(event, (p) => {
    payloads.push(p as Record<string, unknown>);
  });
  return { payloads, off };
}

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'ep1',
    name: '端点',
    type: 'onebot',
    mode: 'reverse',
    host: '127.0.0.1',
    port: 6701,
    accessToken: '',
    enable: true,
    ...over,
  };
}

function fakeOnebotEndpoint(over: { isConnected?: boolean; impl?: () => Promise<unknown> } = {}) {
  return {
    id: 'ep1',
    name: '端点',
    isConnected: over.isConnected ?? true,
    callAction: over.impl ?? (async () => ({ message_id: 1 })),
    stop: () => {},
  };
}

/** 白盒：把端点直接塞进运行表 */
function seedEndpoint(manager: ConnectionManager, id: string, endpoint: unknown): void {
  (manager as unknown as { endpoints: Map<string, unknown> }).endpoints.set(id, endpoint);
}

afterEach(() => {
  mock.restoreAll();
});

/* ═════════ OneBot ═════════ */

test('OneBot：未连接报错文案用 adapterName（历史行为：不含 adapter）', async () => {
  const manager = new ConnectionManager(logger);
  const caller = manager.createActionCaller();
  await assert.rejects(
    () => caller('send_msg', {}, 'my_adapter'),
    (err: unknown) => err instanceof Error
      && err.message === '[plugin_manager] OneBot 未连接，请检查连接管理中的 OneBot 配置',
  );
});

test('OneBot：指定 connectionId 未连接时报「连接 {id}」', async () => {
  const manager = new ConnectionManager(logger);
  const caller = manager.createActionCaller('pm', 'c404');
  await assert.rejects(
    () => caller('send_msg'),
    (err: unknown) => err instanceof Error
      && err.message === '[pm] 连接 c404 未连接，请检查连接管理中的 OneBot 配置',
  );
});

test('OneBot：成功只回 data，onebot/action_result 事件 ok=true', async () => {
  const manager = new ConnectionManager(logger);
  seedEndpoint(manager, 'ep1', fakeOnebotEndpoint());
  const { payloads, off } = collect('onebot/action_result');
  try {
    const caller = manager.createActionCaller('pm', 'ep1');
    const r = await caller('send_msg', { x: 1 }, '适配器A');
    await flush();

    assert.deepEqual(r, { message_id: 1 }, '返回值必须只是 data');
    assert.equal(payloads.length, 1);
    const p = payloads[0]!;
    assert.equal(p.ok, true);
    assert.equal(p.connectionId, 'ep1');
    assert.equal(p.adapter, '适配器A');
    assert.equal(p.action, 'send_msg');
    assert.deepEqual(p.params, { x: 1 });
    assert.deepEqual(p.result, { message_id: 1 });
    assert.equal(p.error, null);
  } finally {
    off();
  }
});

test('OneBot：失败透传异常并 emit ok=false / error=消息', async () => {
  const manager = new ConnectionManager(logger);
  seedEndpoint(manager, 'ep1', fakeOnebotEndpoint({
    impl: async () => {
      throw new Error('boom');
    },
  }));
  const { payloads, off } = collect('onebot/action_result');
  try {
    const caller = manager.createActionCaller('pm', 'ep1');
    await assert.rejects(
      () => caller('send_msg', {}),
      (err: unknown) => err instanceof Error && err.message === 'boom',
    );
    await flush();

    assert.equal(payloads.length, 1);
    const p = payloads[0]!;
    assert.equal(p.ok, false);
    assert.equal(p.result, null);
    assert.equal(p.error, 'boom');
  } finally {
    off();
  }
});

test('OneBot：不带 connectionId 时解析到首个已连接端点', async () => {
  const manager = new ConnectionManager(logger);
  seedEndpoint(manager, 'offline', fakeOnebotEndpoint({ isConnected: false }));
  seedEndpoint(manager, 'online', fakeOnebotEndpoint({ impl: async () => ({ from: 'online' }) }));
  const caller = manager.createActionCaller('pm');
  const r = await caller('get_status');
  assert.deepEqual(r, { from: 'online' });
});

test('createActionCaller：同 (adapterName, connectionId) 复用同一 caller 实例', () => {
  const manager = new ConnectionManager(logger);
  assert.equal(manager.createActionCaller('pm', 'x'), manager.createActionCaller('pm', 'x'));
  assert.notEqual(manager.createActionCaller('pm', 'x'), manager.createActionCaller('pm2', 'x'));
  assert.notEqual(manager.createActionCaller('pm', 'x'), manager.createActionCaller('pm'));
});

/* ═════════ QQ 官方 ═════════ */

function qqClient(): QqOfficialWsClient {
  return new QqOfficialWsClient({
    connection: conn({ id: 'qq1', name: '官方', type: 'qq_official', appId: '1905617227', appSecret: 's' }),
  });
}

test('QQ 官方：未就绪报错文案用 adapter || adapterName（与 OneBot 不同）', async () => {
  const manager = new ConnectionManager(logger);
  const qq = qqClient();
  seedEndpoint(manager, 'qq1', qq);

  const caller = manager.createQqOfficialActionCaller('gf_default', 'qq1');
  await assert.rejects(
    () => caller('send_msg', {}, 'gf_adapter'),
    (err: unknown) => err instanceof Error && err.message === '[gf_adapter] QQ 官方连接未就绪',
  );
  await assert.rejects(
    () => caller('send_msg'),
    (err: unknown) => err instanceof Error && err.message === '[gf_default] QQ 官方连接未就绪',
  );
});

test('QQ 官方：成功回 data 并 emit qq_official/action_result', async () => {
  const manager = new ConnectionManager(logger);
  const qq = qqClient();
  Object.defineProperty(qq, 'isConnected', { get: () => true, configurable: true });
  mock.method(qq, 'callAction', async () => ({ ret: 'ok' }));
  seedEndpoint(manager, 'qq1', qq);

  const { payloads, off } = collect('qq_official/action_result');
  try {
    const r = await manager.createQqOfficialActionCaller('gf', 'qq1')('get_group_info', {});
    await flush();

    assert.deepEqual(r, { ret: 'ok' });
    assert.equal(payloads.length, 1);
    const p = payloads[0]!;
    assert.equal(p.ok, true);
    assert.equal(p.connectionId, 'qq1');
    assert.equal(p.adapter, 'gf');
  } finally {
    off();
  }
});

/* ═════════ 微信 BOT / KOOK ═════════ */

test('微信 BOT：未就绪文案 + 事件命名空间 weixin_bot/action_result', async () => {
  const manager = new ConnectionManager(logger);
  const wx = new WeixinBotClient(conn({ id: 'wx1', type: 'weixin_bot' }));
  seedEndpoint(manager, 'wx1', wx);

  const caller = manager.createWeixinBotActionCaller('wx_default', 'wx1');
  await assert.rejects(
    () => caller('send', {}, 'wx_adapter'),
    (err: unknown) => err instanceof Error && err.message === '[wx_adapter] 微信 BOT 连接未就绪',
  );

  Object.defineProperty(wx, 'isConnected', { get: () => true, configurable: true });
  mock.method(wx, 'callAction', async () => ({ sent: true }));
  const { payloads, off } = collect('weixin_bot/action_result');
  try {
    const r = await caller('send', {});
    await flush();
    assert.deepEqual(r, { sent: true });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.ok, true);
    assert.equal(payloads[0]!.connectionId, 'wx1');
  } finally {
    off();
  }
});

test('KOOK：未就绪文案 + 事件命名空间 kook/action_result', async () => {
  const manager = new ConnectionManager(logger);
  const kook = new KookGatewayClient(conn({ id: 'kk1', type: 'kook' }));
  seedEndpoint(manager, 'kk1', kook);

  const caller = manager.createKookBotActionCaller('ss_default', 'kk1');
  await assert.rejects(
    () => caller('send', {}, 'ss_adapter'),
    (err: unknown) => err instanceof Error && err.message === '[ss_adapter] KOOK 连接未就绪',
  );

  Object.defineProperty(kook, 'isConnected', { get: () => true, configurable: true });
  mock.method(kook, 'callAction', async () => ({ sent: true }));
  const { payloads, off } = collect('kook/action_result');
  try {
    const r = await caller('send', {});
    await flush();
    assert.deepEqual(r, { sent: true });
    assert.equal(payloads.length, 1);
    assert.equal(payloads[0]!.ok, true);
    assert.equal(payloads[0]!.connectionId, 'kk1');
  } finally {
    off();
  }
});

/* ═════════ 类型冒烟 ═════════ */

test('四类 create* 返回值都满足 ActionCaller 形状', () => {
  const manager = new ConnectionManager(logger);
  const callers: ActionCaller[] = [
    manager.createActionCaller(),
    manager.createQqOfficialActionCaller(),
    manager.createWeixinBotActionCaller(),
    manager.createKookBotActionCaller(),
  ];
  for (const c of callers) assert.equal(typeof c, 'function');
});
