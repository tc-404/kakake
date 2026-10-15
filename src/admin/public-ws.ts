import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import { configService } from '../core/config.service.js';
import { subscribeLogs } from '../core/log-store.js';
import { eventBus } from '../event/event-bus.js';
import { rootLogger } from '../core/logger.js';
import { buildPublicOverview } from './public-overview.js';

/**
 * 外放 API 的 WebSocket 实时推送。
 *
 * 挂在主服务同一 IP + 端口上（路径 /api/public/ws），与 HTTP 接口共享
 * 「外放 API 开关」这一唯一边界：
 *  - 开关关闭：拒绝升级（返回 403），并主动断开已连接的客户端；
 *  - 开关开启：任意能连到本端口的来源都可连接（不校验来源 IP），
 *    监听 0.0.0.0 时同局域网设备也能连。
 *
 * 推送时机：连上即发一份快照；之后「账号状态 / 日志计数变化时」推送（合并节流），
 * 外加每 5 秒一次心跳兜底。客户端只读，发来的消息一律忽略。
 */

const WS_PATH = '/api/public/ws';
const HEARTBEAT_MS = 5000;
const COALESCE_MS = 300;

export function attachPublicWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  const pathnameOf = (req: IncomingMessage): string => {
    try {
      return new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      return '';
    }
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    // 只处理外放 API 的路径，其余升级请求原样放过（本端口目前无其它 WS 端点）
    if (pathnameOf(req) !== WS_PATH) return;

    if (!configService.getConfig().publicApiEnabled) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  const sendTo = (ws: WebSocket, payload: string): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(payload);
    } catch {
      /* 单个客户端发送失败不影响其它人 */
    }
  };

  const broadcast = (): void => {
    if (clients.size === 0) return;
    const payload = JSON.stringify(buildPublicOverview());
    for (const ws of clients) sendTo(ws, payload);
  };

  // 状态 / 计数变化 → 合并节流后推送，避免抖动风暴
  let pending: ReturnType<typeof setTimeout> | null = null;
  const scheduleBroadcast = (): void => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      broadcast();
    }, COALESCE_MS);
  };

  const offConn = eventBus.on('connection/status', scheduleBroadcast);
  const offReady = eventBus.on('connection/ready', scheduleBroadcast);
  const offDisc = eventBus.on('connection/disconnect', scheduleBroadcast);
  const offLog = subscribeLogs((entry) => {
    if (
      entry.category === 'event'
      || entry.category === 'gf_event'
      || entry.category === 'action'
      || entry.category === 'gf_action'
    ) {
      scheduleBroadcast();
    }
  });

  // 心跳兜底：顺带在开关被关闭时主动清场
  const heartbeat = setInterval(() => {
    if (!configService.getConfig().publicApiEnabled) {
      for (const ws of clients) {
        try {
          ws.close(1013, '外放 API 已关闭');
        } catch {
          /* ignore */
        }
      }
      clients.clear();
      return;
    }
    broadcast();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    sendTo(ws, JSON.stringify(buildPublicOverview()));
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => {
      clients.delete(ws);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
    // 只读接口：忽略客户端发来的任何消息
  });

  // 主进程退出前清理订阅（正常长驻，一般不会触发）
  const cleanup = (): void => {
    offConn();
    offReady();
    offDisc();
    offLog();
    clearInterval(heartbeat);
  };
  process.once('exit', cleanup);

  rootLogger.info(`[外放API] WebSocket 已就绪：${WS_PATH}（需在设置页开启「外放 API」）`);
}
