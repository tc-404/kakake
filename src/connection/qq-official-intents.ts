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
 * 默认 Intents：群聊 + 私聊 + 群成员变更 + 互动（按钮回调）。
 *
 * INTERACTION（1<<26）必须默认带上：群消息按钮的「回调按钮」被点击时，平台以
 * INTERACTION_CREATE 经 WebSocket 推送（见官方文档「消息 按钮」），没订阅这一位
 * 时点击按钮不会有任何事件到达，插件收不到、日志也没有上报，客户端只会显示
 * “请求第三方失败”。这正是 0.5.0 把 INTERACTION 从默认组合里去掉后按钮失效的原因。
 *
 * 刻意**不**默认带上频道类（GUILDS / GUILD_MEMBERS / GUILD_MESSAGE_REACTIONS /
 * DIRECT_MESSAGE / PUBLIC_GUILD_MESSAGES）：这些事件需要机器人额外开通频道权限，
 * 没开通时平台可能直接以 4014（intents 未获授权）关闭连接。需要频道的用户在连接
 * 配置里显式填 intents 即可。
 *
 * 若机器人连 INTERACTION 都未获授权而被 4014 拒绝，客户端会沿
 * {@link QQ_OFFICIAL_INTENTS_FALLBACK_LADDER} 逐级降级，先摘掉 INTERACTION、再摘掉
 * GROUP_MEMBER，最终退到只收群/私聊消息，尽量不因一个未授权位丢掉其它事件。
 */
export const DEFAULT_QQ_OFFICIAL_INTENTS =
  QQ_INTENTS.GROUP_AND_C2C_EVENT
  | QQ_INTENTS.GROUP_MEMBER
  | QQ_INTENTS.INTERACTION;

/** 连默认组合都被拒（4014）时退到的最小集合：只收群/私聊消息 */
export const MINIMAL_QQ_OFFICIAL_INTENTS = QQ_INTENTS.GROUP_AND_C2C_EVENT;

/**
 * 4014 自动降级阶梯：从默认组合开始，每被拒一次就摘掉一位「可能未授权」的事件，
 * 直到最小集合。让“某一位未授权”只损失那一位，而不是一次性退到最小。
 */
export const QQ_OFFICIAL_INTENTS_FALLBACK_LADDER: readonly number[] = [
  DEFAULT_QQ_OFFICIAL_INTENTS,
  QQ_INTENTS.GROUP_AND_C2C_EVENT | QQ_INTENTS.GROUP_MEMBER,
  MINIMAL_QQ_OFFICIAL_INTENTS,
];

/** 频道/互动等可选事件集合，供界面或文档提示“要开频道就再加这些位” */
export const EXTENDED_QQ_OFFICIAL_INTENTS =
  QQ_INTENTS.GUILDS
  | QQ_INTENTS.GUILD_MEMBERS
  | QQ_INTENTS.GUILD_MESSAGE_REACTIONS
  | QQ_INTENTS.DIRECT_MESSAGE
  | QQ_INTENTS.PUBLIC_GUILD_MESSAGES
  | QQ_INTENTS.INTERACTION;

/** Intents 数字 → 可读的位名称列表（日志/界面用） */
export function describeQqOfficialIntents(intents: number): string {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(QQ_INTENTS)) {
    if ((intents & bit) !== 0) names.push(name);
  }
  const value = Number.isFinite(intents) ? (intents >>> 0) : 0;
  return `0x${value.toString(16)}${names.length ? ` (${names.join(' | ')})` : ''}`;
}
