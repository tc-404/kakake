/**
 * 代理层的错误码、异常类型与失败信封合成。
 *
 * 核心约定：**所有失败路径都返回失败信封，绝不 throw、绝不空返回。**
 * 唯一的例外是调用方显式传 `opts.throwOnError`，那时才转成异常（兼容旧写法）。
 *
 * 合成信封一律是 OneBot 形态（status/retcode/data/message/wording/echo），
 * 哪怕目标是 QQ 官方——这样插件侧 `res.status === 'ok'` 的判断在任何协议下都成立，
 * 不用为了判成功去区分 `_proxy.protocol`。
 */
import {
  PROXY_RETCODE,
  type ProxyEnvelope,
  type ProxyFailure,
  type ProxyMeta,
  type ProxyResult,
} from '../proxy.types.js';

/** 内部异常：承载一次失败，随后被 dispatcher 转成失败信封。 */
export class ProxyError extends Error {
  readonly failure: ProxyFailure;
  readonly retcode: number;

  constructor(failure: ProxyFailure, message: string, retcode?: number) {
    super(message);
    this.name = 'ProxyError';
    this.failure = failure;
    this.retcode = retcode ?? PROXY_RETCODE[failureKeyOf(failure)] ?? -1999;
  }
}

function failureKeyOf(failure: ProxyFailure): keyof typeof PROXY_RETCODE {
  switch (failure) {
    case 'unsupported': return 'unsupported';
    case 'timeout': return 'timeout';
    case 'id-space': return 'idSpace';
    case 'missing-param': return 'missingParam';
    case 'unknown-api': return 'unknownApi';
    case 'not-connected': return 'notConnected';
    case 'network': return 'network';
    case 'intercepted': return 'intercepted';
    case 'upstream':
    default: return 'network';
  }
}

/**
 * 把所有失败分类统一映射到一个 retcode。
 * upstream 特殊：它表示「协议端自己回了失败」，此时应沿用协议端原本的 retcode，
 * 不该被代理层的私有码覆盖——否则就把上游的真实错误码吞掉了。
 */
export function retcodeForFailure(failure: ProxyFailure, upstreamRetcode?: number): number {
  if (failure === 'upstream' && typeof upstreamRetcode === 'number') return upstreamRetcode;
  return PROXY_RETCODE[failureKeyOf(failure)] ?? -1999;
}

/** 合成一个失败信封（尚未附挂 _proxy）。 */
export function failureEnvelope(
  message: string,
  failure: ProxyFailure,
  upstreamRetcode?: number,
): ProxyEnvelope<null> {
  return {
    status: 'failed',
    retcode: retcodeForFailure(failure, upstreamRetcode),
    data: null,
    message,
    wording: wordingOf(failure),
    echo: null,
  };
}

/** wording 是固定的中文短标签，方便前端直接展示，不用按 message 猜。 */
export function wordingOf(failure: ProxyFailure): string {
  switch (failure) {
    case 'upstream': return '协议端返回失败';
    case 'timeout': return '调用超时';
    case 'network': return '网络异常';
    case 'unsupported': return '协议不支持';
    case 'intercepted': return '请求被拦截';
    case 'id-space': return 'ID 空间不匹配';
    case 'missing-param': return '参数缺失';
    case 'unknown-api': return '未知接口';
    case 'not-connected': return '未连接';
    default: return '调用失败';
  }
}

/**
 * 把失败信封和元信息拼成最终返回值。
 * 注意这里是浅拷贝后追加 `_proxy`，不会动信封本身的任何字段。
 */
export function asFailure<T = null>(envelope: ProxyEnvelope<T>, meta: ProxyMeta): ProxyResult<T> {
  return { ...envelope, _proxy: meta };
}

/**
 * 把成功信封和元信息拼成最终返回值。
 *
 * 与 `asFailure` 成对：两者都只是浅拷贝后追加 `_proxy`，绝不改写信封本身的字段——
 * 这是「严格透传」在实现层面的落点。
 */
export function asSuccess<T = unknown>(
  envelope: ProxyEnvelope<T>,
  meta: ProxyMeta,
): ProxyResult<T> {
  return { ...envelope, _proxy: meta };
}

/** 便捷构造：给定失败分类与文案，一步生成最终结果。 */
export function failWith<T = null>(
  message: string,
  failure: ProxyFailure,
  meta: Omit<ProxyMeta, 'failure'>,
  upstreamRetcode?: number,
): ProxyResult<T> {
  // data 在失败时恒为 null。这里用 null as T 而不是断言整个信封，
  // 是为了让 TS 仍逐字段校验其余部分，不要把类型检查整块关掉。
  const env = failureEnvelope(message, failure, upstreamRetcode);
  return asFailure({ ...env, data: null as T }, { ...meta, failure });
}

/**
 * ID 空间不匹配时的文案。
 *
 * 刻意把话说全——开发者拿到这个错误时最需要知道的是「我传的是什么」「这里要什么」
 * 「为什么不能自动转」「该去哪儿拿正确的」，缺一条就得再来问一遍。
 */
export function idSpaceMessage(opts: {
  api: string;
  param: string;
  value: string;
  protocol: string;
  expected: string;
  looksLike: string;
}): string {
  return (
    `ID 空间不匹配：接口 ${opts.api} 的参数 ${opts.param} 需要「${opts.expected}」，`
    + `但传入的 "${opts.value}" 看起来是「${opts.looksLike}」。`
    + `当前连接是 ${opts.protocol}，野生机器人（QQ 号）与官方机器人（openid）之间没有官方互转接口，`
    + `代理层不会猜测或转换。请改用事件中携带的 ${opts.expected}，`
    + `或换一条与该 ID 空间匹配的连接。`
  );
}
