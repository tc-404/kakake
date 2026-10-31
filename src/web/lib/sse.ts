import { useEffect, useRef } from 'react';

export interface SseMessage {
  type: string;
  data: unknown;
  time: number;
}

/** 重连退避：5s 起、成功连接后复位 */
const RECONNECT_BASE_MS = 5_000;
/** 重连退避上限 */
const RECONNECT_MAX_MS = 60_000;

export function useEventSource(onMessage: (msg: SseMessage) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = RECONNECT_BASE_MS;
    let disposed = false;

    const connect = () => {
      if (disposed) return;
      // 页面不可见时暂停重连：恢复可见由 visibilitychange 立即补试
      if (typeof document !== 'undefined' && document.hidden) return;
      es = new EventSource('/api/events', { withCredentials: true });
      es.onopen = () => {
        delay = RECONNECT_BASE_MS;
      };
      es.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data) as SseMessage);
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (disposed) return;
        timer = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
    };

    const onVisible = () => {
      if (disposed || document.hidden) return;
      // 连接还活着就不动；半死的连接（connecting/closed）重开，恢复可见立即试一次
      if (es && es.readyState === EventSource.OPEN) return;
      es?.close();
      es = null;
      clearTimeout(timer);
      delay = RECONNECT_BASE_MS;
      connect();
    };

    connect();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisible);
      es?.close();
      clearTimeout(timer);
    };
  }, []);
}
