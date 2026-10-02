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

/**
 * 通知类事件里值得进预览的字段。
 * 默认只输出 `notice · group_ban` 这种半截信息，看不出发生在哪个群、对谁、多久，
 * 这里按子类型补几个关键字段，避免整串 JSON 被塞进摘要。
 */
const NOTICE_FIELDS: Record<string, string[]> = {
  group_ban: ['duration'],
  ban: ['duration'],
  group_recall: ['message_id'],
  private_recall: ['message_id'],
  recall: ['message_id'],
  group_card: ['card_old', 'card_new'],
  group_upload: ['file_name', 'file_size'],
  group_increase: ['operator_id'],
  group_decrease: ['operator_id'],
  group_admin: ['sub_type'],
  notify: ['sub_type', 'target_id'],
  poke: ['target_id'],
  group_msg_emoji_like: ['message_id', 'emoji_id'],
  essence: ['sub_type', 'message_id'],
};

/** 把对象里若干字段拼成 `key=value` 段，值为空则跳过 */
function kvSegments(obj: Record<string, unknown>, keys: string[]): string[] {
  const out: string[] = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || String(v) === '') continue;
    out.push(k === 'sub_type' ? String(v) : `${k}=${truncateText(String(v), 40)}`);
  }
  return out;
}

/**
 * CQ 段 → 预览短标签。
 * 媒体类 CQ 码自带 url（fileid + rkey），单条能到三四百字符；必须先收敛成 [视频] 这种
 * 短标签再截断，否则 160 字符的截断会把 CQ 码切成半截——闭合的 ] 丢了以后前端再也
 * 匹配不到它，预览里就漏出一长串不可断行的原始参数（真实日志里 698 条上报有 175 条中招）。
 */
const CQ_TAG: Record<string, string> = {
  image: '[图片]',
  record: '[语音]',
  video: '[视频]',
  face: '[表情]',
  file: '[文件]',
  reply: '[回复]',
  forward: '[转发]',
  json: '[卡片]',
  xml: '[卡片]',
  markdown: '[卡片]',
  cardimage: '[卡片]',
  node: '[转发]',
  at: '@',
  dice: '[骰子]',
  rps: '[猜拳]',
  shake: '[抖动]',
  poke: '[戳一戳]',
  share: '[分享]',
  music: '[音乐]',
  redbag: '[红包]',
  contact: '[推荐]',
  location: '[位置]',
  tts: '[语音]',
  mface: '[表情]',
  miniapp: '[小程序]',
  gift: '[礼物]',
};

/**
 * 消息段数组（OneBot11 数组形态）→ 可读文本。
 * 「输出」侧的 send_* 动作 message 常是这个形态，直接 JSON 化会把
 * `[{"type":"text","data":{"text":"…"}}]` 整段代码摆进预览。
 */
function segmentsToText(segments: unknown[]): string {
  const out: string[] = [];
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue;
    const o = seg as Record<string, unknown>;
    const type = String(o.type ?? '').toLowerCase();
    const data = (o.data && typeof o.data === 'object') ? o.data as Record<string, unknown> : {};
    const text = typeof data.text === 'string' ? data.text : '';

    if (type === 'text') {
      if (text) out.push(text);
      continue;
    }
    if (type === 'at') {
      const qq = String(data.qq ?? '');
      out.push(qq === 'all' ? '@全体成员' : (qq ? `@${qq}` : '@成员'));
      continue;
    }
    const tag = CQ_TAG[type];
    if (tag && tag !== '@') {
      out.push(tag);
      continue;
    }
    if (text) out.push(text);
    else if (type) out.push(`[${type}]`);
  }
  return out.join('');
}

/** 输出侧的消息可能是字符串（带 CQ 码）也可能是消息段数组，统一压成可读文本 */
function messageToText(message: unknown): string {
  if (typeof message === 'string') return collapseCqTag(message);
  if (Array.isArray(message)) return segmentsToText(message);
  return serializeDetail(message, 120) ?? '';
}

/**
 * 把 CQ 码整体换成短标签。结尾没有闭合 ] 的半截 CQ 也一并收掉，
 * 保证任何来源（含已被截断的文本）都不会留下原始参数串。
 */
export function collapseCqTag(text: string): string {
  return text.replace(/\[CQ:([a-z_]+)([^\]]*)\]?/gi, (_m, type: string, params: string) => {
    const tag = CQ_TAG[type.toLowerCase()];
    if (tag === '@') {
      const q = /qq=([^,\]]+)/i.exec(params);
      return q ? (q[1] === 'all' ? '@全体成员' : `@${q[1]}`) : '@成员';
    }
    return tag ?? `[${type}]`;
  });
}

/** 目标主体（群 / 人），通知与请求共用 */
function targetSegments(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const gid = obj.group_id;
  if (gid !== undefined && gid !== null && String(gid) !== '') out.push(`群 ${gid}`);
  const uid = obj.user_id ?? obj.target_id ?? obj.operator_id;
  if (uid !== undefined && uid !== null && String(uid) !== '') out.push(String(uid));
  return out;
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
    // 先收敛 CQ 码再截断：不这么做会被 160 字符切在 CQ 码中间，留下一串没有闭合 ] 的原始参数
    const text = rawMsg
      ? collapseCqTag(rawMsg)
      : serializeDetail(event.message, 80) || '(非文本)';
    return {
      message: `${pt} · ${scope} · ${userId}: ${truncateText(text)}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (pt === 'notice') {
    const subtype = String(event.notice_type ?? event.sub_type ?? '?');
    const seg = [...targetSegments(event)];
    // 群文件上传的元信息挂在 file 对象里（{ id, name, size, busid }），不是平铺字段
    if (subtype === 'group_upload') {
      const f = event.file;
      if (f && typeof f === 'object') {
        const fo = f as Record<string, unknown>;
        if (fo.name) seg.push(`file_name=${truncateText(String(fo.name), 40)}`);
        if (fo.size) seg.push(`file_size=${fo.size}`);
      }
    }
    seg.push(...kvSegments(event, NOTICE_FIELDS[subtype] ?? []));
    return {
      message: seg.length > 0 ? `notice · ${subtype} · ${seg.join(' · ')}` : `notice · ${subtype}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (pt === 'request') {
    const subtype = String(event.request_type ?? '?');
    const seg = targetSegments(event);
    const comment = typeof event.comment === 'string' ? truncateText(event.comment, 60) : '';
    if (comment) seg.push(comment);
    return {
      message: seg.length > 0 ? `request · ${subtype} · ${seg.join(' · ')}` : `request · ${subtype}`,
      detail: serializeDetail(event),
      raw,
    };
  }

  if (pt === 'meta_event') {
    const subtype = String(event.meta_event_type ?? event.sub_type ?? '?');
    const selfId = event.self_id != null ? ` · ${event.self_id}` : '';
    return { message: `meta · ${subtype}${selfId}`, detail: serializeDetail(event), raw };
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
    // 先收敛 CQ 码 / 消息段再截断，避免截断切在半截 JSON 里
    const msg = messageToText(p.message);
    return {
      message: `${action} → ${target}: ${truncateText(msg || '(空)')}`,
      detail: serializeDetail(params),
    };
  }

  if (action === 'send_msg') {
    const msg = messageToText(p.message);
    const target = p.group_id != null && String(p.group_id) !== ''
      ? ` → 群 ${p.group_id}`
      : (p.user_id != null && String(p.user_id) !== '' ? ` → 私 ${p.user_id}` : '');
    return {
      message: `${action}${target}: ${truncateText(msg || '(空)')}`,
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

/**
 * 落盘的上报类日志只保留原始 JSON（见 log-file-writer），控制台「临时查看文件」时
 * 需要把它还原成可读摘要。这里复用实时链路同一套格式化函数，保证文件视图与实时
 * 视图一致——否则 OneBot11 上报在文件里只会剩 `message · normal` 这种无信息量的串。
 *
 * @param json      落盘的原始上报 JSON
 * @param fallback  解析不出事件名时的兜底（通常传落盘标签，如 EVENT / GF_EVENT）
 */
export function summarizeEventReport(
  json: string,
  fallback: string,
): { message: string; source: string; level: 'debug' | 'info' } {
  const bail = { message: fallback, source: '', level: 'info' as const };
  const text = json.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return bail;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return bail;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return bail;
  const o = parsed as Record<string, unknown>;

  // OneBot11 及同源实现（NapCat / LLOneBot / go-cqhttp…）：以 post_type 为准
  const pt = typeof o.post_type === 'string' ? o.post_type.trim() : '';
  if (pt) {
    const isHeartbeat = pt === 'meta_event' && o.meta_event_type === 'heartbeat';
    return {
      message: formatOb11Event(o as unknown as OB11Event).message,
      // 落盘丢了 prefix（实时是 `[上报:连接名]`），用 self_id 顶上「连接账号」这一列
      source: o.self_id != null && String(o.self_id) !== '' ? String(o.self_id) : '',
      level: isHeartbeat ? 'debug' : 'info',
    };
  }

  // QQ 官方网关 / KOOK 等 `{ t, d }` 结构：正文在 d 里
  const t = typeof o.t === 'string' ? o.t.trim() : '';
  if (t) {
    const payload = (o.d && typeof o.d === 'object') ? o.d as Record<string, unknown> : o;
    return { message: formatQqOfficialEvent(t, payload).message || t, source: '', level: 'info' };
  }

  return bail;
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
