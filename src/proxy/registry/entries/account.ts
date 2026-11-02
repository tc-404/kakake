/**
 * 账号资料类接口。
 *
 * `get_login_info` 是唯一三协议都支持的条目（单变体写法，无 scene 派发）。
 * 其余条目均为野生专属：QQ 官方 v2 开放接口里只有 `GET /users/@me`（已由 get_login_info
 * 覆盖）与 `GET /users/@me/guilds`（频道列表，归 guild.ts），没有头像/资料/收藏表情的
 * HTTP 接口，因此这些条目的 support 里不列 official，调用会自动降级为 unsupported 失败信封。
 *
 * 参数与返回结构均以 `_sources/napcat-actions.json`、`_sources/snowluma-openapi.json`
 * 两份快照为准；返回结构无法静态确定的，`data` 一律写 null 并在变体 notes 里说明依据。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const accountEntries: ProxyApiEntry[] = [
  {
    name: 'get_login_info',
    title: '获取登录账号信息',
    summary: '获取当前登录机器人的账号与昵称。',
    category: 'account',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_login_info', '/users/@me'],
    params: [],
    impl: {
      // 单变体写法：variants 只给 '*'，不写 variantBy
      napcat: { variants: { '*': { action: 'get_login_info' } } },
      snowluma: { variants: { '*': { action: 'get_login_info' } } },
      official: { variants: { '*': { verb: 'GET', path: '/users/@me' } } },
    },
    examples: {
      request: {},
      success: {
        status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '咔咔' }, message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null, message: '未登录', wording: '未登录', echo: null,
      },
      byProtocol: {
        official: {
          request: {},
          success: { id: '1013531', username: '咔咔', avatar: 'https://...' },
          error: { code: 11242, message: '鉴权失败' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/user/me.html',
  },

  {
    name: 'set_avatar',
    title: '设置账号头像',
    summary: '修改当前登录账号的 QQ 头像，file 支持本地绝对路径、http(s) URL 或 base64。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_qq_avatar', 'set_avatar'],
    params: [
      {
        key: 'file', label: '头像图片', type: 'file', required: true, sample: 'C:/tmp/avatar.jpg',
        desc: '本地绝对路径、http(s) URL 或 base64 图片数据。NapCat 会把 URL/base64 先落地成临时文件再上传',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_qq_avatar',
            notes: 'NapCat 源码 SetQQAvatar.ts 的 returnSchema 为 Type.Null，成功时 data 恒为 null；'
              + '图片非图片格式时协议端返回 result=1004022 的失败信封',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'set_qq_avatar' } } },
    },
    examples: {
      request: { file: 'C:/tmp/avatar.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '头像C:/tmp/avatar.jpg设置失败,file字段可能格式不正确', wording: '头像设置失败', echo: null,
      },
    },
  },

  {
    name: 'set_self_profile',
    title: '设置账号资料',
    summary: '修改当前登录账号的昵称、个性签名与性别。未给的字段协议端会尽量保持原值。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_qq_profile', 'set_self_profile'],
    params: [
      {
        key: 'nickname', label: '昵称', type: 'string', required: true, sample: '咔咔',
        desc: 'NapCat 的 payload schema 把 nickname 标为必填；SnowLuma 三个字段都可省略（省略即保持原值）',
      },
      {
        key: 'personal_note', label: '个性签名', type: 'string', sample: '今天也要开心',
        desc: '对应协议端的 longNick。NapCat 在未传时会沿用当前签名而不是清空',
      },
      {
        key: 'sex', label: '性别', type: 'number', sample: 1,
        desc: '0=未知 / 1=男 / 2=女。NapCat 接受数字或字符串，SnowLuma 为整数',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_qq_profile',
            notes: 'NapCat 源码 SetQQProfile.ts 的 returnSchema 为 Type.Any 且 returnExample 未公开，'
              + '故返回结构未文档化；生日/地区字段该 action 不接受',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'set_qq_profile' } } },
    },
    examples: {
      request: { nickname: '咔咔', personal_note: '今天也要开心', sex: 1 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '资料修改失败: 昵称含敏感词', wording: '资料修改失败', echo: null,
      },
    },
  },

  {
    name: 'set_signature',
    title: '设置个性签名',
    summary: '单独修改当前登录账号的个性签名（longNick）。只想改签名时用这条比 set_self_profile 更直接。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_self_longnick', 'set_long_nick', 'set_signature'],
    params: [
      {
        key: 'signature', label: '签名内容', type: 'string', required: true, sample: '今天也要开心',
        desc: '统一键名 signature，两侧都映射为协议端的 longNick 字段',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_self_longnick',
            map: { signature: 'longNick' },
            notes: 'NapCat 源码 SetLongNick.ts 的 payload 键为驼峰 longNick；returnSchema 为 Type.Any，返回结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'set_self_longnick',
            map: { signature: 'longNick' },
            notes: 'SnowLuma 同时接受 longNick 与 long_nick 两个键',
          },
        },
      },
    },
    examples: {
      request: { signature: '今天也要开心' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '签名设置失败: 内容含敏感词', wording: '签名设置失败', echo: null,
      },
    },
  },

  {
    name: 'get_user_info',
    title: '获取用户资料',
    summary: '按 QQ 号查询一个用户（含非好友/陌生人）的详细资料：昵称、等级、QID、注册时间、VIP 等。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_user_info', 'get_stranger_info'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      {
        key: 'no_cache', label: '不使用缓存', type: 'boolean', only: ['napcat'], sample: false,
        desc: 'NapCat 侧默认 false，其 payload schema 标注为必填（带默认值）；SnowLuma 无此参数',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_stranger_info',
            notes: 'NapCat 源码 GoCQHTTPGetStrangerInfo.ts 的 returnSchema 给出了完整字段；'
              + '其中 login_days 源码注释为「失效」，恒返回 0',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_stranger_info',
            drop: ['no_cache'],
            notes: 'SnowLuma 文档：返回含账号标识、等级别名与可用的注册时间/会员信息，'
              + '注册时间或会员信息拿不到时省略对应字段，登录天数不返回占位值',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001 },
      success: {
        status: 'ok',
        retcode: 0,
        data: {
          user_id: 10001,
          uid: 'u_1a2b3c4d5e6f',
          nickname: '某人',
          age: 20,
          qid: 'a1b2c3',
          qqLevel: 32,
          sex: 'male',
          long_nick: '今天也要开心',
          reg_time: 1483200000,
          is_vip: false,
          is_years_vip: false,
          vip_level: 0,
          remark: '',
          status: 10,
          login_days: 0,
        },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '无法获取用户信息', wording: '无法获取用户信息', echo: null,
      },
    },
  },

  {
    name: 'get_profile_like',
    title: '获取资料点赞',
    summary: '读取一个用户资料页的点赞数据：总赞数、今日赞数、新增赞数与最近点赞的访客明细。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_profile_like'],
    params: [
      {
        key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001,
        desc: '不传表示查当前登录账号自己（NapCat 源码即按「不传或传自身 uin」走自查询分支）',
      },
      { key: 'start', label: '起始位置', type: 'number', sample: 0, desc: '默认 0' },
      { key: 'count', label: '获取数量', type: 'number', sample: 10, desc: '默认 10' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'get_profile_like',
            notes: 'NapCat 源码 GetProfileLike.ts 的 returnSchema 给出了完整字段（uid / time / '
              + 'favoriteInfo / voteInfo），示例见 examples.success',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'get_profile_like',
            notes: 'SnowLuma 只描述为「uid、最近点赞时间、收藏与点赞统计及用户明细」的对象，'
              + '未固化字段名，实际字段以协议端为准',
          },
        },
      },
    },
    examples: {
      request: { user_id: 10001, start: 0, count: 10 },
      success: {
        status: 'ok',
        retcode: 0,
        data: {
          uid: 'u_123',
          time: '1734567890',
          favoriteInfo: { userInfos: [], total_count: 10, last_time: 1734567890, today_count: 5 },
          voteInfo: {
            total_count: 100, new_count: 2, new_nearby_count: 0,
            last_visit_time: 1734567890, userInfos: [],
          },
        },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: 'get info error', wording: '获取资料点赞失败', echo: null,
      },
    },
  },

  {
    name: 'get_user_online_status',
    title: '获取用户在线状态',
    summary: '按 QQ 号查询一个用户的在线状态码与扩展状态码。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_user_online_status', 'nc_get_user_status', 'get_user_status'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'nc_get_user_status',
            notes: 'NapCat 源码 GetUserStatus.ts 的 returnSchema 为 { status, ext_status }（数字），'
              + '底层走 GetStrangerStatus 发包；状态码枚举未在源码中注释',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'nc_get_user_status',
            notes: 'SnowLuma 文档同样为 { status, ext_status }，与 NapCat 一致',
          },
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
        message: '无法获取用户状态', wording: '无法获取用户状态', echo: null,
      },
    },
  },

  {
    name: 'get_custom_face',
    title: '获取收藏表情',
    summary: '读取当前账号的收藏（自定义）表情，默认返回表情图片 URL 列表。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_custom_face', 'get_custom_face'],
    params: [
      { key: 'count', label: '获取数量', type: 'number', sample: 48, desc: '默认 48' },
      {
        key: 'return_type', label: '返回形式', type: 'string', only: ['snowluma'], sample: 'url',
        desc: "'url' 返回图片 URL，'id' 返回 emoji_id。NapCat 无此参数，恒返回 URL",
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'fetch_custom_face',
            drop: ['return_type'],
            notes: 'NapCat 源码 FetchCustomFace.ts 的 payload 确实只有 count（已核对源码，非 schema 缺失），'
              + 'returnSchema 为 Array<string>，恒返回表情 URL 列表',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_custom_face',
            notes: 'SnowLuma 文档：data 为字符串数组，return_type=url 时是图片 URL，=id 时是 emoji_id',
          },
        },
      },
    },
    examples: {
      request: { count: 10 },
      success: {
        status: 'ok', retcode: 0, data: ['https://gchat.qpic.cn/face1.png'], message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取收藏表情失败', wording: '获取收藏表情失败', echo: null,
      },
    },
  },

  {
    name: 'get_custom_face_detail',
    title: '获取收藏表情详情',
    summary: '读取当前账号收藏表情的详情对象（含资源标识 resId、图片地址、摘要与描述），删除/改描述都要先取这里的 resId。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_custom_face_detail', 'get_custom_face_detail'],
    params: [
      { key: 'count', label: '获取数量', type: 'number', sample: 48, desc: '默认 48' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'fetch_custom_face_detail',
            notes: 'NapCat 源码 CustomFace.ts 里 FetchCustomFaceDetail 的 payload 只有 count（已核对源码），'
              + 'returnSchema 却是 Type.Any 且 returnExample 为 null —— 返回结构未文档化，'
              + '已知它直接返回 emojiInfoList 原始对象（删除表情所需的 resId 在其中）',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'fetch_custom_face_detail',
            notes: 'SnowLuma 文档：data 为「含资源标识、图片地址、摘要与描述」的对象数组，未固化字段名',
          },
        },
      },
    },
    examples: {
      request: { count: 10 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取收藏表情详情失败', wording: '获取收藏表情详情失败', echo: null,
      },
    },
  },

  {
    name: 'add_custom_face',
    title: '添加收藏表情',
    summary: '把一张本地图片加入当前账号的表情收藏。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['add_custom_face'],
    params: [
      {
        key: 'file', label: '表情图片', type: 'file', required: true, sample: 'C:/tmp/face.png',
        desc: '本地表情文件路径。NapCat 会读取该文件计算 md5 与大小，所以必须是协议端机器上的真实路径',
      },
      {
        key: 'emoji_id', label: '表情 ID', type: 'string', only: ['napcat'], sample: '',
        desc: 'NapCat 可选；未提供时协议端传空字符串',
      },
      {
        key: 'package_id', label: '表情包 ID', type: 'string', only: ['napcat'], sample: '0',
        desc: 'NapCat 可选；未提供时协议端传 0',
      },
      {
        key: 'is_mark_face', label: '是否商城表情', type: 'boolean', only: ['napcat'], sample: false,
        desc: 'NapCat 可选，默认 false',
      },
      {
        key: 'is_origin', label: '是否原图', type: 'boolean', only: ['napcat'], sample: true,
        desc: 'NapCat 可选，源码默认 true',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'add_custom_face',
            notes: 'NapCat 源码还支持 file_name / file_size / md5（未填时由协议端从本地文件推导），'
              + '未列入统一参数；returnSchema 为 Type.Any，返回结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'add_custom_face',
            drop: ['emoji_id', 'package_id', 'is_mark_face', 'is_origin'],
            notes: 'SnowLuma 的 add_custom_face 只接受 file',
          },
        },
      },
    },
    examples: {
      request: { file: 'C:/tmp/face.png', is_origin: true },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '添加收藏表情失败: 文件不是图片格式', wording: '添加收藏表情失败', echo: null,
      },
    },
  },

  {
    name: 'delete_custom_face',
    title: '删除收藏表情',
    summary: '从当前账号的表情收藏里删除一个（或一批）表情，按 emoji_id / resId 定位。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['delete_custom_face'],
    params: [
      {
        key: 'emoji_id', label: '表情 ID', type: 'string', required: true,
        sample: '2707600964_0_0_0_D8EAA70984B402EE10B0F33DB88F4173_0_0',
        desc: '收藏表情的资源标识，先用 get_custom_face_detail 取到 resId 再删。'
          + 'NapCat 侧映射到 id 字段（源码里 id 与 res_id 等价，且支持传字符串数组批量删除）',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'delete_custom_face',
            map: { emoji_id: 'id' },
            notes: 'NapCat 源码 DeleteCustomFace.ts 只从 ids / res_id / id 取标识；'
              + 'schema 里的 md5 字段在源码中并未参与删除（不能直接按 md5 删），故未开放为统一参数',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'delete_custom_face',
            notes: 'SnowLuma 的 delete_custom_face 只接受 emoji_id 且为必填',
          },
        },
      },
    },
    examples: {
      request: { emoji_id: '2707600964_0_0_0_D8EAA70984B402EE10B0F33DB88F4173_0_0' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: 'res_id or ids is required', wording: '删除收藏表情失败', echo: null,
      },
    },
  },

  {
    name: 'set_custom_face_desc',
    title: '修改收藏表情描述',
    summary: '给一个已收藏的表情改描述（备注）。NapCat 叫 set_custom_face_desc，SnowLuma 叫 modify_custom_face。',
    category: 'account',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_custom_face_desc', 'modify_custom_face'],
    params: [
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '1', desc: '收藏表情 ID' },
      { key: 'desc', label: '新的描述', type: 'string', required: true, sample: '猫猫', desc: '表情备注文字' },
      {
        key: 'res_id', label: '资源 ID', type: 'string', only: ['napcat'], sample: 'resource-id',
        desc: 'NapCat 的 payload schema 未标 optional，实际必填；可用 get_custom_face_detail 取到',
      },
      {
        key: 'md5', label: '表情 MD5', type: 'string', only: ['napcat'], sample: 'd41d8cd98f00b204e9800998ecf8427e',
        desc: 'NapCat 的 payload schema 未标 optional，实际必填',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'set_custom_face_desc',
            notes: 'NapCat 源码 SetCustomFaceDesc.ts 要求 emoji_id / res_id / md5 / desc 四个字段都在；'
              + 'returnSchema 为 Type.Any，返回结构未文档化',
          },
        },
      },
      snowluma: {
        variants: {
          '*': {
            action: 'modify_custom_face',
            drop: ['res_id', 'md5'],
            notes: 'SnowLuma 的 modify_custom_face 只需要 emoji_id 与 desc',
          },
        },
      },
    },
    examples: {
      request: { emoji_id: '1', desc: '猫猫' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '修改收藏表情描述失败: 表情不存在', wording: '修改收藏表情描述失败', echo: null,
      },
    },
  },

  {
    name: 'set_custom_face_front',
    title: '收藏表情移到最前',
    summary: '把一个已收藏的表情移到收藏列表最前面。该能力 NapCat 快照里没有对应 action，仅 SnowLuma 提供。',
    category: 'account',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['move_custom_face_to_front', 'set_custom_face_front'],
    params: [
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '123456', desc: '收藏表情 ID' },
    ],
    impl: {
      // NapCat 快照里没有等价 action，因此 impl 里不出现 napcat 块 —— 野生 NapCat 连接调用
      // 会自动降级为 unsupported 失败信封，不做任何伪造。
      snowluma: {
        variants: {
          '*': {
            action: 'move_custom_face_to_front',
            notes: 'SnowLuma 的 move_custom_face_to_front，data 结构未文档化',
          },
        },
      },
    },
    examples: {
      request: { emoji_id: '123456' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '收藏表情移到最前失败: 表情不存在', wording: '收藏表情移到最前失败', echo: null,
      },
    },
  },
];
