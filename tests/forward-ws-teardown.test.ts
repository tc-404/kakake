/**
 * 回归测试：连接开关在 WebSocket 仍处于 CONNECTING（握手未完成）时关闭，
 * 不得拖崩进程。
 *
 * 旧实现 destroySocket() 先 removeAllListeners() 把 error 监听也摘掉，
 * 再对 CONNECTING 的 socket 调 close()/terminate()；ws 内部 abortHandshake
 * 会在 nextTick 里 emit('error', <WebSocket was closed before the connection was established>)，
 * 因已无 error 监听，Node 以「未处理的 error 事件」直接崩溃。
 *
 * 本测试用一个「接受连接但永远不回握手」的裸 TCP 服务端把 socket 钉在 CONNECTING，
 * 随后立即 stop()，并在测试期间捕获 uncaughtException——
 * 若崩溃发生说明 error 监听被摘掉，用例失败；修复后 error 监听被保留，错误被兜底处理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { ForwardWsClient } from '../src/connection/forward-ws.client.js';
import { Logger } from '../src/core/logger.js';
import type { ConnectionConfig } from '../src/core/types.js';

const logger = new Logger('[test] ', 'error', 'system');
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'tgdown1',
    name: '开关回归测试',
    type: 'onebot',
    mode: 'forward',
    host: '127.0.0.1',
    port: 0,
    accessToken: '',
    enable: true,
    ...over,
  };
}

test('stop() 在 CONNECTING 状态下不应触发未处理的 error 崩溃', async () => {
  // 接受连接但从不回应：把 ws 客户端钉在 CONNECTING
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  let unhandledAbortError = false;
  const onUncaught = (err: Error): void => {
    if (/WebSocket was closed before the connection was established/.test(err.message)) {
      unhandledAbortError = true;
    }
  };
  process.on('uncaughtException', onUncaught);

  const client = new ForwardWsClient({
    connection: conn({ host: '127.0.0.1', port }),
    logger,
    autoReconnect: false,
  });

  try {
    client.start();
    // 立即关闭：此时底层 socket 仍在 CONNECTING，旧实现会在此崩进程
    client.stop();
    // 让 abortHandshake 的 nextTick(emitErrorAndClose) 跑完
    await wait(150);
  } finally {
    process.removeListener('uncaughtException', onUncaught);
    try {
      client.stop();
    } catch {
      /* 二次 stop 忽略 */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.strictEqual(
    unhandledAbortError,
    false,
    'stop() 在 CONNECTING 状态下必须保留 error 监听，避免 abortHandshake 的 error 事件裸奔拖崩进程',
  );
});

test('stop() 在 CONNECTING 状态下不应抛出同步异常', async () => {
  const server = net.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;

  const client = new ForwardWsClient({
    connection: conn({ host: '127.0.0.1', port }),
    logger,
    autoReconnect: false,
  });

  let threw = false;
  try {
    client.start();
    client.stop();
    await wait(50);
  } catch {
    threw = true;
  } finally {
    try {
      client.stop();
    } catch {
      /* 忽略 */
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.strictEqual(threw, false, 'stop() 在 CONNECTING 状态下不应同步抛错');
});
