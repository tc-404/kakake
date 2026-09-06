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

export function resolveConnVisual(conn: ConnectionStatus): {
  key: ConnVisualStatus;
  label: string;
  variant: 'secondary' | 'success' | 'warning' | 'destructive' | 'default';
  failed: boolean;
} {
  if (!conn.enable) {
    return { key: 'disabled', label: '未启用', variant: 'secondary', failed: false };
  }
  if (conn.connected) {
    const label =
      conn.type === 'weixin_bot'
        ? '长轮询中'
        : conn.type === 'qq_official'
          ? conn.mode === 'https'
            ? '回调已就绪'
            : '已连接腾讯'
          : conn.mode === 'http' || conn.mode === 'http_sse' || conn.mode === 'http_client'
            ? '已就绪'
            : isOutboundMode(conn.mode)
              ? '已连接'
              : '已连入';
    return { key: 'connected', label, variant: 'success', failed: false };
  }
  if (conn.type === 'weixin_bot') {
    if (!conn.weixinLoggedIn) {
      return { key: 'waiting', label: '未扫码登录', variant: 'warning', failed: false };
    }
    return { key: 'connecting', label: '轮询启动中', variant: 'warning', failed: false };
  }
  if (conn.type === 'qq_official') {
    if (conn.mode === 'https') {
      return { key: 'waiting', label: '等待腾讯回调', variant: 'warning', failed: false };
    }
    return { key: 'connecting', label: '连接中', variant: 'warning', failed: false };
  }
  if (isOutboundMode(conn.mode) && conn.reconnectAbandoned) {
    return { key: 'failed', label: '重连已停止', variant: 'destructive', failed: true };
  }
  if (isOutboundMode(conn.mode)) {
    const attempts = conn.reconnectAttempts ?? 0;
    if (conn.reconnecting || attempts > 0) {
      return {
        key: 'connecting',
        label: '重连中',
        variant: 'warning',
        failed: false,
      };
    }
    return { key: 'connecting', label: '连接中', variant: 'warning', failed: false };
  }
  if (conn.mode === 'http' || conn.mode === 'http_sse') {
    return { key: 'waiting', label: '启动中', variant: 'warning', failed: false };
  }
  return { key: 'waiting', label: '等待连接', variant: 'warning', failed: false };
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

