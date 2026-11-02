import type { ConnectionStatus } from '@/lib/types';

export type ConnVisualStatus =
  | 'disabled'
  | 'connected'
  | 'connecting'
  | 'failed'
  | 'waiting';

function isOutboundMode(mode: ConnectionStatus['mode']): boolean {
  return mode === 'forward' || mode === 'http_client';
}

/**
 * 判定一条连接的视觉状态。
 *
 * msgKey 只存 i18n key、不存中文：这个函数是模块级纯函数，拿不到 t()，
 * 写死文案的话英文模式下就会漏出一串中文。调用方用 `t(vis.msgKey)` 取文案。
 */
export function resolveConnVisual(conn: ConnectionStatus): {
  key: ConnVisualStatus;
  msgKey: string;
  variant: 'secondary' | 'success' | 'warning' | 'destructive' | 'default';
  failed: boolean;
} {
  if (!conn.enable) {
    return { key: 'disabled', msgKey: 'connections.status.disabled', variant: 'secondary', failed: false };
  }
  if (conn.type === 'qq_official') {
    const isHttps = conn.mode === 'https';
    if (conn.connected) {
      // Webhook 模式下“监听已就绪”不等于平台能推到：没被平台验证过就得说清楚
      if (isHttps && conn.webhookVerified === false) {
        return { key: 'waiting', msgKey: 'connections.status.waitingCallback', variant: 'warning', failed: false };
      }
      return {
        key: 'connected',
        msgKey: isHttps ? 'connections.status.callbackReady' : 'connections.status.connectedTencent',
        variant: 'success',
        failed: false,
      };
    }
    if (conn.reconnectAbandoned) {
      return { key: 'failed', msgKey: 'connections.status.reconnectStopped', variant: 'destructive', failed: true };
    }
    if (isHttps) {
      return { key: 'waiting', msgKey: 'connections.status.waitingCallback', variant: 'warning', failed: false };
    }
    return {
      key: 'connecting',
      msgKey: (conn.reconnectAttempts ?? 0) > 0 ? 'connections.status.reconnecting' : 'connections.status.connecting',
      variant: 'warning',
      failed: false,
    };
  }
  if (conn.type === 'kook') {
    if (!conn.kookReady) {
      return { key: 'waiting', msgKey: 'connections.status.noToken', variant: 'warning', failed: false };
    }
    if (conn.connected) {
      return { key: 'connected', msgKey: 'connections.status.connectedKook', variant: 'success', failed: false };
    }
  }
  if (conn.connected) {
    const msgKey =
      conn.type === 'weixin_bot'
        ? 'connections.status.longPolling'
        : conn.mode === 'http' || conn.mode === 'http_sse' || conn.mode === 'http_client'
          ? 'connections.status.ready'
          : isOutboundMode(conn.mode)
            ? 'connections.status.connected'
            : 'connections.status.linkedIn';
    return { key: 'connected', msgKey, variant: 'success', failed: false };
  }
  if (conn.type === 'weixin_bot') {
    if (!conn.weixinLoggedIn) {
      return { key: 'waiting', msgKey: 'connections.status.notLoggedIn', variant: 'warning', failed: false };
    }
    return { key: 'connecting', msgKey: 'connections.status.pollingStarting', variant: 'warning', failed: false };
  }
  if (isOutboundMode(conn.mode) && conn.reconnectAbandoned) {
    return { key: 'failed', msgKey: 'connections.status.reconnectStopped', variant: 'destructive', failed: true };
  }
  if (isOutboundMode(conn.mode)) {
    const attempts = conn.reconnectAttempts ?? 0;
    if (conn.reconnecting || attempts > 0) {
      return {
        key: 'connecting',
        msgKey: 'connections.status.reconnecting',
        variant: 'warning',
        failed: false,
      };
    }
    return { key: 'connecting', msgKey: 'connections.status.connecting', variant: 'warning', failed: false };
  }
  if (conn.mode === 'http' || conn.mode === 'http_sse') {
    return { key: 'waiting', msgKey: 'connections.status.starting', variant: 'warning', failed: false };
  }
  return { key: 'waiting', msgKey: 'connections.status.waiting', variant: 'warning', failed: false };
}

/** 连接列表排序：在线 > 连接中 > 异常 > 关闭；同级按首次添加时间升序 */
export function sortConnectionsForList(list: ConnectionStatus[]): ConnectionStatus[] {
  const rank = (conn: ConnectionStatus): number => {
    const key = resolveConnVisual(conn).key;
    switch (key) {
      case 'connected':
        return 0;
      case 'connecting':
      case 'waiting':
        return 1;
      case 'failed':
        return 2;
      case 'disabled':
      default:
        return 3;
    }
  };
  return list.slice().sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
}

/**
 * 后端回传的连接类型 / 接入方式标签（modeLabel、typeLabel）是后端写死的中文
 * 常量，英文模式下会原样漏出。这里按原文映射到 i18n key；
 * 没收录的返回 null，调用方回落到后端原文（不至于显示空白）。
 */
const CONN_LABEL_KEY: Record<string, string> = {
  '反向 WS': 'connections.labelReverseWs',
  '正向 WS': 'connections.labelForwardWs',
  'HTTP 服务器': 'connections.labelHttpServer',
  'HTTP SSE 服务器': 'connections.labelHttpSseServer',
  'HTTP 客户端': 'connections.labelHttpClient',
  '官方 HTTPS': 'connections.labelOfficialHttps',
  '官方 WS': 'connections.labelOfficialWs',
  'KOOK 网关': 'connections.labelKookGateway',
  'iLink 长轮询': 'connections.labelIlinkPolling',
  'QQ 官方机器人': 'connections.labelQqOfficial',
  '微信 AI×BOT': 'connections.labelWeixinBot',
  KOOK: 'connections.labelKook',
  OneBot: 'connections.labelOnebot',
};

export function connLabelKey(label?: string | null): string | null {
  const s = String(label ?? '').trim();
  return s ? (CONN_LABEL_KEY[s] ?? null) : null;
}

/** 连接卡片描边：绿在线 / 黄连接中 / 红异常 / 灰关闭无描边 */
export function connBorderClass(key: ConnVisualStatus): string {
  switch (key) {
    case 'connected':
      return 'border-2 border-emerald-500';
    case 'connecting':
    case 'waiting':
      return 'border-2 border-amber-400';
    case 'failed':
      return 'border-2 border-red-500';
    case 'disabled':
    default:
      return 'border-2 border-transparent';
  }
}
