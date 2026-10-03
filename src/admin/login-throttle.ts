import { rootLogger } from '../core/logger.js';
import { describeRemoteAddress } from '../core/net-address.js';

/**
 * 登录失败限速。
 *
 * 后台需要支持公网访问，登录入口必然对全网开放，所以要给失败尝试加成本，
 * 并且把失败记进运行日志——否则被人扫了也完全看不出来。
 *
 * 状态只存在内存里：重启框架即清空，既是实现上的简化，也是用户被自己
 * 锁住时的逃生口（重启即解锁）。
 */

/** 失败计数窗口 */
const WINDOW_MS = 10 * 60 * 1000;
/** 窗口内允许的失败次数（放宽一些，避免手动输入长密钥打错几次就被锁） */
const MAX_FAILS = 8;
/** 超限后的锁定时长 */
const LOCK_MS = 10 * 60 * 1000;
/** 最多跟踪多少个来源，防止伪造来源地址把内存撑爆 */
const MAX_TRACKED = 2048;

/** 失败来源：用于日志区分是哪条登录通道 */
export type LoginChannel = '后台登录' | '快捷登录链接' | 'Authorization 密钥';

type Attempt = {
  fails: number;
  firstFailAt: number;
  lastFailAt: number;
  lockedUntil: number;
};

const attempts = new Map<string, Attempt>();

function prune(now: number): void {
  for (const [ip, rec] of attempts) {
    const expired = now >= rec.lockedUntil && now - rec.lastFailAt >= WINDOW_MS;
    if (expired) attempts.delete(ip);
  }
  if (attempts.size <= MAX_TRACKED) return;
  // 仍然超量：丢掉最久没有活动的记录（Map 迭代顺序即插入顺序）
  const overflow = attempts.size - MAX_TRACKED;
  let dropped = 0;
  for (const ip of attempts.keys()) {
    if (dropped >= overflow) break;
    attempts.delete(ip);
    dropped += 1;
  }
}

function keyOf(ip: string): string {
  return ip || 'unknown';
}

/** 剩余锁定毫秒数；0 表示未被锁定 */
export function loginBlockedFor(ip: string): number {
  const now = Date.now();
  prune(now);
  const rec = attempts.get(keyOf(ip));
  if (!rec) return 0;
  return rec.lockedUntil > now ? rec.lockedUntil - now : 0;
}

/** 锁定剩余时间的中文描述，用于响应文案 */
export function describeBlockedFor(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? '约 1 分钟' : `约 ${minutes} 分钟`;
}

/** 记录一次登录失败；返回是否因此进入锁定 */
export function recordLoginFailure(
  ip: string,
  channel: LoginChannel,
): { locked: boolean; remainingMs: number; fails: number } {
  const now = Date.now();
  prune(now);
  const key = keyOf(ip);
  const existing = attempts.get(key);

  // 窗口已过则重新计数
  const rec: Attempt = existing && now - existing.firstFailAt < WINDOW_MS
    ? existing
    : { fails: 0, firstFailAt: now, lastFailAt: now, lockedUntil: existing?.lockedUntil ?? 0 };

  rec.fails += 1;
  rec.lastFailAt = now;

  let lockedNow = false;
  if (rec.fails >= MAX_FAILS && rec.lockedUntil <= now) {
    rec.lockedUntil = now + LOCK_MS;
    lockedNow = true;
  }
  attempts.set(key, rec);

  const where = describeRemoteAddress(ip);
  if (lockedNow) {
    rootLogger.warn(
      `[鉴权] ${channel}失败 ${rec.fails} 次，已临时拒绝来源 ${where} `
      + `${describeBlockedFor(LOCK_MS)}（重启框架可立即解除）`,
    );
  } else {
    rootLogger.warn(
      `[鉴权] ${channel}失败（来源 ${where}，${WINDOW_MS / 60_000} 分钟内第 ${rec.fails} 次，`
      + `达到 ${MAX_FAILS} 次将临时拒绝）`,
    );
  }

  return {
    locked: rec.lockedUntil > now,
    remainingMs: Math.max(0, rec.lockedUntil - now),
    fails: rec.fails,
  };
}

/** 登录成功：清掉该来源的失败记录 */
export function recordLoginSuccess(ip: string): void {
  attempts.delete(keyOf(ip));
}

/** 供设置页/调试用：清空全部限速状态 */
export function clearLoginThrottle(): void {
  attempts.clear();
}