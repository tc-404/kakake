// ---------------------------------------------------------------------------
// 连接配置导入：判重与合并规则（纯逻辑，不碰磁盘，方便单测）
// ---------------------------------------------------------------------------

import {
  connectionFingerprint,
  hasResolvedAccount,
  onebotLooseFingerprint,
  type ConnectionConfig,
} from './types.js';

/**
 * 判断导入的这条连接，是否命中本机已有的一条。
 *
 * 两条规则：
 *
 * ① 严格指纹相同 → 命中。`connectionFingerprint()` 对 OneBot 取
 *    **账号 + 地址 + 端口 + 密钥** 四要素，其余协议取 账号 id。
 *    所以 OneBot **同账号但换了端口** 不会命中——那是另一个接入点，应作为新连接进来。
 *
 * ② OneBot 且导入项还没有账号（`botUin` 是连上之后才回填的，导出时可能还没填）→
 *    退化成 **地址 + 端口 + 密钥** 三要素再比一次，避免把同一条连接加成两条。
 */
export function matchExistingConnection(
  existing: ConnectionConfig[],
  incoming: ConnectionConfig,
): ConnectionConfig | null {
  const fp = connectionFingerprint(incoming);
  const hit = existing.find((c) => connectionFingerprint(c) === fp);
  if (hit) return hit;

  if (incoming.type === 'onebot' && !hasResolvedAccount(incoming)) {
    const loose = onebotLooseFingerprint(incoming);
    return existing.find(
      (c) => (c.type ?? 'onebot') === 'onebot' && onebotLooseFingerprint(c) === loose,
    ) ?? null;
  }

  return null;
}

/**
 * 合并插件开关：**这份文件里写了的以它为准，没写到的保留原状。**
 *
 * 所以导入一份只提了 A 插件的文件，不会把本机原本开着的 B 插件关掉——
 * 「没提」不等于「关掉」。
 */
export function mergePluginSwitches(
  current: Record<string, boolean> | undefined,
  incoming: Record<string, boolean> | undefined,
): Record<string, boolean> {
  const out: Record<string, boolean> = { ...(current || {}) };
  if (!incoming || typeof incoming !== 'object') return out;
  for (const [key, on] of Object.entries(incoming)) {
    const pluginId = String(key || '').trim();
    if (!pluginId) continue;
    out[pluginId] = Boolean(on);
  }
  return out;
}
