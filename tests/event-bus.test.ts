import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/event/event-bus.js';

test('on/emit 基本派发', async () => {
  const bus = new EventBus();
  const got: unknown[] = [];
  bus.on('e', (p) => { got.push(p); });
  await bus.emit('e', 42);
  assert.deepEqual(got, [42]);
});

test('once 只触发一次并自动注销', async () => {
  const bus = new EventBus();
  let n = 0;
  bus.once('e', () => { n += 1; });
  await bus.emit('e');
  await bus.emit('e');
  assert.equal(n, 1);
});

test('同事件多个处理器并发执行，单个抛错不影响其他', async () => {
  const bus = new EventBus();
  const got: string[] = [];
  bus.on('e', () => { throw new Error('boom'); });
  bus.on('e', (p) => { got.push(String(p)); });
  await bus.emit('e', 'ok');
  assert.deepEqual(got, ['ok']);
});

test('emitHierarchy 各层级都会收到', async () => {
  const bus = new EventBus();
  const hits: string[] = [];
  bus.on('onebot/message', () => { hits.push('leaf'); });
  bus.on('onebot', () => { hits.push('root'); });
  await bus.emitHierarchy('onebot/message', {});
  assert.deepEqual(hits.sort(), ['leaf', 'root']);
});

test('emitHierarchy 层级并行：短层级不再等待慢层级', async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on('a/b/c', async () => {
    await new Promise((r) => setTimeout(r, 20));
    order.push('c');
  });
  bus.on('a', () => { order.push('a'); });
  await bus.emitHierarchy('a/b/c');
  assert.equal(order[0], 'a');
});
