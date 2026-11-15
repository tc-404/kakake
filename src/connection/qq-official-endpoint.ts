/**
 * QQ 官方 OpenAPI 域名兼容层。
 *
 * 官方 2026-08-10 起把接口调用域名统一为 `https://api.bot.qq.com`，并取消了独立的
 * 沙箱域名（旧：`api.sgroup.qq.com` / `sandbox.api.sgroup.qq.com`）。
 *
 * 但框架里存量的连接配置、旧版本插件以及部分自部署环境仍按旧域名工作，
 * 一刀切改成新域名会让这些老配置当场失效。所以这里的策略是：
 *
 *   1. **默认先用旧域名**（保持与旧版本插件、既有配置完全一致的行为）；
 *   2. 只有确认「旧域名行不通」才切到新域名重试同一请求：连接阶段 errno，
 *      或网关返回 404 / 410 且响应体不是官方业务错误；502 / 503 只对 GET 切换
 *      （写请求可能已经送达旧网关，自动重试会造成重复消息）；
 *   3. 切换结果按「沙箱 / 正式」在进程内缓存，后续请求直接用已验证可用的域名，
 *      不会每次都先撞一次墙。需要重新探测时重启进程或调用 reset 即可。
 *
 * 业务错误（401/403/40034xxx 等）**绝不触发切换**：那说明域名是通的，
 * 换域名重试写操作只会造成重复发消息。
 *
 * 可用环境变量覆盖默认策略：
 *   KAKAKE_GF_API_BASE=legacy   强制只用旧域名（排查兼容问题时用）
 *   KAKAKE_GF_API_BASE=current  强制只用新域名（已全量迁移的环境）
 *   KAKAKE_GF_API_BASE=https://...  自定义网关地址
 *   不设置 / auto                先旧后新自动回退
 */

export const QQ_OFFICIAL_LEGACY_API_BASE = 'https://api.sgroup.qq.com';
export const QQ_OFFICIAL_LEGACY_SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com';
/** 2026-08-10 起官方统一域名，沙箱与正式共用，不再有独立沙箱入口 */
export const QQ_OFFICIAL_CURRENT_API_BASE = 'https://api.bot.qq.com';

type EnvKey = 'sandbox' | 'prod';

/** 已判定可用（或已回退）的域名，按环境分别缓存 */
const selectedBases = new Map<EnvKey, string>();

/** 网关侧「域名/路由已停用」类状态码。业务错误码不在此列，见 isQqOfficialEndpointGone */
const DOMAIN_DEAD_HTTP_STATUS = new Set([404, 410, 502, 503]);

/** 连接还没建立就失败：请求体一定没送达，换域名重试不会产生重复消息 */
const CONNECT_STAGE_HINTS = [
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ETIMEDOUT',
  'EACCES',
  'UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
];

function envKey(sandbox?: boolean): EnvKey {
  return sandbox ? 'sandbox' : 'prod';
}

function legacyBase(sandbox?: boolean): string {
  return sandbox ? QQ_OFFICIAL_LEGACY_SANDBOX_API_BASE : QQ_OFFICIAL_LEGACY_API_BASE;
}

/** 环境变量覆盖；返回 null 表示走自动的「先旧后新」策略 */
function envOverride(sandbox?: boolean): string[] | null {
  const raw = String(process.env.KAKAKE_GF_API_BASE ?? '').trim();
  if (!raw || raw.toLowerCase() === 'auto') return null;
  const lower = raw.toLowerCase();
  if (lower === 'legacy') return [legacyBase(sandbox)];
  if (lower === 'current') return [QQ_OFFICIAL_CURRENT_API_BASE];
  if (/^https?:\/\//i.test(raw)) return [raw.replace(/\/+$/, '')];
  return null;
}

/**
 * 本次请求要尝试的域名列表，按顺序排列。
 * 自动策略下：未探测过时是 [旧, 新]；一旦旧域名被判定不可用就只剩 [新]。
 */
export function resolveQqOfficialApiBases(sandbox?: boolean): string[] {
  const override = envOverride(sandbox);
  if (override) return override;
  const selected = selectedBases.get(envKey(sandbox));
  if (selected) return [selected];
  return [legacyBase(sandbox), QQ_OFFICIAL_CURRENT_API_BASE];
}

/** 当前首选域名（供只需展示 / 拼一个 URL 的调用方使用，签名与旧函数一致） */
export function currentQqOfficialApiBase(sandbox?: boolean): string {
  return resolveQqOfficialApiBases(sandbox)[0];
}

/**
 * 标记某个域名不可用，返回切换后的备用域名；没有备用域名（或强制单域名）时返回 null。
 */
export function markQqOfficialBaseUnavailable(base: string, sandbox?: boolean): string | null {
  if (envOverride(sandbox)) return null;
  const all = [legacyBase(sandbox), QQ_OFFICIAL_CURRENT_API_BASE];
  const next = all.find((b) => b !== base) ?? null;
  if (next) selectedBases.set(envKey(sandbox), next);
  return next;
}

/** 仅供单测 / 手动重新探测用：清空进程内的域名选择缓存 */
export function resetQqOfficialApiBaseSelection(): void {
  selectedBases.clear();
}

/**
 * HTTP 层判定：这个响应是不是「域名不可用」而不是业务报错。
 *
 * 官方业务错误永远是带 `code` / `message` 的 JSON；旧域名下线时网关通常回
 * 404 的 HTML 页、空正文或纯文本提示。带 code 的响应一律视为业务错误，不切换。
 */
export function isQqOfficialEndpointGone(httpStatus: number, bodyText: string): boolean {
  if (!DOMAIN_DEAD_HTTP_STATUS.has(httpStatus)) return false;
  const text = String(bodyText ?? '').trim();
  if (!text) return true;
  if (!text.startsWith('{')) return true;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && ('code' in parsed || 'message' in parsed)) {
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

/** 网络层判定：连接阶段失败才允许换域名重试（避免写请求重复送达） */
export function isQqOfficialConnectFailure(err: unknown): boolean {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number): void => {
    if (!node || depth > 5 || seen.has(node)) return;
    seen.add(node);
    if (node instanceof Error) {
      parts.push(String(node.message ?? ''), String((node as { code?: unknown }).code ?? ''));
      const e = node as { cause?: unknown; errors?: unknown };
      if (Array.isArray(e.errors)) for (const sub of e.errors) walk(sub, depth + 1);
      walk(e.cause, depth + 1);
    } else {
      parts.push(String(node));
    }
  };
  walk(err, 0);
  const text = parts.join(' ');
  return CONNECT_STAGE_HINTS.some((hint) => text.includes(hint));
}
