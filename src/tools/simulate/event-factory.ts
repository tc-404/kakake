/** 由模拟输入构造合法的 OB11 上报事件 */
import type { OB11Segment, SimulateEventInput, SimulateInput } from './simulate.types.js';

/** 把消息段数组拼成 raw_message（CQ 码风格，够插件正则匹配用） */
export function segmentsToRaw(segments: OB11Segment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === 'text') return String(seg.data.text ?? '');
      if (seg.type === 'at') return `[CQ:at,qq=${seg.data.qq ?? 'all'}]`;
      if (seg.type === 'face') return `[CQ:face,id=${seg.data.id ?? 0}]`;
      if (seg.type === 'image') return `[CQ:image,file=${seg.data.file ?? seg.data.url ?? ''}]`;
      if (seg.type === 'record') return `[CQ:record,file=${seg.data.file ?? seg.data.url ?? ''}]`;
      if (seg.type === 'video') return `[CQ:video,file=${seg.data.file ?? seg.data.url ?? ''}]`;
      if (seg.type === 'reply') return `[CQ:reply,id=${seg.data.id ?? ''}]`;
      // 其它类型给个通用 CQ 占位
      const kv = Object.entries(seg.data ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(',');
      return `[CQ:${seg.type}${kv ? ',' + kv : ''}]`;
    })
    .join('');
}

/**
 * 构造 OB11 message 事件。
 * @param selfId 目标账号 QQ（accountKey）
 */
export function buildOb11MessageEvent(
  selfId: string | number,
  input: SimulateInput,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const messageId = Math.floor(Math.random() * 2_000_000_000);
  const userId = Number(input.userId) || 0;
  const raw = segmentsToRaw(input.message);

  const sender: Record<string, unknown> = {
    user_id: userId,
    nickname: input.nickname || String(userId),
  };
  if (input.chatType === 'group') {
    sender.card = input.card || '';
    sender.role = 'member';
  }

  const base: Record<string, unknown> = {
    time: now,
    self_id: Number(selfId) || 0,
    post_type: 'message',
    message_type: input.chatType,
    sub_type: input.chatType === 'group' ? 'normal' : 'friend',
    message_id: messageId,
    user_id: userId,
    message: input.message,
    raw_message: raw,
    font: 0,
    sender,
    // NapCat / go-cqhttp 常见附加字段
    message_format: 'array',
    post_source: 'simulate',
  };

  if (input.chatType === 'group') {
    base.group_id = Number(input.groupId) || 0;
  }

  return base;
}

/**
 * 构造 OB11 notice / request 事件，并返回灰字描述。
 * @param selfId 目标账号 QQ（accountKey）
 */
export function buildOb11EventEvent(
  selfId: string | number,
  input: SimulateEventInput,
): { event: Record<string, unknown>; summary: string } {
  const now = Math.floor(Date.now() / 1000);
  const self = Number(selfId) || 0;
  const gid = Number(input.groupId) || 0;
  const uid = Number(input.userId) || 0;
  const op = Number(input.operatorId ?? input.userId) || 0;

  const base: Record<string, unknown> = {
    time: now,
    self_id: self,
    post_source: 'simulate',
  };

  const label = (id: number) => String(id || '');

  const randMsgId = () => Math.floor(Math.random() * 2_000_000_000);

  switch (input.eventType) {
    // ---------- 群事件 ----------
    case 'group_increase':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_increase', sub_type: input.subType || 'approve', group_id: gid, operator_id: op, user_id: uid },
        summary: `${label(uid)} 加入了群 ${label(gid)}`,
      };
    case 'group_decrease':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_decrease', sub_type: input.subType || 'leave', group_id: gid, operator_id: op, user_id: uid },
        summary: input.subType === 'kick' ? `${label(uid)} 被移出群 ${label(gid)}` : `${label(uid)} 退出了群 ${label(gid)}`,
      };
    case 'group_ban':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_ban', sub_type: (input.duration ?? 0) > 0 ? 'ban' : 'lift_ban', group_id: gid, operator_id: op, user_id: uid, duration: input.duration ?? 0 },
        summary: (input.duration ?? 0) > 0 ? `${label(uid)} 被禁言 ${input.duration} 秒` : `${label(uid)} 被解除禁言`,
      };
    case 'group_admin':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_admin', sub_type: input.subType || 'set', group_id: gid, user_id: uid },
        summary: input.subType === 'unset' ? `${label(uid)} 被取消管理员` : `${label(uid)} 被设为管理员`,
      };
    case 'group_recall':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_recall', group_id: gid, operator_id: op, user_id: uid, message_id: randMsgId() },
        summary: `${label(uid)} 撤回了一条群消息`,
      };
    case 'group_upload':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_upload', group_id: gid, user_id: uid, file: { id: 'sim-file', name: input.value || 'test.txt', size: 1024, busid: 0 } },
        summary: `${label(uid)} 上传了文件 ${input.value || 'test.txt'}`,
      };
    case 'group_card':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'group_card', group_id: gid, user_id: uid, card_new: input.value || '', card_old: '' },
        summary: `${label(uid)} 群名片改为「${input.value || ''}」`,
      };
    case 'group_title':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'title', group_id: gid, user_id: uid, title: input.value || '' },
        summary: `${label(uid)} 获得头衔「${input.value || ''}」`,
      };
    case 'group_honor':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'honor', group_id: gid, user_id: uid, honor_type: input.value || 'talkative' },
        summary: `${label(uid)} 获得群荣誉 ${input.value || 'talkative'}`,
      };
    case 'group_essence':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'essence', sub_type: input.subType || 'add', group_id: gid, sender_id: uid, operator_id: op, message_id: randMsgId() },
        summary: input.subType === 'delete' ? `一条群消息被移出精华` : `${label(uid)} 的消息被设为精华`,
      };
    case 'group_poke':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: gid, user_id: op, target_id: uid },
        summary: `${label(op)} 在群 ${label(gid)} 戳了戳 ${uid === self ? '你' : label(uid)}`,
      };
    case 'group_request':
      return {
        event: { ...base, post_type: 'request', request_type: 'group', sub_type: input.subType || 'add', group_id: gid, user_id: uid, comment: input.comment || '', flag: `sim-${Date.now()}` },
        summary: `${label(uid)} 申请加入群 ${label(gid)}${input.comment ? `：${input.comment}` : ''}`,
      };

    // ---------- 私聊 / 好友事件 ----------
    case 'friend_recall':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'friend_recall', user_id: uid, message_id: randMsgId() },
        summary: `${label(uid)} 撤回了一条消息`,
      };
    case 'friend_add':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'friend_add', user_id: uid },
        summary: `${label(uid)} 添加你为好友`,
      };
    case 'friend_poke':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: op, target_id: self, sender_id: op },
        summary: `${label(op)} 戳了戳你`,
      };
    case 'friend_request':
      return {
        event: { ...base, post_type: 'request', request_type: 'friend', user_id: uid, comment: input.comment || '', flag: `sim-${Date.now()}` },
        summary: `${label(uid)} 请求添加你为好友${input.comment ? `：${input.comment}` : ''}`,
      };

    // ---------- 账号 / 生命周期事件 ----------
    case 'profile_like':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', operator_id: op, user_id: op, times: Number(input.value) || 1 },
        summary: `${label(op)} 给你的资料点了 ${Number(input.value) || 1} 个赞`,
      };
    case 'bot_offline':
      return {
        event: { ...base, post_type: 'notice', notice_type: 'bot_offline', user_id: self, tag: 'offline', message: input.value || '你的账号在其它设备登录，已被迫下线' },
        summary: `本账号被踢下线${input.value ? `：${input.value}` : ''}`,
      };
    case 'lifecycle_connect':
      return {
        event: { ...base, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' },
        summary: `连接已建立（lifecycle connect）`,
      };

    default:
      return {
        event: { ...base, post_type: 'notice', notice_type: String(input.eventType) },
        summary: `事件 ${input.eventType}`,
      };
  }
}
