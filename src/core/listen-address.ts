import { isIP } from 'node:net';

/**
 * 监听地址 / 端口收口：设置保存接口与启动兜底共用。
 * 规则与设置页前端的 portIssue / hostIssue 一致：前端管行内提示，这里管落盘。
 */

/** 常见服务默认端口 + 连号/重复数字这类弱端口：扫描器必扫、最容易被猜，一律不允许 */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1080, 1433, 1521, 1723, 2049, 2375, 3128, 3306, 3389, 5432, 5900, 5984, 6379, 6443,
  8080, 8081, 8443, 8880, 8888, 9000, 9090, 9200, 9300, 11211, 27017, 27018,
  1111, 1234, 2222, 3333, 4444, 5555, 6666, 7777, 9999, 12345, 54321,
]);

/** 1–1023 为系统特权端口：普通用户监听不了，也不该把控制台放上去 */
export const PRIVILEGED_PORT_MAX = 1024;

/** 主机名（RFC 1123 简化版）：字母数字连字符的点分标签，单段 ≤63、总长 ≤253 */
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/**
 * 收口监听地址：合法收 IPv4 / IPv6 / 主机名，空串与非法值退回 fallback。
 * 纯数字标签（如 "123"、"999.999.999.999"）按打错的 IP 处理，不收。
 */
export function normalizeListenHost(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const s = value.trim();
  if (!s) return fallback;
  if (isIP(s)) return s;
  if (/^\d+(\.\d+)*$/.test(s)) return fallback;
  if (s.length <= 253 && HOSTNAME_RE.test(s)) return s.toLowerCase();
  return fallback;
}

/** 收口监听端口：非整数、越界、特权端口、弱端口一律退回 fallback（与前端保持一致） */
export function normalizeListenPort(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < PRIVILEGED_PORT_MAX || n > 65535) return fallback;
  if (BLOCKED_PORTS.has(n)) return fallback;
  return n;
}
