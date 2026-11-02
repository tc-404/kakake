import type { OB11Event } from '../connection/onebot.types.js';
import {
  getBotSelf,
  groupLabel,
  requestGroupName,
  shortId,
  userLabel,
} from './entity-names.js';

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
  // 与消息链路同一套兜底：KOOK 用 channel_id，微信用 from_user_id
  const gid = firstNonEmpty(obj.group_id, obj.channel_id);
  if (gid !== '?') out.push(`群 ${gid}`);
  const uid = firstNonEmpty(obj.user_id, obj.target_id, obj.operator_id, obj.from_user_id);
  if (uid !== '?') out.push(uid);
  return out;
}

/**
 * OneBot 上报里 `sender` 自带群名片与昵称，以前只用 user_id，
 * 预览里就只有一串数字看不出是谁。这里名片优先（群里有改名时以名片为准），
 * 都没有才退回 QQ 号。
 */
function senderLabel(
  sender: Record<string, unknown>,
  userId: unknown,
  extraAuthor: Record<string, unknown> = {},
): string {
  const card = String(sender.card ?? '').trim();
  if (card) return card;
  const nick = String(sender.nickname ?? '').trim();
  if (nick) return nick;
  // KOOK 的发言人挂在 extra.author.username，不走 OneBot 的 sender
  const extraName = String(extraAuthor.username ?? '').trim();
  if (extraName) return extraName;
  return String(userId ?? '?');
}

/**
 * 各端 shim 的字段名并不统一：KOOK 把群号放在 `channel_id`，微信把发言人放在
 * `from_user_id`。只认 OneBot 原生字段名的话这两条链路的预览会直接变成 `群 ?` / `私聊 ?`。
 */
function firstNonEmpty(...values: unknown[]): string {
  for (const v of values) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return '?';
}

export function formatOb11Event(event: OB11Event): { message: string; detail?: string; raw: string } {
  const raw = JSON.stringify(event);
  const pt = event.post_type || 'unknown';

  if (pt === 'message' || pt === 'message_sent') {
    const msgType = String(event.message_type || '?');
    const userId = firstNonEmpty(event.user_id, event.from_user_id);
    const groupId = firstNonEmpty(event.group_id, event.channel_id);
    const rawMsg = String(event.raw_message ?? '');
    // 先收敛 CQ 码再截断：不这么做会被 160 字符切在 CQ 码中间，留下一串没有闭合 ] 的原始参数
    const text = rawMsg
      ? collapseCqTag(rawMsg)
      : serializeDetail(event.message, 80) || '(非文本)';
    const sender = (event.sender && typeof event.sender === 'object')
      ? event.sender as Record<string, unknown>
      : {};
    const extra = (event.extra && typeof event.extra === 'object')
      ? event.extra as Record<string, unknown>
      : {};
    const extraAuthor = (extra.author && typeof extra.author === 'object')
      ? extra.author as Record<string, unknown>
      : {};
    return {
      // 私聊里「私聊 X」的 X 就是发言人，再拼一次 `: X` 会把同一个人写两遍
      message: msgType === 'group'
        ? `${pt} · 群 ${groupId} · ${senderLabel(sender, userId, extraAuthor)}: ${truncateText(text)}`
        : `${pt} · 私聊 ${senderLabel(sender, userId, extraAuthor)} · ${truncateText(text)}`,
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

/**
 * 官方正文里的 @ 标记换成「@名字」。
 *
 * 平台给的形态是 `<@openid>`（旧）与 `<qqbot-at-user id="openid" />`（新），
 * 两种都带着被 @ 的人是谁。以前这里一律替换成光秃秃的 `'@'`，id 参数直接丢掉，
 * 预览就只剩一个「@ 」后面接空格——看着像解析挂了，其实是被扔了。
 * 现在按优先级回名字：全体成员 → 机器人自己 → 缓存昵称 → 短 ID。
 */
function prettyOfficialContent(text: string, appId: string): string {
  if (!text) return '';
  const resolve = (id: string): string => {
    const t = String(id ?? '').trim();
    if (!t || t === 'everyone' || t === 'all') return '@全体成员';
    const self = getBotSelf(appId);
    if (self?.openid && t === self.openid) return `@${self.name}`;
    return `@${userLabel(appId, t)}`;
  };
  let s = text.replace(/<qqbot-at-everyone[^>]*>/gi, '@全体成员');
  s = s.replace(/<qqbot-at-user[^>]*>/gi, (m) => {
    const q = /id\s*=\s*["']?([^"'\s/>]+)/i.exec(m);
    return q ? resolve(q[1]) : '@成员';
  });
  s = s.replace(/<@([^>]*)>/g, (_m, id: string) => resolve(id));
  return s;
}

/** 官方事件日志上下文：openid 是按机器人隔离的，只有带上 appId 才能命中名字缓存 */
export interface QqOfficialLogContext {
  appId?: string;
  /** HTTP 方法（DELETE /messages/{id} 是撤回，不是发消息） */
  method?: string;
}

/** 官方 API 路径尾段 → 可读动作名 */
const QQ_ACTION_VERB: Record<string, string> = {
  messages: '发消息',
  files: '上传文件',
  members: '成员操作',
  announces: '发公告',
  reactions: '表态',
  pins: '置顶',
  threads: '主题',
  dms: '发私信',
  mute: '禁言',
};

/**
 * 官方输出侧的 API 路径 → 「动作 → 目标」，例如 `/v2/groups/<openid>/messages`
 * 变成 `发消息 → 群 咔咔珂测试群`。
 *
 * 以前直接把整条路径当预览文本：32 位群 openid 占掉大半行，正文被挤到看不见，
 * 而且路径里明明有群 openid 却不去换名字。这里顺手把群名补上并登记后台刷新。
 * 认不出的路径原样返回，不会比现在更差。
 */
export function qqOfficialActionBrief(action: string, ctx?: QqOfficialLogContext): string {
  const path = String(action ?? '').trim();
  const appId = String(ctx?.appId ?? '').trim();
  const m = /^\/v\d+\/([a-z_]+)\/([^/?#]+)(.*)$/i.exec(path);
  if (!m) return path || action;

  const [, kind, id, rest] = m;
  const kindKey = kind.toLowerCase();
  let target: string;
  if (kindKey === 'groups') {
    // 输出侧同样登记一次，插件主动发消息的群也能被补上名字
    if (appId) requestGroupName(appId, id);
    target = `群 ${groupLabel(appId, id)}`;
  } else if (kindKey === 'users') {
    target = `私聊 ${userLabel(appId, id)}`;
  } else if (kindKey === 'guilds') {
    target = `频道 ${shortId(id)}`;
  } else if (kindKey === 'channels') {
    target = `子频道 ${shortId(id)}`;
  } else {
    target = `${kind} ${shortId(id)}`;
  }

  const seg = rest.split('/').filter(Boolean);
  const head = (seg[0] ?? '').toLowerCase();
  if (!head) return target;
  const method = String(ctx?.method ?? '').toUpperCase();
  let verb = QQ_ACTION_VERB[head] ?? head;
  if (head === 'messages') {
    if (method === 'DELETE') verb = '撤回消息';
    else if (seg.length > 1) verb = `消息 ${shortId(seg[1])}`;
  }
  return `${verb} → ${target}`;
}

/** 官方输出正文：content / markdown / 卡片 / 富媒体，取不出就留空 */
function qqActionContent(params: Record<string, unknown>, appId: string): string {
  const md = params.markdown;
  if (md && typeof md === 'object') {
    const c = (md as Record<string, unknown>).content;
    if (typeof c === 'string' && c.trim()) return truncateText(c);
  }
  if (params.embed || params.ark) return '[卡片]';
  const content = typeof params.content === 'string' ? params.content : '';
  // 输出里也能带 @ 标记，@ 到机器人自己时同样要叫出名字
  if (content.trim()) return truncateText(prettyOfficialContent(content, appId));
  // msg_type=7 是富媒体（图片 / 语音 / 视频），比笼统的「文件」更准确
  if (String(params.msg_type ?? '') === '7') return '[媒体]';
  if (params.file_info || params.file_type || params.file) return '[文件]';
  if (params.image ?? params.media) return '[媒体]';
  return '';
}

/** 官方 API 输出（发消息 / 传文件等）的日志摘要 */
export function formatQqOfficialAction(
  action: string,
  params: Record<string, unknown> | undefined,
  ctx?: QqOfficialLogContext,
): string {
  const appId = String(ctx?.appId ?? '').trim();
  const brief = qqOfficialActionBrief(action, ctx);
  const content = qqActionContent(params ?? {}, appId);
  return content ? `${brief}: ${content}` : brief;
}

/** 官方 API 输出的结果 / 失败摘要（与 formatOb11ActionResult 对齐） */
export function formatQqOfficialActionResult(
  action: string,
  result: unknown,
  error: string | undefined,
  ctx?: QqOfficialLogContext,
): string {
  const brief = qqOfficialActionBrief(action, ctx);
  if (error) return `${brief} ✗ ${truncateText(error, 120)}`;
  const r = (result ?? {}) as Record<string, unknown>;
  const data = (r.data ?? r) as Record<string, unknown>;
  // 官方发送接口回的是 `{ id, timestamp }`，不叫 message_id，也得认
  const msgId = data?.message_id ?? data?.msg_id ?? data?.id ?? r?.message_id ?? r?.msg_id ?? r?.id;
  if (msgId !== undefined && msgId !== null && String(msgId) !== '') {
    return `${brief} ✓ message_id=${String(msgId)}`;
  }
  const summary = serializeDetail(result, 120);
  return summary ? `${brief} ✓ ${summary}` : `${brief} ✓`;
}

/** QQ 官方机器人 Gateway 事件摘要 */
export function formatQqOfficialEvent(
  eventType: string,
  event: unknown,
  ctx?: QqOfficialLogContext,
): { message: string; detail?: string; raw: string } {
  const raw = JSON.stringify(event);
  const data = (typeof event === 'object' && event) ? event as Record<string, unknown> : {};
  const d = (data.d && typeof data.d === 'object') ? data.d as Record<string, unknown> : data;
  const pick = (k: string) => String(d[k] ?? data[k] ?? '').trim();
  const appId = String(ctx?.appId ?? '').trim();
  // 群里统一走缓存名；没 appId（读历史日志）时 groupLabel 会跨账号再找一遍
  const gl = () => groupLabel(appId, pick('group_openid'));
  const ul = (openid: string) => (openid ? userLabel(appId, openid) : '?');

  if (eventType === 'GROUP_AT_MESSAGE_CREATE' || eventType === 'C2C_MESSAGE_CREATE' || eventType === 'GROUP_MESSAGE_CREATE') {
    const author = data.author as { member_openid?: string; id?: string; user_openid?: string } | undefined;
    const groupId = String(data.group_openid ?? data.group_id ?? '').trim();
    const isGroup = eventType.startsWith('GROUP_');
    // 名字是异步补的：首次见到这个群先记一笔，下一条上报就能显示群名
    if (isGroup && groupId && appId) requestGroupName(appId, groupId);
    const memberOpenid = String(author?.member_openid ?? '').trim();
    const userOpenid = String(author?.user_openid ?? author?.id ?? '').trim();
    const speakerOpenid = memberOpenid || userOpenid;
    const content = truncateText(prettyOfficialContent(String(data.content ?? ''), appId));
    const who = appId ? ul(speakerOpenid) : shortId(speakerOpenid);
    return {
      // 私聊里「私聊 X」的 X 就是发言人，再拼一次 `: X` 会同一串 ID 出现两遍
      message: isGroup
        ? `${eventType} · 群 ${gl()} · ${who}: ${content || '(非文本)'}`
        : `${eventType} · 私聊 ${who} · ${content || '(非文本)'}`,
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
      message: `GROUP_ADD_ROBOT · 群 ${gl()} · 操作人 ${ul(pick('op_member_openid'))}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_DEL_ROBOT') {
    return {
      message: `GROUP_DEL_ROBOT · 群 ${gl()} · 操作人 ${ul(pick('op_member_openid'))}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_MEMBER_ADD') {
    return {
      message: `GROUP_MEMBER_ADD · 群 ${gl()} · 成员 ${ul(pick('member_openid') || pick('op_member_openid'))}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_MEMBER_REMOVE') {
    return {
      message: `GROUP_MEMBER_REMOVE · 群 ${gl()} · 成员 ${ul(pick('member_openid') || pick('op_member_openid'))}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'GROUP_JOIN_REQUEST') {
    // username 若平台直接给了就是可读名字，不必再过一遍 openid 缓存
    const who = pick('username') || ul(pick('member_openid'));
    return {
      message: `GROUP_JOIN_REQUEST · 群 ${gl()} · 申请人 ${who}`,
      detail: serializeDetail(event),
      raw,
    };
  }
  if (eventType === 'FRIEND_ADD' || eventType === 'FRIEND_DEL') {
    return {
      message: `${eventType} · 用户 ${ul(pick('openid'))}`,
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
