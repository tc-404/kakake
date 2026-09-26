/**
 * 媒体工具限速。
 *
 * 解析、下载、预览三条路都会真实消耗服务端：解析要挨个请求上游平台，
 * 下载与预览要吃掉服务端带宽（X 的媒体甚至是逐字节过本机代理）。所以
 * 三类接口都要限速，只是额度不同：
 *   - parse    30 次/分钟：一次解析一个链接，够手动用；
 *   - download 60 次/分钟：人工点按，给足重试余地；
 *   - view    300 次/分钟：图集是一张图一个请求，一次点开就是十几条。
 *
 * 分桶按「会话 → 登录密钥 → 来源 IP」依次取值。框架通常监听 0.0.0.0 并
 * 常挂在反向代理后面，那时所有请求的来源 IP 都是代理自己，只按 IP 分桶
 * 会让一个人把所有人一起限住；能拿到会话或密钥就按它们分桶，做到
 * 「限的是人，不是入口」。状态只存在内存里：重启框架即清空，也是被自己
 * 限住时的逃生口。
 */
import { createHash } from 'node:crypto';
import { logAction } from '../../core/log-store.js';
import { describeRemoteAddress, remoteAddressOf, type RemoteAddressSource } from '../../core/net-address.js';

export type MediaThrottleKind = 'parse' | 'download' | 'view';

type Limit = { windowMs: number; max: number };

const LIMITS: Record<MediaThrottleKind, Limit> = {
  parse: { windowMs: 60 * 1000, max: 30 },
  download: { windowMs: 60 * 1000, max: 60 },
  view: { windowMs: 60 * 1000, max: 300 },
};

/** 最多跟踪多少个桶，防止伪造来源把内存撑爆 */
const MAX_TRACKED = 512;

const LABEL: Record<MediaThrottleKind, string> = {
  parse: '解析',
  download: '下载',
  view: '预览',
};

const hits = new Map<string, number[]>();

function prune(now: number): void {
  for (const [key, list] of hits) {
    const last = list[list.length - 1];
    if (last == null || now - last >= windowOf(key)) hits.delete(key);
  }
  if (hits.size <= MAX_TRACKED) return;
  const overflow = hits.size - MAX_TRACKED;
  let dropped = 0;
  for (const key of hits.keys()) {
    if (dropped >= overflow) break;
    hits.delete(key);
    dropped += 1;
  }
}

function windowOf(key: string): number {
  const kind = key.slice(0, key.indexOf('|')) as MediaThrottleKind;
  return LIMITS[kind]?.windowMs ?? LIMITS.parse.windowMs;
}

/**
 * 记一次调用。
 * @returns 剩余等待毫秒数；0 表示本次放行
 */
export function mediaThrottleBlockedFor(kind: MediaThrottleKind, bucket: string): number {
  const limit = LIMITS[kind];
  const now = Date.now();
  const key = `${kind}|${bucket || 'unknown'}`;
  const list = (hits.get(key) || []).filter((t) => now - t < limit.windowMs);

  if (list.length >= limit.max) {
    hits.set(key, list);
    logAction(
      '【视频解析】',
      `${LABEL[kind]}过于频繁，已临时拒绝 ${bucket || '未知来源'}`,
      `${limit.windowMs / 1000} 秒内已请求 ${list.length} 次（上限 ${limit.max} 次），状态存内存，重启框架可立即解除`,
      'warn',
    );
    return limit.windowMs - (now - list[0]!);
  }

  list.push(now);
  hits.set(key, list);
  if (hits.size > MAX_TRACKED) prune(now);
  return 0;
}

/** 兼容旧调用点：解析限速 */
export function mediaParseBlockedFor(bucket: string): number {
  return mediaThrottleBlockedFor('parse', bucket);
}

/** 供调试/设置页使用：清空全部限速状态 */
export function clearMediaThrottle(): void {
  hits.clear();
}

export interface MediaThrottleSource extends RemoteAddressSource {
  headers?: Record<string, unknown> | undefined;
}

function cookieValue(req: MediaThrottleSource, name: string): string {
  const header = req.headers?.cookie;
  if (typeof header !== 'string' || !header) return '';
  const part = header
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`));
  return part ? part.slice(name.length + 1) : '';
}

/**
 * 限速分桶键：优先会话，其次是登录密钥（散列后只留指纹），最后才回退到
 * 来源 IP。这样反代后面的多个使用者互不影响，而匿名请求仍然按 IP 计数。
 */
export function mediaThrottleBucketOf(req: MediaThrottleSource): string {
  const session = cookieValue(req, 'kakake_session');
  if (session) return `会话 ${session.slice(0, 8)}`;

  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.trim()) {
    const digest = createHash('sha256').update(auth.trim()).digest('hex').slice(0, 8);
    return `密钥 ${digest}`;
  }
  return `来源 ${describeRemoteAddress(remoteAddressOf(req))}`;
}
