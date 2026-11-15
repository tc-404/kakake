/** 「模拟消息」前端类型（与后端 src/tools/simulate/simulate.types.ts 对齐） */

export interface OB11Segment {
  type: string;
  data: Record<string, unknown>;
}

export type SimulateAccountKind = 'onebot' | 'official';

export interface SimulateAccount {
  accountKey: string;
  connectionId: string;
  name: string;
  botUin?: string;
  connected: boolean;
  /** onebot / official（QQ 官方机器人）；旧后端可能没有 */
  kind?: SimulateAccountKind;
}

export interface SimulateSendInput {
  chatType: 'group' | 'private';
  groupId?: string;
  userId: string;
  nickname?: string;
  card?: string;
  message: OB11Segment[];
}

export type SimulateEventType =
  | 'group_increase'
  | 'group_decrease'
  | 'group_ban'
  | 'group_admin'
  | 'group_recall'
  | 'group_upload'
  | 'group_card'
  | 'group_title'
  | 'group_honor'
  | 'group_essence'
  | 'group_poke'
  | 'group_request'
  | 'friend_recall'
  | 'friend_add'
  | 'friend_poke'
  | 'friend_request'
  | 'profile_like'
  | 'bot_offline'
  | 'lifecycle_connect'
  | 'gf_group_add_robot'
  | 'gf_group_del_robot'
  | 'gf_group_member_add'
  | 'gf_group_member_remove'
  | 'gf_group_join_request'
  | 'gf_friend_add'
  | 'gf_friend_del';

export type SimulateEventScope = 'group' | 'private' | 'account';

export interface SimulateEventInput {
  eventType: SimulateEventType;
  groupId?: string;
  operatorId?: string;
  userId?: string;
  duration?: number;
  subType?: string;
  comment?: string;
  value?: string;
}

export type SimulateEntry =
  | {
      kind: 'user';
      id: string;
      time: number;
      chatType: 'group' | 'private';
      groupId?: string;
      userId: string;
      nickname?: string;
      message: OB11Segment[];
    }
  | {
      kind: 'plugin';
      id: string;
      time: number;
      pluginId: string;
      action: string;
      params: Record<string, unknown>;
    }
  | {
      kind: 'event';
      id: string;
      time: number;
      eventType: string;
      summary: string;
    };

export interface SimulateTranscript {
  accountKey: string;
  updatedAt: number;
  entries: SimulateEntry[];
}
