import type { ProxyApiEntry } from '../../proxy.types.js';

/**
 * 群成员：踢人、改名片、设管理员、专属头衔、成员列表与信息、入群请求处理。
 *
 * 本分类下的能力**野生协议独享**：QQ 官方 v2 只有一条与「群成员列表」相关的
 * `POST /v2/groups/{group_openid}/members`，且文档整段被注释掉（内邀开放未放开），
 * 因此除 `get_group_member_list` 外一律 `support: ['napcat','snowluma']`、
 * `scope: 'wild-only'` —— 官方连接调用它们会拿到 `unsupported` 失败信封，这是正确行为。
 *
 * 每条 entry 只有单一变体（`'*'`），因为各协议下都只有一个落点：野生只有「QQ 群」这一种
 * 实体，不存在像 `send_text` 那样要按 scene 派发的情况。ID 空间的分裂（group_id vs
 * group_openid）靠 `only` 限定参数解决，不需要 variantBy。
 *
 * 详见同目录 `_CONVENTIONS.md`。
 */
export const memberEntries: ProxyApiEntry[] = [
  {
    name: 'get_group_member_list',
    title: '获取群成员列表',
    summary: '拉取一个群的全部成员信息。官方侧的对应接口文档标注「内邀开放」且整段被注释，当前不可用。',
    category: 'member',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_member_list', 'get_member_list', '/v2/groups/{group_openid}/members'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, only: ['napcat', 'snowluma'], sample: 123456 },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', required: true, only: ['official'], sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', desc: '官方连接时必填，取自群消息事件的 group_openid' },
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', only: ['napcat', 'snowluma'], sample: false, desc: '为 true 时强制向服务端拉取，忽略本地缓存。大群全量拉取很慢，慎用' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_member_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_member_list' } } },
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/v2/groups/{group_openid}/members',
            stub: true,
            notes: '官方文档 server-inter/group/manage 中该接口整段被注释掉，标注「内邀开放」，'
              + '未对普通机器人放开。源快照 disabledEntries 里明确列了这一条。'
              + '官方连接调用会由代理层合成为 stub 失败信封，不会真的发出请求。',
          },
        },
        stub: true,
        requires: '「获取群内成员列表」接口内邀开放，未放开前调用必然失败',
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群成员列表失败: 机器人不在该群内', wording: '获取群成员列表失败', echo: null,
      },
      byProtocol: {
        official: {
          request: { group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
          success: null,
          error: null,
        },
      },
    },
  },

  {
    name: 'get_group_member_info',
    title: '获取群成员信息',
    summary: '按 QQ 号查询单个群成员的资料（名片、角色、头衔、禁言到期时间等）。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_member_info'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'no_cache', label: '不使用缓存', type: 'boolean', sample: false, desc: '为 true 时强制向服务端拉取' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_member_info' } } },
      snowluma: { variants: { '*': { action: 'get_group_member_info' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群成员信息失败: 该用户不在群内', wording: '获取群成员信息失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_kick',
    title: '踢出群成员',
    summary: '把一个成员踢出群聊。不可逆操作，机器人需要是管理员且目标不是群主。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['set_group_kick'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      {
        key: 'reject_add_request', label: '拒绝再次加群', type: 'boolean', sample: false,
        desc: '为 true 时同时把该用户的加群请求一并拒绝，使其短期内无法再次申请',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_kick' } } },
      snowluma: { variants: { '*': { action: 'set_group_kick' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001, reject_add_request: false },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '踢人失败: 机器人权限不足', wording: '踢人失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_kick_members',
    title: '批量踢出群成员',
    summary: '一次性把多个成员踢出群聊。批量失败时的部分成功语义未在源快照中文档化。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['set_group_kick_members'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号列表', type: 'array', idSpace: 'qq_number', required: true, sample: [10001, 10002], desc: 'QQ 号数组' },
      { key: 'reject_add_request', label: '拒绝再次加群', type: 'boolean', sample: false, desc: '为 true 时同时拒绝这些用户的加群请求' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_kick_members' } } },
      snowluma: { variants: { '*': { action: 'set_group_kick_members' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: [10001, 10002] },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '批量踢人失败: 机器人权限不足', wording: '批量踢人失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_admin',
    title: '设置群管理员',
    summary: '任命或撤免群管理员。仅群主可用，属于不可逆的权限变更操作。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['set_group_admin'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'enable', label: '设为管理员', type: 'boolean', sample: true, desc: 'true 任命为管理员 / false 撤免管理员' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_admin' } } },
      snowluma: { variants: { '*': { action: 'set_group_admin' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001, enable: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置管理员失败: 机器人不是群主', wording: '设置管理员失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_card',
    title: '设置群名片',
    summary: '修改某个成员的群名片（群备注名）。传空字符串表示清除名片。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_card'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'card', label: '群名片', type: 'string', sample: '新的群名片', desc: '传空字符串清除该成员的名片（SnowLuma 明确支持，NapCat 同源）' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_card' } } },
      snowluma: { variants: { '*': { action: 'set_group_card' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001, card: '新的群名片' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群名片失败: 机器人权限不足', wording: '设置群名片失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_special_title',
    title: '设置专属头衔',
    summary: '给某个成员设置群专属头衔。仅群主可用，传空字符串表示清除头衔。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_special_title'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '成员 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'special_title', label: '专属头衔', type: 'string', required: true, sample: '头衔', desc: '传空字符串清除头衔' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_special_title' } } },
      snowluma: { variants: { '*': { action: 'set_group_special_title' } } },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001, special_title: '头衔' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置专属头衔失败: 机器人不是群主', wording: '设置专属头衔失败', echo: null,
      },
    },
  },

  {
    name: 'handle_group_add_request',
    title: '处理加群请求',
    summary: '同意或拒绝一条入群申请 / 邀请。flag 取自加群请求事件或群系统消息，无法通过 QQ 号现算。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_add_request'],
    params: [
      {
        key: 'flag', label: '请求 flag', type: 'string', required: true, sample: 'group_add_request_flag',
        desc: '请求的唯一标识，来自加群请求事件的 flag 字段；QQ 号与 openid 都换不出这个值',
      },
      { key: 'approve', label: '是否同意', type: 'boolean', sample: true, desc: 'true 同意 / false 拒绝' },
      { key: 'reason', label: '拒绝理由', type: 'string', sample: '不符合入群条件', desc: '仅 approve=false 时有意义；部分协议端拒绝时必须非空' },
      { key: 'sub_type', label: '请求子类型', type: 'string', only: ['snowluma'], desc: 'SnowLuma 侧的原生字段（如 add / invite）；源快照未给出枚举值，原样透传' },
      { key: 'type', label: '请求类型', type: 'string', only: ['snowluma'], desc: 'SnowLuma 侧的原生字段；源快照未给出枚举值，原样透传' },
      { key: 'count', label: '搜索通知数量', type: 'number', only: ['napcat'], sample: 100, desc: 'NapCat 在通知流里回溯查找该 flag 的条数' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_add_request' } } },
      snowluma: { variants: { '*': { action: 'set_group_add_request' } } },
    },
    examples: {
      request: { flag: 'group_add_request_flag', approve: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '处理加群请求失败: flag 已失效或已被处理', wording: '处理加群请求失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_ignore_add_request',
    title: '获取被忽略的加群请求',
    summary: '拉取被机器人忽略（未处理且已过期/折叠）的入群申请列表。无需参数。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_ignore_add_request'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_ignore_add_request' } } },
      snowluma: { variants: { '*': { action: 'get_group_ignore_add_request' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取被忽略的加群请求失败', wording: '获取被忽略的加群请求失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_ignored_notifies',
    title: '获取被过滤的入群请求',
    summary: '拉取被过滤掉的入群申请与邀请通知，每项含群号、申请人、邀请人、留言与处理标记。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_ignored_notifies'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_ignored_notifies' } } },
      snowluma: { variants: { '*': { action: 'get_group_ignored_notifies' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取被过滤的入群请求失败', wording: '获取被过滤的入群请求失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_mute_list',
    title: '获取群禁言列表',
    summary: '拉取当前仍在禁言中的群成员，每项含 QQ 号、昵称与禁言到期时间戳（秒）。',
    category: 'member',
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
        message: '获取群禁言列表失败: 机器人不在该群内', wording: '获取群禁言列表失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_member_permissions',
    title: '设置群成员功能权限',
    summary: '开关群成员上传群相册、发起临时会话、发起新群聊三项权限。未传入的项保持不变。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_member_permissions'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'allow_member_upload_album', label: '允许上传群相册', type: 'boolean', sample: false, desc: '不传则保持原值' },
      { key: 'allow_member_temporary_session', label: '允许发起临时会话', type: 'boolean', sample: false, desc: '不传则保持原值' },
      { key: 'allow_member_create_group', label: '允许发起新群聊', type: 'boolean', sample: false, desc: '不传则保持原值' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_member_permissions' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'set_group_member_permissions',
            notes: 'SnowLuma 文档标注「仅群主可改」',
          },
        },
      },
    },
    examples: {
      request: { group_id: 123456, allow_member_upload_album: false },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置群成员权限失败: 机器人不是群主', wording: '设置群成员权限失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_member_invite_policy',
    title: '设置群成员邀请策略',
    summary: '设置是否允许群成员邀请好友进群、以及邀请是否需要管理员审核。',
    category: 'member',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_group_member_invite_policy'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'policy', label: '邀请策略', type: 'string', required: true, sample: 'disable_invite',
        desc: '策略标识。NapCat 侧是 MemberInvitePolicySchema、SnowLuma 侧标注为 enum，'
          + '两份源快照都没给出取值表，因此统一层按字符串原样透传，不做枚举校验',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_group_member_invite_policy',
            notes: 'NapCat 侧 policy 走 MemberInvitePolicySchema，源快照未展开取值',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'set_group_member_invite_policy' } } },
    },
    examples: {
      request: { group_id: 123456, policy: 'disable_invite' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置邀请策略失败: 机器人权限不足', wording: '设置邀请策略失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_anonymous',
    title: '群匿名聊天开关',
    summary: '开关群匿名聊天。仅 SnowLuma 暴露该 action，且协议端明确标注「未实现，返回 ok」。',
    category: 'member',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stub',
    alias: ['set_group_anonymous'],
    // SnowLuma 的 OpenAPI 对这两个 action 声明的 requestBody.properties 是空的，
    // 不臆造参数；调用方如需带原生字段，请走 call_native。
    params: [],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'set_group_anonymous',
            stub: true,
            notes: 'SnowLuma OpenAPI 摘要原文：「匿名开关（未实现，返回 ok）」——调用会返回成功信封，'
              + '但不产生任何实际效果。NapCat 的 action 集合里没有同名动作，故 support 不列 napcat。',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置匿名开关失败', wording: '设置匿名开关失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_anonymous_ban',
    title: '禁言匿名用户',
    summary: '禁言群内匿名成员。仅 SnowLuma 暴露该 action，且协议端明确标注「未实现，返回 ok」。',
    category: 'member',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stub',
    alias: ['set_group_anonymous_ban'],
    params: [],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'set_group_anonymous_ban',
            stub: true,
            notes: 'SnowLuma OpenAPI 摘要原文：「匿名禁言（未实现，返回 ok）」——调用会返回成功信封，'
              + '但不产生任何实际效果。NapCat 的 action 集合里没有同名动作，故 support 不列 napcat。',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '匿名禁言失败', wording: '匿名禁言失败', echo: null,
      },
    },
  },
];
