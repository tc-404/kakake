import type { ProxyApiEntry } from '../../proxy.types.js';

/**
 * 官方频道：频道与子频道、身份组、权限位图、频道成员（官方专属）。
 *
 * 这里每一条都是「野生协议完全没有」的能力 —— NapCat 与 SnowLuma 的 action 集合里
 * 找不到任何频道相关动作，所以一律 `support: ['official']` + `scope: 'official-only'`，
 * 且**不写野生变体**（写了就是编造，野生侧会因此得到假的能力）。
 *
 * 两个官方专属的读法，改动本文件前先记住：
 *   1. 子频道权限用位图整数表示，序列化成十进制字符串。
 *      1<<0 可查看、1<<1 可管理、1<<2 可发言（见 role-group/channel_permissions/model.md）。
 *   2. 官方响应**不是信封**，成功直接是业务对象，204 的无包体接口这里写 `success: null`，
 *      失败一律 `{ code, message }` 且 HTTP 非 2xx —— 所以本文件的 examples 不套一层
 *      `{ status, retcode, data }`，那层是代理层合成给插件看的。
 */
export const guildEntries: ProxyApiEntry[] = [
  /* ───────────────────────── 频道 Guild ───────────────────────── */

  {
    name: 'get_guild_list',
    title: '获取机器人所在频道列表',
    summary: '分页拉取当前机器人加入的频道列表（Guild 对象数组）。官方专属。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/users/@me/guilds'],
    params: [
      {
        key: 'limit', label: '每页条数', type: 'number', sample: 100,
        desc: '默认 100，最大 100',
      },
      {
        key: 'after', label: '起始游标（向后翻页）', type: 'string', sample: '0',
        desc: '读此 guild id 之后的数据；与 before 同时设置时 after 无效',
      },
      {
        key: 'before', label: '起始游标（向前翻页）', type: 'string', sample: '0',
        desc: '读此 guild id 之前的数据，设置时会先反序再分页',
      },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/users/@me/guilds' } } },
    },
    examples: {
      request: { limit: 100 },
      success: [{
        id: '696527283900292399',
        name: '鹅们的萌宠啦咔咔啦',
        icon: 'https://groupprohead-76292.picgzc.qpic.cn/482231626508223/100',
        owner_id: '4828365788198541698',
        owner: false,
        joined_at: '2021-12-08T16:12:31+08:00',
        member_count: 17,
        max_members: 300,
        description: '123',
      }],
      error: { code: 11242, message: '校验 token 失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/user/guilds.html',
  },

  {
    name: 'get_guild_info',
    title: '获取频道详情',
    summary: '获取指定频道的详情（名称、头像、创建人、成员数等）。官方专属。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}' } } },
    },
    examples: {
      request: { guild_id: '123456' },
      success: {
        id: '123456',
        name: '鹅们的萌宠啦咔咔啦',
        icon: 'https://groupprohead-76292.picgzc.qpic.cn/482231626508223/100',
        owner_id: 'xxxxxx',
        owner: false,
        joined_at: '2022-01-13T11:02:21+08:00',
        member_count: 5,
        max_members: 300,
        description: '千江有水千江月，万里无云万里天',
      },
      error: { code: 10004, message: 'UnknownGuild 频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/guild/get_guild.html',
  },

  /* ───────────────────────── 子频道 Channel ───────────────────────── */

  {
    name: 'get_channel_list',
    title: '获取子频道列表',
    summary: '获取指定频道下的全部子频道（Channel 对象数组），不分页。官方专属。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/channels'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/channels' } } },
    },
    examples: {
      request: { guild_id: '123456' },
      success: [{
        id: 'xxxxxx',
        guild_id: '123456',
        name: '很高兴遇见你',
        type: 4,
        position: 2,
        parent_id: '0',
        owner_id: '0',
        sub_type: 0,
      }],
      error: { code: 10004, message: 'UnknownGuild 频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/get_channels.html',
  },

  {
    name: 'get_channel_info',
    title: '获取子频道详情',
    summary: '获取单个子频道的详情（类型、分组、私密类型、发言权限等）。官方专属。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/channels/{channel_id}'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/channels/{channel_id}' } } },
    },
    examples: {
      request: { channel_id: '123456' },
      success: {
        id: '123456',
        guild_id: 'xxxxxx',
        name: '很高兴遇见你',
        type: 4,
        position: 2,
        owner_id: '0',
        sub_type: 0,
        private_type: 0,
        speak_permission: 0,
        application_id: '0',
      },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/get_channel.html',
  },

  {
    name: 'create_channel',
    title: '创建子频道',
    summary: '在频道下创建子频道，返回创建出的 Channel 对象。需要「管理频道」权限，机器人需被设为管理员。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/channels'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'name', label: '子频道名称', type: 'string', sample: '私密子频道',
        desc: '官方文档未标必填，但创建时实际都要传',
      },
      {
        key: 'position', label: '排序位置', type: 'number', required: true, sample: 1,
        desc: '从 1 开始；类型为子频道分组（type=4）时必须 ≥2，因为 position 1 被「未分组」占用。填已存在的值则插到该元素之前',
      },
      {
        key: 'type', label: '子频道类型', type: 'number', sample: 0,
        desc: '0=文字 2=语音 4=子频道分组 10005=直播 10006=应用 10007=论坛；1/3 保留不可用',
      },
      {
        key: 'sub_type', label: '子频道子类型', type: 'number', sample: 0,
        desc: '仅文字子频道有意义：0=闲聊 1=公告 2=攻略 3=开黑',
      },
      { key: 'parent_id', label: '所属分组 ID', type: 'string', sample: '123456' },
      {
        key: 'private_type', label: '私密类型', type: 'number', sample: 1,
        desc: '0=公开 1=群主管理员可见 2=群主管理员+指定成员（配合修改子频道权限接口指定成员）',
      },
      {
        key: 'private_user_ids', label: '私密成员 ID 列表', type: 'array', sample: ['2823701233424295228'],
        desc: 'private_type=2 时指定可见成员',
      },
      {
        key: 'speak_permission', label: '发言权限', type: 'number', sample: 1,
        desc: '0=无效类型 1=所有人 2=群主管理员+指定成员',
      },
      {
        key: 'application_id', label: '应用子频道 AppID', type: 'string', sample: '1000000',
        desc: '仅应用子频道（type=10006）需要。1000000=王者开黑大厅 1000010=腾讯投票 1000050=日程提醒 等',
      },
    ],
    impl: {
      official: {
        variants: { '*': { verb: 'POST', path: '/guilds/{guild_id}/channels' } },
        requires: '需「管理频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: {
        guild_id: '123456', name: '私密子频道', type: 0, position: 1, parent_id: '123456', private_type: 1,
      },
      success: {
        id: 'xxxxxx',
        guild_id: 'xxxxxx',
        name: '私密子频道',
        type: 1,
        position: 7,
        parent_id: '123456',
        owner_id: 'xxxxxx',
        sub_type: 0,
      },
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/post_channels.html',
  },

  {
    name: 'update_channel',
    title: '修改子频道',
    summary: '修改子频道的名称/排序/分组/私密类型/发言权限，改哪个传哪个。需要「管理子频道」权限。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
      { key: 'name', label: '子频道名', type: 'string', sample: '新的私密子频道' },
      { key: 'position', label: '排序', type: 'number', sample: 1 },
      { key: 'parent_id', label: '分组 ID', type: 'string', sample: '123456' },
      {
        key: 'private_type', label: '私密类型', type: 'number', sample: 1,
        desc: '0=公开 1=群主管理员可见 2=群主管理员+指定成员',
      },
      {
        key: 'speak_permission', label: '发言权限', type: 'number', sample: 1,
        desc: '0=无效类型 1=所有人 2=群主管理员+指定成员',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PATCH',
            path: '/channels/{channel_id}',
            notes: '官方为局部更新语义：只传要改的字段，未传的不动',
          },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { channel_id: '123456', name: '新的私密子频道', position: 1, private_type: 1 },
      success: {
        id: 'xxxxxx',
        guild_id: 'xxxxxx',
        name: '私密子频道a',
        type: 10006,
        position: 2,
        parent_id: 'xxxxxx',
        owner_id: 'xxxxxx',
        sub_type: 0,
        private_type: 1,
      },
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/patch_channel.html',
  },

  {
    name: 'delete_channel',
    title: '删除子频道',
    summary: '删除子频道。官方明确标注「一旦删除将无法恢复」，不可逆操作。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/channels/{channel_id}'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}',
            notes: '成功返回 HTTP 200 无包体，本条目 success 记为 null',
          },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员。删除不可撤回',
      },
    },
    examples: {
      request: { channel_id: '123456' },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/manage/channel/delete_channel.html',
  },

  {
    name: 'get_channel_online_nums',
    title: '获取音视频子频道在线成员数',
    summary: '查询音视频/直播子频道当前的在线成员数。官方专属。',
    category: 'channel',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/channels/{channel_id}/online_nums'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/channels/{channel_id}/online_nums' } } },
    },
    examples: {
      request: { channel_id: '123456' },
      success: { online_nums: 1 },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/get_online_nums.html',
  },

  /* ───────────────────────── 身份组 Role ───────────────────────── */

  {
    name: 'get_role_list',
    title: '获取频道身份组列表',
    summary: '获取频道下全部身份组，并带回分组数量上限。官方专属。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/roles'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/roles' } } },
    },
    examples: {
      request: { guild_id: '123456' },
      success: {
        guild_id: '123456',
        roles: [
          { id: '4', name: '创建者', color: 4294927682, hoist: 1, number: 1, member_limit: 1 },
          { id: '2', name: '管理员', color: 4280276644, hoist: 1, number: 5, member_limit: 50 },
        ],
        role_num_limit: '30',
      },
      error: { code: 11264, message: '检查小站（频道）权限未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/get_guild_roles.html',
  },

  {
    name: 'create_role',
    title: '创建频道身份组',
    summary: '在频道下新建身份组。三个字段都非必填，但至少要传其中之一。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/roles'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      { key: 'name', label: '身份组名称', type: 'string', sample: 'test' },
      {
        key: 'color', label: '颜色值', type: 'number', sample: 99999,
        desc: 'ARGB 的 HEX 十六进制颜色值转换后的十进制数值',
      },
      {
        key: 'hoist', label: '成员列表中单独展示', type: 'number', sample: 1,
        desc: '0=否 1=是',
      },
    ],
    impl: {
      official: {
        variants: { '*': { verb: 'POST', path: '/guilds/{guild_id}/roles' } },
        requires: '需创建身份组权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { guild_id: '123456', name: 'test', color: 99999, hoist: 1 },
      success: {
        role_id: '10177739',
        role: {
          id: '10177739', name: 'test', color: 99999, hoist: 1, number: 0, member_limit: 2000,
        },
      },
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/post_guild_role.html',
  },

  {
    name: 'update_role',
    title: '修改频道身份组',
    summary: '修改身份组的名称/颜色/是否单独展示。只改传入的字段，至少要传一个。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/roles/{role_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '10177739',
        desc: '系统默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
      { key: 'name', label: '身份组名称', type: 'string', sample: 'test' },
      {
        key: 'color', label: '颜色值', type: 'number', sample: 99999,
        desc: 'ARGB 的 HEX 十六进制颜色值转换后的十进制数值',
      },
      { key: 'hoist', label: '成员列表中单独展示', type: 'number', sample: 1, desc: '0=否 1=是' },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PATCH',
            path: '/guilds/{guild_id}/roles/{role_id}',
            notes: '官方为局部更新语义：至少传一个字段，未传的不改',
          },
        },
        requires: '需修改身份组权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { guild_id: '123456', role_id: '10177739', name: 'test', color: 99999, hoist: 1 },
      success: {
        guild_id: '3489223429684602178',
        role_id: '10177739',
        role: {
          id: '10177739', name: 'test', color: 99999, hoist: 1, number: 1, member_limit: 2000,
        },
      },
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/patch_guild_role.html',
  },

  {
    name: 'delete_role',
    title: '删除频道身份组',
    summary: '删除频道下的身份组。不可逆操作，官方成功返回 204 无包体。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/guilds/{guild_id}/roles/{role_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '112233',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/guilds/{guild_id}/roles/{role_id}',
            notes: '成功返回 HTTP 204 无包体，本条目 success 记为 null',
          },
        },
        requires: '需删除身份组权限；机器人需被频道添加为管理员。删除不可撤回',
      },
    },
    examples: {
      request: { guild_id: '123456', role_id: '112233' },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/delete_guild_role.html',
  },

  {
    name: 'add_role_member',
    title: '添加身份组成员',
    summary: '把频道成员加入指定身份组。官方成功返回 204 无包体。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/members/{user_id}/roles/{role_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true,
        sample: '2823701233424295228',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '445566',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
      {
        key: 'channel', label: '子频道对象', type: 'object', sample: { id: '1744939' },
        desc: '接收只填了 id 的对象；仅当 role_id 为 5-子频道管理员时才需要，用于指定是哪个子频道',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/guilds/{guild_id}/members/{user_id}/roles/{role_id}',
            notes: '子频道管理员（role_id=5）场景必须带 channel 对象；官方要求的是嵌套结构，故这里不做键名映射、直接透传',
          },
        },
        requires: '需增加身份组成员权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: {
        guild_id: '123456', user_id: '2823701233424295228', role_id: '445566', channel: { id: '1744939' },
      },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/put_guild_member_role.html',
  },

  {
    name: 'remove_role_member',
    title: '移除身份组成员',
    summary: '把成员从指定身份组中移除。官方成功返回 204 无包体。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/members/{user_id}/roles/{role_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true,
        sample: '2823701233424295228',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '445566',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
      {
        key: 'channel', label: '子频道对象', type: 'object', sample: { id: '1744939' },
        desc: '仅当 role_id 为 5-子频道管理员时才需要，指定是哪个子频道',
      },
    ],
    impl: {
      official: {
        variants: { '*': { verb: 'DELETE', path: '/guilds/{guild_id}/members/{user_id}/roles/{role_id}' } },
        requires: '需删除身份组成员权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { guild_id: '123456', user_id: '2823701233424295228', role_id: '445566' },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/delete_guild_member_role.html',
  },

  {
    name: 'get_role_members',
    title: '获取身份组成员列表',
    summary: '分页拉取某身份组下的成员详情。用 start_index 游标翻页，不是 offset。',
    category: 'role',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/roles/{role_id}/members'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '4',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
      {
        key: 'start_index', label: '翻页游标', type: 'string', sample: '0',
        desc: '把上一次回包里的 next 填进来；首次请求填 0，默认 0',
      },
      {
        key: 'limit', label: '每页条数', type: 'number', sample: 2,
        desc: '1-400，默认 1。实际返回条数可能与 limit 不等；翻页用返回的 next 继续',
      },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/roles/{role_id}/members' } } },
    },
    examples: {
      request: { guild_id: '123456', role_id: '4', limit: 2 },
      success: {
        data: [{
          user: { id: 'xxx', username: 'xxx', avatar: 'xxx', bot: false },
          nick: 'xxx',
          joined_at: '2021-11-03T20:41:36+08:00',
        }],
        next: '0',
      },
      error: { code: 11264, message: '检查小站（频道）权限未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role/member/get_role_members.html',
  },

  /* ───────────────────────── 子频道权限 ───────────────────────── */

  {
    name: 'get_channel_user_permission',
    title: '获取子频道用户权限',
    summary: '获取某用户在某子频道上的权限位图。权限 = 个人权限与身份组权限的并集。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/channels/{channel_id}/members/{user_id}/permissions'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true, sample: '112233',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': { verb: 'GET', path: '/channels/{channel_id}/members/{user_id}/permissions' },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { channel_id: '123456', user_id: '112233' },
      success: { channel_id: '123456', user_id: '112233', permissions: '4' },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/get_channel_permissions.html',
  },

  {
    name: 'set_channel_user_permission',
    title: '修改子频道用户权限',
    summary: '用 add/remove 两个位图增量调整某用户在某子频道上的权限。本接口不支持改「可管理子频道」权限。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/members/{user_id}/permissions'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true, sample: '112233',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
      {
        key: 'add', label: '要授予的权限位图', type: 'string', sample: '1',
        desc: '字符串形式的十进制位图：1=可查看（1<<0）2=可管理（1<<1）4=可发言（1<<2），按位或后转十进制，如 0x6FFF → "28671"',
      },
      {
        key: 'remove', label: '要删除的权限位图', type: 'string', sample: '4',
        desc: '同 add 的位图写法。add 与 remove 同一位都为 1 时表现为删除',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/channels/{channel_id}/members/{user_id}/permissions',
            notes: '成功返回 HTTP 204 无包体。此接口不支持修改「可管理子频道」（1<<1）权限',
          },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { channel_id: '123456', user_id: '112233', add: '1', remove: '4' },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/put_channel_permissions.html',
  },

  {
    name: 'get_channel_role_permission',
    title: '获取子频道身份组权限',
    summary: '获取某身份组在某子频道上的权限位图。官方专属。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/channels/{channel_id}/roles/{role_id}/permissions'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '112233',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': { verb: 'GET', path: '/channels/{channel_id}/roles/{role_id}/permissions' },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { channel_id: '123456', role_id: '112233' },
      success: { channel_id: '123456', role_id: '112233', permissions: '5' },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/get_channel_roles_permissions.html',
  },

  {
    name: 'set_channel_role_permission',
    title: '修改子频道身份组权限',
    summary: '用 add/remove 两个位图增量调整某身份组在某子频道上的权限。不支持改「可管理子频道」权限。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/roles/{role_id}/permissions'],
    params: [
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', required: true, sample: '123456' },
      {
        key: 'role_id', label: '身份组 ID', type: 'string', idSpace: 'role_id', required: true, sample: '112233',
        desc: '默认组：1=全体成员 2=管理员 4=群主/创建者 5=子频道管理员',
      },
      {
        key: 'add', label: '要授予的权限位图', type: 'string', sample: '1',
        desc: '字符串形式的十进制位图：1=可查看（1<<0）2=可管理（1<<1）4=可发言（1<<2），按位或后转十进制',
      },
      {
        key: 'remove', label: '要删除的权限位图', type: 'string', sample: '4',
        desc: '同 add 的位图写法。add 与 remove 同一位都为 1 时表现为删除',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/channels/{channel_id}/roles/{role_id}/permissions',
            notes: '成功返回 HTTP 204 无包体。此接口不支持修改「可管理子频道」（1<<1）权限',
          },
        },
        requires: '需「管理子频道」权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { channel_id: '123456', role_id: '112233', add: '1', remove: '4' },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/role-group/channel_permissions/put_channel_roles_permissions.html',
  },

  /* ───────────────────────── 频道成员 ───────────────────────── */

  {
    name: 'get_guild_members',
    title: '获取频道成员列表',
    summary: '分页拉取频道成员详情。用 after 游标翻页（不是 offset），且可能有重复项需自行按 user id 去重。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/members'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'after', label: '翻页游标', type: 'string', sample: '0',
        desc: '上一次回包中最后一个 member 的 user id；首次请求填 0，默认 0',
      },
      {
        key: 'limit', label: '每页条数', type: 'number', sample: 2,
        desc: '1-400，默认 1。实际返回条数可能与 limit 不等；翻到最后一次回包为空即拉取结束',
      },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/members' } } },
    },
    examples: {
      request: { guild_id: '123456', limit: 2 },
      success: [{
        user: {
          id: 'xxxxxx', username: 'xxxx', avatar: 'xxxxxx', bot: false,
          public_flags: 0, system: false, union_openid: 'xxxxxx', union_user_account: '',
        },
        nick: '',
        roles: ['1'],
        joined_at: '2021-12-09T15:53:41+08:00',
        deaf: false,
        mute: false,
        pending: false,
      }],
      error: { code: 11264, message: '检查小站（频道）权限未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/get_members.html',
  },

  {
    name: 'get_guild_member',
    title: '获取频道成员详情',
    summary: '获取单个频道成员的详细信息（含其所属身份组 ID 列表）。官方专属。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/members/{user_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true,
        sample: '2823701233424295228',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/members/{user_id}' } } },
    },
    examples: {
      request: { guild_id: '123456', user_id: '2823701233424295228' },
      success: {
        user: {
          id: '2823701233424295228',
          username: 'xxx',
          avatar: 'https://qqchannel-profile-1251316161.file.myqcloud.com/xxxxxxx',
          bot: false,
          union_openid: '',
          union_user_account: '',
        },
        nick: '',
        roles: ['1'],
        joined_at: '2021-12-05T14:08:29+08:00',
      },
      error: { code: 11264, message: '检查小站（频道）权限未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/get_member.html',
  },

  {
    name: 'remove_guild_member',
    title: '删除频道成员（踢人）',
    summary: '把成员移出频道，可同时拉黑并撤回其历史消息。官方明确「无法移除身份为管理员的成员」。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/guilds/{guild_id}/members/{user_id}'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true, sample: '112233',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
      {
        key: 'add_blacklist', label: '同时加入黑名单', type: 'boolean', sample: true,
        desc: '删除成员的同时把该用户加入频道黑名单',
      },
      {
        key: 'delete_history_msg_days', label: '撤回历史消息天数', type: 'number', sample: -1,
        desc: '仅支持 3 / 7 / 15 / 30；-1 表示撤回全部消息；0（默认）表示不撤回',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/guilds/{guild_id}/members/{user_id}',
            notes: '成功返回 HTTP 204 无包体。无法移除身份为管理员的成员',
          },
        },
        requires: '需踢人权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { guild_id: '123456', user_id: '112233', add_blacklist: true, delete_history_msg_days: -1 },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/member/delete_member.html',
  },

  {
    name: 'mute_guild_member',
    title: '频道成员禁言',
    summary:
      '禁言频道内的单个成员，传 duration=0 即解除禁言。'
      + '与 official.ts 的 mute_guild_all（频道全员禁言）、group.ts 的 set_group_ban（QQ 群禁言）是三条不同的东西。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/members/{user_id}/mute'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'user_id', label: '成员用户 ID', type: 'string', idSpace: 'guild_user_id', required: true,
        sample: '2823701233424295228',
        desc: '官方频道内的用户标识，仅在机器人场景流通，与 QQ 号、单聊 openid 都不是同一套',
      },
      {
        key: 'duration', label: '禁言时长（秒）', type: 'number', sample: 600,
        desc: '0 表示解除禁言。与 mute_end_timestamp 二选一，至少传一个；代理层映射到官方的 mute_seconds（秒，字符串形态）',
      },
      {
        key: 'mute_end_timestamp', label: '禁言到期时间戳（秒）', type: 'string', sample: '1641916800',
        desc: '绝对时间戳，与 duration 二选一；两者同时传时官方以该字段为准',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PATCH',
            path: '/guilds/{guild_id}/members/{user_id}/mute',
            map: { duration: 'mute_seconds' },
            notes:
              '官方要求 mute_seconds / mute_end_timestamp 都是字符串，由代理层负责序列化；'
              + '两字段同时赋值时官方以 mute_end_timestamp 为准。传 duration=0 即解除禁言。'
              + '本短名只管「频道内某个人」，全员禁言见 mute_guild_all，QQ 群禁言见 set_group_ban',
          },
        },
        requires: '需管理员权限；机器人需被频道添加为管理员',
      },
    },
    examples: {
      request: { guild_id: '123456', user_id: '2823701233424295228', duration: 600 },
      success: null,
      error: { code: 11282, message: '检查是否是管理员未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/patch_guild_member_mute.html',
  },

  /* ───────────────────────── 接口权限 ───────────────────────── */

  {
    name: 'get_api_permission',
    title: '获取频道接口权限列表',
    summary: '查询机器人在某频道内可用（已授权）的接口权限列表。官方专属。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['/guilds/{guild_id}/api_permission'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
    ],
    impl: {
      official: { variants: { '*': { verb: 'GET', path: '/guilds/{guild_id}/api_permission' } } },
    },
    examples: {
      request: { guild_id: '123456' },
      success: {
        apis: [
          {
            path: '/guilds/{guild_id}/members/{user_id}', method: 'GET', desc: '获取当前频道成员信息', auth_status: 0,
          },
          { path: '/channels/{channel_id}/messages', method: 'POST', desc: '创建消息', auth_status: 1 },
        ],
      },
      error: { code: 11264, message: '检查小站（频道）权限未通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/get_guild_api_permission.html',
  },

  {
    name: 'create_api_permission_demand',
    title: '申请频道接口权限',
    summary:
      '在指定子频道发送一条接口权限授权链接，供管理员点击授权。'
      + '官方限制：每个频道每天默认只能发 3 条。',
    category: 'permission',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/api_permission/demand'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '123456' },
      {
        key: 'channel_id', label: '授权链接发往的子频道', type: 'string', idSpace: 'channel_id', sample: '123456',
        desc: '官方文档未标必填，但授权链接总得发到某个子频道',
      },
      {
        key: 'api_identify', label: '接口权限标识', type: 'object',
        sample: { path: '/guilds/{guild_id}', method: 'GET' },
        desc: 'APIPermissionDemandIdentify 对象，含 path 与 method 两个字段',
      },
      {
        key: 'desc', label: '申请说明', type: 'string', sample: '显示频道信息',
        desc: '机器人拿到该接口权限后可以使用的功能描述，会展示在授权链接上',
      },
    ],
    impl: {
      official: {
        variants: { '*': { verb: 'POST', path: '/guilds/{guild_id}/api_permission/demand' } },
        requires: '每个频道每天默认只能发 3 条授权链接',
      },
    },
    examples: {
      request: {
        guild_id: '123456',
        channel_id: '123456',
        api_identify: { path: '/guilds/{guild_id}', method: 'GET' },
        desc: '显示频道信息',
      },
      success: {
        guild_id: 'xxxxxx',
        channel_id: '123456',
        api_identify: { path: '/guilds/{guild_id}', method: 'GET' },
        title: '王者机器人申请授权频道信息接口权限',
        desc: '申请权限后才能正常使用机器人显示频道信息功能',
      },
      error: { code: 11253, message: '检查应用权限不通过' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/api_permissions/post_api_permission_demand.html',
  },
];
