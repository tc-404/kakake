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
import { logAction, logQqOfficialAction } from '../../core/log-store.js';
import {
  formatOb11Action,
  formatOb11ActionResult,
  formatQqOfficialAction,
  formatQqOfficialActionResult,
} from '../../core/log-format.js';
import { PROXY_ENTRIES, findEntry } from '../registry/index.js';
import { eventBus } from '../../event/event-bus.js';
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
import { dispatch, dispatchNative, type DispatchDeps, type ProxyNativeCall, type ProxyTarget, type ProxyTransport, type RawResponse } from './dispatcher.js';
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
    // 只换 scope，其余共享件原样复用；传输层按 scope 套上输出日志，
    // 日志前缀带作用域标识（插件为 plugin@账号，外放为 external:/api/v1），可溯源。
    const deps: DispatchDeps = {
      ...this.baseDeps,
      scope,
      transport: withActionLog(this.baseDeps.transport, scope),
    };
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

/* ─────────────────────────── 输出日志 ─────────────────────────── */

/**
 * 给传输层套一层输出日志：每次真正发往协议端的请求都记一行运行日志。
 *
 * 为什么套在这里而不是放进 dispatcher：分发内核刻意不 import 任何 kakake 运行时
 * 模块（见 dispatcher.ts 头注释），日志是纯运行时关注点，由 facade 注入正好。
 * 传输层每次 `call` 就是一次真实的上游请求——主调用、官方富媒体的前置上传、
 * `call_native` 逃生舱、外放 API 全都经过它，在这里记录天然全覆盖，
 * 不需要在分发链路的每个出口分别埋点。
 *
 * 与旧调用通道（createActionCaller / createQqOfficialActionCaller）同一套习惯：
 * 请求记 info，成功结果记 debug，失败记 error；官方侧走「官方输出」分类。
 */
function withActionLog(inner: ProxyTransport, scope: string): ProxyTransport {
  const prefix = `[代理输出:${scope}]`;
  const nativeName = (call: ProxyNativeCall): string =>
    call.action ?? (call.path ? `${call.verb ?? 'POST'} ${call.path}` : '(未知接口)');
  /**
   * 代理通道也补发 action_result：本通道走 callActionRaw 旁路、不经过旧 ActionCaller
   * 的事件骨架，不发的话撤回监听类插件就看不见经代理（kakake_api / 外放 API）发出的调用。
   * 事件形状与 connection.manager 的 emitActionResult 保持一致；信封失败也按 ok=false 发。
   */
  const emitActionResult = (target: ProxyTarget, call: ProxyNativeCall, raw: RawResponse, timeoutMs: number): void => {
    try {
      const obj = (raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) as Record<string, unknown>;
      let ok = raw.ok;
      let error: string | null = null;
      if (!raw.ok) {
        error = raw.timedOut ? `超时（${timeoutMs}ms 内未收到协议端响应）` : String(raw.error ?? '未知网络错误');
      } else if (target.protocol === 'official') {
        const failed = raw.httpStatus !== undefined && raw.httpStatus >= 400;
        if (failed) {
          ok = false;
          error = String(obj.message ?? `HTTP ${raw.httpStatus}`);
        }
      } else if (obj.status === 'failed') {
        ok = false;
        error = String(obj.message ?? '调用失败');
      }
      eventBus.emit(
        target.protocol === 'official' ? 'qq_official/action_result' : 'onebot/action_result',
        {
          time: Date.now(),
          connectionId: target.connectionId,
          adapter: scope,
          action: call.action ?? (call.path ? `${call.verb ?? 'POST'} ${call.path}` : ''),
          params: call.params ?? {},
          ok,
          result: raw.payload ?? null,
          error,
        },
      );
    } catch {
      // 事件补发失败绝不影响主调用
    }
  };
  return {
    async call(target: ProxyTarget, call: ProxyNativeCall, timeoutMs: number): Promise<RawResponse> {
      const native = nativeName(call);
      if (target.protocol === 'official') {
        logQqOfficialAction(
          prefix,
          formatQqOfficialAction(call.path ?? native, call.params, { method: call.verb }),
          JSON.stringify(call.params ?? {}),
        );
      } else {
        const brief = formatOb11Action(call.action ?? '', call.params);
        logAction(prefix, brief.message, brief.detail);
      }

      const raw = await inner.call(target, call, timeoutMs);
      emitActionResult(target, call, raw, timeoutMs);

      if (!raw.ok) {
        const msg = raw.timedOut
          ? `${native} ✗ 超时（${timeoutMs}ms 内未收到协议端响应）`
          : `${native} ✗ ${raw.error ?? '未知网络错误'}`;
        logAction(prefix, msg, raw.error, 'error');
        return raw;
      }
      if (target.protocol === 'official') {
        const failed = raw.httpStatus !== undefined && raw.httpStatus >= 400;
        const obj = (raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) as Record<string, unknown>;
        const line = formatQqOfficialActionResult(
          call.path ?? native,
          raw.payload,
          failed ? String(obj.message ?? `HTTP ${raw.httpStatus}`) : undefined,
        );
        logQqOfficialAction(prefix, line, JSON.stringify(raw.payload ?? null), failed ? 'error' : 'debug');
      } else {
        const env = (raw.payload && typeof raw.payload === 'object' ? raw.payload : {}) as Record<string, unknown>;
        const failed = env.status === 'failed';
        const line = formatOb11ActionResult(native, env, failed ? String(env.message ?? '调用失败') : undefined);
        logAction(prefix, line.message, line.detail, failed ? 'error' : 'debug');
      }
      return raw;
    },
  };
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
