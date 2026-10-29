/**
 * 寻址：把「调用方给的连接标识（可省略）」变成真正要发往的协议端。
 *
 * 分发规则：
 *   - 可选 `conn` 参数：传连接 id 或连接名精确指定，找不到就明确报错（列出可用连接），
 *     **绝不静默回落**——那会造成「以为调 A 实际打到 B」。
 *   - 不传 conn：取第一个已连接的 OneBot 连接，没有则取第一个已连接的官方连接。
 *   - 找到但未连接 / 未启用：同样明确报错，不回落。
 *
 * 刻意不 import ConnectionManager / configService，能力从 `ProxyResolvePorts`
 * 注入，可脱离主程序单测；真正接线在 `resolve/target.kakake.ts`。
 */
import type { ProxyTarget, ProxyTargetResult } from '../runtime/dispatcher.js';
import type { ProxyProtocol } from '../proxy.types.js';

/** 一条连接在寻址层看到的模样（刻意最小化，别把整个 ConnectionConfig 拖进来） */
export interface ProxyConnectionView {
  id: string;
  name: string;
  /** 'onebot' | 'qq_official' | 'weixin_bot' | 'kook'；缺省按 onebot */
  type?: string;
  /** 连接页上是否勾了启用 */
  enable?: boolean;
  /** 连接页下拉选择的野生实现；'auto' / 不填 = 探测 */
  onebotImpl?: 'auto' | 'napcat' | 'snowluma';
  /** 当前是否已连接 */
  isConnected: boolean;
}

export interface ProxyResolvePorts {
  /** 全部连接（含未启用的，方便给出「存在但没启用」的明确报错） */
  listConnections(): ProxyConnectionView[];
  /** 识别一条 OneBot 连接的野生实现（NapCat / SnowLuma / unknown） */
  detectOnebotImpl(connectionId: string): Promise<'napcat' | 'snowluma' | 'unknown'>;
}

const PROTOCOL_NAMES: Record<ProxyProtocol, string> = {
  napcat: 'NapCat',
  snowluma: 'SnowLuma',
  official: 'QQ 官方机器人',
};

function protocolOf(view: ProxyConnectionView): ProxyProtocol {
  return view.type === 'qq_official' ? 'official' : 'napcat';
}

function notConnected(reason: string): ProxyTargetResult {
  return { ok: false, reason };
}

/**
 * 从已传参数的 ID 空间推断目标协议偏好：openid / group_openid / guild_id /
 * channel_id / role_id 是官方专属空间，qq_number 是野生专属。两类同时出现或
 * 都没出现时不表态（message_id 两侧都有，视为中性）。
 */
const OFFICIAL_ID_SPACES: ReadonlySet<string> = new Set(['openid', 'group_openid', 'guild_id', 'channel_id', 'role_id']);

export function preferProtocolFromParams(
  entry: { params: ReadonlyArray<{ key: string; idSpace?: string }> },
  params: Record<string, unknown>,
): ProxyProtocol | undefined {
  let official = false;
  let wild = false;
  for (const p of entry.params) {
    if (params?.[p.key] === undefined) continue;
    if (p.idSpace && OFFICIAL_ID_SPACES.has(p.idSpace)) official = true;
    else if (p.idSpace === 'qq_number') wild = true;
  }
  if (official && !wild) return 'official';
  if (wild && !official) return 'napcat';
  return undefined;
}

/**
 * 生成 `ProxyTargetResolver`。
 *
 * 解析顺序：
 *   1. 传了 conn → 先按 id 找，再按 name 找；找不到就明确报错（列出可用的连接），
 *      **绝不静默回落到默认连接**——那会让「我以为在调 A 其实打到了 B」。
 *   2. 没传 conn → 优先取符合协议偏好（prefer，来自参数 ID 空间推断）的已连接
 *      连接；没有符合的再按原规则：第一条已连接的 OneBot 连接，没有则第一条
 *      已连接的官方连接。
 *   3. 找到但未连接 / 未启用 → 明确报错，同样不回落。
 */
export function createProxyTargetResolver(ports: ProxyResolvePorts): (conn?: string, prefer?: ProxyProtocol) => Promise<ProxyTargetResult> {
  return async (conn?: string, prefer?: ProxyProtocol): Promise<ProxyTargetResult> => {
    let view: ProxyConnectionView | undefined;

    if (conn !== undefined && conn !== null && conn !== '') {
      const key = String(conn);
      const all = ports.listConnections();
      view = all.find((c) => c.id === key) ?? all.find((c) => c.name === key);
      if (!view) {
        const avail = all
          .filter((c) => c.enable !== false)
          .map((c) => `${c.name}（${c.id}${c.isConnected ? '' : '，未连接'}）`)
          .join('、');
        return notConnected(
          `没有 id 或名称为「${key}」的连接。${avail ? `当前可用连接：${avail}。` : '当前没有可用连接。'}`
          + '连接 id 可在控制台「连接管理」页查看。',
        );
      }
    } else {
      const connected = ports.listConnections().filter((c) => c.enable !== false && c.isConnected);
      const byPrefer = prefer === 'official'
        ? connected.find((c) => c.type === 'qq_official')
        : prefer === 'napcat'
          ? connected.find((c) => c.type !== 'qq_official')
          : undefined;
      // 首选协议没有在线连接时维持原规则：第一条 OneBot → 任意第一条
      view = byPrefer
        ?? connected.find((c) => c.type !== 'qq_official')
        ?? connected[0];
      if (!view) {
        return notConnected(
          '当前没有已连接的机器人。请在控制台「连接管理」页确认至少有一条连接处于已连接状态，'
          + '或在调用时用 conn 参数指定连接。',
        );
      }
    }

    if (view.enable === false) {
      return notConnected(`连接「${view.name}」(${view.id}) 已在连接管理中停用，请先启用或换一条连接。`);
    }
    if (!view.isConnected) {
      return notConnected(`连接「${view.name}」(${view.id}) 当前未连接，请先连接或换一条连接。`);
    }

    const protocol = protocolOf(view);
    if (protocol === 'official') {
      const target: ProxyTarget = { protocol: 'official', connectionId: view.id };
      return { ok: true, target };
    }

    const onebotImpl = await ports.detectOnebotImpl(view.id);
    const target: ProxyTarget = {
      // 识别不出来时按 napcat 走：NapCat 是 OneBot 生态里最常见的那一个。
      // 这不是猜功能，是选默认分支；不确定性会通过 _proxy.onebotImpl 暴露给调用方。
      protocol: onebotImpl === 'snowluma' ? 'snowluma' : 'napcat',
      connectionId: view.id,
      onebotImpl,
    };
    return { ok: true, target };
  };
}

export { PROTOCOL_NAMES };
