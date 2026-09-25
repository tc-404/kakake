import { useEffect, useRef } from 'react';

export interface SseMessage {
  type: string;
  data: unknown;
  time: number;
}

export function useEventSource(onMessage: (msg: SseMessage) => void) {
  const handler = useRef(onMessage);
  handler.current = onMessage;

  useEffect(() => {
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource('/api/events', { withCredentials: true });
      es.onmessage = (ev) => {
        try {
          handler.current(JSON.parse(ev.data) as SseMessage);
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        timer = setTimeout(connect, 5000);
      };
    };

    connect();
    return () => {
      es?.close();
      clearTimeout(timer);
    };
  }, []);
}
