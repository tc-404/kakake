/**
 * QQ 官方 OpenAPI 错误码表（对齐 2026-10-28 版官方文档）。
 *
 * 数据来源：
 *   - 发送群聊消息 / 发送单聊消息 autogen 接口页的「错误码」表
 *   - 素材管理 <https://bot.qq.com/wiki/develop/api-v2/server-inter/message/material-management.html>
 *   - 获取群成员列表等群管理接口页
 *   - 变更记录 <https://bot.qq.com/wiki/develop/api-v2/changelog.html>
 *
 * 2026-08~10 新增/变更的能力带来了一批新错误码（素材 400350xx、消息类型 340069、
 * 不允许发 URL 40054010、召回消息 4003412x 等），旧的错误码速查表没有收录。
 * 这里做成结构化数据，供失败信封的 wording、日志和 GF 手册复用。
 *
 * 原则：**只收录文档里写明的码**，不猜测、不编造；每个码给出中文含义与排查建议。
 * `since` 只标注 2026-08-10 之后随变更记录新增/明确的一批，历史码留空。
 */

export type QqOfficialErrorGroup =
  | 'message'
  | 'markdown'
  | 'media'
  | 'material'
  | 'group'
  | 'recall'
  | 'permission';

export interface QqOfficialApiErrorInfo {
  code: number;
  desc: string;
  hint?: string;
  group: QqOfficialErrorGroup;
  /** 随官方哪一批变更新增/明确；历史码不填 */
  since?: '20260810' | '20260916' | '20261021' | '20261026' | '20261028';
}

export const QQ_OFFICIAL_ERROR_CODES: readonly QqOfficialApiErrorInfo[] = [
  /* ── 发送 / 被动回复 ── */
  { code: 22006, desc: '消息类型与内容不匹配', hint: '检查 msg_type 与 content / markdown / media / card 是否对应', group: 'message' },
  { code: 50059, desc: '输入类型错误', hint: 'msg_type=6 时检查 input_notify.input_type', group: 'message' },
  { code: 304061, desc: '消息内容无效', hint: '检查消息格式', group: 'message' },
  { code: 304062, desc: '订阅按钮数量达到上限', hint: '减少按钮数量', group: 'message' },
  { code: 304064, desc: '订阅消息未授权', hint: '先引导用户授权订阅消息', group: 'message' },
  { code: 304103, desc: '消息 ID 已过期，不能回复', hint: '收到消息后尽快回复', group: 'message' },
  { code: 340067, desc: '获取机器人信息失败', hint: '检查机器人状态', group: 'message' },
  { code: 340069, desc: '消息类型无效', hint: '检查 msg_type 取值（群 0/2/7/8，单聊 0/2/6/7/8）', group: 'message', since: '20261028' },
  { code: 40034005, desc: '回复消息 msg_id 已过期', hint: '群 5 分钟 / 单聊 60 分钟内回复', group: 'message' },
  { code: 40034006, desc: '消息内容违规', hint: '修改内容后重试', group: 'message' },
  { code: 40034024, desc: '请求参数 msg_id 无效或越权', hint: '检查是否拿了别的账号/会话的 id', group: 'message' },
  { code: 40034025, desc: '请求参数 event_id 无效', hint: '检查事件类型是否在支持列表', group: 'message' },
  { code: 40034026, desc: '请求参数 event_id 已过期', hint: '尽快回', group: 'message' },
  { code: 40034027, desc: '该事件不支持回复消息', hint: '换 msg_id 或转成主动消息', group: 'message' },
  { code: 40034100, desc: '主动消息发送超过频控限制', hint: '降频或等配额恢复', group: 'message' },
  { code: 40034101, desc: '机器人非群成员', hint: '先把机器人加入群聊', group: 'message' },
  { code: 40034105, desc: '主动消息发送失败，无权限', hint: '检查机器人权限设置 / 用户是否关闭主动消息', group: 'message' },
  { code: 40034122, desc: '召回消息已达区间上限', hint: '同一周期内只能下发 1 条 is_wakeup 消息', group: 'message', since: '20260810' },
  { code: 40034123, desc: '不支持召回消息', hint: '该消息不能使用 is_wakeup', group: 'message', since: '20260810' },
  { code: 40034128, desc: '被动回复时间或次数超限', hint: '群 5 次 / 单聊 4 次', group: 'message' },
  { code: 40054002, desc: '机器人被禁言', hint: '等解禁后再发送', group: 'message' },
  { code: 40054003, desc: '机器人不是群成员', hint: '先把机器人加入群聊', group: 'message' },
  { code: 40054004, desc: '无好友关系', hint: '先添加好友后再发送私信', group: 'message' },
  { code: 40054005, desc: '消息被去重', hint: '换 msg_seq', group: 'message' },
  { code: 40054006, desc: '验证好友关系失败', hint: '重试', group: 'message' },
  { code: 40054007, desc: '消息长度超限', hint: '缩短内容', group: 'message' },
  { code: 40054010, desc: '不允许发送 URL', hint: '移除消息中的 URL；图文卡片改用 card.content.url', group: 'message', since: '20261028' },
  { code: 40054013, desc: '用户拒收消息', hint: '无解', group: 'message' },
  { code: 40054016, desc: '机器人已下线', hint: '检查机器人状态', group: 'message' },
  { code: 40054018, desc: '消息过长或异常', hint: '缩短消息内容', group: 'message' },
  { code: 50055001, desc: '消息发送异常', hint: '稍后重试', group: 'message' },
  { code: 50055002, desc: '消息发送异常', hint: '稍后重试', group: 'message' },
  { code: 50055006, desc: 'ARK 消息发送异常', hint: '稍后重试', group: 'message' },

  /* ── Markdown / 键盘 ── */
  { code: 304004, desc: '无权限使用该 ARK 模板', hint: '先申请 ARK 模板权限', group: 'markdown' },
  { code: 304036, desc: '无 Markdown 模板权限', hint: '改用原生 markdown.content（模板方式已废弃）', group: 'markdown' },
  { code: 305007, desc: '键盘样式参数错误', hint: '检查 keyboard 参数', group: 'markdown' },
  { code: 40034008, desc: 'Markdown 参数有空值', hint: '确保所有 Markdown 参数都有值', group: 'markdown' },
  { code: 40034009, desc: 'Markdown 参数有换行符', hint: '移除参数中的换行符', group: 'markdown' },
  { code: 40034010, desc: '模板参数中不能含有 Markdown 语法', hint: '模板参数用纯文本', group: 'markdown' },
  { code: 40034011, desc: '无效的 Markdown 内容', hint: '检查 Markdown 语法', group: 'markdown' },
  { code: 40034029, desc: '内联键盘行/列超限', hint: '减少键盘按钮数量', group: 'markdown' },
  { code: 40034106, desc: '消息不支持该指令类型', hint: '检查消息指令类型', group: 'markdown' },
  { code: 40034108, desc: '指令参数长度超限', hint: '缩短指令参数', group: 'markdown' },
  { code: 40034109, desc: '指令参数解析失败', hint: '检查指令参数格式', group: 'markdown' },
  { code: 40034124, desc: 'Markdown 消息参数错误', hint: '检查 Markdown 参数格式', group: 'markdown' },
  { code: 40034127, desc: '无 Markdown 模板权限', hint: '改用原生 markdown.content', group: 'markdown' },

  /* ── 富媒体上传 ── */
  { code: 304080, desc: '文件信息无效', hint: '检查 file_info 格式与时效（ttl）', group: 'media' },
  { code: 40034004, desc: '富媒体信息转存失败', hint: '重试；或给 markdown 传 force_verify_image_resource=true 让失败显式暴露', group: 'media', since: '20260810' },
  { code: 40093001, desc: '文件上传失败（大文件分片异常）', hint: '重试', group: 'media' },
  { code: 40093002, desc: '超过当天发送文件容量上限', hint: '次日再试', group: 'media' },
  { code: 850018, desc: '群/机器人被禁言', hint: '等解禁', group: 'media' },
  { code: 850019, desc: '不支持的文件格式', hint: '检查 file_type', group: 'media' },
  { code: 850026, desc: '下载原始文件失败', hint: '检查 URL 是否公网可访问', group: 'media' },
  { code: 850031, desc: '超过大小限制', hint: '软限制：图/语音 20MB、视频 30MB；硬限制 200MB', group: 'media' },

  /* ── 素材管理（20261021 新增） ── */
  { code: 40035001, desc: '图片格式不支持', hint: '扩展名与 Content-Type 需为 png/jpeg/gif/webp 且一致', group: 'material', since: '20261021' },
  { code: 40035002, desc: '图片超过大小上限', hint: '默认 10MB', group: 'material', since: '20261021' },
  { code: 40035003, desc: '上传任务不存在/已过期，或 MD5 不匹配', hint: 'prepare 后 4 小时内完成；complete 的 md5 用 COS 返回的 ETag', group: 'material', since: '20261021' },
  { code: 40035006, desc: '服务端内部错误（COS 处理/链接生成）', hint: '稍后重试', group: 'material', since: '20261021' },
  { code: 40035007, desc: '图片数量超过上限（100 张）', hint: '删除部分图片后重试', group: 'material', since: '20261021' },
  { code: 40035008, desc: '图片不存在或已被删除', hint: '检查 image_id', group: 'material', since: '20261021' },
  { code: 40035009, desc: '图片已过期或已被删除，引用链接不再可用', hint: '重新上传；链接 90 天未引用会失效', group: 'material', since: '20261021' },
  { code: 40035010, desc: '引用链接无效或不属于当前机器人', hint: 'qqbot-media:// 与机器人绑定，不能跨机器人引用', group: 'material', since: '20261021' },

  /* ── 群管理 / 权限 ── */
  { code: 11253, desc: '应用无接口访问权限', hint: '该接口仅白名单机器人可用，联系平台运营申请权限', group: 'permission' },
  { code: 40064004, desc: '已超出撤回时限', hint: '只能撤回 2 分钟内、机器人自己发的消息', group: 'recall' },
  { code: 40062003, desc: '无操作权限', hint: '机器人不是管理员且撤回的是别人的消息', group: 'recall' },
];

const BY_CODE = new Map<number, QqOfficialApiErrorInfo>(
  QQ_OFFICIAL_ERROR_CODES.map((item) => [item.code, item]),
);

/** 按错误码查结构化信息；查不到返回 undefined（绝不编造含义） */
export function lookupQqOfficialApiError(
  code: number | string | null | undefined,
): QqOfficialApiErrorInfo | undefined {
  const n = typeof code === 'string' ? Number.parseInt(code, 10) : code;
  return typeof n === 'number' && Number.isFinite(n) ? BY_CODE.get(n) : undefined;
}

/** 给日志 / 失败信封用的一行中文说明；未知错误码返回 undefined */
export function describeQqOfficialApiError(
  code: number | string | null | undefined,
): string | undefined {
  const info = lookupQqOfficialApiError(code);
  if (!info) return undefined;
  return info.hint ? `${info.desc}：${info.hint}` : info.desc;
}

/** 按分组取错误码，便于文档生成与控制台筛选 */
export function qqOfficialApiErrorsByGroup(group: QqOfficialErrorGroup): QqOfficialApiErrorInfo[] {
  return QQ_OFFICIAL_ERROR_CODES.filter((item) => item.group === group);
}
