/**
 * 由模拟输入构造 QQ 官方机器人 Gateway 事件。
 * 官方事件结构：顶层带 t（事件类型）+ d 字段展开，插件读取 event.content / event.author /
 * event.group_openid 等。这里把常用字段直接铺在事件对象上，并附带 t 与 qq_official 标记，
 * 与 gf-plugin.manager 的 enriched 逻辑保持一致。
 */
import type { OB11Segment, SimulateEventInput, SimulateInput } from './simulate.types.js';

/** 把消息段拼成官方 content 纯文本（官方群/私聊消息以纯文本 + 附件为主） */
export function officialContentOf(segments: OB11Segment[]): { content: string; attachments: Record<string, unknown>[] } {
  let content = '';
  const attachments: Record<string, unknown>[] = [];
  for (const seg of segments) {
    if (seg.type === 'text') content += String(seg.data.text ?? '');
    else if (seg.type === 'at') content += `<@${seg.data.qq ?? 'everyone'}>`;
    else if (seg.type === 'image') {
      const url = String(seg.data.url ?? seg.data.file ?? '');
      attachments.push({ content_type: 'image', url, filename: 'image' });
    } else if (seg.type === 'video') {
      attachments.push({ content_type: 'video', url: String(seg.data.url ?? seg.data.file ?? '') });
    } else if (seg.type === 'record') {
      attachments.push({ content_type: 'voice', url: String(seg.data.url ?? seg.data.file ?? '') });
    }
  }
  return { content, attachments };
}

const rid = () => `SIM${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`;

/**
 * 构造官方消息事件。
 * 群聊 → GROUP_AT_MESSAGE_CREATE；私聊 → C2C_MESSAGE_CREATE。
 * @param appId 目标账号 AppID（accountKey）
 */
export function buildOfficialMessageEvent(
  appId: string,
  input: SimulateInput,
): { event: Record<string, unknown>; eventType: string } {
  const now = new Date().toISOString();
  const { content, attachments } = officialContentOf(input.message);
  const userOpenid = String(input.userId || 'sim-user');
  const eventType = input.chatType === 'group' ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE';

  const author = input.chatType === 'group'
    ? { id: userOpenid, member_openid: userOpenid, union_openid: userOpenid }
    : { id: userOpenid, user_openid: userOpenid, union_openid: userOpenid };

  const base: Record<string, unknown> = {
    id: rid(),
    content,
    timestamp: now,
    author,
    message_scene: { source: 'sim' },
    ...(attachments.length ? { attachments } : {}),
  };

  if (input.chatType === 'group') {
    base.group_openid = String(input.groupId || 'sim-group');
    base.group_id = String(input.groupId || 'sim-group');
  }

  return { event: { ...base, t: eventType, qq_official: true }, eventType };
}

/**
 * 构造官方 notice 事件（机器人进出群、成员增减、加好友等）。
 * @param appId 目标账号 AppID
 */
export function buildOfficialEventEvent(
  appId: string,
  input: SimulateEventInput,
): { event: Record<string, unknown>; eventType: string; summary: string } {
  const now = new Date().toISOString();
  const group = String(input.groupId || 'sim-group');
  const member = String(input.userId || 'sim-member');
  const op = String(input.operatorId || member);
  const user = String(input.userId || 'sim-user');

  const wrap = (eventType: string, d: Record<string, unknown>, summary: string) => ({
    event: { ...d, timestamp: now, t: eventType, qq_official: true },
    eventType,
    summary,
  });

  switch (input.eventType) {
    case 'gf_group_add_robot':
      return wrap('GROUP_ADD_ROBOT',
        { group_openid: group, op_member_openid: op },
        `机器人被添加进群 ${group}（操作人 ${op}）`);
    case 'gf_group_del_robot':
      return wrap('GROUP_DEL_ROBOT',
        { group_openid: group, op_member_openid: op },
        `机器人被移出群 ${group}（操作人 ${op}）`);
    case 'gf_group_member_add':
      return wrap('GROUP_MEMBER_ADD',
        { group_openid: group, member_openid: member, op_member_openid: op },
        `${member} 加入群 ${group}`);
    case 'gf_group_member_remove':
      return wrap('GROUP_MEMBER_REMOVE',
        { group_openid: group, member_openid: member, op_member_openid: op },
        `${member} 退出群 ${group}`);
    case 'gf_group_join_request':
      return wrap('GROUP_JOIN_REQUEST',
        { group_openid: group, member_openid: member, comment: input.comment || '' },
        `${member} 申请加入群 ${group}${input.comment ? `：${input.comment}` : ''}`);
    case 'gf_friend_add':
      return wrap('FRIEND_ADD',
        { openid: user },
        `用户 ${user} 添加了机器人`);
    case 'gf_friend_del':
      return wrap('FRIEND_DEL',
        { openid: user },
        `用户 ${user} 删除了机器人`);
    default:
      return wrap(String(input.eventType),
        { group_openid: group },
        `官方事件 ${input.eventType}`);
  }
}
