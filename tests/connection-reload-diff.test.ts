/**
 * ConnectionManager.reload() 增量 diff：按 id + 连接指纹只重启变更项。
 * 单元路径用 mock start（真实 start 会绑端口/发起 I/O）+ 真 stop 验证指纹簿记，
 * 端点用假对象直接持引用（真 stop 会把它移出运行表）；
 * 集成路径用真实 start/stop（反向 WS 服务端绑 0 号端口 = 系统分配，本机回环）。
 */
import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { configService } from '../src/core/config.service.js';
import { ConnectionManager } from '../src/connection/connection.manager.js';
import { connectionFingerprint, type ConnectionConfig } from '../src/core/types.js';
import { Logger } from '../src/core/logger.js';

const logger = new Logger('[test] ', 'error', 'system');

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'a1',
    name: '甲',
    type: 'onebot',
    mode: 'reverse',
    host: '127.0.0.1',
    port: 6701,
    accessToken: '',
    enable: true,
    ...over,
  };
}

/** 直接观察/布置运行态私有簿记（endpoints + runningFingerprints） */
interface Internals {
  endpoints: Map<string, unknown>;
  runningFingerprints: Map<string, string>;
}
const internals = (manager: ConnectionManager): Internals =>
  manager as unknown as Internals;

interface FakeEndpoint {
  stopCalls: number;
  stop(): void;
}

/** 用假端点预置运行态（模拟这些连接已在真实 start() 下运行），返回可直接断言的端点引用 */
function seedRunning(
  manager: ConnectionManager,
  connections: ConnectionConfig[],
): Map<string, FakeEndpoint> {
  const internal = internals(manager);
  const refs = new Map<string, FakeEndpoint>();
  for (const c of connections) {
    const ep: FakeEndpoint = {
      stopCalls: 0,
      stop() {
        this.stopCalls += 1;
      },
    };
    refs.set(c.id, ep);
    internal.endpoints.set(c.id, ep);
    internal.runningFingerprints.set(c.id, connectionFingerprint(c));
  }
  return refs;
}

function mockStart(manager: ConnectionManager): { started: string[] } {
  const started: string[] = [];
  mock.method(manager, 'start', (c: ConnectionConfig) => {
    started.push(c.id);
    return undefined as unknown as ReturnType<ConnectionManager['start']>;
  });
  return { started };
}

function stubConnections(list: ConnectionConfig[]): void {
  mock.method(configService, 'getConnections', () => ({ connections: list }));
}

afterEach(() => {
  mock.restoreAll();
});

test('reload：只改备注（指纹不变）→ 谁都不停、谁都不启', () => {
  const manager = new ConnectionManager(logger);
  const eps = seedRunning(manager, [
    conn({ id: 'a1' }),
    conn({ id: 'a2', port: 6702, name: '乙' }),
  ]);
  const { started } = mockStart(manager);
  stubConnections([
    conn({ id: 'a1', name: '甲改了备注' }),
    conn({ id: 'a2', port: 6702, name: '乙也改名' }),
  ]);

  manager.reload();

  const internal = internals(manager);
  assert.equal(eps.get('a1')?.stopCalls, 0, '改备注不应 stop a1');
  assert.equal(eps.get('a2')?.stopCalls, 0, '改备注不应 stop a2');
  assert.equal(internal.endpoints.get('a1'), eps.get('a1'), 'a1 端点对象原样保留');
  assert.equal(internal.endpoints.get('a2'), eps.get('a2'), 'a2 端点对象原样保留');
  assert.deepEqual(started, [], '改备注不应触发任何 start');
});

test('reload：一条连接端口变更 → 只有它被重启', () => {
  const manager = new ConnectionManager(logger);
  const eps = seedRunning(manager, [
    conn({ id: 'a1' }),
    conn({ id: 'a2', port: 6702 }),
  ]);
  const { started } = mockStart(manager);
  stubConnections([conn({ id: 'a1', port: 6801 }), conn({ id: 'a2', port: 6702 })]);

  manager.reload();

  const internal = internals(manager);
  assert.equal(eps.get('a1')?.stopCalls, 1, '指纹变更的 a1 应被 stop');
  assert.equal(eps.get('a2')?.stopCalls, 0, '未变的 a2 不应被 stop');
  assert.equal(internal.endpoints.get('a2'), eps.get('a2'), 'a2 端点保持在线');
  assert.deepEqual(started, ['a1'], '只重启 a1');
});

test('reload：账号绑定变化（botUin）→ 只重启那条', () => {
  const manager = new ConnectionManager(logger);
  const eps = seedRunning(manager, [
    conn({ id: 'a1', botUin: '10001' }),
    conn({ id: 'a2', port: 6702, botUin: '20002' }),
  ]);
  const { started } = mockStart(manager);
  stubConnections([
    conn({ id: 'a1', botUin: '10001' }),
    conn({ id: 'a2', port: 6702, botUin: '29999' }),
  ]);

  manager.reload();

  assert.equal(eps.get('a1')?.stopCalls, 0);
  assert.equal(eps.get('a2')?.stopCalls, 1, '账号变化的 a2 应被重启');
  assert.deepEqual(started, ['a2']);
});

test('reload：删除一条连接 → 被移除且指纹簿记同步清理，另一条不动', () => {
  const manager = new ConnectionManager(logger);
  const eps = seedRunning(manager, [
    conn({ id: 'a1' }),
    conn({ id: 'a2', port: 6702 }),
  ]);
  const { started } = mockStart(manager);
  stubConnections([conn({ id: 'a2', port: 6702 })]);

  manager.reload();

  const internal = internals(manager);
  assert.equal(eps.get('a1')?.stopCalls, 1);
  assert.equal(internal.endpoints.has('a1'), false, 'a1 从运行表移除');
  assert.equal(internal.runningFingerprints.has('a1'), false, '指纹簿记同步清理');
  assert.equal(eps.get('a2')?.stopCalls, 0);
  assert.deepEqual(started, []);
});

test('reload：停用一条 → 被 stop；新增启用一条 → 被 start', () => {
  const manager = new ConnectionManager(logger);
  const eps = seedRunning(manager, [
    conn({ id: 'a1' }),
    conn({ id: 'a2', port: 6702 }),
  ]);
  const { started } = mockStart(manager);
  stubConnections([
    conn({ id: 'a1', enable: false }),
    conn({ id: 'a2', port: 6702 }),
    conn({ id: 'a3', port: 6703 }),
  ]);

  manager.reload();

  assert.equal(eps.get('a1')?.stopCalls, 1, '停用的 a1 应被 stop');
  assert.equal(eps.get('a2')?.stopCalls, 0);
  assert.deepEqual(started, ['a3'], '只有新增的 a3 需要 start（a2 已在线）');
});

test('reload：空运行表（启动路径）→ 全量 start，与旧行为一致', () => {
  const manager = new ConnectionManager(logger);
  const { started } = mockStart(manager);
  stubConnections([conn({ id: 'a1' }), conn({ id: 'a2', port: 6702 })]);

  manager.reload();

  assert.deepEqual(started.sort(), ['a1', 'a2']);
});

test('reload（真实 start/stop）：改备注不重建端点，改端口只重建那条', () => {
  const manager = new ConnectionManager(logger);
  // 端口 0 = 系统分配空闲端口；反向 WS 服务端仅在回环上监听，stop 后释放
  const c1 = conn({ id: 'r1', port: 0, name: '甲' });
  const c2 = conn({ id: 'r2', port: 0, name: '乙' });
  stubConnections([c1, c2]);
  manager.reload();

  const internal = internals(manager);
  const ep1 = internal.endpoints.get('r1') as { stop(): void } | undefined;
  const ep2 = internal.endpoints.get('r2') as { stop(): void } | undefined;
  assert.ok(ep1, 'r1 应已启动');
  assert.ok(ep2, 'r2 应已启动');

  // 给真实端点套 stop 计数（保留原 stop 行为，防止监听端口泄漏）
  const stopCalls = new Map<object, number>();
  for (const ep of [ep1, ep2]) {
    const original = ep.stop.bind(ep);
    stopCalls.set(ep, 0);
    mock.method(ep, 'stop', () => {
      stopCalls.set(ep, (stopCalls.get(ep) ?? 0) + 1);
      original();
    });
  }

  stubConnections([conn({ id: 'r1', port: 0, name: '甲改备注' }), c2]);
  manager.reload();
  assert.equal(internal.endpoints.get('r1'), ep1, '改备注不应重建 r1 端点');
  assert.equal(internal.endpoints.get('r2'), ep2);
  assert.equal(stopCalls.get(ep1), 0);

  stubConnections([conn({ id: 'r1', port: 0, name: '甲改备注' }), conn({ id: 'r2', port: 12345, name: '乙' })]);
  manager.reload();
  assert.notEqual(internal.endpoints.get('r2'), ep2, '改端口应重建 r2 端点');
  assert.equal(stopCalls.get(ep2), 1);

  manager.stopAll();
  assert.equal(internal.endpoints.size, 0);
});
