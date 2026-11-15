/**
 * 接口代理的三钩子注册表：before / after / error。
 *
 * 三条设计约束：
 *
 *   1. **before 可以拦截也可以改写**。返回 `false` 表示「别发了」，代理层会合成
 *      `intercepted` 失败信封（不是空返回，也不是异常）；返回一个对象表示「用这组
 *      参数发」；返回 undefined/null 表示放行。
 *   2. **after / error 的异常不许外溢**。钩子是插件写的，一个写崩了不该把整条调用
 *      拖下水——否则「永不空返回」这条铁律会被一个第三方插件的 bug 破坏。
 *   3. **作用域随插件释放**。每个插件注册时带自己的 scope id，插件卸载时
 *      `clearScope` 一次性摘干净，避免钩子泄漏后对着一个已销毁的上下文继续跑。
 */
import type {
  ProxyAfterHook,
  ProxyBeforeHook,
  ProxyErrorHook,
  ProxyFailure,
  ProxyHookCtx,
  ProxyMeta,
  HookUnregister,
} from '../proxy.types.js';

type HookKind = 'before' | 'after' | 'error';

interface HookItem {
  id: number;
  scope: string;
  kind: HookKind;
  fn: ProxyBeforeHook | ProxyAfterHook | ProxyErrorHook;
}

/** 传给 error 钩子的失败描述。与 ProxyErrorHook 第三参的 `err` 字段结构一致。 */
export interface ProxyHookError {
  failure: ProxyFailure;
  message: string;
  meta: ProxyMeta;
}

export class ProxyHookRegistry {
  private seq = 0;
  private items: HookItem[] = [];

  private add(scope: string, kind: HookKind, fn: HookItem['fn']): HookUnregister {
    const id = ++this.seq;
    this.items.push({ id, scope, kind, fn });
    return () => this.remove(id);
  }

  private remove(id: number): void {
    const at = this.items.findIndex((x) => x.id === id);
    if (at >= 0) this.items.splice(at, 1);
  }

  before(scope: string, fn: ProxyBeforeHook): HookUnregister {
    return this.add(scope, 'before', fn);
  }

  after(scope: string, fn: ProxyAfterHook): HookUnregister {
    return this.add(scope, 'after', fn);
  }

  error(scope: string, fn: ProxyErrorHook): HookUnregister {
    return this.add(scope, 'error', fn);
  }

  /** 插件卸载时调用，摘掉该作用域的全部钩子 */
  clearScope(scope: string): number {
    const before = this.items.length;
    this.items = this.items.filter((x) => x.scope !== scope);
    return before - this.items.length;
  }

  /**
   * 依次执行**本作用域**的 before 钩子。
   *
   * 为什么必须按 scope 过滤：插件 A 注册的 before 不该在插件 B 的调用上触发。
   * 早先的版本漏了这层过滤，结果所有插件的钩子对所有调用生效——那不叫钩子，叫串话。
   *
   * @returns `{ proceed: false }` 被拦截；否则返回最终参数（可能被改写过）
   */
  async runBefore(
    scope: string,
    api: string,
    params: Record<string, unknown>,
    ctx: ProxyHookCtx,
  ): Promise<{ proceed: boolean; params: Record<string, unknown> }> {
    let current = params;
    for (const item of this.items.filter((x) => x.kind === 'before' && x.scope === scope)) {
      try {
        const out = await (item.fn as ProxyBeforeHook)(api, current, ctx);
        if (out === false) return { proceed: false, params: current };
        if (out && typeof out === 'object') current = out;
      } catch (err: unknown) {
        // 钩子自己崩了不该阻断调用 —— 记日志后继续，按「放行」处理
        console.warn(
          `[proxy] before 钩子异常（scope=${item.scope}, api=${api}）:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { proceed: true, params: current };
  }

  async runAfter(
    scope: string,
    api: string,
    params: Record<string, unknown>,
    result: unknown,
    ctx: ProxyHookCtx,
  ): Promise<void> {
    for (const item of this.items.filter((x) => x.kind === 'after' && x.scope === scope)) {
      try {
        await (item.fn as ProxyAfterHook)(api, params, result, ctx);
      } catch (err: unknown) {
        console.warn(
          `[proxy] after 钩子异常（scope=${item.scope}, api=${api}）:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  async runError(
    scope: string,
    api: string,
    params: Record<string, unknown>,
    err: ProxyHookError,
    ctx: ProxyHookCtx,
  ): Promise<void> {
    for (const item of this.items.filter((x) => x.kind === 'error' && x.scope === scope)) {
      try {
        await (item.fn as ProxyErrorHook)(api, params, err, ctx);
      } catch (e: unknown) {
        console.warn(
          `[proxy] error 钩子异常（scope=${item.scope}, api=${api}）:`,
          e instanceof Error ? e.message : e,
        );
      }
    }
  }

  /** 当前注册的钩子数量，供控制台诊断用 */
  size(): number {
    return this.items.length;
  }
}
