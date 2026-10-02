/**
 * 外放 API 的数据组装（纯函数，不依赖 HTTP / Nest，便于单独验证）。
 *
 * 账号列表覆盖全部接入类型（onebot / qq_official / weixin_bot / kook），
 * 只对外暴露最小信息：头像、连接名字、连接状态。
 * 头像只给「公网可直接访问」的地址：
 *  - onebot：按机器人 QQ 号拼 q.qlogo.cn 头像
 *  - qq_official：官方资料里的 avatar
 *  - weixin_bot / kook：缓存头像需登录态代理，公网取不到，返回空串
 */

import type { ConnectionManager } from '../connection/connection.manager.js';
import { onebotQlogoAvatarUrl } from '../connection/connection-avatar.store.js';

type StatusItem = ReturnType<ConnectionManager['getStatusList']>[number];

export type PublicAccountStatus = 'connected' | 'disconnected' | 'disabled';

/**
 * 连接阶段（比 status 更细）：把「未连接」进一步拆成
 * 「连接中/等待连接」和「连接失败（重连次数耗尽）」。
 */
export type PublicAccountPhase = 'connected' | 'reconnecting' | 'failed' | 'disabled';

export interface PublicAccount {
  /** 连接名字（用户自起名，官方/KOOK 兜底为机器人昵称） */
  name: string;
  /** 接入类型：onebot / qq_official / weixin_bot / kook */
  type: string;
  /** 接入类型中文名 */
  typeText: string;
  /** 连接状态（粗三态）：已连接 / 未连接 / 已关闭 */
  status: PublicAccountStatus;
  statusText: string;
  /** 连接阶段（细四态）：已连接 / 连接中 / 连接失败 / 已关闭 */
  phase: PublicAccountPhase;
  phaseText: string;
  /** 该连接开关是否开启 */
  enable: boolean;
  /** 是否已连上 */
  connected: boolean;
  /** 头像地址（取不到公网地址时为空串） */
  avatar: string;
}

const STATUS_TEXT: Record<PublicAccountStatus, string> = {
  connected: '已连接',
  disconnected: '未连接',
  disabled: '已关闭',
};

const PHASE_TEXT: Record<PublicAccountPhase, string> = {
  connected: '已连接',
  reconnecting: '连接中',
  failed: '连接失败',
  disabled: '已关闭',
};

/** 三态：开关关掉是「已关闭」，与「开着但没连上」区分开 */
function resolveStatus(connected: boolean, enable: boolean): PublicAccountStatus {
  if (!enable) return 'disabled';
  return connected ? 'connected' : 'disconnected';
}

/**
 * 四态阶段：
 * - connected：已连上
 * - reconnecting：开着但还没连上，正在重试 / 等待首次连接
 * - failed：开着、一直连不上且重连次数已耗尽（宿主标记 reconnectAbandoned）
 * - disabled：开关关闭
 */
function resolvePhase(item: StatusItem, status: PublicAccountStatus): PublicAccountPhase {
  if (status === 'connected') return 'connected';
  if (status === 'disabled') return 'disabled';
  return item.reconnectAbandoned ? 'failed' : 'reconnecting';
}

function resolveAvatar(item: StatusItem): string {
  if (item.type === 'qq_official') return String(item.botProfile?.avatar ?? '').trim();
  if (item.type === 'onebot') return onebotQlogoAvatarUrl(String(item.botUin ?? ''));
  return '';
}

export function buildPublicAccounts(list: StatusItem[]): PublicAccount[] {
  return list.map((c) => {
    const status = resolveStatus(c.connected, c.enable);
    const phase = resolvePhase(c, status);
    return {
      name: c.name,
      type: c.type,
      typeText: c.typeLabel,
      status,
      statusText: STATUS_TEXT[status],
      phase,
      phaseText: PHASE_TEXT[phase],
      enable: c.enable,
      connected: c.connected,
      avatar: resolveAvatar(c),
    };
  });
}

/** 运行时长秒数转「N天N时N分N秒」可读串（省略为 0 的高位） */
export function formatUptime(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}天`);
  if (h || d) parts.push(`${h}小时`);
  if (m || h || d) parts.push(`${m}分`);
  parts.push(`${s}秒`);
  return parts.join('');
}
