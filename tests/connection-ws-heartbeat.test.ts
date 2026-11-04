/**
 * WS 协议级心跳：ws 库 ping/pong 帧的判死与保活。
 * 「死链」用完成握手后黑洞流量的裸 TCP 对端模拟（半开 TCP：不发 FIN、不回 pong）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { ForwardWsClient } from '../src/connection/forward-ws.client.js';
import { OneBotWsServer } from '../src/connection/onebot-ws.server.js';
import { Logger } from '../src/core/logger.js';
import type { ConnectionConfig } from '../src/core/types.js';

const logger = new Logger('[test] ', 'error', 'system');

function conn(over: Partial<ConnectionConfig>): ConnectionConfig {
  return {
    id: 'hb1',
    name: '心跳测试',
    type: 'onebot',
    mode: 'reverse',
    host: '127.0.0.1',
    port: 0,
    accessToken: '',
    enable: true,
    ...over,
  };
}

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 分块缓冲到出现空行，避免握手报文被 TCP 拆包切碎 */
function readHead(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const onChunk = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      socket.off('data', onChunk);
      resolve(buf.slice(0, idx).toString());
    };
    socket.on('data', onChunk);
  });
}

/** 完成 WS 握手后黑洞一切流量：不回 pong、不发 close —— 半开 TCP 的进程内模拟 */
function startDeadWsServer(): Promise<{
  server: net.Server;
  port: number;
  /** 强制断开全部存量连接（Node 24 的 net.Server 没有 closeAllConnections） */
  destroyAll: () => void;
}> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      void readHead(socket).then((head) => {
        const key = /Sec-WebSocket-Key: (.+)$/im.exec(head)?.[1]?.trim();
        if (!key) {
          socket.destroy();
          return;
        }
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Connection: Upgrade\r\n'
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.resume(); // 吞掉后续帧（ping 在内），永不回应
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({
        server,
        port: addr.port,
        destroyAll: () => {
          for (const s of sockets) s.destroy();
        },
      });
    });
    server.on('error', reject);
  });
}

/** 先占住再释放的空闲端口（OneBotWsServer 不暴露实际监听端口，只能预先挑好） */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address() as net.AddressInfo;
      srv.close(() => resolve(addr.port));
    });
    srv.on('error', reject);
  });
}

/** 服务端 start() 是异步监听，连不上就稍等重试 */
async function connectWs(url: string): Promise<WebSocket> {
  for (let i = 0; i < 50; i++) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      });
    } catch {
      await wait(20);
    }
  }
  throw new Error(`测试内始终连不上 ${url}`);
}

test('正向 WS：对端健康回 pong，心跳不误杀连接且 ping 持续发出', async () => {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.on('listening', r));
  const addr = wss.address() as net.AddressInfo;
  let pings = 0;
  wss.on('connection', (ws) => {
    ws.on('ping', () => {
      pings += 1;
    });
  });

  let resolveOpen!: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const client = new ForwardWsClient({
    connection: conn({ mode: 'forward', port: addr.port }),
    logger,
    autoReconnect: false,
    heartbeatIntervalMs: 30,
    onReady: () => resolveOpen(),
  });
  client.start();
  await opened;
  await wait(300);

  assert.equal(client.isConnected, true, '健康链路不该被心跳断开');
  assert.ok(pings >= 3, `服务端应收到多次协议级 ping，实际 ${pings}`);

  client.stop();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
});

test('正向 WS：对端黑洞不回 pong → 判死 terminate 并进入既有重连状态机', async () => {
  const dead = await startDeadWsServer();
  const events: string[] = [];
  let resolveOpen!: () => void;
  const opened = new Promise<void>((r) => {
    resolveOpen = r;
  });
  const client = new ForwardWsClient({
    connection: conn({ mode: 'forward', port: dead.port, reconnectIntervalMs: 500 }),
    logger,
    autoReconnect: true,
    heartbeatIntervalMs: 30,
    onReady: () => {
      events.push('ready');
      resolveOpen();
    },
    onDisconnect: () => events.push('disconnect'),
  });
  client.start();
  await opened;

  // 30ms × 3 个周期 ≈ 90ms 判死；重连间隔 500ms，断言窗口内不会发生第二次连接
  await wait(400);

  assert.equal(client.isConnected, false, '死链应被心跳判死');
  assert.ok(events.includes('disconnect'), '应触发 onDisconnect');
  const rs = client.getReconnectStatus();
  assert.ok(rs.attempts >= 1, `应进入既有重连状态机，实际 attempts=${rs.attempts}`);
  assert.equal(rs.reconnecting, true, '判死后应排队自动重连');

  // 先断服务端 socket：让客户端 'close' 事件走完既有状态机后（此时 this.ws 已置空），
  // 再 stop() 清掉重连定时器 —— 避免对半开链路发 close 帧挂住 30s 关闭超时
  dead.destroyAll();
  await wait(50);
  client.stop();
  await new Promise<void>((r) => dead.server.close(() => r()));
});

test('反向 WS：客户端健康回 pong，心跳不误杀连接且 ping 持续发出', async () => {
  const port = await freePort();
  let resolveConnect!: () => void;
  const serverConnected = new Promise<void>((r) => {
    resolveConnect = r;
  });
  let disconnects = 0;
  const server = new OneBotWsServer({
    connection: conn({ port }),
    logger,
    heartbeatIntervalMs: 30,
    onClientConnect: () => resolveConnect(),
    onClientDisconnect: () => {
      disconnects += 1;
    },
  });
  server.start();

  const ws = await connectWs(`ws://127.0.0.1:${port}`);
  ws.on('error', () => {});
  let serverPings = 0;
  ws.on('ping', () => {
    serverPings += 1;
  });
  await serverConnected;
  await wait(300);

  assert.equal(server.isConnected, true, '健康客户端不该被心跳断开');
  assert.equal(disconnects, 0);
  assert.ok(serverPings >= 3, `客户端应收到多次协议级 ping，实际 ${serverPings}`);

  server.stop();
  ws.terminate();
});

test('反向 WS：客户端黑洞不回 pong → 服务端 terminate 死链并触发断开回调', async () => {
  const port = await freePort();
  let disconnects = 0;
  const server = new OneBotWsServer({
    connection: conn({ port }),
    logger,
    heartbeatIntervalMs: 30,
    onClientDisconnect: () => {
      disconnects += 1;
    },
  });
  server.start();

  // 裸 TCP 客户端：完成握手后黑洞，不回 pong
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  socket.on('error', () => {});
  const key = crypto.randomBytes(16).toString('base64');
  socket.write(
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n`
    + `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const head = await readHead(socket);
  assert.ok(head.includes('101'), '裸客户端应完成握手才进入心跳观察期');
  socket.resume(); // 吞掉 ping，永不回应

  // 30ms × 2 周期 ≈ 60ms 判死，留足裕量
  await wait(400);

  assert.equal(server.isConnected, false, '死链应被服务端心跳 terminate');
  assert.equal(disconnects, 1, '应触发 onClientDisconnect');

  socket.destroy();
  server.stop();
});
