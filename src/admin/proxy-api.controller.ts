/**
 * 接口代理外放层：`/api/v1/<接口短名>`。
 *
 * 设计要点：
 *
 *   1. **仅在开启外放 API 时才暴露**。`proxyApiEnabled` 默认关闭，关闭时一律 403，
 *      不返回任何数据——与 `publicApiEnabled`（只读概览）是**两个独立开关**，
 *      因为放开「能以机器人身份发消息」和放开「给外部看一眼运行状态」风险量级不同。
 *   2. **鉴权沿用控制台 Bearer 密钥**。不另造一套 token：少一套凭证就少一处泄露面。
 *   3. **限流，且与登录限速隔离**。外放接口按「来源 IP + 接口短名」分桶限流；
 *      桶是独立的，外部把外放接口打爆不该把登录入口一起锁死（那会让使用者
 *      自己被关在后台外面，属于把事故放大成故障）。
 *   4. **GET / POST 都支持**。GET 参数走 query，POST 走 body；官方 DELETE/PATCH
 *      这类动词由注册表里的 `verb` 决定，调用方只传 GET/POST 表达「读/写」意图。
 *
 * 关于 HTTP 状态码的分工（这一点容易含糊，所以写清楚）：
 *   - 代理层**受理**了请求 → 一律 200，真实成败放在 body 的信封里。
 *     因为 body 才是「按原文档透传」的产物，代理层自己套 4xx 反而破坏透传。
 *   - kakake 自己的边界 → 用真实状态码：401 密钥错、403 开关没开、
 *     404 没有这个短名、429 限流。
 */
import { All, Controller, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { configService } from '../core/config.service.js';
import { matchesAuthKey } from './auth-key.js';
import { describeRemoteAddress } from '../core/net-address.js';
import { rootLogger } from '../core/logger.js';
import { kakakeApp } from '../kakake-app.js';
import { getProxyRuntime } from '../proxy/runtime/facade.js';
import type { ProxyHttpMethod } from '../proxy/proxy.types.js';

/* ─────────────────────────── 限流 ─────────────────────────── */

/** 限流窗口 */
const WINDOW_MS = 60 * 1000;
/** 每桶窗口内允许的请求数 */
export const PROXY_API_MAX_PER_WINDOW = 60;
/** 最多跟踪多少个桶，防止伪造来源把内存撑爆 */
const MAX_BUCKETS = 2048;

/**
 * 独立于登录限速的分桶计数器。
 *
 * 为什么不直接复用 login-throttle：那套状态里存的是「失败次数 + 锁定时长」，
 * 语义是「失败 N 次锁 M 分钟」；这里要的是「每分钟 N 次」。更关键的是**隔离**——
 * 共用一份状态就意味着外放接口被刷会把登录入口一起锁掉，使用者连后台都进不去。
 * 所以这里照它的分桶/淘汰思路另起一套，两边互不影响。
 */
const buckets = new Map<string, { count: number; startedAt: number }>();

function bucketKey(ip: string, api: string): string {
  return `${ip || 'unknown'}|${api}`;
}

function pruneBuckets(now: number): void {
  for (const [key, rec] of buckets) {
    if (now - rec.startedAt >= WINDOW_MS) buckets.delete(key);
  }
  if (buckets.size <= MAX_BUCKETS) return;
  const overflow = buckets.size - MAX_BUCKETS;
  let dropped = 0;
  for (const key of buckets.keys()) {
    if (dropped >= overflow) break;
    buckets.delete(key);
    dropped += 1;
  }
}

/**
 * 取一个令牌，返回剩余可请求数；0 表示本窗口已用满。
 * 导出供测试：限流是外放层唯一会被「正常使用」触发的拒绝路径，必须有覆盖。
 */
export function takeProxyApiToken(ip: string, api: string): number {
  const now = Date.now();
  pruneBuckets(now);
  const key = bucketKey(ip, api);
  const rec = buckets.get(key);
  if (!rec || now - rec.startedAt >= WINDOW_MS) {
    buckets.set(key, { count: 1, startedAt: now });
    return PROXY_API_MAX_PER_WINDOW - 1;
  }
  rec.count += 1;
  return Math.max(0, PROXY_API_MAX_PER_WINDOW - rec.count);
}

/** 供测试与设置页诊断用：清空限流状态 */
export function clearProxyApiThrottle(): void {
  buckets.clear();
}

/* ─────────────────────────── 控制器 ─────────────────────────── */

@Controller('api/v1')
export class ProxyApiController {
  /**
   * 通配路由：`/api/v1/xxx` 全部落到这里，再由代理层查注册表。
   *
   * 用通配而不是逐个接口声明，是因为注册表有 270 条且会持续增长——
   * 手写 270 个路由既不可维护，也会让「新增接口要先改外放层」变成隐形耦合。
   *
   * 语法必须是 `{*splat}` 而不是 `*`：项目里的 path-to-regexp 是 8.x，
   * 裸 `*` 会直接抛 "Missing parameter name"，路由静默不注册，
   * 表现为「控制器明明写了却一律 404」。改这里前先确认没把它改回 `*`。
   */
  @All('{*splat}')
  async handle(@Req() req: Request, @Res() res: Response) {
    const api = firstPathSegment(req.path);
    if (!api) {
      res.status(404).json({
        ok: false,
        message: '缺少接口短名。用法：POST /api/v1/<接口短名>，可用短名见控制台「接口代理」页。',
      });
      return;
    }

    // 边界一：开关
    if (!configService.getConfig().proxyApiEnabled) {
      res.status(403).json({
        ok: false,
        message: '接口代理外放未开启（请在设置页开启「接口代理外放 API」开关）',
      });
      return;
    }

    // 边界二：鉴权（复用控制台 Bearer 密钥）
    const auth = req.headers.authorization;
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ')
      ? auth.slice('Bearer '.length)
      : typeof auth === 'string' ? auth : '';
    if (!presented.trim() || !matchesAuthKey(presented.trim())) {
      rootLogger.warn(`[接口代理] 外放调用密钥校验失败（接口 ${api}，来源 ${describeRemoteAddress(req.ip)}）`);
      res.status(401).json({ ok: false, message: '密钥校验失败：请带上控制台 Bearer 密钥' });
      return;
    }

    // 边界三：限流（按来源 IP + 接口短名分桶）
    const ip = describeRemoteAddress(req.ip) === '未知来源' ? '' : String(req.ip ?? '');
    const remaining = takeProxyApiToken(ip, api);
    if (remaining <= 0) {
      res.status(429).json({
        ok: false,
        message: `请求过于频繁：每分钟最多 ${PROXY_API_MAX_PER_WINDOW} 次，请稍后再试`,
      });
      return;
    }

    // 边界四：参数（GET 走 query，POST 走 body）
    const params = collectParams(req);
    const method: ProxyHttpMethod = req.method === 'GET' ? 'GET' : 'POST';
    const conn = typeof params.conn === 'string' ? params.conn : undefined;
    if (conn) delete params.conn;

    // kakake_api 的调用形态：接口短名 + GET/POST + 统一参数。
    // 外放调用没有插件作用域，用一个固定的 source 标识，便于在 _proxy 里分辨来源。
    const api1 = getProxyRuntime({ manager: kakakeApp.connectionManager })
      .createApi('external:/api/v1', {});
    const result = await api1(api, method, params, { conn });
    res.json(result);
  }
}

/** `/api/v1/send_text` → `send_text`；`/api/v1` 或 `/api/v1/` → ''（导出供测试） */
export function firstPathSegment(pathname: string): string {
  const raw = String(pathname || '');
  const withoutPrefix = raw.startsWith('/api/v1') ? raw.slice('/api/v1'.length) : raw;
  const seg = withoutPrefix.split('/').filter(Boolean)[0] ?? '';
  return seg;
}

/**
 * 收集请求参数：GET 用 query，POST 用 body；两者都认 `conn` 指定连接。
 *
 * 只收「裸值」——数组 / 对象这类嵌套参数走 POST body 传，
 * query string 表达不了（`?messages[]=...` 这种写法各协议端解析不一致）。
 */
/** 导出供测试：GET query + POST body 的合并规则 */
export function collectParams(req: Request): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const query = req.query ?? {};
  for (const [k, v] of Object.entries(query)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v) && typeof v[0] === 'string') out[k] = v[0];
  }
  const body = req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (v !== undefined) out[k] = v;
    }
  }
  return out;
}
