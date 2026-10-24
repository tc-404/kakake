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
    // 包一层异步：处理器同步抛错时不能打断 map（否则后续处理器不再执行、emit 整体 reject）
    await Promise.allSettled([...set].map(async (h) => {
      try {
        await h(payload);
      } catch {
        // 与 allSettled 对异步拒绝的处理一致：单个处理器异常不影响其他处理器
      }
    }));
  }

  /** 通配符：onebot/message, onebot/notice 等（各层级并行派发，emit 内部已是 allSettled，不会 reject） */
  async emitHierarchy(event: string, payload?: unknown): Promise<void> {
    const parts = event.split('/');
    if (parts.length <= 1) {
      await this.emit(event, payload);
      return;
    }
    await Promise.all(parts.map((_, i) => this.emit(parts.slice(0, i + 1).join('/'), payload)));
  }
}

export const eventBus = new EventBus();
