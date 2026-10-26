/**
 * QQ 官方机器人专属接口。
 *
 * 这里放**只有官方有、野生协议完全没有**的能力（原生 markdown / embed / ark /
 * keyboard / 频道禁言等）。判据很简单：NapCat 与 SnowLuma 的 action 集合里都找不到
 * 对应动作，就归到这里，scope 一律 'official-only'，support 只写 ['official']。
 *
 * 「频道公告」「子频道精华」这类名字上像、实际是另一套实体的能力也放这里，
 * 不要和野生的群公告 / 群精华合并 —— 它们是不同对象，合并会造成参数语义错乱。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const officialEntries: ProxyApiEntry[] = [
  {
    name: 'send_markdown',
    title: '发送 Markdown 消息',
    summary: '发送原生 Markdown 消息（官方专属能力）。模板 markdown 需内邀开通。',
    category: 'message',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'experimental',
    alias: ['/v2/users/{openid}/messages', '/v2/groups/{group_openid}/messages', '/channels/{channel_id}/messages'],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'channel',
        desc: 'channel=子频道 / private=单聊 / group=群聊 / dms=频道私信',
      },
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', sample: '1572735' },
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', sample: '1013531' },
      { key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid', sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D' },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      {
        key: 'markdown', label: 'Markdown 内容', type: 'object', required: true,
        sample: { content: '**加粗** 与 `代码`' },
        desc: '对象形态。模板 markdown 时填 { custom_template_id, params }',
      },
      { key: 'keyboard', label: '交互按钮', type: 'object', desc: 'button 键盘结构' },
      { key: 'msg_id', label: '被动回复的消息 ID', type: 'string' },
      { key: 'msg_seq', label: '消息序号', type: 'number' },
      { key: 'event_id', label: '事件 ID', type: 'string' },
    ],
    impl: {
      official: {
        variantBy: 'scene',
        variants: {
          channel: { verb: 'POST', path: '/channels/{channel_id}/messages' },
          dms: { verb: 'POST', path: '/dms/{guild_id}/messages' },
          private: {
            verb: 'POST', path: '/v2/users/{openid}/messages',
            const: { msg_type: 2 },
            notes: 'msg_type=2 即 markdown，由代理层注入',
          },
          group: {
            verb: 'POST', path: '/v2/groups/{group_openid}/messages',
            const: { msg_type: 2 },
          },
        },
        requires: '模板 markdown（custom_template_id）需官方内邀开通',
      },
    },
    examples: {
      request: { scene: 'channel', channel_id: '1572735', markdown: { content: '**加粗**' } },
      success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
      error: { code: 50021, message: 'markdown 内容不合法' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html',
  },

  {
    name: 'mute_guild_all',
    title: '频道全员禁言',
    summary: '对频道全体成员开启/解除禁言。官方专属，且是**频道**不是 QQ 群。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'danger',
    status: 'stable',
    alias: ['/guilds/{guild_id}/mute'],
    params: [
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', required: true, sample: '1013531' },
      {
        key: 'enable', label: '是否禁言', type: 'boolean', required: true, sample: true,
        desc: 'true=全员禁言，false=解除',
      },
      { key: 'duration', label: '禁言时长（秒）', type: 'number', sample: 600 },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PATCH',
            path: '/guilds/{guild_id}/mute',
            notes: '官方此接口同时承载「全员禁言」与「批量禁言」两种语义，靠请求体区分',
          },
        },
      },
    },
    examples: {
      request: { guild_id: '1013531', enable: true, duration: 600 },
      success: null,
      error: { code: 11253, message: '机器人没有该频道的管理权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/mute/manage.html',
  },

  /* ─────────────────────────── 日程 Schedule ─────────────────────────── */

  {
    name: 'get_schedules',
    title: '获取日程列表',
    summary: '获取日程子频道下的日程列表。不传 since 返回当天日程，传 since 返回结束时间在该时间戳之后的日程。',
    category: 'schedule',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/schedules'],
    params: [
      {
        key: 'channel_id', label: '日程子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735', desc: '必须是日程类型的子频道',
      },
      {
        key: 'since', label: '起始时间戳（毫秒）', type: 'number', sample: 1642076400000,
        desc: '返回结束时间在 since 之后的日程；不传则默认返回当天的日程列表',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/schedules',
            notes: 'since 走 query 参数。返回的 start_timestamp / end_timestamp 是毫秒时间戳字符串',
          },
        },
        requires: '仅日程子频道可用；读取公开日程不需要管理权限',
      },
    },
    examples: {
      request: { channel_id: '1572735', since: 1642076400000 },
      success: [
        {
          id: 'xxxxxx',
          name: '上王者',
          start_timestamp: '1642076400000',
          end_timestamp: '1642083600000',
          creator: {
            user: { id: 'xxxxxx', username: 'xxxxxx', bot: true },
            nick: '',
            joined_at: '2022-01-11T10:24:13+08:00',
          },
          jump_channel_id: '0',
          remind_type: '0',
        },
      ],
      error: { code: 302002, message: '查询日程列表失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/get_schedules.html',
  },

  {
    name: 'get_schedule',
    title: '获取日程详情',
    summary: '获取日程子频道下指定 schedule_id 的日程详情。',
    category: 'schedule',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/schedules/{schedule_id}'],
    params: [
      {
        key: 'channel_id', label: '日程子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      { key: 'schedule_id', label: '日程 ID', type: 'string', required: true, sample: '112233' },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/schedules/{schedule_id}',
            notes: 'schedule_id 是日程实体 ID，不是消息 ID，官方未提供除本组接口外的其他取数方式',
          },
        },
      },
    },
    examples: {
      request: { channel_id: '1572735', schedule_id: '112233' },
      success: {
        id: '112233',
        name: '上王者',
        start_timestamp: '1642076400000',
        end_timestamp: '1642083600000',
        creator: {
          user: { id: 'xxxxxx', username: 'xxxxxx', bot: true },
          nick: '',
          joined_at: '2022-01-11T10:24:13+08:00',
        },
        jump_channel_id: '0',
        remind_type: '0',
      },
      error: { code: 302003, message: '查询日程失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/get_schedule.html',
  },

  {
    name: 'create_schedule',
    title: '创建日程',
    summary: '在日程子频道下创建一个日程，返回创建成功的 Schedule 对象。',
    category: 'schedule',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/schedules'],
    params: [
      {
        key: 'channel_id', label: '日程子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'schedule', label: '日程对象', type: 'object', required: true,
        sample: {
          name: '上王者',
          description: '今晚八点',
          start_timestamp: '1642076453000',
          end_timestamp: '1642083653000',
          jump_channel_id: '0',
          remind_type: '0',
        },
        desc: 'Schedule 对象，不需要带 id。start_timestamp / end_timestamp 为毫秒时间戳字符串；'
          + 'remind_type：0 不提醒 / 1 开始时提醒 / 2 开始前5分钟 / 3 开始前15分钟 / 4 开始前30分钟 / 5 开始前60分钟',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/channels/{channel_id}/schedules',
            notes: '官方要求请求体形如 { schedule: {...} }；schedule 内时间戳是毫秒字符串',
          },
        },
        requires: '操作人需有「管理频道」权限，机器人需被设为管理员。'
          + '频次限制：单个管理员每天 10 次，单个频道每天 100 次',
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        schedule: {
          name: '上王者',
          start_timestamp: '1642076453000',
          end_timestamp: '1642083653000',
          jump_channel_id: '0',
          remind_type: '0',
        },
      },
      success: {
        id: 'xxxxxx',
        name: '上王者',
        start_timestamp: '1642076453000',
        end_timestamp: '1642083653000',
        creator: {
          user: { id: 'xxxxxx', username: 'xxxxxx', bot: true },
          nick: '',
          joined_at: '2022-01-13T11:02:21+08:00',
        },
        jump_channel_id: '0',
        remind_type: '0',
      },
      error: { code: 302012, message: '每天只能创建 10 个日程，明天再来吧！' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/post_schedule.html',
  },

  {
    name: 'patch_schedule',
    title: '修改日程',
    summary: '修改日程子频道下指定 schedule_id 的日程。官方是 PATCH 语义，整体传 Schedule 对象。',
    category: 'schedule',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/schedules/{schedule_id}'],
    params: [
      {
        key: 'channel_id', label: '日程子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      { key: 'schedule_id', label: '日程 ID', type: 'string', required: true, sample: '112233' },
      {
        key: 'schedule', label: '日程对象', type: 'object', required: true,
        sample: {
          name: '今晚八点上王者',
          start_timestamp: '1642076453000',
          end_timestamp: '1642083653000',
          jump_channel_id: '0',
          remind_type: '0',
        },
        desc: 'Schedule 对象，不需要带 id；字段含义同 create_schedule',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PATCH',
            path: '/channels/{channel_id}/schedules/{schedule_id}',
            notes: '官方要求请求体形如 { schedule: {...} }',
          },
        },
        requires: '操作人需有「管理频道」权限，机器人需被设为管理员',
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        schedule_id: '112233',
        schedule: {
          name: '今晚八点上王者',
          start_timestamp: '1642076453000',
          end_timestamp: '1642083653000',
          jump_channel_id: '0',
          remind_type: '0',
        },
      },
      success: {
        id: '112233',
        name: '今晚八点上王者',
        start_timestamp: '1642076453000',
        end_timestamp: '1642083653000',
        creator: {
          user: { id: 'xxxxxx', username: 'xxxxxx', bot: true },
          nick: '',
          joined_at: '2022-01-13T11:02:21+08:00',
        },
        jump_channel_id: '0',
        remind_type: '0',
      },
      error: { code: 302010, message: '暂无修改日程权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/patch_schedule.html',
  },

  {
    name: 'delete_schedule',
    title: '删除日程',
    summary: '删除日程子频道下指定 schedule_id 的日程。',
    category: 'schedule',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/schedules/{schedule_id}'],
    params: [
      {
        key: 'channel_id', label: '日程子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      { key: 'schedule_id', label: '日程 ID', type: 'string', required: true, sample: '112233' },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}/schedules/{schedule_id}',
            notes: '成功返回 HTTP 204，无响应体',
          },
        },
        requires: '操作人需有「管理频道」权限，机器人需被设为管理员',
      },
    },
    examples: {
      request: { channel_id: '1572735', schedule_id: '112233' },
      success: null,
      error: { code: 302005, message: '删除日程失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/schedule/delete_schedule.html',
  },

  /* ─────────────────────────── 音频 Audio ─────────────────────────── */

  {
    name: 'set_audio',
    title: '控制子频道音频播放',
    summary: '控制语音子频道内的音频播放：开始播放 / 暂停 / 继续 / 停止。',
    category: 'audio',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'experimental',
    alias: ['/channels/{channel_id}/audio'],
    params: [
      {
        key: 'channel_id', label: '语音子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'status', label: '播放状态', type: 'number', required: true, sample: 0,
        desc: '0=START 开始播放 / 1=PAUSE 暂停 / 2=RESUME 继续 / 3=STOP 停止。'
          + '官方取值为数字，不是字符串枚举',
      },
      {
        key: 'audio_url', label: '音频 URL', type: 'string', sample: 'http://xxxxx.mp3',
        desc: 'status=0（开始播放）时传；其他状态不传',
      },
      {
        key: 'text', label: '状态文本', type: 'string', sample: '简单爱-周杰伦',
        desc: '选填，status=0 时传，用于展示「正在播放」文案',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/channels/{channel_id}/audio',
            notes: '请求体是扁平的 { audio_url, text, status }，不是 { audio_control: {...} } 嵌套结构；'
              + '成功返回空对象 {}',
          },
        },
        requires: '仅限音频类机器人使用，需联系平台申请接口权限',
      },
    },
    examples: {
      request: { channel_id: '1572735', status: 0, audio_url: 'http://xxxxx.mp3', text: '简单爱-周杰伦' },
      success: {},
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/audio_control.html',
  },

  {
    name: 'set_mic',
    title: '机器人上/下麦',
    summary: '让机器人在语音子频道上麦或下麦。enable=true 上麦（PUT），false 下麦（DELETE）。',
    category: 'audio',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'experimental',
    alias: ['/channels/{channel_id}/mic'],
    params: [
      {
        key: 'channel_id', label: '语音子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'enable', label: '是否上麦', type: 'boolean', required: true, sample: true,
        desc: 'true=上麦（PUT /mic），false=下麦（DELETE /mic）',
      },
    ],
    impl: {
      official: {
        variantBy: 'enable',
        variants: {
          true: {
            verb: 'PUT',
            path: '/channels/{channel_id}/mic',
            notes: '上麦，成功返回空对象 {}',
          },
          false: {
            verb: 'DELETE',
            path: '/channels/{channel_id}/mic',
            notes: '下麦，成功返回空对象 {}',
          },
        },
        requires: '仅限音频类机器人使用，需联系平台申请接口权限',
      },
    },
    examples: {
      request: { channel_id: '1572735', enable: true },
      success: {},
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/audio/put_mic.html',
  },

  /* ─────────────────────────── 论坛 Forum ─────────────────────────── */

  {
    name: 'get_threads',
    title: '获取帖子列表',
    summary: '获取话题子频道下的主题（帖子）列表。',
    category: 'forum',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/threads'],
    params: [
      {
        key: 'channel_id', label: '话题子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '2324603',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/threads',
            notes: '官方该接口无分页参数，一次返回全部并通过 is_finish 标记是否拉完（0 否 / 1 是）；'
              + 'thread_info.content 是 RichText 序列化后的字符串',
          },
        },
        requires: '仅私域机器人可用',
      },
    },
    examples: {
      request: { channel_id: '2324603' },
      success: {
        threads: [
          {
            guild_id: '75827011639035987',
            channel_id: '2324603',
            author_id: '144115218680332809',
            thread_info: {
              thread_id: 'B_59101362700301001441152186803328090X60-1645416537',
              title: '帖子标题1',
              content: '{"paragraphs":[{"elems":[{"text":{"text":"发送消息"},"type":1}],"props":{}}]}',
              date_time: '2022-02-21T12:08:57+08:00',
            },
          },
        ],
        is_finish: 1,
      },
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/get_threads_list.html',
  },

  {
    name: 'get_thread',
    title: '获取帖子详情',
    summary: '获取话题子频道下指定 thread_id 的主题详情。',
    category: 'forum',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/threads/{thread_id}'],
    params: [
      {
        key: 'channel_id', label: '话题子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '2324603',
      },
      {
        key: 'thread_id', label: '主题 ID', type: 'string', required: true,
        sample: 'B_79051362477c03001441152186803328090X60-1645413753',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/threads/{thread_id}',
            notes: '返回体是 { thread: {...} }，thread 内含 guild_id / channel_id / author_id / thread_info',
          },
        },
        requires: '仅私域机器人可用',
      },
    },
    examples: {
      request: {
        channel_id: '2324603',
        thread_id: 'B_79051362477c03001441152186803328090X60-1645413753',
      },
      success: {
        thread: {
          guild_id: '75827011639035987',
          channel_id: '2324603',
          author_id: '144115218680332809',
          thread_info: {
            thread_id: 'B_79051362477c03001441152186803328090X60-1645413753',
            title: '帖子标题',
            content: '{"paragraphs":[{"elems":[{"text":{"text":"发送消息"},"type":1}],"props":{}}]}',
            date_time: '2022-02-21T11:22:33+08:00',
          },
        },
      },
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/get_thread.html',
  },

  {
    name: 'create_thread',
    title: '发表帖子',
    summary: '在话题子频道下发表一个主题（帖子）。官方用 PUT 语义，返回异步任务 ID。',
    category: 'forum',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/threads'],
    params: [
      {
        key: 'channel_id', label: '话题子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '2324603',
      },
      { key: 'title', label: '帖子标题', type: 'string', required: true, sample: 'title' },
      {
        key: 'content', label: '帖子内容', type: 'string', required: true, sample: '<html lang="en-US"></html>',
        desc: '按 format 指定的格式组织；format=4 时内容需符合 RichText 结构（详见官方 forum/model.md）',
      },
      {
        key: 'format', label: '文本格式', type: 'number', required: true, sample: 2,
        desc: '1=普通文本 / 2=HTML / 3=Markdown / 4=JSON（RichText）',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/channels/{channel_id}/threads',
            notes: '官方论坛只有这 4 个 HTTP 接口；「评论(post)」「回复(reply)」没有任何 HTTP 接口，'
              + '只能通过 FORUM_POST_CREATE / FORUM_REPLY_CREATE 等 WebSocket 事件感知，无法主动发表',
          },
        },
        requires: '仅私域机器人可用',
      },
    },
    examples: {
      request: { channel_id: '2324603', title: 'title', content: '<html lang="en-US"></html>', format: 2 },
      success: { task_id: '1645413752912602306', create_time: '1645503180' },
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/put_thread.html',
  },

  {
    name: 'delete_thread',
    title: '删除帖子',
    summary: '删除话题子频道下指定 thread_id 的主题。',
    category: 'forum',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/threads/{thread_id}'],
    params: [
      {
        key: 'channel_id', label: '话题子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '2324603',
      },
      {
        key: 'thread_id', label: '主题 ID', type: 'string', required: true,
        sample: 'B_79051362477c03001441152186803328090X60-1645413753',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}/threads/{thread_id}',
            notes: '成功返回 HTTP 204，无响应体。评论 / 回复没有对应的删除接口',
          },
        },
        requires: '仅私域机器人可用',
      },
    },
    examples: {
      request: {
        channel_id: '2324603',
        thread_id: 'B_79051362477c03001441152186803328090X60-1645413753',
      },
      success: null,
      error: { code: 11253, message: '机器人未获得该接口权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/forum/delete_thread.html',
  },

  /* ─────────────────────── 子频道精华 Pins ─────────────────────── */

  {
    name: 'mark_pin',
    title: '添加子频道精华消息',
    summary: '把子频道内某条消息设为精华消息。与野生的「群精华」是不同实体，不要混用。',
    category: 'pin',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/pins/{message_id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/channels/{channel_id}/pins/{message_id}',
            notes: '这是「子频道精华消息」，和野生的群精华 set_essence_msg / delete_essence_msg '
              + '不是同一套实体，参数与返回都不同，因此不合并。'
              + '官方限制：单个子频道最多 20 条精华，且只有可见消息才能被设为精华',
          },
        },
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
      },
      success: {
        guild_id: 'xxxxxx',
        channel_id: '1572735',
        message_ids: ['08c0e0b0f1a2b3c4d5e6f708192a3b4c'],
      },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/put_pins_message.html',
  },

  {
    name: 'unmark_pin',
    title: '删除子频道精华消息',
    summary: '删除子频道内某条精华消息；message_id 传 all 表示清空该子频道全部精华。',
    category: 'pin',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/pins/{message_id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
        desc: '填 all 表示删除该子频道内全部精华消息',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}/pins/{message_id}',
            notes: '与野生的群精华删除不是同一套实体。成功返回 HTTP 204，无响应体',
          },
        },
      },
    },
    examples: {
      request: { channel_id: '1572735', message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c' },
      success: null,
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/delete_pins_message.html',
  },

  {
    name: 'get_pins',
    title: '获取子频道精华消息',
    summary: '获取子频道内全部精华消息的 message_id 列表。',
    category: 'pin',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/pins'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/pins',
            notes: '只返回 message_id 数组，不含消息正文；要拿正文需再按 message_id 取消息',
          },
        },
      },
    },
    examples: {
      request: { channel_id: '1572735' },
      success: {
        guild_id: 'xxxxxx',
        channel_id: '1572735',
        message_ids: ['08c0e0b0f1a2b3c4d5e6f708192a3b4c'],
      },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/pins/get_pins_message.html',
  },

  /* ─────────────────────── 频道公告 Announces ─────────────────────── */

  {
    name: 'create_guild_announce',
    title: '创建频道公告',
    summary: '创建频道全局公告：消息类型（设某条消息为成员公告）或推荐子频道类型。',
    category: 'announce',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/announces'],
    params: [
      {
        key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id',
        required: true, sample: '1013531',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
        desc: '有值时优先创建「消息类型」的频道公告（只能是成员公告），此时 channel_id 必填；'
          + '创建推荐子频道类型公告请留空并传 announces_type 与 recommend_channels',
      },
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        sample: '1572735', desc: 'message_id 有值时必填，指该消息所在子频道',
      },
      {
        key: 'announces_type', label: '公告类别', type: 'number', sample: 0,
        desc: '0=成员公告（默认） / 1=欢迎公告',
      },
      {
        key: 'recommend_channels', label: '推荐子频道列表', type: 'array',
        sample: [{ channel_id: '1572735', introduce: '推荐语' }],
        desc: 'RecommendChannel 数组 [{ channel_id, introduce }]，会一次全部替换原有推荐列表；'
          + '同频道最多 3 条，且只有全体成员可见的子频道才能被推荐',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/guilds/{guild_id}/announces',
            notes: '这是「频道公告」，和野生的群公告 _send_group_notice 不是同一套实体，不合并。'
              + '推荐子频道与消息类型公告互相顶替，不能同时存在',
          },
        },
      },
    },
    examples: {
      request: {
        guild_id: '1013531',
        channel_id: '1572735',
        message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
      },
      success: {
        guild_id: '1013531',
        channel_id: '1572735',
        message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
        announces_type: 0,
        recommend_channels: [],
      },
      error: { code: 11253, message: '机器人没有该频道的管理权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/post_guild_announces.html',
  },

  {
    name: 'delete_guild_announce',
    title: '删除频道公告',
    summary: '删除频道下指定 message_id 的全局公告；传 all 表示不校验 message_id 直接删除。',
    category: 'announce',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/guilds/{guild_id}/announces/{message_id}'],
    params: [
      {
        key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id',
        required: true, sample: '1013531',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
        desc: '有值时会校验 message_id 合法性；不校验请填 all',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/guilds/{guild_id}/announces/{message_id}',
            notes: '删除推荐子频道类型的频道公告同样走这个接口，message_id 设为 all。'
              + '成功返回 HTTP 204，无响应体',
          },
        },
      },
    },
    examples: {
      request: { guild_id: '1013531', message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c' },
      success: null,
      error: { code: 11253, message: '机器人没有该频道的管理权限' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_guild_announces.html',
  },

  {
    name: 'create_channel_announce',
    title: '创建子频道公告',
    summary: '把子频道内某条消息设为子频道公告。官方文档标注「2022年3月15日后废弃」，建议改用 mark_pin。',
    category: 'announce',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stub',
    alias: ['/channels/{channel_id}/announces'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'POST',
            path: '/channels/{channel_id}/announces',
            stub: true,
            notes: '官方文档标题即为「创建子频道公告（2022年3月15日后废弃）」，APP v8.8.65 后不保证完全兼容，'
              + '官方建议改用「添加精华消息」即 mark_pin。保留此条目仅为兼容老代码，新代码请用 mark_pin',
          },
        },
      },
    },
    examples: {
      request: { channel_id: '1572735', message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c' },
      success: {
        guild_id: 'xxxxxx',
        channel_id: '1572735',
        message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
      },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/post_channel_announces.html',
  },

  {
    name: 'delete_channel_announce',
    title: '删除子频道公告',
    summary: '删除子频道下指定 message_id 的子频道公告。官方文档标注「2022年3月15日后废弃」，建议改用 unmark_pin。',
    category: 'announce',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stub',
    alias: ['/channels/{channel_id}/announces/{message_id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c0e0b0f1a2b3c4d5e6f708192a3b4c',
        desc: '有值时会校验 message_id 合法性；不校验请填 all',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}/announces/{message_id}',
            stub: true,
            notes: '官方文档标题即为「删除子频道公告（2022年3月15日后废弃）」，APP v8.8.65 后不保证完全兼容，'
              + '官方建议改用「删除精华消息」即 unmark_pin。保留此条目仅为兼容老代码。'
              + '成功返回 HTTP 204，无响应体',
          },
        },
      },
    },
    examples: {
      request: { channel_id: '1572735', message_id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c' },
      success: null,
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/content/announces/delete_channel_announces.html',
  },

  /* ─────────────────────── 表态 Reaction ─────────────────────── */

  {
    name: 'add_reaction',
    title: '发表表情表态',
    summary: '对子频道内某条消息发表表情表态。目前官方仅支持在频道内使用。',
    category: 'reaction',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
      },
      {
        key: 'type', label: '表情类型', type: 'number', required: true, sample: 1,
        desc: 'EmojiType：1=系统表情 / 2=emoji 表情',
      },
      {
        key: 'id', label: '表情 ID', type: 'string', required: true, sample: '203',
        desc: 'type=1 时为系统表情数字 ID，type=2 时为 emoji 的 unicode 码点（详见官方 openapi/emoji/model.md）',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}',
            notes: 'type 与 id 都在路径上，没有请求体。成功返回 HTTP 204，无响应体。'
              + '表态对象只能是子频道消息，官方未提供群聊 / 单聊的表态接口。'
              + '注意：本接口仅支持频道子频道，野生机器人的表情点赞请用 set_msg_emoji_like',
          },
        },
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        message_id: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
        type: 1,
        id: '203',
      },
      success: null,
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/emoji.html',
  },

  {
    name: 'remove_reaction',
    title: '删除表情表态',
    summary: '删除机器人自己对某条消息发表的表情表态。',
    category: 'reaction',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
      },
      {
        key: 'type', label: '表情类型', type: 'number', required: true, sample: 1,
        desc: 'EmojiType：1=系统表情 / 2=emoji 表情',
      },
      { key: 'id', label: '表情 ID', type: 'string', required: true, sample: '203' },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'DELETE',
            path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}',
            notes: '只能删除机器人自己的表态，删不了别人的。成功返回 HTTP 204，无响应体。'
              + '注意：本接口仅支持频道子频道，野生机器人的表情点赞请用 set_msg_emoji_like',
          },
        },
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        message_id: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
        type: 1,
        id: '203',
      },
      success: null,
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/emoji.html',
  },

  {
    name: 'get_reaction_users',
    title: '获取表态用户列表',
    summary: '拉取对某条消息指定表情表态的用户列表，带 cookie 游标分页。',
    category: 'reaction',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}'],
    params: [
      {
        key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id',
        required: true, sample: '1572735',
      },
      {
        key: 'message_id', label: '消息 ID', type: 'string', idSpace: 'message_id',
        required: true, sample: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
      },
      {
        key: 'type', label: '表情类型', type: 'number', required: true, sample: 1,
        desc: 'EmojiType：1=系统表情 / 2=emoji 表情',
      },
      { key: 'id', label: '表情 ID', type: 'string', required: true, sample: '203' },
      {
        key: 'limit', label: '每页数量', type: 'number', sample: 20,
        desc: '默认 20，最多 50，只在第一次请求时设置',
      },
      {
        key: 'cookie', label: '分页游标', type: 'string', sample: '1_2',
        desc: '上次请求返回的 cookie，第一次请求无需填写',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/channels/{channel_id}/messages/{message_id}/reactions/{type}/{id}',
            notes: 'limit 与 cookie 走 query 参数；用返回的 cookie 翻下一页，is_end=true 表示拉完。'
              + '注意：本接口仅支持频道子频道，野生机器人的表情点赞列表请用 get_emoji_likes',
          },
        },
      },
    },
    examples: {
      request: {
        channel_id: '1572735',
        message_id: '08c095b7ba8ed4abd7e00110cbd83f3841489aa2bd9006',
        type: 1,
        id: '203',
        limit: 20,
      },
      success: {
        users: [
          {
            id: '1158788878435714165',
            username: '频道机器人',
            avatar: 'http://thirdqq.qlogo.cn/g?b=oidb&k=T2qBkyqicopYXA5mn0lBkqA&s=0&t=1635736336',
          },
        ],
        cookie: '1_2',
        is_end: false,
      },
      error: { code: 10003, message: 'UnknownChannel 子频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/emoji.html',
  },

  /* ─────────────────────── 交互 Interaction ─────────────────────── */

  {
    name: 'handle_interaction',
    title: '回应交互按钮回调',
    summary: '收到 INTERACTION_CREATE 事件后调用本接口回应，否则客户端会一直 loading 直到超时。',
    category: 'interaction',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/interactions/{interaction_id}'],
    params: [
      {
        key: 'interaction_id', label: '交互事件 ID', type: 'string', required: true,
        sample: '30540ff7-9d8f-4737-83f1-e116ce6afa8b',
        desc: '取自 INTERACTION_CREATE 事件的 id 字段',
      },
      {
        key: 'code', label: '处理结果', type: 'number', required: true, sample: 0,
        desc: '0=成功 / 1=操作失败 / 2=操作频繁 / 3=重复操作 / 4=没有权限 / 5=仅管理员操作',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'PUT',
            path: '/interactions/{interaction_id}',
            notes: '请求体只有 { code }；成功返回空。WebSocket 推送是单向的，不回应客户端会一直转圈',
          },
        },
      },
    },
    examples: {
      request: { interaction_id: '30540ff7-9d8f-4737-83f1-e116ce6afa8b', code: 0 },
      success: null,
      error: { code: 11252, message: '检查应用权限失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/trans/msg-btn.html',
  },

  /* ─────────────────────── 频道消息频率设置 ─────────────────────── */

  {
    name: 'get_message_setting',
    title: '获取频道消息频率设置',
    summary: '获取机器人在某频道内的主动消息频率设置（是否允许发主动消息、允许推送的子频道与条数）。',
    category: 'guild',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/guilds/{guild_id}/message/setting'],
    params: [
      {
        key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id',
        required: true, sample: '1013531',
      },
    ],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/guilds/{guild_id}/message/setting',
            notes: '官方 model 里 disable_create_dm / disable_push_msg 标的是 string，'
              + '但接口示例返回的是布尔值，此处以示例为准，不做类型转换',
          },
        },
      },
    },
    examples: {
      request: { guild_id: '1013531' },
      success: {
        disable_create_dm: true,
        disable_push_msg: false,
        channel_ids: ['1146313', '2651849', '2651149'],
        channel_push_max_num: 12,
      },
      error: { code: 10004, message: 'UnknownGuild 频道异常' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/channel/speak/setting/message_setting.html',
  },

  /* ─────────────────────── Gateway 接入点 ─────────────────────── */

  {
    name: 'get_gateway',
    title: '获取通用 WSS 接入点',
    summary: '获取通用 WebSocket 接入地址，用于建立事件长连接。官方专属，野生侧由连接层自行管理。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/gateway'],
    params: [],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/gateway',
            notes: '日常由 kakake 的连接层自行调用；暴露出来是给需要自建连接的插件用',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { url: 'wss://api.sgroup.qq.com/websocket/' },
      error: { code: 11242, message: '校验 token 失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/url_get.html',
  },

  {
    name: 'get_gateway_bot',
    title: '获取带分片的 WSS 接入点',
    summary: '获取 WebSocket 接入地址及建议分片数、Session 创建限额信息。',
    category: 'system',
    scope: 'official-only',
    support: ['official'],
    risk: 'read',
    status: 'stable',
    alias: ['/gateway/bot'],
    params: [],
    impl: {
      official: {
        variants: {
          '*': {
            verb: 'GET',
            path: '/gateway/bot',
            notes: 'session_start_limit：total=每 24h 可创建 Session 数，remaining=剩余，'
              + 'reset_after=重置剩余时间(ms)，max_concurrency=每 5s 可创建数',
          },
        },
      },
    },
    examples: {
      request: {},
      success: {
        url: 'wss://api.sgroup.qq.com/websocket/',
        shards: 9,
        session_start_limit: {
          total: 1000,
          remaining: 999,
          reset_after: 14400000,
          max_concurrency: 1,
        },
      },
      error: { code: 11242, message: '校验 token 失败' },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/openapi/wss/shard_url_get.html',
  },
];
