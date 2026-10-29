import fs from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
// 注意 import 顺序：logger ↔ atomic-file 存在循环依赖，这里必须先落存储层，
// 否则在「本模块最先被加载」的入口里会撞上 rootLogger 尚未初始化的 TDZ 报错。
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { matchesAuthKey } from './auth-key.js';
import { rootLogger } from '../core/logger.js';
import {
  describeRemoteAddress,
  isTrustedLocalAddress,
  normalizeIpAddress,
  proxyHeadersPresent,
} from '../core/net-address.js';
import { PATHS } from '../paths.js';

/**
 * 登录失败限速：来源 IP、网段（IPv4 /24、IPv6 /64）、密钥指纹 HMAC、全局计数四层叠加。
 * 全局冷却对可信来源 / 本机回环 / 多来源攻击期间的内网来源豁免，避免把管理员反锁。
 * 其余状态只在内存，重启即清空（也是被锁时的逃生口）；失败越多响应越慢。
 */

/** 失败计数窗口（四层共用一个窗口长度，便于统一过期清理） */
const WINDOW_MS = 10 * 60 * 1000;

/** ① 来源：窗口内允许的失败次数（放宽一些，避免手动输入长密钥打错几次就被锁） */
const SOURCE_MAX_FAILS = 6;
/** ① 来源：超限后的锁定时长 */
const SOURCE_LOCK_MS = 30 * 60 * 1000;
/** ① 来源：全局高压期间收紧到的阈值（此时已明确有人在扫，不再宽容） */
const SOURCE_MAX_FAILS_PRESSURE = 3;

/** ② 网段：IPv4 /24、IPv6 /64。阈值明显高于单来源，避免同网段误伤 */
const NET_MAX_FAILS = 24;
const NET_LOCK_MS = 15 * 60 * 1000;

/** ③ 密钥指纹：同一个错误密钥跨来源允许的失败次数 */
const KEY_MAX_FAILS = 6;
const KEY_LOCK_MS = 15 * 60 * 1000;

/** ④ 全局：进入「高压」（不硬拒，但强延迟 + 收紧单来源阈值） */
const GLOBAL_PRESSURE_FAILS = 40;
const GLOBAL_PRESSURE_SOURCES = 12;
/** ④ 全局：进入「硬冷却」（直接拒绝所有未豁免来源） */
const GLOBAL_LOCK_FAILS = 120;
const GLOBAL_LOCK_SOURCES = 30;
const GLOBAL_LOCK_MS = 60 * 60 * 1000;
/** 高压态在最后一次失败后还保持多久 */
const PRESSURE_HOLD_MS = 10 * 60 * 1000;
/** 高压期间的响应延迟 */
const PRESSURE_DELAY_MS = 1500;
/** 告警节流：同一类全局告警的最小间隔，避免刷爆日志 */
const ALERT_THROTTLE_MS = 60 * 1000;

/** 各表最多跟踪多少个键，防止伪造来源地址把内存撑爆 */
const MAX_TRACKED_SOURCE = 2048;
const MAX_TRACKED_NET = 1024;
const MAX_TRACKED_KEY = 1024;

/** 可信来源：最多记录多少个、记多久 */
const TRUSTED_MAX = 512;
const TRUSTED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 失败来源：用于日志区分是哪条登录通道 */
export type LoginChannel = '后台登录' | '快捷登录链接' | 'Authorization 密钥';

/** 被拒的原因，用于给出更准确的提示 */
export type LoginBlockReason = 'source' | 'network' | 'key' | 'global';

export interface LoginGuardVerdict {
  /** 剩余锁定毫秒数；0 表示可以继续尝试 */
  blockedMs: number;
  /** 命中哪一层；null 表示未命中 */
  reason: LoginBlockReason | null;
  /** 建议的响应延迟（毫秒）：失败越多越慢，拖住爆破但不挡真人 */
  delayMs: number;
  /** 当前是否处于全局高压 */
  pressure: boolean;
  /** 该来源本次窗口内已失败次数 */
  fails: number;
}

type Attempt = {
  fails: number;
  firstFailAt: number;
  lastFailAt: number;
  lockedUntil: number;
};

type Bucket = {
  times: number[];
  lockedUntil: number;
};

type GlobalState = {
  times: number[];
  /** 来源 -> 该来源最后一次失败的时间 */
  sources: Map<string, number>;
  lockedUntil: number;
  pressureUntil: number;
  lastPressureAlertAt: number;
  lastLockAlertAt: number;
};

/**
 * 密钥指纹盐：进程内随机生成。
 *
 * 刻意**不使用登录密钥本身**做 HMAC 的 key——那会为取盐而触发 auth-key 的
 * 读取/初始化（有写文件副作用），也让指纹随用户改密而失效。指纹只需要
 * 「同一进程内对同一输入稳定」，随机盐足够，且重启后整张表本来就是空的。
 */
const FINGERPRINT_SECRET = randomBytes(32).toString('hex');

const sources = new Map<string, Attempt>();
const networks = new Map<string, Bucket>();
const keyPrints = new Map<string, Bucket>();

const globalState: GlobalState = {
  times: [],
  sources: new Map<string, number>(),
  lockedUntil: 0,
  pressureUntil: 0,
  lastPressureAlertAt: 0,
  lastLockAlertAt: 0,
};

/** 曾成功登录的来源：全局层对它们放行 */
const trustedIps = new Map<string, number>();
const trustedNets = new Map<string, number>();
let trustedLoaded = false;

type GlobalLockListener = () => void;
const globalLockListeners: GlobalLockListener[] = [];

export function onGlobalLock(listener: GlobalLockListener): void {
  globalLockListeners.push(listener);
}

function notifyGlobalLock(): void {
  for (const listener of globalLockListeners) {
    try {
      listener();
    } catch {}
  }
}

export function sourceBlockedMs(ip: string): number {
  const rec = sources.get(keyOf(ip));
  if (!rec || rec.lockedUntil <= Date.now()) return 0;
  return rec.lockedUntil - Date.now();
}

export function globalBlockedMs(): number {
  const remain = globalState.lockedUntil - Date.now();
  return remain > 0 ? remain : 0;
}

export function isBannedSource(
  ip: string,
  headers: Record<string, unknown> | undefined | null,
): boolean {
  if (isTrustedLocalAddress(ip) && proxyHeadersPresent(headers).length === 0) return false;
  return sourceBlockedMs(ip) > 0 || globalBlockedMs() > 0;
}

function now(): number {
  return Date.now();
}

function keyOf(ip: string): string {
  return normalizeIpAddress(ip) || 'unknown';
}

/**
 * 网段键：IPv4 取 /24，IPv6 取 /64。
 *
 * IPv6 必须聚合：一台机器通常就握着一整个 /64（SLAAC / PD 下发），换地址
 * 不要钱，按精确地址计数等于没有计数。
 */
function netKeyOf(ip: string): string {
  const norm = keyOf(ip);
  if (norm === 'unknown') return 'unknown';

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(norm);
  if (v4) return `v4:${v4[1]}.${v4[2]}.${v4[3]}.0/24`;

  const groups = expandIpv6(norm);
  if (groups) return `v6:${groups.slice(0, 4).join(':')}::/64`;

  return `raw:${norm}`;
}

/** 把 IPv6 展开成 8 组四位十六进制；不是合法 IPv6 则返回 null */
function expandIpv6(ip: string): string[] | null {
  if (!ip.includes(':')) return null;

  let text = ip;
  // 内嵌 IPv4 形式：x:x:x:x:x:x:d.d.d.d → 末两段
  const lastColon = text.lastIndexOf(':');
  const tail = lastColon >= 0 ? text.slice(lastColon + 1) : '';
  if (tail.includes('.')) {
    const parts = tail.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p))) {
      const hi = ((Number(parts[0]) << 8) | Number(parts[1])).toString(16);
      const lo = ((Number(parts[2]) << 8) | Number(parts[3])).toString(16);
      text = `${text.slice(0, lastColon + 1)}${hi}:${lo}`;
    }
  }

  const hasCompress = text.includes('::');
  const head = hasCompress ? text.slice(0, text.indexOf('::')) : text;
  const rest = hasCompress ? text.slice(text.indexOf('::') + 2) : '';
  const headGroups = head ? head.split(':') : [];
  const tailGroups = rest ? rest.split(':') : [];
  const fill = 8 - headGroups.length - tailGroups.length;
  if (fill < 0) return null;
  const groups = [...headGroups, ...Array(Math.max(0, fill)).fill('0'), ...tailGroups];
  if (groups.length !== 8) return null;
  return groups.map((g) => (g || '0').toLowerCase().padStart(4, '0'));
}

/** 提交的密钥 → 指纹。空输入不参与（登录页空提交不该被当成一次固定猜测） */
function fingerprintOf(presented: string | undefined): string {
  if (!presented) return '';
  return createHmac('sha256', FINGERPRINT_SECRET).update(presented).digest('hex').slice(0, 20);
}

function trimWindow(times: number[], at: number): number[] {
  return times.filter((t) => at - t < WINDOW_MS);
}

function dropStale(global: GlobalState, at: number): void {
  if (global.times.length) {
    global.times = global.times.filter((t) => at - t < WINDOW_MS);
  }
  for (const [ip, at2] of global.sources) {
    if (at - at2 >= WINDOW_MS) global.sources.delete(ip);
  }
}

function pruneSources(at: number): void {
  for (const [k, rec] of sources) {
    if (at >= rec.lockedUntil && at - rec.lastFailAt >= WINDOW_MS) sources.delete(k);
  }
  cap(sources, MAX_TRACKED_SOURCE);
}

function pruneBuckets(m: Map<string, Bucket>, at: number, limit: number): void {
  for (const [k, b] of m) {
    const stale = b.times.length === 0 || at - Math.max(...b.times) >= WINDOW_MS;
    if (at >= b.lockedUntil && stale) m.delete(k);
  }
  cap(m, limit);
}

/** 超量时丢掉最久没动的键（Map 迭代顺序即插入顺序） */
function cap(m: Map<string, unknown>, limit: number): void {
  if (m.size <= limit) return;
  const overflow = m.size - limit;
  let dropped = 0;
  for (const k of m.keys()) {
    if (dropped >= overflow) break;
    m.delete(k);
    dropped += 1;
  }
}

function pruneAll(at: number): void {
  pruneSources(at);
  pruneBuckets(networks, at, MAX_TRACKED_NET);
  pruneBuckets(keyPrints, at, MAX_TRACKED_KEY);
  dropStale(globalState, at);
}

/* ------------------------------------------------------------------ *
 * 可信来源（曾成功登录过）：全局层对它们放行
 * ------------------------------------------------------------------ */

interface LoginGuardFile {
  trustedIps?: Record<string, number>;
  trustedNets?: Record<string, number>;
}

function ensureTrustedLoaded(): void {
  if (trustedLoaded) return;
  trustedLoaded = true;
  try {
    const raw = readJsonSafe<LoginGuardFile>(PATHS.loginGuard, {}, { label: 'login-guard.json' });
    for (const [k, v] of Object.entries(raw.trustedIps ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) trustedIps.set(k, v);
    }
    for (const [k, v] of Object.entries(raw.trustedNets ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v)) trustedNets.set(k, v);
    }
    cap(trustedIps, TRUSTED_MAX);
    cap(trustedNets, TRUSTED_MAX);
  } catch {
    /* 读不到就当没有，不影响启动 */
  }
}

function persistTrusted(): void {
  try {
    writeJsonAtomic(PATHS.loginGuard, {
      trustedIps: Object.fromEntries(trustedIps),
      trustedNets: Object.fromEntries(trustedNets),
    } satisfies LoginGuardFile);
  } catch (err) {
    rootLogger.debug(`[鉴权] 可信来源持久化失败：${String(err)}`);
  }
}

function isTrustedSource(ip: string, at: number): boolean {
  ensureTrustedLoaded();
  const norm = keyOf(ip);
  const ipAt = trustedIps.get(norm);
  if (typeof ipAt === 'number' && at - ipAt < TRUSTED_TTL_MS) return true;
  const netAt = trustedNets.get(netKeyOf(norm));
  if (typeof netAt === 'number' && at - netAt < TRUSTED_TTL_MS) return true;
  return false;
}

function markTrusted(ip: string, at: number): void {
  ensureTrustedLoaded();
  const norm = keyOf(ip);
  trustedIps.set(norm, at);
  trustedNets.set(netKeyOf(norm), at);
  cap(trustedIps, TRUSTED_MAX);
  cap(trustedNets, TRUSTED_MAX);
  persistTrusted();
}

/* ------------------------------------------------------------------ *
 * 判定
 * ------------------------------------------------------------------ */

/** 当前是否处于全局高压 */
function inPressure(at: number): boolean {
  return globalState.lockedUntil > at || globalState.pressureUntil > at;
}

/** 来源失败次数递增的响应延迟：真人无感，脚本很疼 */
function stepDelayFor(fails: number): number {
  if (fails <= 1) return 0;
  if (fails === 2) return 250;
  if (fails === 3) return 700;
  if (fails === 4) return 1500;
  return 2500;
}

/**
 * 全局硬冷却的豁免判定。
 *
 * 只豁免两类：曾成功登录过的来源；本机 / 内网来源（自救通道）。内网豁免不再
 * 取决于窗口内的来源数量：整站闸门已经按「是否带代理头」把反代场景挡在外面，
 * 这里再按来源数收口只会让内网在冷却中段被误伤。
 */
function exemptFromGlobalLock(ip: string, at: number): boolean {
  if (isTrustedSource(ip, at)) return true;
  return isTrustedLocalAddress(ip);
}

/**
 * 判定一次登录尝试是否放行。
 *
 * @param ip 来源地址
 * @param presentedKey 本次提交的密钥（取指纹计数用；比对只在放行判定，不落明文）
 */
export function inspectLoginGuard(ip: string, presentedKey?: string): LoginGuardVerdict {
  const at = now();
  pruneAll(at);
  const src = keyOf(ip);
  const trusted = isTrustedSource(src, at);

  const rec = sources.get(src);
  const net = networks.get(netKeyOf(src));
  const print = fingerprintOf(presentedKey);
  const kb = print ? keyPrints.get(print) : undefined;

  let blockedMs = 0;
  let reason: LoginBlockReason | null = null;
  const consider = (until: number, tag: LoginBlockReason): void => {
    if (until <= at) return;
    const remain = until - at;
    if (remain > blockedMs) {
      blockedMs = remain;
      reason = tag;
    }
  };

  // 来源/网段/密钥指纹层：密钥正确即放行——能给出正确密钥的只有管理员本人，
  // 锁定只拦错误密钥，防爆破语义不变，同时消除「打错 6 次反锁管理员」的 DoS 面。
  // 全局层不受此豁免：多来源攻击风暴期间连正确密钥也按密码错误伪装拒绝（调用方负责伪装）。
  const keyMatches = !!presentedKey && matchesAuthKey(presentedKey);
  if (!keyMatches) {
    consider(rec?.lockedUntil ?? 0, 'source');
    consider(net?.lockedUntil ?? 0, 'network');
    consider(kb?.lockedUntil ?? 0, 'key');
  }
  if (!exemptFromGlobalLock(src, at)) consider(globalState.lockedUntil, 'global');

  const pressure = inPressure(at);
  let delayMs = 0;
  if (!trusted) {
    delayMs = pressure ? PRESSURE_DELAY_MS : stepDelayFor(rec?.fails ?? 0);
  }

  return {
    blockedMs,
    reason,
    delayMs: blockedMs > 0 ? 0 : delayMs,
    pressure,
    fails: rec?.fails ?? 0,
  };
}

/** 剩余锁定毫秒数；0 表示未被锁定（兼容旧调用点） */
export function loginBlockedFor(ip: string, presentedKey?: string): number {
  return inspectLoginGuard(ip, presentedKey).blockedMs;
}

/** 锁定剩余时间的中文描述，用于响应文案 */
export function describeBlockedFor(remainingMs: number): string {
  const minutes = Math.ceil(remainingMs / 60_000);
  return minutes <= 1 ? '约 1 分钟' : `约 ${minutes} 分钟`;
}

/** 按被拒原因给出提示文案：全局层值得说清楚，否则管理员不知道发生了什么 */
export function describeBlockReason(reason: LoginBlockReason | null, remainingMs: number): string {
  if (reason === 'global') {
    return `检测到来自多个来源的异常登录尝试，已临时加强登录防护，请在${describeBlockedFor(remainingMs)}后重试`;
  }
  return `登录尝试过于频繁，请在${describeBlockedFor(remainingMs)}后重试`;
}

/* ------------------------------------------------------------------ *
 * 记账
 * ------------------------------------------------------------------ */

/** 记录一次登录失败；返回是否因此进入锁定 */
export function recordLoginFailure(
  ip: string,
  channel: LoginChannel,
  presentedKey?: string,
): { locked: boolean; remainingMs: number; fails: number } {
  const at = now();
  pruneAll(at);
  const src = keyOf(ip);
  const where = describeRemoteAddress(ip);

  // ① 来源维度
  const existing = sources.get(src);
  const rec: Attempt = existing && at - existing.firstFailAt < WINDOW_MS
    ? existing
    : { fails: 0, firstFailAt: at, lastFailAt: at, lockedUntil: existing?.lockedUntil ?? 0 };
  rec.fails += 1;
  rec.lastFailAt = at;
  const pressureBefore = inPressure(at);
  const sourceLimit = pressureBefore ? SOURCE_MAX_FAILS_PRESSURE : SOURCE_MAX_FAILS;
  if (rec.fails >= sourceLimit && rec.lockedUntil <= at) {
    rec.lockedUntil = at + SOURCE_LOCK_MS;
  }
  sources.set(src, rec);

  // ② 网段维度
  const nk = netKeyOf(src);
  const net = bumpBucket(networks, nk, at);
  if (net.times.length >= NET_MAX_FAILS && net.lockedUntil <= at) {
    net.lockedUntil = at + NET_LOCK_MS;
  }
  networks.set(nk, net);

  // ③ 密钥指纹维度（跨来源累计）
  const print = fingerprintOf(presentedKey);
  if (print) {
    const kb = bumpBucket(keyPrints, print, at);
    if (kb.times.length >= KEY_MAX_FAILS && kb.lockedUntil <= at) {
      kb.lockedUntil = at + KEY_LOCK_MS;
    }
    keyPrints.set(print, kb);
  }

  // ④ 全局维度
  globalState.times.push(at);
  globalState.sources.set(src, at);
  if (globalState.times.length > 512) {
    globalState.times = globalState.times.slice(-512);
  }
  const totalFails = globalState.times.length;
  const distinctSources = globalState.sources.size;

  let hardLocked = false;
  if (
    globalState.lockedUntil <= at
    && (totalFails >= GLOBAL_LOCK_FAILS || distinctSources >= GLOBAL_LOCK_SOURCES)
  ) {
    globalState.lockedUntil = at + GLOBAL_LOCK_MS;
    globalState.pressureUntil = at + GLOBAL_LOCK_MS;
    hardLocked = true;
    notifyGlobalLock();
  } else if (totalFails >= GLOBAL_PRESSURE_FAILS || distinctSources >= GLOBAL_PRESSURE_SOURCES) {
    globalState.pressureUntil = Math.max(globalState.pressureUntil, at + PRESSURE_HOLD_MS);
  }

  cap(networks, MAX_TRACKED_NET);
  cap(keyPrints, MAX_TRACKED_KEY);
  cap(sources, MAX_TRACKED_SOURCE);

  // 日志：已经喊过警报之后降级为 info，避免分布式扫描把运行日志刷爆
  const noisy = inPressure(at);
  const write = (msg: string): void => {
    if (noisy) rootLogger.info(msg);
    else rootLogger.warn(msg);
  };

  if (hardLocked && at - globalState.lastLockAlertAt >= ALERT_THROTTLE_MS) {
    globalState.lastLockAlertAt = at;
    rootLogger.warn(
      `[鉴权] 检测到分布式登录尝试：${WINDOW_MS / 60_000} 分钟内失败 ${totalFails} 次、`
      + `来自 ${distinctSources} 个不同来源，已临时拒绝未验证来源 ${describeBlockedFor(GLOBAL_LOCK_MS)}`
      + '（曾成功登录的来源与本机/内网来源仍可登录；重启框架可立即解除）'
      + '。若部署在反向代理之后，所有请求的来源地址相同，建议在代理层做限速或真实 IP 透传。',
    );
  } else if (globalState.pressureUntil > at && at - globalState.lastPressureAlertAt >= ALERT_THROTTLE_MS) {
    globalState.lastPressureAlertAt = at;
    rootLogger.warn(
      `[鉴权] 登录失败集中在短时间内：${WINDOW_MS / 60_000} 分钟内 ${totalFails} 次、`
      + `来自 ${distinctSources} 个来源，已进入高压模式（响应延迟 + 单来源阈值收紧至 `
      + `${SOURCE_MAX_FAILS_PRESSURE} 次）`,
    );
  }

  if (!noisy || rec.fails >= sourceLimit) {
    write(
      `[鉴权] ${channel}失败（来源 ${where}，${WINDOW_MS / 60_000} 分钟内第 ${rec.fails} 次，`
      + `达到 ${sourceLimit} 次将临时拒绝；全局 ${totalFails} 次 / ${distinctSources} 个来源）`,
    );
  }

  const remainingMs = Math.max(0, rec.lockedUntil - at);
  return {
    locked: remainingMs > 0,
    remainingMs,
    fails: rec.fails,
  };
}

function bumpBucket(m: Map<string, Bucket>, k: string, at: number): Bucket {
  const existing = m.get(k);
  const b: Bucket = existing ?? { times: [], lockedUntil: 0 };
  b.times = trimWindow(b.times, at);
  b.times.push(at);
  m.set(k, b);
  return b;
}

const MAX_PENDING_PAUSES = 64;
let pendingPauses = 0;

/** 响应前等待：把「失败延迟」真正落到响应上（调用点 await 即可） */
export function pauseLoginResponse(ms: number): Promise<void> {
  if (ms <= 0 || pendingPauses >= MAX_PENDING_PAUSES) return Promise.resolve();
  pendingPauses += 1;
  return new Promise((resolve) => {
    setTimeout(() => {
      pendingPauses -= 1;
      resolve();
    }, ms);
  });
}

/** 登录成功：清掉该来源的失败记录，登记可信来源，并把来源记进运行日志 */
export function recordLoginSuccess(ip: string, channel: LoginChannel = '后台登录'): void {
  const at = now();
  const src = keyOf(ip);
  sources.delete(src);
  // 成功登录说明不是攻击：把全局层的账也一并清掉，避免自己打错几次后
  // 与真实攻击叠加，把管理员拖进冷却。攻击者无法成功登录，清不掉。
  globalState.times = [];
  globalState.sources.clear();
  globalState.lockedUntil = 0;
  globalState.pressureUntil = 0;
  markTrusted(src, at);
  rootLogger.info(`[鉴权] ${channel}成功（来源 ${describeRemoteAddress(ip)}）`);
}

/** 供设置页/调试用：清空全部限速状态（含持久化的可信来源） */
export function clearLoginThrottle(): void {
  sources.clear();
  networks.clear();
  keyPrints.clear();
  globalState.times = [];
  globalState.sources.clear();
  globalState.lockedUntil = 0;
  globalState.pressureUntil = 0;
  globalState.lastPressureAlertAt = 0;
  globalState.lastLockAlertAt = 0;
  trustedIps.clear();
  trustedNets.clear();
  trustedLoaded = true;
  try {
    if (fs.existsSync(PATHS.loginGuard)) fs.rmSync(PATHS.loginGuard, { force: true });
  } catch {
    /* 清理失败不致命 */
  }
}

/** 当前防护状态快照：排查「为什么登不进去」时有用 */
export function loginGuardSnapshot(): {
  pressure: boolean;
  globalLockedMs: number;
  failsInWindow: number;
  distinctSources: number;
  trackedSources: number;
  trackedNetworks: number;
  trackedKeys: number;
  trustedSources: number;
} {
  const at = now();
  pruneAll(at);
  ensureTrustedLoaded();
  return {
    pressure: inPressure(at),
    globalLockedMs: Math.max(0, globalState.lockedUntil - at),
    failsInWindow: globalState.times.length,
    distinctSources: globalState.sources.size,
    trackedSources: sources.size,
    trackedNetworks: networks.size,
    trackedKeys: keyPrints.size,
    trustedSources: trustedIps.size,
  };
}
