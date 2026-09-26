import { useEffect, useRef } from 'react';
import type { SimulateEntry } from '@/lib/simulate-types';

/** 订阅某账号的模拟输出实时流 */
export function useSimulateStream(
  accountKey: string | undefined,
  onEntry: (entry: SimulateEntry) => void,
) {
  const handler = useRef(onEntry);
  handler.current = onEntry;

  useEffect(() => {
    if (!accountKey) return;
    let es: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout>;

    const connect = () => {
      es = new EventSource(
        `/api/simulate/stream?accountKey=${encodeURIComponent(accountKey)}`,
        { withCredentials: true },
      );
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data) as { type: string; data?: unknown };
          if (msg.type === 'output' && msg.data) {
            handler.current(msg.data as SimulateEntry);
          }
        } catch { /* ignore */ }
      };
      es.onerror = () => {
        es?.close();
        timer = setTimeout(connect, 4000);
      };
    };

    connect();
    return () => {
      es?.close();
      clearTimeout(timer);
    };
  }, [accountKey]);
}
