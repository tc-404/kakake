/**
 * 野生协议端实现识别：NapCat 还是 SnowLuma。
 *
 * 两者都自称 OneBot v11，但同一功能的 action 名与参数键名不完全一致，
 * 代理层必须先认出对面是谁才能选对 `impl[protocol]` 变体。识别双保险：
 *   1. 连接页显式指定（`ConnectionConfig.onebotImpl`），指定了就不探测；
 *   2. auto 探测：发一次 `get_version_info` 按 `app_name` 认实现，结果按连接缓存。
 *
 * 认不出来返回 'unknown'，不猜。调用方把 unknown 按 napcat 处理（生态最常见），
 * 并在 `_proxy.onebotImpl` 留下 'unknown' 让使用者知道该去连接页选对实现名。
 */
import type { OneBotRawResult } from '../../connection/onebot.types.js';

export type OnebotImpl = 'napcat' | 'snowluma' | 'unknown';

/** 连接配置上由使用者指定的实现；'auto' 与不填都表示交给探测（不含 unknown） */
export type OnebotImplSetting = 'auto' | Exclude<OnebotImpl, 'unknown'>;

/** 探测用的一次性原始调用：只依赖 `get_version_info` 这一个动作 */
export type VersionProbe = () => Promise<OneBotRawResult>;

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { impl: OnebotImpl; at: number }>();

/** 从 `get_version_info` 的响应里认出实现名。认不出返回 'unknown'，绝不猜 */
export function implFromVersionInfo(payload: unknown): OnebotImpl {
  const env = (payload && typeof payload === 'object')
    ? payload as Record<string, unknown>
    : {};
  // OneBot 11 的 get_version_info 返回 `{ app_name, app_version, protocol_version, ... }`
  const data = (env.data && typeof env.data === 'object')
    ? env.data as Record<string, unknown>
    : env;
  const hay = [
    data.app_name, data.app_version, data.impl, data.version,
    env.app_name, env.app_version,
  ].filter((v): v is string => typeof v === 'string').join(' ').toLowerCase();

  if (!hay) return 'unknown';
  if (hay.includes('snowluma')) return 'snowluma';
  if (hay.includes('napcat')) return 'napcat';
  return 'unknown';
}

/** 供测试与手动维护使用：清掉某个连接（或全部）的探测缓存 */
export function clearImplCache(connectionId?: string): void {
  if (connectionId) cache.delete(connectionId);
  else cache.clear();
}

/**
 * 取一条 OneBot 连接的实现名。
 *
 * @param setting 连接页上的显式指定；'auto' / undefined 表示探测
 * @param connectionId 用于缓存探测结果
 * @param probe 发一次 `get_version_info` 的能力（由适配层注入）
 */
export async function detectOnebotImpl(
  setting: OnebotImplSetting | undefined,
  connectionId: string,
  probe: VersionProbe,
): Promise<OnebotImpl> {
  if (setting === 'napcat' || setting === 'snowluma') return setting;

  const hit = cache.get(connectionId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.impl;

  let impl: OnebotImpl = 'unknown';
  try {
    const raw = await probe();
    if (raw.ok) impl = implFromVersionInfo(raw.envelope);
  } catch {
    // 探测失败不该让整条请求失败：按 unknown 继续，调用方仍会标明不确定性
    impl = 'unknown';
  }
  cache.set(connectionId, { impl, at: Date.now() });
  return impl;
}
