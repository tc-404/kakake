/**
 * 传输层：把 `ProxyNativeCall` 真正发到协议端，并把上游响应原样带回。
 *
 * 约定：
 *   - `ok: true` 只表示「拿到了上游响应」——HTTP 4xx/5xx、`status:'failed'` 的
 *     OneBot 信封都算拿到，成败由信封自己说，传输层不判定；
 *   - `ok: false` 表示「根本没拿到响应」（超时 / 未连接 / 无 raw 通道 / 网络错误），
 *     此时才由代理层合成 `timeout` / `network` 失败信封。
 *
 * 走 `callActionRaw` / `callRaw` 旁路而非旧 `callAction`（后者失败即 throw、丢失
 * HTTP 状态码与 wording/echo）。旧通道未动，行为由 onebot-caller-parity.test.ts 锁定。
 */
import type { OneBotRawResult } from '../../connection/onebot.types.js';
import type { QqOfficialEndpoint } from '../../connection/qq-official-ws.client.js';
import type { OneBotEndpoint } from '../../connection/onebot-endpoint.js';
import type { ProxyHttpMethod } from '../proxy.types.js';
import type {
  ProxyNativeCall,
  ProxyTarget,
  ProxyTransport,
  RawResponse,
} from '../runtime/dispatcher.js';

export interface ProxyTransportPorts {
  getOnebotEndpoint(connectionId: string): OneBotEndpoint | undefined;
  getQqOfficialEndpoint(connectionId: string): QqOfficialEndpoint | undefined;
}

/** 给一个 promise 套超时。超时不取消底层请求（fetch 无法安全中断），只放弃等待 */
type RaceOutcome<T> = { value: T } | { timedOut: true } | { thrown: unknown };

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  return new Promise<RaceOutcome<T>>((resolve) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve({ value }); },
      (err: unknown) => { clearTimeout(timer); resolve({ thrown: err }); },
    );
  });
}

export function createProxyTransport(ports: ProxyTransportPorts): ProxyTransport {
  return {
    async call(target: ProxyTarget, call: ProxyNativeCall, timeoutMs: number): Promise<RawResponse> {
      if (target.protocol === 'official') {
        return callOfficial(ports, target.connectionId, call, timeoutMs);
      }
      return callOnebot(ports, target.connectionId, call, timeoutMs);
    },
  };
}

async function callOnebot(
  ports: ProxyTransportPorts,
  connectionId: string,
  call: ProxyNativeCall,
  timeoutMs: number,
): Promise<RawResponse> {
  const ep = ports.getOnebotEndpoint(connectionId);
  if (!ep) {
    return { ok: false, error: `找不到 OneBot 连接 ${connectionId}（可能已被删除或重启）` };
  }
  if (!ep.isConnected) {
    return { ok: false, error: `OneBot 连接「${ep.name ?? connectionId}」当前未连接` };
  }
  if (!ep.callActionRaw) {
    // 不静默降级到 callAction：那会丢掉 HTTP 状态码与信封字段，等于偷偷违反透传约定
    return {
      ok: false,
      error: `OneBot 连接「${ep.name ?? connectionId}」的协议端未提供 callActionRaw 通道，`
        + '无法透传原始响应。请升级协议端，或改用 call_native（会降级为旧调用通道）。',
    };
  }
  if (!call.action) {
    return { ok: false, error: '内部错误：OneBot 调用缺少 action' };
  }

  const outcome = await withTimeout(
    ep.callActionRaw(call.action, call.params, call.method as ProxyHttpMethod),
    timeoutMs,
  );
  if ('timedOut' in outcome) {
    return { ok: false, timedOut: true, error: `等待协议端响应超时（${timeoutMs}ms）` };
  }
  if ('thrown' in outcome) {
    const msg = outcome.thrown instanceof Error ? outcome.thrown.message : String(outcome.thrown);
    return { ok: false, error: msg };
  }
  return fromOneBotRaw(outcome.value);
}

/** OneBotRawResult → RawResponse：字段一一对应，一个字段都不改 */
function fromOneBotRaw(r: OneBotRawResult): RawResponse {
  const out: RawResponse = { ok: r.ok, payload: r.envelope };
  if (r.httpStatus !== undefined) out.httpStatus = r.httpStatus;
  if (r.timedOut !== undefined) out.timedOut = r.timedOut;
  if (r.error !== undefined) out.error = r.error;
  // 非 JSON 响应：把原文塞进 error，绝不静默丢弃——调用方至少能看到协议端回了什么
  if (!r.ok && r.rawText !== undefined && r.error === undefined) out.error = r.rawText;
  return out;
}

async function callOfficial(
  ports: ProxyTransportPorts,
  connectionId: string,
  call: ProxyNativeCall,
  timeoutMs: number,
): Promise<RawResponse> {
  const ep = ports.getQqOfficialEndpoint(connectionId);
  if (!ep) {
    return { ok: false, error: `找不到 QQ 官方连接 ${connectionId}（可能已被删除或重启）` };
  }
  if (!ep.isConnected) {
    return { ok: false, error: `QQ 官方连接「${ep.name ?? connectionId}」当前未连接` };
  }
  if (!ep.callRaw) {
    return {
      ok: false,
      error: `QQ 官方连接「${ep.name ?? connectionId}」未提供 callRaw 通道，无法透传原始响应`,
    };
  }
  if (!call.path) {
    return { ok: false, error: '内部错误：官方调用缺少 path' };
  }

  const outcome = await withTimeout(
    ep.callRaw({ method: call.verb ?? 'POST', path: call.path, body: call.params }),
    timeoutMs,
  );
  if ('timedOut' in outcome) {
    return { ok: false, timedOut: true, error: `等待开放平台响应超时（${timeoutMs}ms）` };
  }
  if ('thrown' in outcome) {
    const msg = outcome.thrown instanceof Error ? outcome.thrown.message : String(outcome.thrown);
    return { ok: false, error: msg };
  }
  const r = outcome.value;
  const out: RawResponse = { ok: r.ok, payload: r.body };
  if (r.httpStatus !== undefined) out.httpStatus = r.httpStatus;
  if (r.error !== undefined) out.error = r.error;
  return out;
}
