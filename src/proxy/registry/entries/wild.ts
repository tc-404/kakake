/**
 * 野生机器人专属接口。
 *
 * 只有 NapCat / SnowLuma 有、QQ 官方完全没有的能力（点赞、戳一戳、表情收藏、
 * QQ 空间、底层发包等）归到这里，scope 一律 'wild-only'，support 只写野生两家。
 *
 * 注意：**两家野生的 action 集合并不相同**（180 vs 200）。
 * 如果某个 action 只有 SnowLuma 有、NapCat 没有（例如 qzone 系列、系统表情系列），
 * support 就只写 ['snowluma']，不要为了「对齐」给 NapCat 编一个变体。
 * 反之为 NapCat 独有的同理。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const wildEntries: ProxyApiEntry[] = [
  {
    name: 'send_like',
    title: '点赞',
    summary: '给好友或群成员点赞。野生专属能力，官方机器人无此接口。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_like'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'times', label: '点赞次数', type: 'number', sample: 10, desc: '默认 1，单次上限 20' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'send_like' } } },
      snowluma: { variants: { '*': { action: 'send_like' } } },
    },
    examples: {
      request: { user_id: 10001, times: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null, message: '今日点赞次数已达上限', wording: '点赞失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── QQ 空间 ─────────────────────────── */

  {
    name: 'send_qzone_msg',
    title: '发表 QQ 空间说说',
    summary: '在 QQ 空间发一条说说，支持纯文字或带图，可设置查看权限。野生专属能力，官方机器人无此接口。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_qzone_msg'],
    params: [
      { key: 'content', label: '说说正文', type: 'string', required: true, sample: '今天天气不错' },
      {
        key: 'images', label: '图片', type: 'array', sample: ['file://C:/tmp/a.jpg'],
        desc: '图片数组，支持 file:// / http(s):// / base64://，协议端会自动上传',
      },
      {
        key: 'ugc_right', label: '查看权限', type: 'number', sample: 1,
        desc: '1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见',
      },
      {
        key: 'target_uins', label: '权限作用 QQ 号', type: 'array', sample: [10001],
        desc: 'ugc_right=16 时为可见名单，128 时为不可见名单',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_qzone_msg', notes: '返回结构未文档化，data 以协议端实际返回为准' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_qzone_msg', notes: '返回结构未文档化，data 以协议端实际返回为准' },
        },
      },
    },
    examples: {
      request: { content: '今天天气不错', images: ['file://C:/tmp/a.jpg'] },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发表说说失败: 空间被限制', wording: '发表说说失败', echo: null,
      },
    },
  },

  {
    name: 'delete_qzone_msg',
    title: '删除 QQ 空间说说',
    summary: '按 tid 删除自己空间里的一条说说。tid 来自发表说说的返回或说说列表。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_qzone_msg'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'delete_qzone_msg', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'delete_qzone_msg', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除说说失败: tid 不存在', wording: '删除说说失败', echo: null,
      },
    },
  },

  {
    name: 'get_qzone_msg_list',
    title: '获取 QQ 空间说说列表',
    summary: '分页拉取某人 QQ 空间的说说列表，默认取机器人自己的空间。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_qzone_msg_list'],
    params: [
      {
        key: 'target_uin', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number',
        sample: 10001, desc: '省略则取机器人自己的空间',
      },
      { key: 'pos', label: '起始偏移', type: 'number', sample: 0 },
      { key: 'num', label: '本页数量', type: 'number', sample: 10 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'get_qzone_msg_list',
            notes: '返回「说说总数 + 本页说说数组」对象，字段名未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: { target_uin: 10001, pos: 0, num: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取说说列表失败: 没有访问权限', wording: '获取说说列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_qzone_msg_detail',
    title: '获取 QQ 空间说说详情',
    summary: '按 tid 拉取一条说说的详情与一页评论（含服务端内联的二级回复）。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_qzone_msg_detail'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
      {
        key: 'target_uin', label: '说说所属 QQ 号', type: 'number', idSpace: 'qq_number',
        sample: 10001, desc: '省略则取机器人自己的空间',
      },
      { key: 'pos', label: '一级评论起始偏移', type: 'number', sample: 0 },
      { key: 'num', label: '请求的一级评论数量', type: 'number', sample: 10, desc: '实际返回数量受服务端限制' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'get_qzone_msg_detail',
            notes: '返回「说说详情 + 评论总数 + 本页评论」，字段名未文档化；replies 仅含服务端内联的二级回复，不保证完整',
          },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70', pos: 0, num: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取说说详情失败: 需要访问权限', wording: '获取说说详情失败', echo: null,
      },
    },
  },

  {
    name: 'get_qzone_feeds',
    title: '获取 QQ 空间好友动态',
    summary: '拉取 QQ 空间好友动态（feed）。仅 SnowLuma 提供；深翻页需时间游标，当前未实现。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_qzone_feeds'],
    params: [
      { key: 'page_num', label: '页码', type: 'number', sample: 1, desc: '从 1 起；仅首页可靠' },
      { key: 'count', label: '本页数量', type: 'number', sample: 10 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'get_qzone_feeds',
            notes: '返回「本页 feed 数组 + 是否有更多页」对象，字段名未文档化；page_num 仅首页可靠',
          },
        },
      },
    },
    examples: {
      request: { page_num: 1, count: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取好友动态失败', wording: '获取好友动态失败', echo: null,
      },
    },
  },

  {
    name: 'send_qzone_like',
    title: '给说说点赞',
    summary: '给 QQ 空间的一条说说点赞。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['like_qzone', 'send_qzone_like'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
      {
        key: 'target_uin', label: '说说所属 QQ 号', type: 'number', idSpace: 'qq_number',
        sample: 10001, desc: '省略则为机器人自己',
      },
      { key: 'abstime', label: '说说发表时间', type: 'number', sample: 1728134400, desc: 'unix 秒；传真实值更可靠' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'like_qzone', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70', target_uin: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '点赞失败: 该说说不存在', wording: '点赞失败', echo: null,
      },
    },
  },

  {
    name: 'delete_qzone_like',
    title: '取消说说点赞',
    summary: '取消对 QQ 空间一条说说的点赞。仅 SnowLuma 提供；取消赞端点待真机核实。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['unlike_qzone', 'delete_qzone_like'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
      {
        key: 'target_uin', label: '说说所属 QQ 号', type: 'number', idSpace: 'qq_number',
        sample: 10001, desc: '省略则为机器人自己',
      },
      { key: 'abstime', label: '说说发表时间', type: 'number', sample: 1728134400, desc: 'unix 秒；传真实值更可靠' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'unlike_qzone',
            notes: 'SnowLuma 文档标注「取消赞端点待真机核实」，可能返回失败信封；返回结构未文档化',
          },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70', target_uin: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '取消赞失败', wording: '取消赞失败', echo: null,
      },
    },
  },

  {
    name: 'send_qzone_comment',
    title: '评论说说',
    summary: '给 QQ 空间的一条说说发评论，支持纯文字或带图（传 images 自动上传）。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['comment_qzone', 'send_qzone_comment'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
      { key: 'content', label: '评论内容', type: 'string', required: true, sample: '说得好' },
      {
        key: 'target_uin', label: '说说所属 QQ 号', type: 'number', idSpace: 'qq_number',
        sample: 10001, desc: '省略则为机器人自己',
      },
      {
        key: 'images', label: '图片', type: 'array', sample: ['file://C:/tmp/a.jpg'],
        desc: '支持 file:// / http:// / base64://，协议端自动上传',
      },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'comment_qzone', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70', content: '说得好' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '评论失败: 对方已关闭评论', wording: '评论失败', echo: null,
      },
    },
  },

  {
    name: 'set_qzone_ban',
    title: '设置 QQ 空间黑名单',
    summary: '把某人加入或移出机器人自身 QQ 空间的黑名单。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_qzone_ban'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'enable', label: '是否拉黑', type: 'boolean', required: true, sample: true, desc: 'true=拉黑，false=解除拉黑' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'set_qzone_ban', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, enable: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置黑名单失败', wording: '设置黑名单失败', echo: null,
      },
    },
  },

  {
    name: 'set_qzone_msg_right',
    title: '设置说说查看权限',
    summary: '按 tid 修改一条已发说说的查看权限。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_qzone_msg_right'],
    params: [
      { key: 'tid', label: '说说 tid', type: 'string', required: true, sample: 'tid_6f1a2b3c4d5e6f70' },
      {
        key: 'ugc_right', label: '查看权限', type: 'number', required: true, sample: 1,
        desc: '1=所有人可见，4=好友可见，16=部分好友可见，64=仅自己可见，128=部分好友不可见',
      },
      {
        key: 'target_uins', label: '权限作用 QQ 号', type: 'array', sample: [10001],
        desc: 'ugc_right=16 时为可见名单，128 时为不可见名单',
      },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'set_qzone_msg_right',
            notes: '返回「更新后的权限对象」，字段名未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: { tid: 'tid_6f1a2b3c4d5e6f70', ugc_right: 64 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '修改权限失败: 说说不存在', wording: '修改权限失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 系统表情 ─────────────────────────── */

  {
    name: 'get_sys_faces',
    title: '获取 QQ 系统表情目录',
    summary: '拉取按分组组织的 QQ 系统表情目录（编号与含义映射）。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_sys_faces', 'get_sys_faces'],
    params: [
      { key: 'refresh', label: '强制刷新', type: 'boolean', sample: false, desc: '为 true 时跳过缓存、强制从 QQ 刷新目录' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_sys_faces',
            notes: '返回「按分组的表情映射」对象，分组与字段名未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取系统表情目录失败', wording: '获取系统表情目录失败', echo: null,
      },
    },
  },

  {
    name: 'search_sys_faces',
    title: '搜索 QQ 系统表情',
    summary: '按编号、名称、别名或分组名搜索 QQ 系统表情。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['search_sys_faces'],
    params: [
      { key: 'query', label: '搜索词', type: 'string', required: true, sample: '微笑', desc: '编号、名称、别名或分组名' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'search_sys_faces',
            notes: '返回匹配的表情列表对象，字段名未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: { query: '微笑' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '搜索系统表情失败', wording: '搜索系统表情失败', echo: null,
      },
    },
  },

  {
    name: 'get_sys_face',
    title: '查询系统表情详情',
    summary: '按编号查询一个 QQ 系统表情的详情；编号不存在时返回 null。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_face_entity', 'get_sys_face'],
    params: [
      { key: 'face_id', label: '表情编号', type: 'number', required: true, sample: 14 },
      { key: 'refresh', label: '强制刷新', type: 'boolean', sample: false, desc: '为 true 时跳过缓存、强制从 QQ 刷新目录' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_face_entity',
            notes: '返回表情详情对象；编号不存在时 data 为 null。字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { face_id: 14 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '查询系统表情失败', wording: '查询系统表情失败', echo: null,
      },
    },
  },

  {
    name: 'get_super_face_id',
    title: '查询超级表情格式',
    summary: '判断某个 QQ 系统表情是否使用超级表情格式。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_super_face_id', 'get_super_face_id'],
    params: [
      { key: 'face_id', label: '表情编号', type: 'number', required: true, sample: 14 },
      { key: 'refresh', label: '强制刷新', type: 'boolean', sample: false, desc: '为 true 时跳过缓存、强制从 QQ 刷新目录' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_super_face_id',
            notes: '返回「是否使用超级表情格式」的对象，字段名未文档化，data 以协议端实际返回为准',
          },
        },
      },
    },
    examples: {
      request: { face_id: 14 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '查询超级表情失败', wording: '查询超级表情失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 底层发包 ─────────────────────────── */

  {
    name: 'send_packet',
    title: '发送原始数据包',
    summary: '向 QQ 服务端发送原始 SSO 包（命令字 + 十六进制数据）。逃生级底层能力，参数错误可能导致掉线，慎用。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'experimental',
    alias: ['send_packet'],
    params: [
      { key: 'cmd', label: '命令字', type: 'string', required: true, sample: 'OidbSvc.0x88d_0' },
      { key: 'data', label: '包体数据', type: 'string', required: true, sample: '0801', desc: '十六进制字符串' },
      { key: 'rsp', label: '是否等待响应', type: 'boolean', sample: true, desc: '为 true 时同步等待服务端回包' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_packet', notes: '返回结构未文档化（取决于具体命令字的回包）' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_packet', notes: '返回结构未文档化（取决于具体命令字的回包）' },
        },
      },
    },
    examples: {
      request: { cmd: 'OidbSvc.0x88d_0', data: '0801', rsp: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发包失败: 命令字不受支持', wording: '发包失败', echo: null,
      },
    },
  },


  /* ─────────────────────────── 流式传输 ─────────────────────────── */

  {
    name: 'upload_file_stream',
    title: '流式上传文件',
    summary: '以分块方式把文件流式上传到机器人本地，完成后返回可用于发送的本地路径。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['upload_file_stream'],
    params: [
      { key: 'stream_id', label: '流 ID', type: 'string', required: true, sample: 'b3f1-9c2a-4d5e', desc: '客户端生成的 UUID，SnowLuma 限定 [A-Za-z0-9_-]' },
      { key: 'chunk_data', label: '分块数据', type: 'string', sample: 'aGVsbG8=', desc: 'Base64 编码的分块内容' },
      { key: 'chunk_index', label: '分块索引', type: 'number', sample: 0, desc: '从 0 开始' },
      { key: 'total_chunks', label: '总分块数', type: 'number', sample: 4, desc: '新流必填' },
      { key: 'file_size', label: '文件总大小', type: 'number', sample: 1048576, desc: '单位字节' },
      { key: 'expected_sha256', label: '期望 SHA256', type: 'string', desc: '整文件校验值，协议端会比对' },
      { key: 'is_complete', label: '是否为最后一块', type: 'boolean', sample: false, desc: '为 true 时触发合并' },
      { key: 'filename', label: '文件名', type: 'string', sample: 'pic.jpg' },
      { key: 'reset', label: '重置该流', type: 'boolean', sample: false, desc: '为 true 时丢弃已收到的分块' },
      { key: 'verify_only', label: '仅查询状态', type: 'boolean', sample: false, desc: '为 true 时只返回当前流状态，不写数据' },
      {
        key: 'file_retention', label: '文件保留时长', type: 'number', sample: 300000,
        desc: '合并后文件的保留毫秒数；0 表示不回收。NapCat 默认 300000（5 分钟）',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'upload_file_stream',
            notes: '流式接口：返回分块确认帧，最终帧含 file_path / file_name / file_size / sha256，整体结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'upload_file_stream',
            notes: '流式接口：分块确认帧 type=stream，完成帧 type=response（含 file_path / file_name / file_size / sha256）',
          },
        },
      },
    },
    examples: {
      request: { stream_id: 'b3f1-9c2a-4d5e', chunk_data: 'aGVsbG8=', chunk_index: 0, total_chunks: 4, filename: 'pic.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传分块失败: SHA256 校验不一致', wording: '上传分块失败', echo: null,
      },
    },
  },

  {
    name: 'download_file_stream',
    title: '流式下载文件',
    summary: '以分块方式从本地 stream 目录、URL 或缓存媒体流式下载文件。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['download_file_stream'],
    params: [
      { key: 'file', label: '文件路径或 URL', type: 'string', sample: 'https://example.com/a.zip', desc: 'SnowLuma 限定为 stream 临时目录内的文件或 http(s) URL' },
      { key: 'file_id', label: '文件 ID', type: 'string', sample: 'cache_img_001', desc: '缓存的图片 / 语音 ID' },
      { key: 'chunk_size', label: '分块大小', type: 'number', sample: 65536, desc: '单位字节，默认 64KB' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'download_file_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'download_file_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列' },
        },
      },
    },
    examples: {
      request: { file: 'https://example.com/a.zip', chunk_size: 65536 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '流式下载失败: 文件不存在', wording: '流式下载失败', echo: null,
      },
    },
  },

  {
    name: 'download_image_stream',
    title: '流式下载图片',
    summary: '以分块方式流式下载图片（缓存图片 ID / URL / stream 目录本地文件）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['download_file_image_stream', 'download_image_stream'],
    params: [
      { key: 'file', label: '文件路径或 URL', type: 'string', sample: 'https://example.com/pic.jpg' },
      { key: 'file_id', label: '文件 ID', type: 'string', sample: 'cache_img_001' },
      { key: 'chunk_size', label: '分块大小', type: 'number', sample: 65536, desc: '单位字节，默认 64KB' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'download_file_image_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'download_file_image_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列' },
        },
      },
    },
    examples: {
      request: { file: 'https://example.com/pic.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '流式下载图片失败', wording: '流式下载图片失败', echo: null,
      },
    },
  },

  {
    name: 'download_record_stream',
    title: '流式下载语音',
    summary: '以分块方式流式下载语音（缓存语音 ID / URL / stream 目录本地文件），可指定输出格式。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['download_file_record_stream', 'download_record_stream'],
    params: [
      { key: 'file', label: '文件路径或 URL', type: 'string', sample: 'https://example.com/a.amr' },
      { key: 'file_id', label: '文件 ID', type: 'string', sample: 'cache_ptt_001' },
      { key: 'chunk_size', label: '分块大小', type: 'number', sample: 65536, desc: '单位字节，默认 64KB' },
      { key: 'out_format', label: '输出格式', type: 'string', sample: 'mp3', desc: '仅 NapCat 支持；不传则原样输出' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'download_file_record_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'download_file_record_stream', notes: '流式接口：返回 file_info → file_chunk* → file_complete 帧序列；SnowLuma 未提供 out_format' },
        },
      },
    },
    examples: {
      request: { file_id: 'cache_ptt_001', out_format: 'mp3' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '流式下载语音失败', wording: '流式下载语音失败', echo: null,
      },
    },
  },


  {
    name: 'test_download_stream',
    title: '测试下载流',
    summary: '推送 10 个数据帧用于验证流式传输链路是否正常，不触达 QQ 服务端。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['test_download_stream'],
    params: [
      { key: 'error', label: '触发测试错误', type: 'boolean', sample: false, desc: '为 true 时以 error 帧结束，用于验证错误分支' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'test_download_stream', notes: '返回 data_chunk*10 → data_complete 帧序列' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'test_download_stream', notes: '返回 data_chunk*10 → data_complete 帧序列；error=true 时以 error 帧结束' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '流式测试失败', wording: '流式测试失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 闪传 / 文件集 ─────────────────────────── */

  {
    name: 'create_flash_task',
    title: '创建闪传任务',
    summary: '把一批本地文件打包成 QQ 闪传文件集，返回可用于发送 / 下载的文件集 ID。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['create_flash_task'],
    params: [
      {
        key: 'files', label: '文件列表', type: 'array', required: true, sample: ['C:/tmp/a.zip'],
        desc: '本地路径数组；也接受单个路径字符串，或 { file, name } 形式的数组（SnowLuma）',
      },
      { key: 'name', label: '任务名称', type: 'string', sample: '本周素材' },
      { key: 'thumb_path', label: '缩略图路径', type: 'string', sample: 'C:/tmp/thumb.jpg' },
      {
        key: 'validity_seconds', label: '有效期（秒）', type: 'number', only: ['napcat'], sample: 1209600,
        desc: '可选 1209600(14天) / 7776000(90天) / 15552000(180天)，默认 1209600。仅 NapCat 支持',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'create_flash_task', map: { validity_seconds: 'validitySeconds' }, notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'create_flash_task', notes: '返回结构未文档化；不支持 validity_seconds，有效期由服务端决定' },
        },
      },
    },
    examples: {
      request: { files: ['C:/tmp/a.zip'], name: '本周素材' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '创建闪传任务失败: 文件不存在', wording: '创建闪传任务失败', echo: null,
      },
    },
  },

  {
    name: 'get_flash_file_list',
    title: '获取闪传文件列表',
    summary: '列出某个闪传文件集里的文件。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_flash_file_list'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_flash_file_list', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_flash_file_list', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取闪传文件列表失败: 文件集不存在', wording: '获取闪传文件列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_flash_file_url',
    title: '获取闪传文件链接',
    summary: '取闪传文件集里某个文件的下载链接，可按文件名或索引定位。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_flash_file_url'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
      { key: 'file_name', label: '文件名', type: 'string', sample: 'a.zip', desc: '与 file_index 二选一' },
      { key: 'file_index', label: '文件索引', type: 'number', sample: 0, desc: '与 file_name 二选一' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_flash_file_url', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_flash_file_url', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c', file_name: 'a.zip' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取闪传文件链接失败', wording: '获取闪传文件链接失败', echo: null,
      },
    },
  },

  {
    name: 'download_fileset',
    title: '解析闪传下载直链',
    summary: '把闪传文件集解析成下载直链（只解析不下载，下载由调用方自行实现）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['download_fileset'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
      { key: 'file_name', label: '文件名', type: 'string', only: ['snowluma'], sample: 'a.zip' },
      { key: 'file_index', label: '文件索引', type: 'number', only: ['snowluma'], sample: 0 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'download_fileset', notes: 'NapCat 只接受 fileset_id；返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'download_fileset', notes: '返回 { url, file_name, file_size }' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c' },
      success: {
        status: 'ok', retcode: 0,
        data: { url: 'https://qfile.qq.com/d/xxxx', file_name: 'a.zip', file_size: 1048576 },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '解析下载直链失败: 文件集已过期', wording: '解析下载直链失败', echo: null,
      },
    },
  },

  {
    name: 'get_fileset_id',
    title: '解析闪传分享码',
    summary: '把 QQ 闪传分享码或官方分享链接解析成文件集 ID。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_fileset_id'],
    params: [
      {
        key: 'share_code', label: '分享码或链接', type: 'string', required: true, sample: 'https://qfile.qq.com/q/abcd',
        desc: 'QQ 闪传分享码，或 https://qfile.qq.com/q/... 形式的官方分享链接',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_fileset_id', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_fileset_id', notes: '返回 { fileset_id }' },
        },
      },
    },
    examples: {
      request: { share_code: 'https://qfile.qq.com/q/abcd' },
      success: { status: 'ok', retcode: 0, data: { fileset_id: 'fileset_9f8e7d6c' }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '解析分享码失败: 链接已失效', wording: '解析分享码失败', echo: null,
      },
    },
  },

  {
    name: 'get_fileset_info',
    title: '获取文件集信息',
    summary: '查询一个闪传文件集的元信息（文件数量、大小、有效期等）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_fileset_info'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_fileset_info', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_fileset_info', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取文件集信息失败', wording: '获取文件集信息失败', echo: null,
      },
    },
  },

  {
    name: 'send_flash_msg',
    title: '发送闪传消息',
    summary: '在私聊或群里发一条引用闪传文件集的消息，让对端自行下载。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_flash_msg'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001, desc: '私聊时填；与 group_id 二选一' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456, desc: '群聊时填；与 user_id 二选一' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_flash_msg', notes: '返回 { message_id }（SnowLuma 文档口径）；NapCat 侧返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_flash_msg', notes: '返回 { message_id }' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c', group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: { message_id: 1728134402 }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送闪传消息失败: 文件集已过期', wording: '发送闪传消息失败', echo: null,
      },
    },
  },

  {
    name: 'get_fileset_list',
    title: '列出闪传文件集',
    summary: '列出当前账号的全部闪传文件集。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['list_filesets', 'get_fileset_list'],
    params: [],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'list_filesets', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '列出文件集失败', wording: '列出文件集失败', echo: null,
      },
    },
  },

  {
    name: 'delete_flash_file',
    title: '删除闪传文件',
    summary: '删除一个闪传文件集。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_flash_file'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'delete_flash_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除闪传文件失败', wording: '删除闪传文件失败', echo: null,
      },
    },
  },

  {
    name: 'set_flash_file_name',
    title: '重命名闪传文件',
    summary: '重命名一个闪传文件集。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['rename_flash_file', 'set_flash_file_name'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
      { key: 'new_name', label: '新名称', type: 'string', required: true, sample: '本周素材' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'rename_flash_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c', new_name: '本周素材' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '重命名闪传文件失败', wording: '重命名闪传文件失败', echo: null,
      },
    },
  },

  {
    name: 'get_share_link',
    title: '获取文件分享链接',
    summary: '把一个闪传文件集解析成可对外分享的链接。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_share_link'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fileset_9f8e7d6c' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_share_link', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_share_link', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { fileset_id: 'fileset_9f8e7d6c' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取分享链接失败: 文件集不存在', wording: '获取分享链接失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 在线文件 ─────────────────────────── */

  {
    name: 'send_online_file',
    title: '发送在线文件',
    summary: '向好友发送本地文件（在线文件通道）。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['send_online_file'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'file_path', label: '本地文件路径', type: 'string', required: true, sample: 'C:/tmp/a.zip' },
      { key: 'file_name', label: '文件名', type: 'string', sample: 'a.zip', desc: '可选；省略则用原文件名' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_online_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, file_path: 'C:/tmp/a.zip' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送在线文件失败: 文件不存在', wording: '发送在线文件失败', echo: null,
      },
    },
  },

  {
    name: 'send_online_folder',
    title: '发送在线文件夹',
    summary: '向好友发送整个本地文件夹（在线文件通道）。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['send_online_folder'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'folder_path', label: '本地文件夹路径', type: 'string', required: true, sample: 'C:/tmp/photos' },
      { key: 'folder_name', label: '文件夹名称', type: 'string', sample: 'photos', desc: '可选；省略则用原文件夹名' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_online_folder', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, folder_path: 'C:/tmp/photos' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送在线文件夹失败', wording: '发送在线文件夹失败', echo: null,
      },
    },
  },

  {
    name: 'receive_online_file',
    title: '接收在线文件',
    summary: '接受好友发来的在线文件传输。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['receive_online_file'],
    params: [
      { key: 'user_id', label: '对方 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'msg_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: '1728134400' },
      { key: 'element_id', label: '元素 ID', type: 'string', required: true, sample: 'elem_001' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'receive_online_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, msg_id: '1728134400', element_id: 'elem_001' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '接收在线文件失败: 传输已取消', wording: '接收在线文件失败', echo: null,
      },
    },
  },

  {
    name: 'refuse_online_file',
    title: '拒绝在线文件',
    summary: '拒收好友发来的在线文件传输。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['refuse_online_file'],
    params: [
      { key: 'user_id', label: '对方 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'msg_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: '1728134400' },
      { key: 'element_id', label: '元素 ID', type: 'string', required: true, sample: 'elem_001' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'refuse_online_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, msg_id: '1728134400', element_id: 'elem_001' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '拒绝在线文件失败', wording: '拒绝在线文件失败', echo: null,
      },
    },
  },

  {
    name: 'cancel_online_file',
    title: '取消在线文件',
    summary: '取消正在进行的在线文件传输。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['cancel_online_file'],
    params: [
      { key: 'user_id', label: '对方 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'msg_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: '1728134400' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'cancel_online_file', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001, msg_id: '1728134400' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '取消在线文件失败', wording: '取消在线文件失败', echo: null,
      },
    },
  },

  {
    name: 'get_online_file_msg',
    title: '获取在线文件消息',
    summary: '拉取与某好友之间的在线文件传输消息。仅 NapCat 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_online_file_msg'],
    params: [
      { key: 'user_id', label: '对方 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_online_file_msg', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取在线文件消息失败', wording: '获取在线文件消息失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 收藏 ─────────────────────────── */

  {
    name: 'create_collection',
    title: '创建收藏',
    summary: '把一段原始内容存进 QQ 收藏。SnowLuma 侧该 action 标注为未实现。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['create_collection'],
    params: [
      { key: 'raw_data', label: '原始数据', type: 'string', required: true, sample: '{"app":"com.tencent.qq","desc":"..."}' },
      { key: 'brief', label: '简要描述', type: 'string', required: true, sample: '一段聊天记录' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'create_collection', map: { raw_data: 'rawData' }, notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'create_collection', stub: true, notes: 'SnowLuma 标注为未实现；rawData / brief 均未在文档中声明' },
        },
      },
    },
    examples: {
      request: { raw_data: '{"app":"com.tencent.qq"}', brief: '一段聊天记录' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '创建收藏失败', wording: '创建收藏失败', echo: null,
      },
    },
  },

  {
    name: 'get_collection_list',
    title: '获取收藏列表',
    summary: '分页拉取当前账号的 QQ 收藏条目。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_collection_list'],
    params: [
      {
        key: 'category', label: '分类 ID', type: 'string', required: true, sample: '0',
        desc: '0 表示全部分类。NapCat 侧该字段为字符串类型',
      },
      {
        key: 'count', label: '获取数量', type: 'number', sample: 50,
        desc: 'NapCat 默认 50 且要求字符串类型，代理层不做类型转换',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_collection_list', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_collection_list',
            notes: '返回收藏条目、是否还有更多数据及底部时间游标；字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { category: '0', count: 50 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取收藏列表失败', wording: '获取收藏列表失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 表情回应 ─────────────────────────── */

  {
    name: 'get_emoji_like',
    title: '获取表情回应（分页）',
    summary: '分页拉取一条消息上某个表情的回应用户列表（NapCat 形状，带分页游标）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_emoji_like', 'get_emoji_like'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '10001' },
      { key: 'emoji_type', label: '表情类型', type: 'string', only: ['napcat'], sample: '1', desc: '仅 NapCat 支持' },
      { key: 'count', label: '获取数量', type: 'number', sample: 20 },
      { key: 'cookie', label: '分页游标', type: 'string', sample: '', desc: '上一页返回的游标，首页留空' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'fetch_emoji_like',
            map: { emoji_id: 'emojiId', emoji_type: 'emojiType' },
            notes: '返回结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_emoji_like',
            map: { emoji_id: 'emojiId' },
            notes: '返回分页的用户列表，含分页游标 cookie 与首/末页标记；字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { message_id: 1728134400, emoji_id: '10001', count: 20 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取表情回应失败: 消息不存在', wording: '获取表情回应失败', echo: null,
      },
    },
  },

  {
    name: 'get_emoji_likes',
    title: '获取表情回应列表',
    summary: '拉取一条消息上指定表情的回应用户列表（不分页）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_emoji_likes'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '10001' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', only: ['napcat'], sample: 123456, desc: 'NapCat 侧短 ID 场景可不传' },
      { key: 'emoji_type', label: '表情类型', type: 'string', only: ['napcat'], sample: '1' },
      { key: 'count', label: '数量', type: 'number', only: ['napcat'], sample: 0, desc: '0 代表全部' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_emoji_likes', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_emoji_likes', notes: '返回 { emoji_like_list }；SnowLuma 说明 nick_name 恒为空串' },
        },
      },
    },
    examples: {
      request: { message_id: 1728134400, emoji_id: '10001' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取表情回应列表失败', wording: '获取表情回应列表失败', echo: null,
      },
    },
  },

  {
    name: 'set_msg_emoji_like',
    title: '设置消息表情回应',
    summary: '给一条消息加 / 取消表情回应（贴表情）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_msg_emoji_like'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '10001' },
      { key: 'enable', label: '是否添加', type: 'boolean', sample: true, desc: 'true=贴表情，false=取消' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'set_msg_emoji_like', map: { enable: 'set' }, notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'set_msg_emoji_like', map: { enable: 'set' }, notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { message_id: 1728134400, emoji_id: '10001', enable: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '设置表情回应失败: 不支持该表情', wording: '设置表情回应失败', echo: null,
      },
    },
  },

  {
    name: 'get_msg_emoji_likes',
    title: '获取消息全部表情回应',
    summary: '拉取一条消息上的全部表情回应（每个表情的编号、数量与用户列表）。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_msg_emoji_likes'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: 'get_msg_emoji_likes',
            notes: '返回「每个表情回应的编号、数量与用户列表」数组，字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取表情回应失败', wording: '获取表情回应失败', echo: null,
      },
    },
  },


  /* ─────────────────────────── Ark 卡片 ─────────────────────────── */

  {
    name: 'send_ark_share',
    title: '发送联系人 Ark 卡片',
    summary: '发送推荐联系人 / 群的 Ark 分享卡片（按 user_id / group_id / 手机号生成）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_ark_share', 'share_peer'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001, desc: '分享的联系人 QQ 号；私聊场景也用作接收方' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456, desc: '分享该群的卡片；群聊场景也用作接收方' },
      { key: 'phone_number', label: '手机号', type: 'string', sample: '13800000000' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_ark_share', notes: 'NapCat 未公开参数表；返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_ark_share', notes: '返回 { arkMsg }（服务端生成的 Ark 卡片 JSON 字符串）' },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送 Ark 卡片失败: 目标不存在', wording: '发送 Ark 卡片失败', echo: null,
      },
    },
  },

  {
    name: 'send_group_ark_share',
    title: '发送群 Ark 卡片',
    summary: '发送群推荐 Ark 分享卡片。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_group_ark_share', 'share_group_ex'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_group_ark_share', notes: 'NapCat 未公开参数表；返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_group_ark_share', notes: '返回服务端生成的群推荐 Ark 卡片 JSON 字符串' },
        },
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送群 Ark 卡片失败', wording: '发送群 Ark 卡片失败', echo: null,
      },
    },
  },

  {
    name: 'get_peer_ark_share',
    title: '生成联系人 Ark 卡片',
    summary: '只生成推荐联系人 Ark 卡片的 JSON（不负责发送）。NapCat 侧对应内部 action ArkSharePeer。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['ArkSharePeer', 'share_peer', 'get_peer_ark_share'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001 },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'phone_number', label: '手机号', type: 'string', sample: '13800000000' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'ArkSharePeer',
            notes: 'NapCat 未公开参数表与返回结构；与 send_ark_share 语义相近，建议优先用 send_ark_share',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'share_peer',
            notes: '返回 { arkMsg }：服务端生成的推荐联系人 Ark 卡片 JSON 字符串',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '生成 Ark 卡片失败', wording: '生成 Ark 卡片失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_ark_share',
    title: '生成群 Ark 卡片',
    summary: '只生成群推荐 Ark 卡片的 JSON（不负责发送）。NapCat 侧对应内部 action ArkShareGroup。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['ArkShareGroup', 'share_group_ex', 'get_group_ark_share'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'ArkShareGroup',
            notes: 'NapCat 未公开参数表与返回结构；与 send_group_ark_share 语义相近，建议优先用后者',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'share_group_ex',
            notes: '返回服务端生成的群推荐 Ark 卡片 JSON 字符串',
          },
        },
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '生成群 Ark 卡片失败', wording: '生成群 Ark 卡片失败', echo: null,
      },
    },
  },

  {
    name: 'get_mini_app_ark',
    title: '生成小程序 Ark 卡片',
    summary: '按模板（bili / weibo 等）生成小程序分享用的 Ark 卡片数据。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_mini_app_ark'],
    params: [
      { key: 'type', label: '模板类型', type: 'string', required: true, sample: 'bili', desc: 'NapCat 支持 bili / weibo' },
      { key: 'title', label: '标题', type: 'string', required: true, sample: '某个视频' },
      { key: 'desc', label: '描述', type: 'string', required: true, sample: '点开看看' },
      { key: 'pic_url', label: '图片 URL', type: 'string', required: true, sample: 'https://example.com/pic.jpg' },
      { key: 'jump_url', label: '跳转 URL', type: 'string', required: true, sample: 'https://example.com/v/1' },
      { key: 'web_url', label: '网页 URL', type: 'string', only: ['napcat'], sample: 'https://example.com' },
      {
        key: 'raw_ark_data', label: '返回原始 Ark 数据', type: 'boolean', only: ['napcat'], sample: false,
        desc: '为 true 时协议端返回未经包装的原始 Ark 数据',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_mini_app_ark',
            map: { pic_url: 'picUrl', jump_url: 'jumpUrl', web_url: 'webUrl', raw_ark_data: 'rawArkData' },
            notes: '返回结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_mini_app_ark',
            notes: 'SnowLuma 同时接受 picUrl / pic_url 与 jumpUrl / jump_url 两种写法；返回结构未文档化',
          },
        },
      },
    },
    examples: {
      request: { type: 'bili', title: '某个视频', desc: '点开看看', pic_url: 'https://example.com/pic.jpg', jump_url: 'https://example.com/v/1' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '生成小程序 Ark 失败: 模板类型不支持', wording: '生成小程序 Ark 失败', echo: null,
      },
    },
  },

  {
    name: 'send_tuwen_ark',
    title: '发送图文 Ark 卡片',
    summary: '在私聊或群里发一张图文（标题+描述+跳转）Ark 卡片。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_tuwen_ark'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001, desc: '私聊时填；与 group_id 二选一' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456, desc: '群聊时填；与 user_id 二选一' },
      { key: 'title', label: '标题', type: 'string', required: true, sample: '活动通知' },
      { key: 'desc', label: '描述', type: 'string', required: true, sample: '点击查看详情' },
      { key: 'summary', label: '摘要', type: 'string', sample: '一句话简介' },
      { key: 'preview_url', label: '预览图 URL', type: 'string', sample: 'https://example.com/pic.jpg' },
      { key: 'jump_url', label: '跳转 URL', type: 'string', required: true, sample: 'https://example.com/act/1' },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'send_tuwen_ark', notes: 'SnowLuma 文档标注该接口返回 null' },
        },
      },
    },
    examples: {
      request: { group_id: 123456, title: '活动通知', desc: '点击查看详情', jump_url: 'https://example.com/act/1' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送图文卡片失败', wording: '发送图文卡片失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 其他野生能力 ─────────────────────────── */

  {
    name: 'click_inline_keyboard_button',
    title: '点击内联键盘按钮',
    summary: '模拟点击一条消息里的内联键盘按钮（官方机器人下发按钮时的回调触发）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['click_inline_keyboard_button'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'bot_appid', label: '机器人 AppID', type: 'string', required: true, sample: '1020xxxxx' },
      { key: 'button_id', label: '按钮 ID', type: 'string', sample: 'btn_1' },
      { key: 'callback_data', label: '回调数据', type: 'string', sample: 'action=vote' },
      { key: 'msg_seq', label: '消息序列号', type: 'number', sample: 10086 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'click_inline_keyboard_button', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'click_inline_keyboard_button', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { group_id: 123456, bot_appid: '1020xxxxx', button_id: 'btn_1' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '点击按钮失败: 按钮已失效', wording: '点击按钮失败', echo: null,
      },
    },
  },

  {
    name: 'get_ai_characters',
    title: '获取 AI 语音角色',
    summary: '拉取某个群里可用的 AI 语音角色列表（按分类分组，含试听 URL）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_ai_characters'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'chat_type', label: '聊天类型', type: 'number', sample: 1, desc: 'NapCat 默认 1；SnowLuma 同样接受该字段' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_ai_characters', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_ai_characters',
            notes: '返回按分类分组的角色列表，每组含分类名与角色（id、名称、试听 URL）；字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取 AI 角色失败: 该群未开放', wording: '获取 AI 角色失败', echo: null,
      },
    },
  },

  {
    name: 'get_ai_record',
    title: '生成 AI 语音',
    summary: '用 AI 语音引擎把一段文本合成语音，返回可播放的语音 URL（不发送）。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['get_ai_record'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'character', label: '角色 ID', type: 'string', required: true, sample: 'character_001' },
      { key: 'text', label: '语音文本', type: 'string', required: true, sample: '大家好' },
      { key: 'chat_type', label: '聊天类型', type: 'number', only: ['snowluma'], sample: 1 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_ai_record', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'get_ai_record', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { group_id: 123456, character: 'character_001', text: '大家好' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '生成 AI 语音失败: 角色不存在', wording: '生成 AI 语音失败', echo: null,
      },
    },
  },

  {
    name: 'send_ai_record',
    title: '发送 AI 语音',
    summary: '用 AI 语音角色把一段文本合成语音并发到群里。协议端仅有群聊实现。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_group_ai_record', 'send_ai_record'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'character', label: '角色 ID', type: 'string', required: true, sample: 'character_001' },
      { key: 'text', label: '语音文本', type: 'string', required: true, sample: '大家好' },
      { key: 'chat_type', label: '聊天类型', type: 'number', only: ['snowluma'], sample: 1 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'send_group_ai_record', notes: '返回结构未文档化；NapCat 仅有群聊版本 send_group_ai_record' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'send_group_ai_record', notes: '返回 { message_id }' },
        },
      },
    },
    examples: {
      request: { group_id: 123456, character: 'character_001', text: '大家好' },
      success: { status: 'ok', retcode: 0, data: { message_id: 1728134403 }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送 AI 语音失败', wording: '发送 AI 语音失败', echo: null,
      },
    },
  },

  {
    name: 'translate_text',
    title: '英译中',
    summary: '把一批英文单词翻译成中文，返回与输入等长的译文数组。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['translate_en2zh', 'translate_text'],
    params: [
      { key: 'words', label: '待翻译单词', type: 'array', required: true, sample: ['hello', 'world'] },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'translate_en2zh', notes: '返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'translate_en2zh', notes: '返回 { words }：与输入等长的中文译文字符串数组' },
        },
      },
    },
    examples: {
      request: { words: ['hello', 'world'] },
      success: { status: 'ok', retcode: 0, data: { words: ['你好', '世界'] }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '翻译失败', wording: '翻译失败', echo: null,
      },
    },
  },







  {
    name: 'get_friend_dress',
    title: '获取好友个性装扮',
    summary: '查询某个 QQ 号正在使用的个性装扮（挂件 / 名片 / 来电 / 输入状态等）。仅 SnowLuma 提供。',
    category: 'wild-only',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['_get_friend_dress', 'get_friend_dress'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': {
            action: '_get_friend_dress',
            notes: '返回装扮信息，目标未使用可查询装扮时 items 为空数组；字段名未文档化',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取个性装扮失败: 未登录或触发风控', wording: '获取个性装扮失败', echo: null,
      },
    },
  },

  /* ─────────────────────────── 频道（野生侧残留） ─────────────────────────── */

  {
    name: 'get_qq_guild_list',
    title: '获取频道列表（野生）',
    summary: '拉取当前账号所在的 QQ 频道列表。NapCat 侧的「频道接口」，与官方机器人的 /guilds 不是同一套 ID 空间。',
    category: 'guild',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_guild_list', 'get_qq_guild_list'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_guild_list',
            notes: 'NapCat 未公开参数表与返回结构；与官方 /guilds 的 guild_id 不通用，勿混用',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取频道列表失败', wording: '获取频道列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_guild_service_profile',
    title: '获取频道个人信息',
    summary: '拉取当前账号在频道里的个人资料。NapCat 侧的「频道接口」。',
    category: 'guild',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_guild_service_profile'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'get_guild_service_profile', notes: 'NapCat 未公开参数表与返回结构' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取频道个人信息失败', wording: '获取频道个人信息失败', echo: null,
      },
    },
  },

  /* ───────────────────── 兜底补充：其他分类文件未认领的野生残留 ───────────────────── */

  {
    name: 'send_group_poke',
    title: '群内拍一拍',
    summary: '在群里对某个成员使用「拍一拍」。私聊 / 好友场景的拍一拍见 send_poke。',
    category: 'friend',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['group_poke', 'send_group_poke'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'user_id', label: '被拍的 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': { action: 'group_poke', notes: 'NapCat 未公开参数表，按 SnowLuma 的 group_id + user_id 组织；返回结构未文档化' },
        },
      },
      snowluma: {
        variants: {
          '*': { action: 'group_poke', notes: '返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { group_id: 123456, user_id: 10001 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '拍一拍失败: 对方不在该群', wording: '拍一拍失败', echo: null,
      },
    },
  },

  // send_group_sign 已合并进 group.ts 的 set_group_sign（NapCat 同一 handler 的两个
  // 注册名，用 impl.sameAs 声明别名即可，不再单独占一条 entry）。

  {
    name: 'upload_forward_msg',
    title: '上传转发消息',
    summary: '把一组转发节点上传为可复用的转发消息（仅 SnowLuma 提供）。',
    category: 'message',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['upload_forward_msg'],
    params: [
      {
        key: 'messages', label: '转发节点数组', type: 'array', required: true,
        sample: [{ type: 'node', data: { name: '某人', uin: '10001', content: '你好' } }],
        desc: '节点 content 内的 reply.data.message 可提供自定义引用内容；qq / time / seq 可选',
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'upload_forward_msg', notes: '返回结构未文档化；SnowLuma 同时接受 message 作为 messages 的同义键' },
        },
      },
    },
    examples: {
      request: { messages: [{ type: 'node', data: { name: '某人', uin: '10001', content: '你好' } }] },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传转发消息失败', wording: '上传转发消息失败', echo: null,
      },
    },
  },

  {
    name: 'upload_foward_msg',
    title: '上传转发消息（别名拼写）',
    summary: 'upload_forward_msg 的协议端别名拼写（foward），行为与 upload_forward_msg 一致。仅 SnowLuma 提供。',
    category: 'message',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['upload_foward_msg'],
    params: [
      {
        key: 'messages', label: '转发节点数组', type: 'array', required: true,
        sample: [{ type: 'node', data: { name: '某人', uin: '10001', content: '你好' } }],
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
    ],
    impl: {
      snowluma: {
        variants: {
          '*': { action: 'upload_foward_msg', notes: '协议端把 foward 作为 forward 的兼容别名；返回结构未文档化' },
        },
      },
    },
    examples: {
      request: { messages: [{ type: 'node', data: { name: '某人', uin: '10001', content: '你好' } }] },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传转发消息失败', wording: '上传转发消息失败', echo: null,
      },
    },
  },
];
