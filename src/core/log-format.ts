import type { OB11Event } from '../connection/onebot.types.js';

const TEXT_LIMIT = 160;
const UI_DETAIL_LIMIT = 2048;

/** 格式化日志参数（多参数、Error 对象） */
export function formatLogArgs(args: unknown[]): string {
  if (!args.length) return '';
  return args.map(formatLogArg).join(' ');
}

export function formatLogArg(arg: unknown): string {
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.stack || arg.message;
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') return String(arg);
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function truncateText(text: string, max = TEXT_LIMIT): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

export function serializeDetail(data: unknown, max = UI_DETAIL_LIMIT): string | undefined {
  if (data === undefined || data === null) return undefined;
  try {
    const s = typeof data === 'string' ? data : JSON.stringify(data);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  } catch {
    return String(data);
  }
}

export function formatOb11Event(event: OB11Event): { message: string; detail?: string; raw: string } {
  const raw = JSON.stringify(event);
  const pt = event.post_type || 'unknown';

  if (pt === 'message' || pt === 'message_sent') {
    const msgType = String(event.message_type || '?');
    const userId = event.user_id ?? '?';
    const rawMsg = String(event.raw_message ?? '');
    const scope = msgType === 'group'
      ? `群 ${event.group_id ?? '?'}`
      : `私聊 ${userId}`;
    const text = rawMsg || serializeDetail(event.message, 80) || '(非文本)';
    return {
      message: `${pt} · ${scope} · ${userId}: ${truncateText(text)}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (pt === 'notice') {
    const subtype = String(event.notice_type ?? event.sub_type ?? '?');
    return { message: `notice · ${subtype}`, detail: serializeDetail(event), raw };
  }

  if (pt === 'request') {
    const subtype = String(event.request_type ?? '?');
    return { message: `request · ${subtype}`, detail: serializeDetail(event), raw };
  }

  if (pt === 'meta_event') {
    const subtype = String(event.meta_event_type ?? event.sub_type ?? '?');
    return { message: `meta · ${subtype}`, detail: serializeDetail(event), raw };
  }

  return { message: pt, detail: serializeDetail(event), raw };
}

export function formatOb11Action(
  action: string,
  params?: Record<string, unknown>,
): { message: string; detail?: string } {
  const p = params ?? {};

  if (action === 'send_group_msg' || action === 'send_private_msg') {
    const target = action === 'send_group_msg' ? `群 ${p.group_id}` : `私 ${p.user_id}`;
    const msg = typeof p.message === 'string'
      ? p.message
      : serializeDetail(p.message, 120) ?? '';
    return {
      message: `${action} → ${target}: ${truncateText(msg || '(空)')}`,
      detail: serializeDetail(params),
    };
  }

  if (action === 'send_msg') {
    const msg = typeof p.message === 'string' ? p.message : serializeDetail(p.message, 120) ?? '';
    return {
      message: `${action}: ${truncateText(msg || '(空)')}`,
      detail: serializeDetail(params),
    };
  }

  const summary = serializeDetail(params, 120);
  return {
    message: summary ? `${action} ${summary}` : action,
    detail: serializeDetail(params),
  };
}

/** QQ 官方机器人 Gateway 事件摘要 */
export function formatQqOfficialEvent(
  eventType: string,
  event: unknown,
): { message: string; detail?: string; raw: string } {
  const raw = JSON.stringify(event);
  const data = (typeof event === 'object' && event) ? event as Record<string, unknown> : {};
  const d = (data.d && typeof data.d === 'object') ? data.d as Record<string, unknown> : data;
  const pick = (k: string) => String(d[k] ?? data[k] ?? '').trim();

  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'C2C_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
    const author = data.author as { member_openid?: string; id?: string } | undefined;
    const groupId = data.group_openid ?? data.group_id ?? '';
    const content = truncateText(String(data.content ?? ''));
    const scope = eventType.startsWith('GROUP_')
      ? `群 ${groupId || '?'}`
      : `私聊 ${author?.id ?? author?.member_openid ?? '?'}`;
    return {
      message: `${eventType} · ${scope} · ${content || '(非文本)'}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (eventType === 'AT_MESSAGE_CREATE' || eventType === 'DIRECT_MESSAGE_CREATE') {
    const content = truncateText(String(data.content ?? ''));
    const channel = data.channel_id ?? data.guild_id ?? '?';
    return {
      message: `${eventType} · 频道 ${channel} · ${content || '(非文本)'}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (eventType === 'GROUP_ADD_ROBOT') {
    return {
      message: `GROUP_ADD_ROBOT · 群 ${pick('group_openid') || '?'} · 操作人 ${pick('op_member_openid') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_DEL_ROBOT') {
    return {
      message: `GROUP_DEL_ROBOT · 群 ${pick('group_openid') || '?'} · 操作人 ${pick('op_member_openid') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_MEMBER_ADD') {
    return {
      message: `GROUP_MEMBER_ADD · 群 ${pick('group_openid') || '?'} · 成员 ${pick('member_openid') || pick('op_member_openid') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_MEMBER_REMOVE') {
    return {
      message: `GROUP_MEMBER_REMOVE · 群 ${pick('group_openid') || '?'} · 成员 ${pick('member_openid') || pick('op_member_openid') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_JOIN_REQUEST') {
    return {
      message: `GROUP_JOIN_REQUEST · 群 ${pick('group_openid') || '?'} · 申请人 ${pick('member_openid') || pick('username') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'FRIEND_ADD' || eventType === 'FRIEND_DEL') {
    return {
      message: `${eventType} · 用户 ${pick('openid') || '?'}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  return {
    message: eventType,
    detail: serializeDetail(event),
    raw,
  };
}

export function formatOb11ActionResult(
  action: string,
  result: unknown,
  error?: string,
): { message: string; detail?: string } {
  if (error) {
    return {
      message: `${action} ✗ ${truncateText(error, 120)}`,
      detail: serializeDetail({ error }),
    };
  }
  // 对发送类动作优先展示 message_id，便于追踪撤回/发送失败问题
  if (/^send_/.test(action)) {
    const r = (result ?? {}) as Record<string, unknown>;
    const data = (r.data ?? r) as Record<string, unknown>;
    const msgId = data?.message_id ?? data?.msg_id ?? r?.message_id ?? r?.msg_id;
    if (msgId !== undefined && msgId !== null && String(msgId) !== '') {
      return {
        message: `${action} ✓ message_id=${String(msgId)}`,
        detail: serializeDetail(result),
      };
    }
  }
  const summary = serializeDetail(result, 120);
  return {
    message: summary ? `${action} ✓ ${summary}` : `${action} ✓`,
    detail: serializeDetail(result),
  };
}
