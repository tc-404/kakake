/**
 * 统一超时处理。
 *
 * 超时在代理层里是一种「结果」而不是「异常」：超过阈值就合成一个失败信封返回，
 * 同时触发 error 钩子。这样才能同时满足两条要求——
 * 「超时即超时（不能因为异常就什么都不返回）」和「原生函数能监听到超时」。
 */
import { DEFAULT_API_TIMEOUT_MS, normalizeApiTimeoutMs } from '../../core/types.js';
import { failWith } from './errors.js';

/** 超时阈值钳制到 5s~600s，与全局 apiTimeoutMs 走同一套规则。 */
export const PROXY_MIN_TIMEOUT_MS = 5_000;
export const PROXY_MAX_TIMEOUT_MS = 600_000;

export function resolveTimeoutMs(requested?: number, globalValue?: number): number {
  if (typeof requested === 'number' && Number.isFinite(requested)) {
    return Math.min(PROXY_MAX_TIMEOUT_MS, Math.max(PROXY_MIN_TIMEOUT_MS, Math.floor(requested)));
  }
  const base = typeof globalValue === 'number' ? globalValue : DEFAULT_API_TIMEOUT_MS;
  return normalizeApiTimeoutMs(base);
}

/** 给 fetch 用的超时信号。取不到 AbortSignal.timeout 时退化为 AbortController + setTimeout。 */
export function createTimeoutSignal(ms: number): { signal: AbortSignal; done(): void } {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), done() {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/** 判断一个异常是不是超时。fetch 的 AbortError 与 NapCat 的「API 超时」文案都要认。 */
export function isTimeoutError(err: unknown): boolean {
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
    if (/API 超时|timeout/i.test(err.message)) return true;
  }
  return false;
}

/** 合成超时失败信封。 */
export function timeoutResult<T = null>(
  meta: Omit<import('../proxy.types.js').ProxyMeta, 'failure'>,
): import('../proxy.types.js').ProxyResult<T> {
  return failWith<T>(
    `API 超时: ${meta.api}（超过 ${meta.timeoutMs}ms 未响应）`,
    'timeout',
    meta,
  );
}
