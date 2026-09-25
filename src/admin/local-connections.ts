/**
 * 本地连接列表接口的数据组装（纯函数，不依赖 HTTP / Nest，便于单独验证）。
 *
 * 只对两类接入出数据：
 * - onebot：野生机器人（OneBot 协议端，如 NapCat / Lagrange）
 * - qq_official：QQ 开放平台官方机器人
 * 微信 BOT 等其它类型不在此接口范围内。
 */

import type { ConnectionManager } from '../connection/connection.manager.js';
import { onebotQlogoAvatarUrl } from '../connection/connection-avatar.store.js';

type StatusItem = ReturnType<ConnectionManager['getStatusList']>[number];

type LocalConnectionType = 'onebot' | 'qq_official';

type LocalConnectionStatus = 'connected' | 'disconnected' | 'disabled';

/**
 * 连接阶段：给「运行状态」的账号头像描边上色用。
 * 比 status 多区分了两档 —— 「正在重连/等待连接」和「重连次数耗尽（失败）」。
 */
export type LocalConnectionPhase = 'connected' | 'reconnecting' | 'failed' | 'disabled';

export interface LocalConnectionItem {
  id: string;
  name: string;
  /** 机器人 QQ 号（OneBot 接入为登录号；官方机器人通常没有，返回空串） */
  qq: string;
  /** 官方机器人的 AppID（OneBot 接入返回空串） */
  appId: string;
  status: LocalConnectionStatus;
  statusText: string;
  /** 连接阶段（描边配色）：已连接 / 重连中 / 失败 / 已关闭 */
  phase: LocalConnectionPhase;
  connected: boolean;
  enable: boolean;
  type: LocalConnectionType;
  typeText: string;
  direction: string;
  directionText: string;
  avatar: string;
}

export interface LocalConnectionsPayload {
  count: number;
  connections: LocalConnectionItem[];
}

const STATUS_TEXT: Record<LocalConnectionStatus, string> = {
  connected: '已连接',
  disconnected: '未连接',
  disabled: '已关闭',
};

/**
 * 三态：开关关掉是「已关闭」，与「开着但没连上」区分开。
 * 未连接的连接也会照常返回，不做过滤。
 */
function resolveStatus(connected: boolean, enable: boolean): LocalConnectionStatus {
  if (!enable) return 'disabled';
  return connected ? 'connected' : 'disconnected';
}

/**
 * 连接阶段：宿主已经区分好「重连中」与「重连放弃」，这里只做归一化。
 * - connected：已连上
 * - reconnecting：开着但还没连上，框架正在重试 / 等待首次连接
 * - failed：开着、一直连不上，重连次数已耗尽（宿主标记 abandoned）
 * - disabled：开关关闭
 */
function resolvePhase(item: StatusItem, status: LocalConnectionStatus): LocalConnectionPhase {
  if (status === 'connected') return 'connected';
  if (status === 'disabled') return 'disabled';
  if ('reconnectAbandoned' in item && item.reconnectAbandoned) return 'failed';
  return 'reconnecting';
}

/**
 * 头像：
 * - 官方机器人：官方接口返回的头像地址（botProfile.avatar）
 * - 野生机器人：按保存的机器人 QQ 号拼 QQ 用户头像地址
 * - 取不到则给空字符串
 */
function resolveAvatar(item: StatusItem): string {
  if (item.type === 'qq_official') {
    return String(item.botProfile?.avatar ?? '').trim();
  }
  return onebotQlogoAvatarUrl(String(item.botUin ?? ''));
}

function isLocalStatusItem(item: StatusItem): item is StatusItem & { type: LocalConnectionType } {
  return item.type === 'onebot' || item.type === 'qq_official';
}

export function buildLocalConnectionsPayload(list: StatusItem[]): LocalConnectionsPayload {
  const connections = list.filter(isLocalStatusItem).map((c) => {
    const status = resolveStatus(c.connected, c.enable);
    return {
      id: c.id,
      name: c.name,
      qq: String(c.botUin ?? '').trim(),
      appId: String(c.appId ?? '').trim(),
      status,
      statusText: STATUS_TEXT[status],
      phase: resolvePhase(c, status),
      connected: c.connected,
      enable: c.enable,
      type: c.type,
      typeText: c.typeLabel,
      direction: c.mode,
      directionText: c.modeLabel,
      avatar: resolveAvatar(c),
    };
  });

  return { count: connections.length, connections };
}
