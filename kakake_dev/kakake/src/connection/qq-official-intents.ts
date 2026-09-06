/** QQ 开放平台 Gateway Intents 位标志（API v2）
 * 对齐官方文档 / zhinjs/qq-official-bot（2026-06 起 GROUP_MEMBER = 1<<24）
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
 * @see https://github.com/zhinjs/qq-official-bot/blob/main/src/constants.ts
 */
export const QQ_INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  GUILD_MESSAGES: 1 << 9,
  GUILD_MESSAGE_REACTIONS: 1 << 10,
  DIRECT_MESSAGE: 1 << 12,
  /** 群成员进退：GROUP_MEMBER_ADD / GROUP_MEMBER_REMOVE（勿与公域频道消息混淆） */
  GROUP_MEMBER: 1 << 24,
  /** 群/私聊消息、机器人进退群、好友增减等 */
  GROUP_AND_C2C_EVENT: 1 << 25,
  INTERACTION: 1 << 26,
  MESSAGE_AUDIT: 1 << 27,
  FORUMS_EVENT: 1 << 28,
  AUDIO_ACTION: 1 << 29,
  /** 公域频道 @ 消息（旧代码曾误写成 1<<24） */
  PUBLIC_GUILD_MESSAGES: 1 << 30,
} as const;

/**
 * 群聊 + 私聊 + 群成员变更 + 互动 + 频道基础
 * 含 GROUP_MEMBER，才能收到 GROUP_MEMBER_ADD / REMOVE
 */
export const DEFAULT_QQ_OFFICIAL_INTENTS =
  QQ_INTENTS.GROUP_AND_C2C_EVENT
  | QQ_INTENTS.GROUP_MEMBER
  | QQ_INTENTS.INTERACTION
  | QQ_INTENTS.GUILDS
  | QQ_INTENTS.GUILD_MEMBERS
  | QQ_INTENTS.GUILD_MESSAGE_REACTIONS
  | QQ_INTENTS.DIRECT_MESSAGE;
