type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

/**
 * 轻量事件总线，参考 Koishi 的 ctx.on / ctx.emit 模式
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler as EventHandler);
    return () => this.handlers.get(event)?.delete(handler as EventHandler);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const off = this.on<T>(event, async (payload) => {
      off();
      await handler(payload);
    });
    return off;
  }

  async emit<T = unknown>(event: string, payload?: T): Promise<void> {
    const set = this.handlers.get(event);
    if (!set?.size) return;
    await Promise.allSettled([...set].map(h => h(payload)));
  }

  /** 通配符：onebot/message, onebot/notice 等 */
  async emitHierarchy(event: string, payload?: unknown): Promise<void> {
    const parts = event.split('/');
    for (let i = parts.length; i >= 1; i--) {
      const name = parts.slice(0, i).join('/');
      await this.emit(name, payload);
    }
  }
}

export const eventBus = new EventBus();
