/**
 * 群管理类接口 —— 只收「QQ 群本体」的设置与信息，不含成员操作（member.ts）、
 * 消息收发（message.ts）、群文件（media.ts）。
 *
 * 形态参考：跨协议「语义相同但实体不同」的能力如何合并 ——
 * `set_group_ban` 把野生「QQ 群禁言某人」与官方「频道禁言某成员」收在同一个短名下，
 * 用 scene 区分：scene=group 走野生 QQ 群，scene=channel 走官方频道。
 * 注意两者是**不同实体**（QQ 群 vs 频道），所以 ID 参数分别用 group_id 和 guild_id。
 *
 * 本文件除 set_group_ban 外**全部是野生专属**（support 只有 napcat / snowluma）：
 * QQ 官方的「群」只开放了发消息、撤回、上传、成员列表四个接口，没有群设置、群公告、
 * 群精华、群待办这类能力；官方的「频道 guild」是另一个实体，归 guild.ts / official.ts。
 * 因此这里不为了「对齐三协议」编造官方变体 —— 官方连接调用这些短名会正确降级为
 * unsupported 失败信封。
 *
 * 关于 examples：三份源快照里 NapCat 的返回全是 Type.Any()、SnowLuma 的 responses
 * 只标了 data 是 object / array<object>，没有字段级定义。按 `_CONVENTIONS.md` 第 8 条，
 * 除 get_group_list / get_group_info（OneBot11 标准里字段是定型的）外，
 * 其余条目的 success.data 统一写 null，实际返回由代理层原样透传。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const groupEntries: ProxyApiEntry[] = [
  {
    name: 'set_group_ban',
    title: '禁言群成员',
    summary: '禁言某个人。野生侧禁言 QQ 群成员；官方侧禁言频道成员。duration=0 表示解除禁言。',
    category: 'group',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_ban', '/guilds/{guild_id}/members/{user_id}/mute'],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'group',
        desc: 'group=野生 QQ 群 / channel=官方频道',
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', only: ['napcat', 'snowluma'], sample: 123456 },
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', only: ['official'], sample: '1013531' },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      {
        key: 'duration', label: '禁言时长（秒）', type: 'number', required: true, sample: 600,
        desc: '0 表示解除禁言。野生上限 30 天；官方频道禁言走 mute_seconds / end_time 语义，由代理层换算',
      },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'set_group_ban', map: { duration: 'duration' } },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'set_group_ban', map: { duration: 'duration' } },
        },
      },
      official: {
        variantBy: 'scene',
        variants: {
          channel: {
            verb: 'PATCH',
            path: '/guilds/{guild_id}/members/{user_id}/mute',
            transforms: { duration: 'officialMute' },
            notes: '官方频道禁言用 { mute_seconds } 或 { end_time }，由 transforms.officialMute 从 duration 换算',
          },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, user_id: 10001, duration: 600 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null, message: '机器人不是管理员', wording: '权限不足', echo: null,
      },
      byProtocol: {
        official: {
          request: { scene: 'channel', guild_id: '1013531', user_id: 10001, duration: 600 },
          success: null,
          error: { code: 11253, message: '机器人没有该频道的管理权限' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/mute/manage.html',
  },

  {
    name: 'get_group_list',
    title: '获取群列表',
    summary: '拉取当前账号加入的群列表。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_list'],
    params: [
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', sample: false, desc: 'true 时跳过本地缓存直接向服务器拉取' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_list' } } },
    },
    examples: {
      request: { no_cache: false },
      success: {
        status: 'ok',
        retcode: 0,
        data: [
          { group_id: 123456, group_name: 'kakake 交流群', member_count: 128, max_member_count: 500 },
          { group_id: 234567, group_name: '测试群', member_count: 3, max_member_count: 200 },
        ],
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群列表失败: 未登录', wording: '获取群列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_info',
    title: '获取群信息',
    summary: '按群号拉取单个群的基础信息（群名、成员数、容量等）。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_info'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', only: ['snowluma'], sample: false },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_info' } } },
      snowluma: { variants: { '*': { action: 'get_group_info' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: {
        status: 'ok',
        retcode: 0,
        data: { group_id: 123456, group_name: 'kakake 交流群', member_count: 128, max_member_count: 500 },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '群不存在或机器人不在该群内', wording: '群不存在', echo: null,
      },
    },
  },

  {
    name: 'get_group_detail_info',
    title: '获取群详细信息',
    summary: '拉取群的详细信息，比 get_group_info 多出成员数、最大成员数等扩展字段。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_detail_info'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', only: ['snowluma'], sample: false },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_detail_info' } } },
      snowluma: { variants: { '*': { action: 'get_group_detail_info' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群详细信息失败', wording: '获取群详细信息失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_info_ex',
    title: '获取群详细信息（扩展）',
    summary: '协议端「群组扩展」分类下的群详细信息接口，字段集与 get_group_detail_info 不完全一致，单独保留一个短名。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_info_ex'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', only: ['snowluma'], sample: false },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_info_ex' } } },
      snowluma: { variants: { '*': { action: 'get_group_info_ex' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群扩展信息失败', wording: '获取群扩展信息失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_honor_info',
    title: '获取群荣誉信息',
    summary: '拉取群的荣誉信息（龙王、群聊火焰等）。type 可指定某一种荣誉，不传返回全部。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_honor_info'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'type', label: '荣誉类型', type: 'string', sample: 'talkative',
        desc: '不传返回全部荣誉。取值由协议端的荣誉枚举决定（如 talkative / performer / legend 等）',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_honor_info' } } },
      snowluma: { variants: { '*': { action: 'get_group_honor_info' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群荣誉失败: 不支持的荣誉类型', wording: '获取群荣誉失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_at_all_remain',
    title: '获取群 @全体成员 剩余次数',
    summary: '查询当前账号在该群当天还能 @全体成员 多少次。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_at_all_remain'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_at_all_remain' } } },
      snowluma: { variants: { '*': { action: 'get_group_at_all_remain' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取剩余次数失败', wording: '获取剩余次数失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_shut_list',
    title: '获取群禁言列表',
    summary: '拉取当前处于禁言状态的群成员列表。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_shut_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_shut_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_shut_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取禁言列表失败', wording: '获取禁言列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_signed_list',
    title: '获取群今日打卡列表',
    summary: '拉取当天完成群打卡的成员列表。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_signed_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_signed_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_signed_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取打卡列表失败', wording: '获取打卡列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_share_link',
    title: '获取群分享链接',
    summary: '通过 NTQQ 原生 getJoinGroupLink 取群的 H5 分享/加群链接。默认返回短链（qm.qq.com/q/xxx）。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_share_link'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'need_short_url', label: '返回短链', type: 'boolean', sample: true,
        desc: 'true 返回短链 qm.qq.com/q/xxx；false 返回完整 universal-share 链接',
      },
      { key: 'src_id', label: '分享来源 ID', type: 'number', sample: 73 },
      { key: 'additional_param', label: '附加参数', type: 'string', sample: '' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_share_link' } } },
      snowluma: { variants: { '*': { action: 'get_group_share_link' } } },
    },
    examples: {
      request: { group_id: 123456, need_short_url: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群分享链接失败: 需要群主或管理员授权', wording: '获取群分享链接失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_system_msg',
    title: '获取群系统消息',
    summary: '拉取群系统消息（入群申请、邀请、撤回提醒等收件箱内容）。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_system_msg'],
    params: [
      {
        key: 'count', label: '获取数量', type: 'number', sample: 50,
        desc: '每个收件箱最多读取的记录数。NapCat 侧为必填，默认 50',
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', only: ['snowluma'], sample: 123456 },
      { key: 'only_pending', label: '仅未处理', type: 'boolean', only: ['snowluma'], sample: false },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_system_msg' } } },
      snowluma: { variants: { '*': { action: 'get_group_system_msg' } } },
    },
    examples: {
      request: { count: 50 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群系统消息失败', wording: '获取群系统消息失败', echo: null,
      },
    },
  },

  // get_group_ignored_notifies / get_group_ignore_add_request 已由 member.ts 收录
  // （短名需全局唯一，两边都写会撞名；两条 action 在 member.ts 里已被引到，覆盖率不受影响）。

  {
    name: 'set_group_name',
    title: '设置群名称',
    summary: '修改群名。需要机器人是群主或管理员。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_name'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'group_name', label: '群名称', type: 'string', required: true, sample: 'kakake 交流群' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_name' } } },
      snowluma: { variants: { '*': { action: 'set_group_name' } } },
    },
    examples: {
      request: { group_id: 123456, group_name: 'kakake 交流群' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '修改群名失败: 权限不足', wording: '修改群名失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_remark',
    title: '设置群备注',
    summary: '给群设置一个仅机器人自己可见的备注名。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_remark'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'remark', label: '备注', type: 'string', required: true, sample: '重要客户群' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_remark' } } },
      snowluma: { variants: { '*': { action: 'set_group_remark' } } },
    },
    examples: {
      request: { group_id: 123456, remark: '重要客户群' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群备注失败', wording: '设置群备注失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_portrait',
    title: '设置群头像',
    summary: '更换群头像。file 支持本地绝对路径或 http(s) URL。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_portrait'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file', label: '头像图片', type: 'file', required: true, sample: 'C:/tmp/avatar.jpg', desc: '本地绝对路径或 URL' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_portrait' } } },
      snowluma: { variants: { '*': { action: 'set_group_portrait' } } },
    },
    examples: {
      request: { group_id: 123456, file: 'C:/tmp/avatar.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群头像失败: 图片格式不支持', wording: '设置群头像失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_leave',
    title: '退出群组',
    summary: '退出（或解散）指定群。不可逆操作：解散后群与群内消息全部消失。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['set_group_leave'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'is_dismiss', label: '是否解散', type: 'boolean', only: ['napcat'], sample: false,
        desc: 'true 时解散群（仅群主可用）。SnowLuma 侧未提供该参数，只能退群',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_leave' } } },
      snowluma: { variants: { '*': { action: 'set_group_leave' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '退群失败: 群主不能直接退出自己的群', wording: '退群失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_whole_ban',
    title: '全员禁言',
    summary: '开启或关闭全群禁言。需要机器人是群主或管理员；开启后除管理员外全体无法发言。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['set_group_whole_ban'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'enable', label: '开启全员禁言', type: 'boolean', required: true, sample: true, desc: 'false 表示解除全员禁言' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_whole_ban' } } },
      snowluma: { variants: { '*': { action: 'set_group_whole_ban' } } },
    },
    examples: {
      request: { group_id: 123456, enable: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '全员禁言失败: 权限不足', wording: '全员禁言失败', echo: null,
      },
    },
  },

  // set_group_anonymous / set_group_anonymous_ban 已由 member.ts 收录（同上，短名全局唯一）。

  {
    name: 'set_group_sign',
    title: '群打卡',
    summary: '在当前群执行一次打卡/签到。NapCat 的 send_group_sign 与 set_group_sign 是同一份 handler 的两个注册名，合并为一个短名。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_sign', 'send_group_sign'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: {
        variants: { '*': { action: 'set_group_sign' } },
        // NapCat 把同一份 handler 注册成 set_group_sign 与 send_group_sign 两个 action 名，
        // 语义完全相同；统一走 set_group_sign，另一个只作为别名参与覆盖率对账与搜索
        sameAs: ['send_group_sign'],
      },
      snowluma: { variants: { '*': { action: 'set_group_sign' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '群打卡失败: 该群未开启打卡', wording: '群打卡失败', echo: null,
      },
    },
  },

  {
    name: 'send_group_notice',
    title: '发布群公告',
    summary: '在指定群发布一条公告，可配图、置顶、弹窗、要求成员确认等。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['_send_group_notice', 'send_group_notice'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'content', label: '公告正文', type: 'string', required: true, sample: '本周末停服维护，请大家提前安排' },
      { key: 'image', label: '公告图片', type: 'file', sample: 'C:/tmp/notice.jpg', desc: '本地路径、URL 或 base64' },
      { key: 'pinned', label: '是否置顶', type: 'boolean', sample: true, desc: '协议端用 0/1 表示，代理层不做转换' },
      {
        key: 'type', label: '发布类型', type: 'number', sample: 1,
        desc: '1=普通公告，20=新成员公告。SnowLuma 建议改用 send_to_new_members',
      },
      { key: 'send_to_new_members', label: '发给新成员', type: 'boolean', only: ['snowluma'], sample: false, desc: '与 type=20 等价，二选一' },
      { key: 'confirm_required', label: '需成员确认', type: 'boolean', sample: false, desc: '协议端用 0/1 表示' },
      { key: 'is_show_edit_card', label: '引导改群名片', type: 'boolean', sample: false, desc: '协议端用 0/1 表示' },
      { key: 'tip_window_type', label: '弹窗类型', type: 'number', sample: 0, desc: '0=开启弹窗，1=关闭弹窗（QQ 原始字段为反向语义）' },
    ],
    impl: {
      napcat: { variants: { '*': { action: '_send_group_notice' } } },
      snowluma: { variants: { '*': { action: '_send_group_notice' } } },
    },
    examples: {
      request: { group_id: 123456, content: '本周末停服维护', pinned: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发布群公告失败: 权限不足', wording: '发布群公告失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_notice',
    title: '获取群公告',
    summary: '拉取指定群的公告列表，普通公告与新成员公告在同一数组里返回。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['_get_group_notice', 'get_group_notice'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: '_get_group_notice' } } },
      snowluma: {
        variants: {
          '*': {
            action: '_get_group_notice',
            notes: '返回为公告数组，send_to_new_members 标识新成员公告；图片含 id、url、宽高。字段级结构未文档化，data 原样透传',
          },
        },
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群公告失败', wording: '获取群公告失败', echo: null,
      },
    },
  },

  {
    name: 'delete_group_notice',
    title: '删除群公告',
    summary: '按公告 ID 删除一条群公告。SnowLuma 额外支持用 fid 定位。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['_del_group_notice', 'del_group_notice', 'delete_group_notice'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'notice_id', label: '公告 ID', type: 'string', required: true, sample: 'a1b2c3d4', desc: '从 get_group_notice 的返回里取' },
      { key: 'fid', label: '公告 fid', type: 'string', only: ['snowluma'], desc: 'SnowLuma 侧与 notice_id 二选一' },
    ],
    impl: {
      napcat: { variants: { '*': { action: '_del_group_notice' } } },
      snowluma: { variants: { '*': { action: '_del_group_notice' } } },
    },
    examples: {
      request: { group_id: 123456, notice_id: 'a1b2c3d4' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除群公告失败: 公告不存在', wording: '删除群公告失败', echo: null,
      },
    },
  },

  {
    name: 'set_essence_msg',
    title: '设置精华消息',
    summary: '把群里一条消息设为精华消息。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_essence_msg'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_essence_msg' } } },
      snowluma: { variants: { '*': { action: 'set_essence_msg' } } },
    },
    examples: {
      request: { message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置精华失败: 消息不存在或权限不足', wording: '设置精华失败', echo: null,
      },
    },
  },

  {
    name: 'delete_essence_msg',
    title: '移出精华消息',
    summary: '把一条消息从群精华列表里移除。NapCat 允许用 msg_seq / msg_random 定位，SnowLuma 只认 message_id。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['delete_essence_msg'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
      { key: 'msg_seq', label: '消息序号', type: 'string', only: ['napcat'], desc: 'NapCat 侧与 message_id 二选一' },
      { key: 'msg_random', label: '消息随机数', type: 'string', only: ['napcat'], desc: 'NapCat 侧与 message_id 二选一' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', only: ['napcat'], sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'delete_essence_msg' } } },
      snowluma: { variants: { '*': { action: 'delete_essence_msg' } } },
    },
    examples: {
      request: { message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '移出精华失败: 该消息不是精华消息', wording: '移出精华失败', echo: null,
      },
    },
  },

  {
    name: 'get_essence_msg_list',
    title: '获取群精华消息',
    summary: '拉取指定群的精华消息列表。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_essence_msg_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_essence_msg_list' } } },
      snowluma: { variants: { '*': { action: 'get_essence_msg_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取精华消息列表失败', wording: '获取精华消息列表失败', echo: null,
      },
    },
  },

  {
    name: 'handle_group_request',
    title: '处理加群请求',
    summary: '同意或拒绝一条入群申请 / 邀请。flag 从加群请求事件的 flag 字段取得。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_add_request', 'handle_group_request'],
    params: [
      { key: 'flag', label: '请求 flag', type: 'string', required: true, sample: 'add_request_flag_xxx', desc: '来自加群请求事件，具有时效性' },
      { key: 'approve', label: '是否同意', type: 'boolean', sample: true, desc: 'false 表示拒绝' },
      { key: 'reason', label: '拒绝理由', type: 'string', sample: '不符合入群条件', desc: '仅 approve=false 时有意义' },
      { key: 'sub_type', label: '请求子类型', type: 'string', only: ['snowluma'], desc: 'add=申请加群 / invite=被邀请入群' },
      { key: 'type', label: '请求类型', type: 'string', only: ['snowluma'] },
      { key: 'count', label: '搜索通知数量', type: 'number', only: ['napcat'], sample: 100, desc: 'NapCat 侧用于限定在多少条通知里搜索该 flag' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_add_request' } } },
      snowluma: { variants: { '*': { action: 'set_group_add_request' } } },
    },
    examples: {
      request: { flag: 'add_request_flag_xxx', approve: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '处理加群请求失败: flag 已过期', wording: '处理加群请求失败', echo: null,
      },
    },
  },

  // set_group_special_title 已由 member.ts 收录（头衔挂在成员身上，归成员类更合适）。

  {
    name: 'set_group_add_option',
    title: '设置加群方式',
    summary: '设置群的加群方式（直接加入 / 需审核 / 回答问题等），并可在问答模式下配置问题与答案。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_add_option'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'add_type', label: '加群方式', type: 'number', required: true,
        desc: '取值由协议端定义（如允许任何人 / 需管理员审核 / 需回答问题）。NapCat 侧为必填',
      },
      { key: 'group_question', label: '加群问题', type: 'string', sample: '群主叫什么', desc: 'add_type 为问答模式时必填' },
      { key: 'group_answer', label: '加群答案', type: 'string', sample: 'kakake' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_add_option' } } },
      snowluma: { variants: { '*': { action: 'set_group_add_option' } } },
    },
    examples: {
      request: { group_id: 123456, add_type: 2, group_question: '群主叫什么', group_answer: 'kakake' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置加群方式失败: 权限不足', wording: '设置加群方式失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_robot_add_option',
    title: '设置群机器人加群选项',
    summary: '设置机器人被拉进群时的开关与审核策略。入参语义协议端未文档化，按原样透传。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['set_group_robot_add_option'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'robot_member_switch', label: '机器人成员开关', type: 'number', sample: 1 },
      { key: 'robot_member_examine', label: '机器人成员审核', type: 'number', sample: 1 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_robot_add_option' } } },
      snowluma: { variants: { '*': { action: 'set_group_robot_add_option' } } },
    },
    examples: {
      request: { group_id: 123456, robot_member_switch: 1 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置机器人加群选项失败', wording: '设置机器人加群选项失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_search',
    title: '设置群搜索选项',
    summary: '设置群能否被搜索到（群指纹 / 群号搜索开关）。两个开关在协议端标注为「未知」，按原样透传。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['set_group_search'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'no_finger_open', label: '群指纹搜索开关', type: 'number', sample: 0 },
      { key: 'no_code_finger_open', label: '群号搜索开关', type: 'number', sample: 0 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_search' } } },
      snowluma: { variants: { '*': { action: 'set_group_search' } } },
    },
    examples: {
      request: { group_id: 123456, no_finger_open: 0 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群搜索选项失败', wording: '设置群搜索选项失败', echo: null,
      },
    },
  },

  // set_group_member_invite_policy / set_group_member_permissions 已由 member.ts 收录。

  {
    name: 'set_group_new_member_history_visibility',
    title: '设置新成员历史消息可见性',
    summary: '设置新入群的成员默认能否查看入群前的聊天记录。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_new_member_history_visibility'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'visible', label: '新成员可见历史消息', type: 'boolean', required: true, sample: true },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_new_member_history_visibility' } } },
      snowluma: { variants: { '*': { action: 'set_group_new_member_history_visibility' } } },
    },
    examples: {
      request: { group_id: 123456, visible: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置历史消息可见性失败', wording: '设置历史消息可见性失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_todo',
    title: '设置群待办',
    summary: '把群里一条消息标记为群待办。NapCat 侧未声明入参结构，按 SnowLuma 的 group_id + message_id 透传。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['set_group_todo'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_todo' } } },
      snowluma: { variants: { '*': { action: 'set_group_todo' } } },
    },
    examples: {
      request: { group_id: 123456, message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群待办失败', wording: '设置群待办失败', echo: null,
      },
    },
  },

  {
    name: 'complete_group_todo',
    title: '完成群待办',
    summary: '把某条消息对应的群待办标记为已完成。动词沿用原生 action 名（动词表里没有更贴合的）。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['complete_group_todo'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'complete_group_todo' } } },
      snowluma: { variants: { '*': { action: 'complete_group_todo' } } },
    },
    examples: {
      request: { group_id: 123456, message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '完成群待办失败: 该消息不是待办', wording: '完成群待办失败', echo: null,
      },
    },
  },

  {
    name: 'cancel_group_todo',
    title: '取消群待办',
    summary: '取消某条消息对应的群待办。动词沿用原生 action 名（动词表里没有更贴合的）。',
    category: 'group',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['cancel_group_todo'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'cancel_group_todo' } } },
      snowluma: { variants: { '*': { action: 'cancel_group_todo' } } },
    },
    examples: {
      request: { group_id: 123456, message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '取消群待办失败: 该消息不是待办', wording: '取消群待办失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_todo_list',
    title: '获取群待办列表',
    summary: '拉取指定群当前的待办列表。仅 SnowLuma 提供。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_todo_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      // NapCat 侧没有 get_group_todo_list，support 里不列
      snowluma: { variants: { '*': { action: 'get_group_todo_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },

  {
    name: 'get_group_admin_settings',
    title: '获取群管理设置',
    summary: '读取群管理相关设置项的当前值。仅 SnowLuma 提供，返回字段未文档化。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_group_admin_settings'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'get_group_admin_settings', notes: '返回结构未文档化，data 原样透传' },
        },
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },

  {
    name: 'set_group_reaction',
    title: '群聊表情回应',
    summary: '对群里一条消息发表情回应（is_set=false 表示取消）。仅 SnowLuma 提供；通用表情回应见 set_msg_emoji_like。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_reaction'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
      { key: 'code', label: '表情编码', type: 'string', required: true, sample: '128513', desc: 'QQ 表情 ID，取值由协议端定义' },
      { key: 'is_set', label: '添加/取消', type: 'boolean', sample: true, desc: 'true 添加回应，false 取消回应' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'set_group_reaction' } } },
    },
    examples: {
      request: { group_id: 123456, message_id: 1728134400, code: '128513', is_set: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },

  {
    name: 'get_group_tags',
    title: '读取群分类资料标签',
    summary: '读取某个群分类（group_class）下的资料标签列表。仅 SnowLuma 提供。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_group_tags'],
    params: [
      { key: 'group_class', label: '群分类 ID', type: 'number', required: true, sample: 1 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'get_group_tags', notes: '返回结构未文档化，data 原样透传' },
        },
      },
    },
    examples: {
      request: { group_class: 1 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },

  {
    name: 'add_group_tag',
    title: '添加群分类资料标签',
    summary: '向某个群分类下添加一个资料标签。仅 SnowLuma 提供。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['add_group_tag'],
    params: [
      { key: 'group_class', label: '群分类 ID', type: 'number', required: true, sample: 1 },
      { key: 'name', label: '标签名', type: 'string', required: true, sample: '客户' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'add_group_tag' } } },
    },
    examples: {
      request: { group_class: 1, name: '客户' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },

  {
    name: 'delete_group_tag',
    title: '移除群分类资料标签',
    summary: '从某个群分类下移除一个资料标签。仅 SnowLuma 提供。',
    category: 'group',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['delete_group_tag'],
    params: [
      { key: 'group_class', label: '群分类 ID', type: 'number', required: true, sample: 1 },
      { key: 'name', label: '标签名', type: 'string', required: true, sample: '客户' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'delete_group_tag' } } },
    },
    examples: {
      request: { group_class: 1, name: '客户' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: -1001, data: null,
        message: '当前协议不支持该接口', wording: '协议不支持', echo: null,
      },
    },
  },
];
