/** 「模拟消息」功能类型定义（仅 OneBot 账号） */

/** OB11 消息段（数组格式） */
export interface OB11Segment {
  type: string;
  data: Record<string, unknown>;
}

/** 账号类别：OneBot 或 QQ 官方机器人 */
export type SimulateAccountKind = 'onebot' | 'official';

/** 一次用户模拟输入 */
export interface SimulateInput {
  /** 会话类型 */
  chatType: 'group' | 'private';
  /** 群号（group 必填） */
  groupId?: string | number;
  /** 发送者 QQ */
  userId: string | number;
  /** 发送者昵称 */
  nickname?: string;
  /** 群名片（群聊可选） */
  card?: string;
  /** 消息段数组 */
  message: OB11Segment[];
}

/** 可模拟的 OneBot 事件类型（notice / request / meta 子类） */
export type SimulateEventType =
  // 群
  | 'group_increase'      // 群成员增加
  | 'group_decrease'      // 群成员减少
  | 'group_ban'           // 群禁言
  | 'group_admin'         // 群管理员变动
  | 'group_recall'        // 群消息撤回
  | 'group_upload'        // 群文件上传
  | 'group_card'          // 群名片变更
  | 'group_title'         // 群头衔变更
  | 'group_honor'         // 群荣誉变更（龙王/群聊之火等）
  | 'group_essence'       // 设精
  | 'group_poke'          // 群内戳一戳
  | 'group_request'       // 加群请求
  // 私聊 / 好友
  | 'friend_recall'       // 好友消息撤回
  | 'friend_add'          // 好友添加
  | 'friend_poke'         // 好友戳一戳
  | 'friend_request'      // 加好友请求
  // 账号 / 生命周期（与会话无关）
  | 'profile_like'        // 本账号资料被点赞
  | 'bot_offline'         // 本账号被踢下线
  | 'lifecycle_connect'   // 连接/上线
  // ==== QQ 官方机器人事件（Gateway 事件类型）====
  | 'gf_group_add_robot'    // 机器人被添加进群
  | 'gf_group_del_robot'    // 机器人被移出群
  | 'gf_group_member_add'   // 群成员增加
  | 'gf_group_member_remove'// 群成员减少
  | 'gf_group_join_request' // 入群申请
  | 'gf_friend_add'         // 用户添加机器人（好友）
  | 'gf_friend_del';        // 用户删除机器人

/** 事件适用范围：group=群聊会话可见；private=私聊会话可见；account=两种都可见 */
export type SimulateEventScope = 'group' | 'private' | 'account';

/** 一次事件上报输入 */
export interface SimulateEventInput {
  eventType: SimulateEventType;
  /** 群号（群相关事件必填） */
  groupId?: string | number;
  /** 操作者 QQ（如管理员、撤回操作者、点赞者） */
  operatorId?: string | number;
  /** 目标 QQ（被禁言/被戳/进群者等） */
  userId?: string | number;
  /** 附加：禁言时长（秒）/ sub_type / comment 等 */
  duration?: number;
  subType?: string;
  comment?: string;
  /** 文本值：新名片 / 新头衔 / 点赞数 / 荣誉类型等 */
  value?: string;
}

/** 捕获到的一次插件 action 调用 */
export interface CapturedCall {
  id: string;
  time: number;
  pluginId: string;
  action: string;
  params: Record<string, unknown>;
}

/** 对话记录里的一条：用户输入 / 插件输出 / 事件上报（系统灰字） */
export type TranscriptEntry =
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
      /** 灰字描述，如「测试用户 撤回了一条消息」 */
      summary: string;
    };

/** 每账号一份的持久化文件结构 */
export interface AccountTranscript {
  accountKey: string;
  updatedAt: number;
  entries: TranscriptEntry[];
}
