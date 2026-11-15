import type { ProxyApiEntry } from '../../proxy.types.js';

/**
 * 好友与好友互动类接口。
 *
 * 覆盖：好友列表 / 分组 / 单向好友 / 最近会话、删除好友、好友申请（含可疑申请）处理、
 * 陌生人信息、拍一拍（戳一戳）、备注与分组调整、在线状态、输入状态、私聊已读标记，
 * 以及官方侧唯一的「主动单聊」入口 `POST /users/@me/dms`（创建私信会话）。
 *
 * 边界说明（避免与其他分类文件重复建条目）：
 *   - `send_like`（点赞）在 wild.ts，这里不建；
 *   - `group_poke`（群内拍一拍）属群相关，交 group.ts；本文件的 send_poke 只在
 *     scene=group 时落到通用的 send_poke（按 group_id 自动路由）；
 *   - `set_online_status` / `set_diy_online_status` / `set_input_status`（改的是机器人
 *     自己的状态，不是好友）已由 system.ts 建条目，这里不重复建；
 *   - `mark_msg_as_read`（按消息 ID 标记已读、协议端自动路由群聊/私聊）已由 message.ts
 *     建条目，这里不重复建；本文件只保留好友/私聊维度的 mark_private_msg_as_read；
 *   - `mark_group_msg_as_read` / `_mark_all_as_read` 归 group.ts / message.ts；
 *   - `set_qq_profile` / `set_self_longnick`（改自己资料与签名）归 account.ts；
 *   - `ArkSharePeer`(napcat) / `share_peer`(snowluma)（分享联系人 Ark 卡片）属 Ark 分享，
 *     归 message.ts 或 wild.ts；
 *   - `get_friend_msg_history` 是好友维度的聊天记录，与 group 的 get_group_msg_history 对称，
 *     因此收在这里而不是 message.ts。
 *
 * 详见同目录 `_CONVENTIONS.md`。
 */
export const friendEntries: ProxyApiEntry[] = [
  {
    name: 'get_friend_list',
    title: '获取好友列表',
    summary: '获取当前登录账号的好友列表。官方协议没有等价接口，官方连接下调用会降级为 unsupported 失败信封。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_friend_list'],
    params: [
      {
        key: 'no_cache', label: '不使用缓存', type: 'boolean', sample: false,
        only: ['napcat'], desc: '为 true 时跳过协议端缓存直接拉取。仅 NapCat 声明了该参数',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_friend_list' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'get_friend_list',
            notes: 'SnowLuma 的 OpenAPI 未声明任何请求参数，传 no_cache 会被忽略',
          },
        },
      },
      // 官方 v2 只开放「频道成员列表」，没有好友概念，因此 support 里不列 official。
    },
    examples: {
      request: {},
      success: {
        status: 'ok',
        retcode: 0,
        data: [{ user_id: 10001, nickname: '某人', remark: '小张' }],
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取好友列表失败', wording: '获取好友列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_friends_with_category',
    title: '获取带分组的好友列表',
    summary: '按好友分组返回好友列表（每组含分组 ID、分组名、成员数与好友数组）。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_friends_with_category'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_friends_with_category',
            notes: 'NapCat 侧无请求参数，返回结构未文档化，字段名以协议端实际返回为准',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_friends_with_category',
            notes: 'SnowLuma 文档：每组含 categoryId、categoryName、categoryMbCount、buddyList',
          },
        },
      },
    },
    examples: {
      request: {},
      success: {
        status: 'ok',
        retcode: 0,
        data: [
          {
            categoryId: 0,
            categoryName: '我的好友',
            categoryMbCount: 1,
            buddyList: [{ user_id: 10001, nickname: '某人', remark: '小张' }],
          },
        ],
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取分组好友列表失败', wording: '获取分组好友列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_unidirectional_friend_list',
    title: '获取单向好友列表',
    summary: '获取单向好友列表（对方好友列表里有你、你的好友列表里没有对方的那批人）。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_unidirectional_friend_list'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_unidirectional_friend_list',
            notes: '返回结构未文档化，data 以协议端实际返回为准',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_unidirectional_friend_list',
            notes: '返回结构未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取单向好友列表失败', wording: '获取单向好友列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_recent_contact',
    title: '获取最近会话',
    summary: '获取最近有往来的会话列表（好友与群混合）。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_recent_contact'],
    params: [
      {
        key: 'count', label: '获取数量', type: 'number', sample: 10,
        desc: 'NapCat 侧为必填（默认 10）；SnowLuma 侧可省略',
      },
    ],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_recent_contact', notes: 'NapCat 要求 count 必填' } },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_recent_contact',
            stub: true,
            notes: 'SnowLuma 自述为占位实现，恒返回空数组，不作为可用数据源',
          },
        },
      },
    },
    examples: {
      request: { count: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取最近会话失败', wording: '获取最近会话失败', echo: null,
      },
    },
  },

  {
    name: 'delete_friend',
    title: '删除好友',
    summary: '从好友列表中删除指定 QQ 号。不可逆操作，可选同时拉黑。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_friend'],
    params: [
      {
        key: 'user_id', label: '好友 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001,
      },
      {
        key: 'block', label: '同时加入黑名单', type: 'boolean', sample: false,
        desc: 'NapCat 侧会被映射为 temp_block 字段',
      },
      {
        key: 'temp_both_del', label: '双向删除', type: 'boolean', sample: false,
        only: ['napcat'], desc: '为 true 时让对方好友列表里也删掉自己。仅 NapCat 支持',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'delete_friend',
            map: { block: 'temp_block' },
            notes: 'NapCat 同时接受 friend_id 与 user_id，这里统一用 user_id',
          },
        },
      },
      snowluma: {
        variants: { '*': { action: 'delete_friend' } },
      },
    },
    examples: {
      request: { user_id: 10001, block: false },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除好友失败: 该用户不是好友', wording: '删除好友失败', echo: null,
      },
    },
  },

  {
    name: 'handle_friend_request',
    title: '处理好友添加请求',
    summary: '同意或拒绝一条加好友请求。flag 必须从好友添加请求事件里取得，无法凭 QQ 号构造。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_friend_add_request'],
    params: [
      {
        key: 'flag', label: '请求 flag', type: 'string', required: true, sample: '1678addf-8f2a-4c31',
        desc: '加好友请求的标识，从好友添加请求上报事件中获取（不是 QQ 号）',
      },
      {
        key: 'approve', label: '是否同意', type: 'boolean', sample: true,
        desc: 'true=同意，false=拒绝',
      },
      {
        key: 'remark', label: '添加后的备注', type: 'string', sample: '小张',
        only: ['napcat'], desc: '同意时顺带设置的备注。仅 NapCat 声明了该参数',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_friend_add_request' } } },
      snowluma: { variants: { '*': { action: 'set_friend_add_request' } } },
    },
    examples: {
      request: { flag: '1678addf-8f2a-4c31', approve: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '处理好友请求失败: flag 已失效', wording: '处理好友请求失败', echo: null,
      },
    },
  },

  {
    name: 'get_doubt_friend_request',
    title: '获取可疑好友申请',
    summary: '获取系统判定为可疑的加好友申请列表，用于人工复核或批量放行。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_doubt_friends_add_request'],
    params: [
      { key: 'count', label: '获取数量', type: 'number', sample: 50, desc: 'NapCat 侧为必填（默认 50）' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_doubt_friends_add_request',
            notes: '返回结构未文档化，data 以协议端实际返回为准',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_doubt_friends_add_request',
            notes: 'SnowLuma 文档：数组每项含 uid（作为处理用 flag）、昵称、来源、留言与申请时间；'
              + '除 uid 外字段名未文档化，故 data 不构造具体字段',
          },
        },
      },
    },
    examples: {
      request: { count: 50 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取可疑好友申请失败', wording: '获取可疑好友申请失败', echo: null,
      },
    },
  },

  {
    name: 'handle_doubt_friend_request',
    title: '处理可疑好友申请',
    summary: '同意或拒绝一条系统标记的可疑加好友申请。flag 取自 get_doubt_friend_request 返回的 uid。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_doubt_friends_add_request'],
    params: [
      {
        key: 'flag', label: '请求 flag', type: 'string', required: true, sample: '10001',
        desc: '可疑好友申请的标识，取自 get_doubt_friend_request 返回项的 uid',
      },
      {
        key: 'approve', label: '是否同意', type: 'boolean', sample: true,
        desc: 'NapCat 端该值被强制为 true（只支持放行，不支持拒绝）',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_doubt_friends_add_request',
            notes: 'NapCat 的 approve 参数描述为「是否同意 (强制为 true)」，传 false 无效',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'set_doubt_friends_add_request' } } },
    },
    examples: {
      request: { flag: '10001', approve: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '处理可疑好友申请失败', wording: '处理可疑好友申请失败', echo: null,
      },
    },
  },

  {
    name: 'get_stranger_info',
    title: '获取陌生人信息',
    summary: '获取指定非好友用户（陌生人）的资料。查自己的资料用 get_login_info。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_stranger_info'],
    params: [
      {
        key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001,
      },
      {
        key: 'no_cache', label: '不使用缓存', type: 'boolean', sample: false,
        only: ['napcat'], desc: 'NapCat 侧为必填参数（默认 false）',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_stranger_info', notes: '返回结构未文档化，data 以协议端实际返回为准' },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_stranger_info',
            notes: 'SnowLuma 文档：含账号标识、等级别名与可用的注册时间、会员信息；'
              + '未返回的字段会省略，字段名未逐一文档化，故 data 不构造具体字段',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取陌生人信息失败: 用户不存在', wording: '获取陌生人信息失败', echo: null,
      },
    },
  },

  {
    name: 'send_poke',
    title: '拍一拍（戳一戳）',
    summary: '对好友或群成员发一次「拍一拍」。按 scene 派发：私聊走专用好友拍接口，群聊走通用拍一拍接口。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_poke', 'friend_poke'],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'private',
        desc: 'private=对好友拍一拍 / group=对群成员拍一拍',
      },
      {
        key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001, desc: '被拍一拍的人',
      },
      {
        key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456,
        desc: 'scene=group 时必填，协议端据此路由到群内拍一拍',
      },
      {
        key: 'target_id', label: '被拍目标', type: 'number', idSpace: 'qq_number',
        desc: '仅 SnowLuma 的 friend_poke 声明了该字段，语义未文档化；留空时等价于 user_id',
      },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          private: { action: 'friend_poke' },
          group: { action: 'send_poke', notes: '传 group_id，由协议端自动路由到群内拍一拍' },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          private: { action: 'friend_poke' },
          group: { action: 'send_poke', notes: '传 group_id，由协议端自动路由到群内拍一拍' },
        },
      },
    },
    examples: {
      request: { scene: 'private', user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '拍一拍失败: 对方不是好友', wording: '拍一拍失败', echo: null,
      },
    },
  },

  {
    name: 'set_friend_remark',
    title: '设置好友备注',
    summary: '给指定好友设置备注名。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_friend_remark'],
    params: [
      {
        key: 'user_id', label: '好友 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001,
      },
      { key: 'remark', label: '备注内容', type: 'string', required: true, sample: '小张' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_friend_remark' } } },
      snowluma: { variants: { '*': { action: 'set_friend_remark' } } },
    },
    examples: {
      request: { user_id: 10001, remark: '小张' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置备注失败: 对方不是好友', wording: '设置备注失败', echo: null,
      },
    },
  },

  {
    name: 'set_friends_category',
    title: '移动好友到分组',
    summary: '把指定好友移动到某个好友分组。仅 SnowLuma 提供，NapCat 无对应动作。',
    category: 'friend',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_friends_category'],
    params: [
      {
        key: 'user_id', label: '好友 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001, desc: '协议端字段名为 uin',
      },
      {
        key: 'category_id', label: '目标分组 ID', type: 'number', sample: 1,
        desc: '协议端字段名为 categoryId',
      },
      {
        key: 'category_name', label: '目标分组名称', type: 'string', sample: '同学',
        desc: '协议端字段名为 categoryName，必须唯一且与现有分组完全匹配',
      },
    ],
    impl: {
      // NapCat 的 action 集合里没有 set_friends_category，因此 impl 里不出现 napcat 块，
      // support 也不列 —— NapCat 连接下会自动降级为 unsupported 失败信封。
      snowluma: {
        variants: {
          '*': {
            action: 'set_friends_category',
            map: { user_id: 'uin', category_id: 'categoryId', category_name: 'categoryName' },
            notes: '分组 ID 与分组名给其一即可；两者都给时以协议端校验为准',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001, category_name: '同学' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '移动好友分组失败: 分组不存在', wording: '移动好友分组失败', echo: null,
      },
    },
  },

  {
    name: 'get_user_status',
    title: '获取用户在线状态',
    summary: '查询指定 QQ 号的在线状态码与扩展状态码。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['nc_get_user_status'],
    params: [
      {
        key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number',
        required: true, sample: 10001,
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'nc_get_user_status',
            notes: 'NapCat 侧返回结构未文档化，字段名以协议端实际返回为准',
          },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'nc_get_user_status', notes: 'SnowLuma 文档：data 为 { status, ext_status }' },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: {
        status: 'ok', retcode: 0, data: { status: 10, ext_status: 0 }, message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取用户状态失败', wording: '获取用户状态失败', echo: null,
      },
    },
  },



  {
    name: 'create_dms',
    title: '创建私信会话',
    summary: '官方侧主动与用户建立单聊（私信）会话，返回可用于发消息的频道 ID。'
      + '这是官方机器人唯一能「主动发起私聊」的入口；野生协议下发消息即自动建立会话，不需要这一步。',
    category: 'friend',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/users/@me/dms'],
    params: [
      {
        key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid',
        required: true, sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D',
        desc: '要发起私信的用户的 openid（不是 QQ 号，两者不可互转）。协议端字段名为 recipient_id',
      },
      {
        key: 'guild_id', label: '来源频道 ID', type: 'string', idSpace: 'guild_id', sample: '1013531',
        desc: '用户在哪个频道里与机器人产生关联，用于建立私信。协议端字段名为 source_guild_id',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/users/@me/dms',
            map: { openid: 'recipient_id', guild_id: 'source_guild_id' },
            notes: '官方请求体字段为 recipient_id / source_guild_id，由代理层从统一键映射过去',
          },
        },
      },
    },
    examples: {
      request: { openid: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D', guild_id: '1013531' },
      success: { guild_id: '1013531' },
      error: { code: 11252, message: '用户不在该频道内，无法创建私信会话' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/dms/post_dms.html',
  },
];
