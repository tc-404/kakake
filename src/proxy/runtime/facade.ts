/**
 * 接口代理运行时门面：拼装分发内核、钩子、寻址、传输，产出插件 ctx 上的 `kakake_api`。
 *
 * 职责：
 *   1. 每插件独立实例，scope 为 `plugin@account` 标识，`_proxy.source` 可溯源；
 *   2. 默认连接兜底：事件上下文绑定连接 → 全局默认连接；
 *   3. 作用域释放：插件卸载时 `releaseScope` 摘掉全部钩子。
 *
 * deps 按 scope 浅拷贝：hooks / resolveTarget / transport 无状态共享，仅 scope 每插件一份。
 */
import type { ConnectionManager } from '../../connection/connection.manager.js';
import type { Logger } from '../../core/logger.js';
import { PROXY_ENTRIES, findEntry } from '../registry/index.js';
import type {
  KakakeApi,
  ProxyAfterHook,
  ProxyApiEntry,
  ProxyApiSummary,
  ProxyBeforeHook,
  ProxyCategory,
  ProxyErrorHook,
  ProxyCallOptions,
  ProxyHttpMethod,
  ProxyProtocol,
  ProxyResult,
} from '../proxy.types.js';
import { dispatch, dispatchNative, type DispatchDeps, type ProxyTarget } from './dispatcher.js';
import { ProxyHookRegistry } from './hooks.js';
import { createKakakeTargetResolver } from '../resolve/target.kakake.js';
import { createProxyTransport } from '../transport/onebot.js';
import { failWith } from '../transport/errors.js';
import { PROXY_RETCODE } from '../proxy.types.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface ProxyRuntimeOptions {
  manager: ConnectionManager;
  logger?: Logger;
  /** 全局默认超时（毫秒），钳制在 5s~600s */
  defaultTimeoutMs?: number;
}

/** 生成一个插件的 kakake_api 时需要的绑定信息 */
export interface ProxyBinding {
  connectionId?: string;
  protocol?: ProxyProtocol;
}

export class ProxyRuntime {
  private readonly hooks = new ProxyHookRegistry();
  private readonly baseDeps: DispatchDeps;
  private readonly logger?: Logger;

  constructor(opts: ProxyRuntimeOptions) {
    this.logger = opts.logger;
    this.baseDeps = {
      hooks: this.hooks,
      resolveTarget: createKakakeTargetResolver(opts.manager),
      transport: createProxyTransport({
        getOnebotEndpoint: (id) => opts.manager.getOnebotEndpoint(id),
        getQqOfficialEndpoint: (id) => opts.manager.getQqOfficialClient(id),
      }),
      defaultTimeoutMs: opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      scope: 'proxy',
    };
  }

  /** 插件卸载时调用：摘掉该作用域的全部钩子，返回摘掉的条数 */
  releaseScope(scope: string): number {
    return this.hooks.clearScope(scope);
  }

  /** 当前注册的钩子总数，供自检/测试用 */
  hookCount(): number {
    return this.hooks.size();
  }

  /** 生成某个插件实例的 kakake_api */
  createApi(scope: string, binding?: ProxyBinding): KakakeApi {
    // 只换 scope，其余共享件原样复用
    const deps: DispatchDeps = { ...this.baseDeps, scope };
    const defaultConn = binding?.connectionId;

    const call = async (
      name: string,
      method: ProxyHttpMethod = 'POST',
      params: Record<string, unknown> = {},
      opts: ProxyCallOptions = {},
    ): Promise<ProxyResult> => {
      const merged: ProxyCallOptions = opts.conn === undefined && defaultConn
        ? { ...opts, conn: defaultConn }
        : opts;
      const result = await dispatch(deps, { api: name, method, params, opts: merged });
      if (opts.throwOnError && result.status !== 'ok') {
        throw new Error(`[接口代理] ${result.message}`);
      }
      return result;
    };

    // 逃生舱：绕过变体选择与参数翻译，直连原生接口。
    // 官方连接发 path（带 verb），OneBot 连接发 action —— 与 dispatchNative 的约定一致。
    const native = async (
      targetName: string,
      params: Record<string, unknown> = {},
      opts: ProxyCallOptions = {},
    ): Promise<ProxyResult> => {
      const resolved = await deps.resolveTarget(opts.conn ?? defaultConn);
      if (!resolved.ok) {
        return failWith(
          resolved.reason, 'not-connected',
          {
            api: 'call_native', protocol: 'napcat', variant: '*', connectionId: '',
            native: targetName, httpMethod: 'POST', elapsedMs: 0, at: Date.now(),
            timeoutMs: deps.defaultTimeoutMs, source: scope,
          },
          PROXY_RETCODE.notConnected,
        );
      }
      const target: ProxyTarget = resolved.target;
      return dispatchNative(deps, {
        api: 'call_native',
        method: 'POST',
        params: target.protocol === 'official'
          ? { path: targetName, params }
          : { action: targetName, params },
        opts: { ...opts, conn: opts.conn ?? defaultConn },
        target,
      });
    };

    // KakakeApi 是「可调用 + 只读属性」的接口，不能逐字段赋值，
    // 所以一次性构造完再断言（readonly 只是给使用方的约束，不是运行时的）。
    const api = Object.assign(call, {
      before: (hook: ProxyBeforeHook) => this.hooks.before(scope, hook),
      after: (hook: ProxyAfterHook) => this.hooks.after(scope, hook),
      error: (hook: ProxyErrorHook) => this.hooks.error(scope, hook),
      on: {
        before: (hook: ProxyBeforeHook) => this.hooks.before(scope, hook),
        after: (hook: ProxyAfterHook) => this.hooks.after(scope, hook),
        error: (hook: ProxyErrorHook) => this.hooks.error(scope, hook),
      },
      list: (filter?: { protocol?: ProxyProtocol; category?: ProxyCategory }) => PROXY_ENTRIES
        .filter((e) => !filter?.protocol || e.support.includes(filter.protocol))
        .filter((e) => !filter?.category || e.category === filter.category)
        .map((e) => stripExamples(e)),
      get: (name: string) => findEntry(name),
      binding: Object.freeze({ connectionId: defaultConn, protocol: binding?.protocol }),
      native,
    }) as unknown as KakakeApi;

    return api;
  }
}

/**
 * 事件上下文里的 kakake_api 重绑定：事件必须打到「事件来源的那条连接」，
 * 否则消息从 A 连接进来、回复却发到 B。连接未变时复用原对象避免重复建闭包。
 */
export function rebindKakakeApi(
  base: KakakeApi | undefined,
  scope: string,
  connectionId: string | undefined,
  runtime: ProxyRuntime,
): KakakeApi | undefined {
  if (!base) return undefined;
  if (connectionId && base.binding?.connectionId === connectionId) return base;
  return runtime.createApi(scope, {
    connectionId,
    protocol: base.binding?.protocol,
  });
}

function stripExamples(entry: ProxyApiEntry): ProxyApiSummary {
  const { examples: _examples, ...rest } = entry;
  return rest;
}

/* ─────────────────────────── 进程级单例 ─────────────────────────── */

let singleton: ProxyRuntime | null = null;

/** 供插件管理器与控制台共用：整个进程只有一份代理运行时 */
export function getProxyRuntime(opts?: ProxyRuntimeOptions): ProxyRuntime {
  if (!singleton) {
    if (!opts) throw new Error('ProxyRuntime 尚未初始化：首次获取必须传入 manager');
    singleton = new ProxyRuntime(opts);
  }
  return singleton;
}

/** 仅测试用：重置单例 */
export function resetProxyRuntimeForTest(): void {
  singleton = null;
}
