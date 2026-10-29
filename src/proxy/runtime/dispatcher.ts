/**
 * 分发主链路：从「统一短名 + 统一参数」到「上游原始响应」。
 *
 * 本文件不 import 任何 kakake 运行时模块，环境能力全部通过
 * `ProxyTargetResolver` / `ProxyTransport` 两个端口注入，可脱离主程序单测。
 *
 * 调用顺序（每步都可能提前返回，但都返回信封）：
 *   1. 查注册表 → unknown-api            2. 解析连接与协议 → not-connected
 *   3. before 钩子 → intercepted          4. 连接不可用 → not-connected
 *   5. 选变体 → unsupported               6. ID 空间校验 → id-space
 *   7. 翻译参数 + 路径 → missing-param    8. 前置步骤 → upstream/timeout/network
 *   9. 发请求 → timeout/network/透传     10. after / error 钩子
 */
import {
  PROXY_RETCODE,
  type ProxyApiEntry,
  type ProxyCallOptions,
  type ProxyEnvelope,
  type ProxyHttpMethod,
  type ProxyMeta,
  type ProxyProtocol,
  type ProxyResult,
  type ProxyVariant,
} from '../proxy.types.js';
import { findEntry } from '../registry/index.js';
import { preferProtocolFromParams } from '../resolve/target.js';
import {
  TRANSFORMS,
  checkIdSpaces,
  describeIdSpaceIssue,
  extractPathKeys,
  pickVariant,
  resolveOfficialPath,
  stripPathKeys,
  translateParams,
} from '../translate/params.js';
import { failWith, asSuccess } from '../transport/errors.js';
import type { ProxyHookRegistry } from './hooks.js';

/* ─────────────────────────── 注入端口 ─────────────────────────── */

export interface ProxyTarget {
  protocol: ProxyProtocol;
  connectionId: string;
  /** OneBot 连接背后的协议端实现（napcat / snowluma / unknown） */
  onebotImpl?: string;
}

export type ProxyTargetResult =
  | { ok: true; target: ProxyTarget }
  | { ok: false; reason: string };

/**
 * 寻址：由「调用方传入的连接标识（可省略）」得到真正要发的目标。
 *
 * 之所以是 async：NapCat 与 SnowLuma 的识别要靠一次 `get_version_info` 探测
 * （见 resolve/impl-detect.ts），那是网络往返。宁可多一次往返，也不靠猜——
 * 猜错协议的后果是参数键名对不上，报出来的错还很不好查。
 */
export type ProxyTargetResolver = (conn?: string, prefer?: ProxyProtocol) => Promise<ProxyTargetResult>;

/** 上游实际要发的落点 */
export interface ProxyNativeCall {
  /** OneBot 系：action 名 */
  action?: string;
  /** QQ 官方：已替换好占位的 path 与动词 */
  path?: string;
  verb?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  params: Record<string, unknown>;
  method: ProxyHttpMethod;
}

export interface RawResponse {
  /** 是否拿到上游响应。4xx/5xx 也算拿到 */
  ok: boolean;
  httpStatus?: number;
  /** 上游响应原文：OneBot 是信封，官方是业务对象或 { code, message } */
  payload?: unknown;
  error?: string;
  timedOut?: boolean;
}

export interface ProxyTransport {
  call(
    target: ProxyTarget,
    call: ProxyNativeCall,
    timeoutMs: number,
  ): Promise<RawResponse>;
}

export interface DispatchDeps {
  hooks: ProxyHookRegistry;
  resolveTarget: ProxyTargetResolver;
  transport: ProxyTransport;
  /** 默认超时，钳制在 5s~600s */
  defaultTimeoutMs: number;
  scope: string;
}

/* ─────────────────────────── 主入口 ─────────────────────────── */

export interface DispatchInput {
  api: string;
  method: ProxyHttpMethod;
  params: Record<string, unknown>;
  opts?: ProxyCallOptions;
}

function clampTimeout(ms: number | undefined, fallback: number): number {
  const v = Number(ms ?? fallback);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(600_000, Math.max(5_000, Math.floor(v)));
}

export async function dispatch(
  deps: DispatchDeps,
  input: DispatchInput,
): Promise<ProxyResult> {
  const started = Date.now();
  const { api, method, params, opts } = input;
  const timeoutMs = clampTimeout(opts?.timeoutMs, deps.defaultTimeoutMs);

  const baseMeta = () => ({
    api,
    protocol: 'napcat' as ProxyProtocol,
    variant: '*',
    connectionId: '',
    native: '',
    httpMethod: method as ProxyMeta['httpMethod'],
    elapsedMs: Date.now() - started,
    at: Date.now(),
    timeoutMs,
    source: deps.scope,
  });

  /* 1. 查注册表 */
  const entry = findEntry(api);
  if (!entry) {
    return failWith(
      `接口代理没有名为 "${api}" 的接口。可用接口见控制台「接口代理」页，或用 call_native 直连原生接口。`,
      'unknown-api',
      baseMeta(),
      PROXY_RETCODE.unknownApi,
    );
  }

  /* 2. 解析目标连接。
   *
   * 放在 before 钩子之前，是因为钩子的 ctx 里要带协议与连接信息；
   * 又只解析一次——`conn` 在 opts 里而不是 params 里，before 钩子改不了它，
   * 解析两次只会白费一次探测。
   * 无显式 conn 时按已传参数的 ID 空间推断协议偏好（openid 类参数指向官方
   * 连接、QQ 号类指向野生），避免混合连接下把官方参数路由进野生连接。 */
  const resolved = await deps.resolveTarget(opts?.conn, preferProtocolFromParams(entry, params));
  const hookCtx = {
    protocol: (resolved.ok ? resolved.target.protocol : 'napcat') as ProxyProtocol,
    connectionId: resolved.ok ? resolved.target.connectionId : '',
    source: { pluginId: deps.scope },
  };

  /* 3. before 钩子 */
  const before = await deps.hooks.runBefore(deps.scope, entry.name, params, hookCtx);
  if (!before.proceed) {
    const meta: ProxyMeta = {
      ...baseMeta(),
      protocol: hookCtx.protocol,
      connectionId: hookCtx.connectionId,
      native: '',
      degraded: 'intercepted',
    };
    const result = failWith(
      `请求被 before 钩子拦截，未发往协议端（接口 ${entry.name}）`,
      'intercepted',
      meta,
      PROXY_RETCODE.intercepted,
    );
    await deps.hooks.runError(deps.scope, entry.name, before.params, {
      failure: 'intercepted',
      message: result.message,
      meta: result._proxy,
    }, hookCtx);
    return result;
  }
  const callParams = before.params;

  /* 4. 连接不可用 */
  if (!resolved.ok) {
    return finishError(deps, entry, callParams, 'not-connected', resolved.reason, {
      ...baseMeta(),
      native: '',
    }, PROXY_RETCODE.notConnected, hookCtx);
  }
  const target = resolved.target;
  const protocol = target.protocol;

  /* 5. 选变体 */
  const impl = entry.impl[protocol];
  if (!impl) {
    const names = { napcat: 'NapCat', snowluma: 'SnowLuma', official: 'QQ 官方机器人' };
    return finishError(
      deps, entry, callParams, 'unsupported',
      `接口「${entry.title}」(${entry.name}) 不支持当前连接协议：${names[protocol]}。`
      + `该接口支持：${entry.support.map((p) => names[p]).join(' / ')}。`
      + '如需绕过限制强行发送，请传 opts.force（结果仍会标记为降级）。',
      { ...baseMeta(), protocol, connectionId: target.connectionId, native: '' },
      PROXY_RETCODE.unsupported, hookCtx,
    );
  }
  const picked = pickVariant(impl, callParams);
  const variant: ProxyVariant | null = picked?.variant ?? null;
  if (!variant) {
    return finishError(
      deps, entry, callParams, 'missing-param',
      `接口「${entry.title}」需要 scene 参数来区分场景（group / private / channel / dms），`
      + `当前未传或取值不受支持。`,
      { ...baseMeta(), protocol, connectionId: target.connectionId, native: '' },
      PROXY_RETCODE.missingParam, hookCtx,
    );
  }

  const native = variant.action ?? (variant.path ? `${variant.verb ?? 'POST'} ${variant.path}` : '');

  /* 6. ID 空间校验 */
  const idIssues = checkIdSpaces(entry, protocol, callParams);
  if (idIssues.length) {
    const first = idIssues[0];
    const spec = entry.params.find((p) => p.key === first.key);
    const msg = describeIdSpaceIssue(spec?.label ?? first.key, first.expect, protocol);
    return finishError(deps, entry, callParams, 'id-space', msg,
      { ...baseMeta(), protocol, connectionId: target.connectionId, native },
      PROXY_RETCODE.idSpace, hookCtx);
  }

  /* 7. 翻译参数与路径 */
  const sent = translateParams(variant, callParams, impl.variantBy);
  let finalPath = variant.path;
  // 真正要发的请求体：路径占位拿走的值不再进 body（见 stripPathKeys 注释）
  let bodyParams = sent;
  if (variant.path) {
    // 路径占位优先用翻译后的参数（协议侧键名），取不到再回退到原始统一键名。
    // 官方的 DELETE/PATCH 大量把 ID 放在路径上，占位一旦取不到就是整条调不通，
    // 所以这里给一次回退，而不是只认其中一种写法。
    const r = resolveOfficialPath(variant.path, sent, callParams);
    if (r.missing.length) {
      return finishError(
        deps, entry, callParams, 'missing-param',
        `接口「${entry.title}」缺少路径参数：${r.missing.join('、')}`,
        { ...baseMeta(), protocol, connectionId: target.connectionId, native },
        PROXY_RETCODE.missingParam, hookCtx,
      );
    }
    finalPath = r.path;
    bodyParams = stripPathKeys(sent, extractPathKeys(variant.path));
  }

  const meta: ProxyMeta = {
    ...baseMeta(),
    protocol,
    connectionId: target.connectionId,
    onebotImpl: target.onebotImpl,
    native,
    variant: picked?.key ?? '*',
    httpMethod: (variant.verb ?? (protocol === 'official' ? 'POST' : method)) as ProxyMeta['httpMethod'],
  };

  /* 8. 前置步骤（官方富媒体：先上传拿 file_info，再发消息） */
  if (variant.pre) {
    const pre = variant.pre;
    // skipWhenMissing：统一发消息条目在「纯文本」时没有 file 可上传，
    // 前置上传必须整个跳过——否则文本消息也被迫走一次必然失败的上传。
    const skipKey = pre.skipWhenMissing;
    const skipPre = skipKey !== undefined
      && (callParams[skipKey] === undefined || callParams[skipKey] === null || callParams[skipKey] === '');
    if (!skipPre) {
    // 前置请求体基于**调用方的原始参数**构造，而不是已经注入过主变体 const 的 bodyParams：
    // 上传接口只关心文件本身，把主消息的 msg_type 一起带过去纯属污染。
    const preParams: Record<string, unknown> = {};
    const from = pre.from ?? {};
    const dispatchKey = impl.variantBy;
    // only 白名单：配合 transforms 拆 url / file_data / file_type 时，
    // 只有列出的统一键才允许进前置请求体。
    const preSource: Record<string, unknown> = pre.only
      ? Object.fromEntries(pre.only.map((k) => [k, callParams[k]]))
      : callParams;
    for (const [k, v] of Object.entries(preSource)) {
      if (v === undefined) continue;
      // 派发字段（scene 等）同样不该出现在前置请求里
      if (dispatchKey && k === dispatchKey) continue;
      preParams[from[k] ?? k] = v;
    }
    for (const [k, v] of Object.entries(pre.const ?? {})) {
      preParams[k] = v;
    }
    // 前置值转换：转换器入参是调用方的完整统一参数，
    // 便于从 params.file / params.media_type 推导 url / file_data / file_type。
    for (const [k, name] of Object.entries(pre.transforms ?? {})) {
      const fn = TRANSFORMS[name];
      if (!fn) continue;
      const converted = fn(preParams[k] ?? callParams[k], { ...callParams });
      if (converted === undefined) delete preParams[k];
      else preParams[k] = converted;
    }
    // 已被转换器消费掉的原始键（如 file）不许再留在上传请求体里
    for (const k of pre.drop ?? []) delete preParams[k];
    let prePath = pre.path;
    let preBody = preParams;
    if (pre.path) {
      const rp = resolveOfficialPath(pre.path, preParams, callParams);
      if (rp.missing.length) {
        return finishError(
          deps, entry, callParams, 'missing-param',
          `接口「${entry.title}」的前置步骤缺少路径参数：${rp.missing.join('、')}`,
          { ...meta, native: `${pre.verb ?? 'POST'} ${pre.path}` },
          PROXY_RETCODE.missingParam, hookCtx,
        );
      }
      prePath = rp.path;
      preBody = stripPathKeys(preParams, extractPathKeys(pre.path));
    }
    const preNative = pre.action ?? `${pre.verb ?? 'POST'} ${pre.path ?? ''}`;
    const preMeta: ProxyMeta = { ...meta, native: preNative };

    let preRaw: RawResponse;
    try {
      preRaw = await deps.transport.call(
        target,
        { action: pre.action, path: prePath, verb: pre.verb, params: preBody, method },
        timeoutMs,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return finishError(deps, entry, callParams, 'network', msg, preMeta, PROXY_RETCODE.network, hookCtx);
    }
    if (!preRaw.ok) {
      const timedOut = preRaw.timedOut === true;
      const result = failWith(
        timedOut
          ? `接口「${entry.title}」的前置步骤超时（${timeoutMs}ms 内未收到协议端响应）`
          : `接口「${entry.title}」的前置步骤失败：${preRaw.error ?? '未知网络错误'}`,
        timedOut ? 'timeout' : 'network',
        { ...preMeta, httpStatus: preRaw.httpStatus },
        timedOut ? PROXY_RETCODE.timeout : PROXY_RETCODE.network,
      );
      await deps.hooks.runError(deps.scope, entry.name, callParams, {
        failure: timedOut ? 'timeout' : 'network', message: result.message, meta: result._proxy,
      }, { ...hookCtx, protocol, connectionId: target.connectionId, meta: result._proxy });
      return result;
    }

    // 前置步骤拿到的是失败信封：按原样透传，不拿一个错误的 file_info 去发主请求。
    // 这一步是「报错即报错」的关键——上游在上传阶段就拒绝了，主请求根本不该发出。
    const preEnvelope = toEnvelope(preRaw.payload, protocol, preRaw.httpStatus);
    if (preEnvelope.status === 'failed') {
      return asSuccess(preEnvelope, { ...preMeta, httpStatus: preRaw.httpStatus });
    }
    const picked = pickFromPayload(preRaw.payload, pre.pick);
    // 前置步骤「消费掉」的键要从主请求里去掉：file 已经换成 file_info / media 了，
    // 再原样带过去就是往官方请求体里塞一个它不认识的字段。
    // 只摘 `from` 显式列出的键——没列 from 时语义是「同名全带」，不该顺手动别人的参数。
    const consumed = new Set(Object.keys(pre.from ?? {}));
    const afterPre: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bodyParams)) {
      if (consumed.has(k)) continue;
      afterPre[k] = v;
    }
    afterPre[pre.injectAs] = picked ?? null;
    bodyParams = afterPre;
    }
  }

  /* 9. 发出请求 */
  let raw: RawResponse;
  try {
    raw = await deps.transport.call(
      target,
      {
        action: variant.action,
        path: finalPath,
        verb: variant.verb,
        params: bodyParams,
        // 变体可以要求固定走某个 OneBot HTTP 方法（有些协议端只认其中一种）
        method: (variant.obMethod ?? method) as ProxyHttpMethod,
      },
      timeoutMs,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return finishError(deps, entry, callParams, 'network', msg, meta, PROXY_RETCODE.network, hookCtx);
  }

  /* 10. 合成结果 */
  const elapsedMs = Date.now() - started;
  const finalMeta: ProxyMeta = { ...meta, elapsedMs, httpStatus: raw.httpStatus };

  if (!raw.ok) {
    const failure = raw.timedOut ? 'timeout' : 'network';
    const result = failWith(
      raw.timedOut
        ? `接口「${entry.title}」调用超时（${timeoutMs}ms 内未收到协议端响应）`
        : `接口「${entry.title}」调用失败：${raw.error ?? '未知网络错误'}`,
      failure,
      finalMeta,
      raw.timedOut ? PROXY_RETCODE.timeout : PROXY_RETCODE.network,
    );
    await deps.hooks.runError(deps.scope, entry.name, callParams, {
      failure, message: result.message, meta: result._proxy,
    }, { ...hookCtx, protocol, connectionId: target.connectionId, meta: result._proxy });
    return result;
  }

  // 归一为信封后透传：数据本身一字不改，只是外面套一层可统一判断的壳
  const result = asSuccess(toEnvelope(raw.payload, protocol, raw.httpStatus), finalMeta);
  await deps.hooks.runAfter(deps.scope, entry.name, callParams, result, {
    ...hookCtx, protocol, connectionId: target.connectionId, meta: finalMeta,
  });
  return result;
}

/** 从前置响应里取出要注入主请求的那一段（pick 语义见 ProxyVariant.pre）。 */
export function pickFromPayload(payload: unknown, pick?: string): unknown {
  if (!pick) return payload;
  if (pick === 'data') {
    if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
      return (payload as Record<string, unknown>).data;
    }
    return payload;
  }
  let cur: unknown = payload;
  for (const seg of pick.split('.')) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

/**
 * 把上游原文归一成 OneBot 形态信封。
 *
 * OneBot 系本身就是信封；QQ 官方成功时直接返回业务对象、失败时才是
 * `{ code, message }` 且 HTTP 非 2xx。统一套壳后插件只需判断 `res.status`，
 * data 原样透传不改写。
 */
export function toEnvelope(
  payload: unknown,
  protocol: ProxyProtocol,
  httpStatus?: number,
): ProxyEnvelope {
  if (protocol === 'official') {
    const failed = httpStatus !== undefined && httpStatus >= 400;
    if (!failed) return { status: 'ok', retcode: 0, data: payload ?? null, message: '' };
    const obj = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};
    const code = typeof obj.code === 'number' ? obj.code : httpStatus ?? 0;
    const message = typeof obj.message === 'string' ? obj.message : `HTTP ${httpStatus}`;
    return { status: 'failed', retcode: code, data: payload ?? null, message };
  }

  // OneBot 系：本身就是信封，逐字段保留（含 wording / echo，这些老版本会丢）
  if (payload && typeof payload === 'object' && 'status' in payload) {
    const p = payload as Partial<ProxyEnvelope>;
    const ok = p.status === 'ok';
    return {
      status: ok ? 'ok' : 'failed',
      retcode: typeof p.retcode === 'number' ? p.retcode : ok ? 0 : -1,
      data: p.data ?? null,
      message: typeof p.message === 'string' ? p.message : '',
      wording: p.wording,
      echo: p.echo,
    };
  }

  // 非信封形态但 HTTP 已报错（HTML 错误页 / 网关 502 / 鉴权失败的非 JSON）：按失败返回，原文进 data 供排查。
  if (httpStatus !== undefined && httpStatus >= 400) {
    return { status: 'failed', retcode: httpStatus, data: payload ?? null, message: `HTTP ${httpStatus}` };
  }

  // 协议端返回了非信封形态（罕见但要兜住）：按成功处理，原文放进 data，绝不丢内容
  return { status: 'ok', retcode: 0, data: payload ?? null, message: '' };
}

/** 统一的失败出口：保证 error 钩子一定被触发，且返回值一定是信封 */
async function finishError(
  deps: DispatchDeps,
  entry: ProxyApiEntry,
  params: Record<string, unknown>,
  failure: ProxyMeta['failure'] & string,
  message: string,
  meta: ProxyMeta,
  retcode: number,
  hookCtx: Parameters<ProxyHookRegistry['runError']>[4],
): Promise<ProxyResult> {
  const result = failWith(message, failure as NonNullable<ProxyMeta['failure']>, meta, retcode);
  await deps.hooks.runError(deps.scope, entry.name, params, {
    failure: failure as NonNullable<ProxyMeta['failure']>,
    message,
    meta: result._proxy,
  }, hookCtx);
  return result;
}

/** 供逃生舱 call_native 使用：跳过变体选择与参数翻译，直接发原生调用 */
export async function dispatchNative(
  deps: DispatchDeps,
  input: DispatchInput & { target: ProxyTarget },
): Promise<ProxyResult> {
  const started = Date.now();
  const { api, method, params, target } = input;
  const timeoutMs = clampTimeout(input.opts?.timeoutMs, deps.defaultTimeoutMs);
  const p = { ...params };
  const action = typeof p.action === 'string' ? p.action : undefined;
  const path = typeof p.path === 'string' ? p.path : undefined;
  const verb = typeof p.verb === 'string' ? p.verb as ProxyNativeCall['verb'] : undefined;
  const inner = (p.params && typeof p.params === 'object')
    ? p.params as Record<string, unknown>
    : {};

  const meta: ProxyMeta = {
    api,
    protocol: target.protocol,
    variant: '*',
    connectionId: target.connectionId,
    onebotImpl: target.onebotImpl,
    native: action ?? (path ? `${verb ?? 'POST'} ${path}` : ''),
    httpMethod: (verb ?? method) as ProxyMeta['httpMethod'],
    elapsedMs: 0,
    at: Date.now(),
    timeoutMs,
    source: deps.scope,
  };

  let raw: RawResponse;
  try {
    raw = await deps.transport.call(target, { action, path, verb, params: inner, method }, timeoutMs);
  } catch (err: unknown) {
    return failWith(
      `原生调用失败：${err instanceof Error ? err.message : String(err)}`,
      'network', meta, PROXY_RETCODE.network,
    );
  }
  const finalMeta: ProxyMeta = { ...meta, elapsedMs: Date.now() - started, httpStatus: raw.httpStatus };
  if (!raw.ok) {
    return failWith(
      raw.timedOut
        ? `原生调用超时（${timeoutMs}ms）`
        : `原生调用失败：${raw.error ?? '未知错误'}`,
      raw.timedOut ? 'timeout' : 'network',
      finalMeta,
      raw.timedOut ? PROXY_RETCODE.timeout : PROXY_RETCODE.network,
    );
  }
  return asSuccess(toEnvelope(raw.payload, target.protocol, raw.httpStatus), finalMeta);
}

export type { ProxyEnvelope };
