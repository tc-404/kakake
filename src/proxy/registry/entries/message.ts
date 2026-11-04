/**
 * 消息收发类接口。
 *
 * 本文件是整份注册表的**黄金样板**：`send_msg`（发消息，统一入口）展示了最复杂的形态（按 scene 派发、
 * 三协议四个变体、ID 空间分裂、键名映射、常量注入），后续所有 entry 都照它的风格写。
 * 详见同目录 `_CONVENTIONS.md`。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const messageEntries: ProxyApiEntry[] = [
  {
    name: 'send_msg',
    title: '发消息',
    summary: '统一发消息入口：纯文本、单发图片/语音/视频、图文一起发，全部由 message / file 参数的 JSON 形态决定，'
      + '不再按消息类型拆成多条接口。file 同时接受本地绝对路径、http(s) URL 与 base64://，本地与远程资源同权重。'
      + '由 kakake 按当前连接协议决定实际落到哪套接口；官方侧带媒体时自动先上传换 file_info。',
    category: 'message',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'write',
    status: 'stable',
    alias: [
      'send_text', 'send_image',
      'send_group_msg', 'send_private_msg',
      '/v2/users/{openid}/messages', '/v2/groups/{group_openid}/messages',
      '/channels/{channel_id}/messages', '/dms/{guild_id}/messages',
      '/v2/users/{openid}/files', '/v2/groups/{group_openid}/files',
    ],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'group',
        desc: 'group=群聊 / private=私聊 / channel=官方子频道 / dms=官方频道私信。',
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', only: ['napcat', 'snowluma'], sample: 123456, desc: 'scene=group 且当前是野生连接时必填' },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', only: ['official'], sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', desc: 'scene=group 且当前是官方连接时必填' },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', only: ['napcat', 'snowluma'], sample: 10001, desc: 'scene=private 且当前是野生连接时必填' },
      { key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid', only: ['official'], sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D', desc: 'scene=private 且当前是官方连接时必填' },
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', only: ['official'], sample: '1572735', desc: 'scene=channel 时必填' },
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', only: ['official'], sample: '1013531', desc: 'scene=dms（频道私信）时必填' },
      {
        key: 'message', label: '消息内容', type: 'object', required: true, sample: '你好，世界',
        desc: '字符串=纯文本；数组=OneBot 消息段（text/image/record/video 可任意组合，图文一起发就写 [{text},{image}]）。'
          + '媒体段的 data.file 支持本地绝对路径、http(s) URL 与 base64://。',
      },
      {
        key: 'file', label: '单发媒体', type: 'file',
        desc: '便捷单发：一张图 / 一条语音 / 一段视频直接填这里（本地路径 / URL / base64://）。'
          + '与 media_type 搭配，默认按图片处理；与 message 同传时媒体在前、文字在后。',
      },
      {
        key: 'media_type', label: '媒体类型', type: 'string', only: ['napcat', 'snowluma'], sample: 'image',
        desc: 'image / record / video。仅在 file 单发时用来区分媒体种类，默认 image',
      },
      { key: 'summary', label: '图片描述', type: 'string', only: ['napcat', 'snowluma'], desc: '官方侧收进卡片里的摘要文字，野生侧透传' },
      { key: 'auto_escape', label: '纯文本发送', type: 'boolean', only: ['napcat', 'snowluma'], sample: false, desc: '为 true 时不解析消息里的 CQ 码' },
      { key: 'msg_id', label: '被动回复的消息 ID', type: 'string', only: ['official'], desc: '官方要求 5 秒内回复且每消息只能被动回复一次' },
      { key: 'msg_seq', label: '消息序号', type: 'number', only: ['official'] },
      { key: 'event_id', label: '事件 ID', type: 'string', only: ['official'] },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          // OneBot 原生支持消息段数组：文本/图片/语音/视频/混发全走同一条 action。
          // file / media_type 是统一层的便捷键，消费完就丢，不透传给协议端。
          group: { action: 'send_group_msg', drop: ['file', 'media_type'], transforms: { message: 'unifiedSegments' } },
          private: { action: 'send_private_msg', drop: ['file', 'media_type'], transforms: { message: 'unifiedSegments' } },
        },
        // send_text / send_image 旧名已并入本 entry；协议端统一注册名 send_msg 用 sameAs 声明覆盖
        sameAs: ['send_msg'],
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'send_group_msg', drop: ['file', 'media_type'], transforms: { message: 'unifiedSegments' } },
          private: { action: 'send_private_msg', drop: ['file', 'media_type'], transforms: { message: 'unifiedSegments' } },
        },
        sameAs: ['send_msg'],
      },
      official: {
        variantBy: 'scene',
        variants: {
          // 官方：纯文本 msg_type=0 直发；带 file 时 msg_type=7 且 pre 先上传换
          // file_info（本地路径由服务端读成 base64，URL 直接给 url 字段）。
          // skipWhenMissing=file 让纯文本跳过上传步骤——这是「一条接口发所有内容」的关键。
          group: {
            verb: 'POST',
            path: '/v2/groups/{group_openid}/messages',
            map: { message: 'content' },
            drop: ['file', 'media_type'],
            transforms: { msg_type: 'officialMsgType', content: 'officialContentFromMessage' },
            pre: {
              verb: 'POST',
              path: '/v2/groups/{group_openid}/files',
              only: ['file'],
              skipWhenMissing: 'file',
              drop: ['file'],
              transforms: { file_type: 'officialFileType', url: 'officialFileUrl', file_data: 'officialFileData' },
              const: { srv_send_msg: false },
              injectAs: 'media',
              pick: 'file_info',
            },
            notes: '群聊：纯文本 msg_type=0；带媒体 msg_type=7 且先上传 /files 拿 file_info。file_type 随 media_type：图 1 / 视频 2 / 语音 3',
          },
          private: {
            verb: 'POST',
            path: '/v2/users/{openid}/messages',
            map: { message: 'content' },
            drop: ['file', 'media_type'],
            transforms: { msg_type: 'officialMsgType', content: 'officialContentFromMessage' },
            pre: {
              verb: 'POST',
              path: '/v2/users/{openid}/files',
              only: ['file'],
              skipWhenMissing: 'file',
              drop: ['file'],
              transforms: { file_type: 'officialFileType', url: 'officialFileUrl', file_data: 'officialFileData' },
              const: { srv_send_msg: false },
              injectAs: 'media',
              pick: 'file_info',
            },
          },
          channel: {
            verb: 'POST',
            path: '/channels/{channel_id}/messages',
            map: { message: 'content', file: 'image' },
            drop: ['media_type'],
            notes: '子频道消息直接传图片 URL，无需预先上传',
          },
          dms: {
            verb: 'POST',
            path: '/dms/{guild_id}/messages',
            map: { message: 'content', file: 'image' },
            drop: ['media_type'],
          },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, message: [{ type: 'text', data: { text: '看这张图 ' } }, { type: 'image', data: { file: 'C:/tmp/pic.jpg' } }] },
      success: {
        status: 'ok', retcode: 0, data: { message_id: 1728134400 }, message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '发送消息失败: 账号可能被风控', wording: '发送消息失败', echo: null,
      },
      byProtocol: {
        official: {
          request: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', file: 'https://example.com/pic.jpg' },
          success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
          error: { code: 11261, message: '富媒体文件上传失败' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html',
  },



  {
    name: 'recall_msg',
    title: '撤回消息',
    summary: '撤回一条已发出的消息。野生侧撤回任意消息；官方侧撤回自己发的消息有 2 分钟时限。',
    category: 'message',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'write',
    status: 'stable',
    alias: [
      'delete_msg',
      '/channels/{channel_id}/messages/{message_id}',
      '/dms/{guild_id}/messages/{message_id}',
      '/v2/users/{openid}/messages/{message_id}',
      '/v2/groups/{group_openid}/messages/{message_id}',
    ],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'group',
        desc: 'group / private / channel / dms。官方侧不同场景走不同的 DELETE 路径',
      },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: '1728134400' },
      { key: 'channel_id', label: '子频道 ID', type: 'string', idSpace: 'channel_id', only: ['official'], sample: '1572735' },
      { key: 'guild_id', label: '频道 ID', type: 'string', idSpace: 'guild_id', only: ['official'], sample: '1013531' },
      { key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid', only: ['official'], sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D' },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', only: ['official'], sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      { key: 'hidetip', label: '隐藏撤回提示', type: 'boolean', only: ['official'], sample: false, desc: '官方频道撤回时是否隐藏「xx 撤回了一条消息」提示' },
    ],
    impl: {
      napcat: {
        variants: { '*': { action: 'delete_msg' } },
        notes: 'OneBot 的 delete_msg 不需要区分场景，scene 参数会被丢弃',
      },
      snowluma: {
        variants: { '*': { action: 'delete_msg' } },
      },
      official: {
        variantBy: 'scene',
        variants: {
          group: { verb: 'DELETE', path: '/v2/groups/{group_openid}/messages/{message_id}' },
          private: { verb: 'DELETE', path: '/v2/users/{openid}/messages/{message_id}' },
          channel: { verb: 'DELETE', path: '/channels/{channel_id}/messages/{message_id}', map: { hidetip: 'hidetip' } },
          dms: { verb: 'DELETE', path: '/dms/{guild_id}/messages/{message_id}' },
        },
      },
    },
    examples: {
      request: { scene: 'group', message_id: '1728134400' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '撤回失败: 消息超过 2 分钟', wording: '撤回失败', echo: null,
      },
      byProtocol: {
        official: {
          request: { scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D', message_id: '08c0e0b0f1a2b3c4' },
          success: null,
          error: { code: 50003, message: '消息已超过撤回时限' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/delete.html',
  },

  {
    name: 'get_msg',
    title: '获取消息详情',
    summary: '按消息 ID 拉取一条消息的内容与发送者。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_msg'],
    params: [
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134400 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_msg' } } },
      snowluma: { variants: { '*': { action: 'get_msg' } } },
      // 官方 v2 没有「按 ID 取单条消息」的 HTTP 接口（文档未开放），
      // 因此 support 里不列 official —— 调用会自动降级为 unsupported 失败信封。
    },
    examples: {
      request: { message_id: 1728134400 },
      success: {
        status: 'ok',
        retcode: 0,
        data: {
          time: 1728134400,
          message_type: 'group',
          message_id: 1728134400,
          real_id: 1728134400,
          sender: { user_id: 10001, nickname: '某人' },
          message: [{ type: 'text', data: { text: '你好' } }],
        },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '消息不存在', wording: '消息不存在', echo: null,
      },
    },
  },


  {
    name: 'send_forward',
    title: '发送合并转发消息',
    summary: '把一组转发节点打包成一条合并转发消息发出。有群、私聊两个按 scene 派发的原生动作，以及一个自动路由兜底。'
      + '参数依据 SnowLuma 文档化请求体；NapCat 未声明 schema，source / summary / prompt 按 OneBot 通行字段原样透传。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_forward_msg', 'send_group_forward_msg', 'send_private_forward_msg'],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', sample: 'group',
        desc: 'group=群合并转发 / private=私聊合并转发。不传时走 send_forward_msg 的 message_type 自动路由',
      },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001 },
      {
        key: 'messages', label: '转发节点数组', type: 'array', required: true, sample: [{ type: 'node', data: { name: '甲', uin: 10001, content: '原话' } }],
        desc: 'OneBot forward node 数组。节点内 reply.data.message 可自定义引用预览内容',
      },
      { key: 'source', label: '来源描述', type: 'string', desc: '对外展示的来源名称，通常不必填' },
      { key: 'summary', label: '摘要', type: 'string', sample: '10 条聊天记录' },
      { key: 'prompt', label: '提示文案', type: 'string', desc: '对外显示的外层提示，如「群聊的聊天记录」' },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'send_group_forward_msg' },
          private: { action: 'send_private_forward_msg' },
          '*': { action: 'send_forward_msg', notes: '不传 scene 时按 message_type / 群号自动路由' },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'send_group_forward_msg' },
          private: { action: 'send_private_forward_msg' },
          '*': { action: 'send_forward_msg', notes: '不传 scene 时按 message_type / 群号自动路由' },
        },
      },
    },
    examples: {
      request: {
        scene: 'group', group_id: 123456, summary: '10 条聊天记录',
        messages: [{ type: 'node', data: { name: '甲', uin: 10001, content: '你好' } }],
      },
      success: {
        status: 'ok', retcode: 0,
        data: { message_id: 1728134403, res_id: 'Q0b1c2', forward_id: 'fw-1a2b3c' },
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '转发节点为空', wording: '转发节点为空', echo: null,
      },
    },
  },

  {
    name: 'get_forward_msg',
    title: '获取合并转发内容',
    summary: '按消息 ID 拉取一条合并转发消息内部的节点列表。'
      + 'data.messages 每项是一段 OneBot 消息事件，字段随原消息而定，因此示例给出空数组而不编造内部字段；'
      + '带引用内容的节点会保留 reply.id / reply.message / reply.qq / reply.time / reply.seq。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_forward_msg'],
    params: [
      {
        key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134404,
        desc: '合并转发那条消息的 ID。OneBot 侧的 id 参数是同一个含义的历史叫法',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_forward_msg' } } },
      snowluma: { variants: { '*': { action: 'get_forward_msg' } } },
    },
    examples: {
      request: { message_id: 1728134404 },
      success: { status: 'ok', retcode: 0, data: { messages: [] }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '不是合并转发消息', wording: '不是合并转发消息', echo: null,
      },
    },
  },

  {
    name: 'forward_msg',
    title: '转发单条消息',
    summary: '把一条已存在的消息原样转发给某个好友或群，按 scene 派发到两个原生动作。'
      + '返回结构未文档化：两个协议源的成功响应 data 都标注为 unknown，示例里的 data 写 null。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['forward_friend_single_msg', 'forward_group_single_msg'],
    params: [
      { key: 'scene', label: '场景', type: 'string', required: true, sample: 'group', desc: 'group=转发到群 / private=转发给好友' },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134405 },
      { key: 'group_id', label: '目标群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001 },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'forward_group_single_msg' },
          private: { action: 'forward_friend_single_msg' },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'forward_group_single_msg' },
          private: { action: 'forward_friend_single_msg' },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, message_id: 1728134405 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '目标会话不存在', wording: '目标会话不存在', echo: null,
      },
    },
  },

  {
    name: 'mark_msg_as_read',
    title: '标记消息已读',
    summary: '把某个会话的未读清到指定消息为止，按 scene 派发到群、私聊或自动路由三个原生动作。'
      + '返回结构未文档化：源快照 data 标注为 unknown，示例里的 data 写 null；'
      + 'NapCat 侧未声明参数 schema，参数表依据 SnowLuma 快照整理。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['mark_msg_as_read', 'mark_group_msg_as_read', 'mark_private_msg_as_read'],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', sample: 'group',
        desc: 'group=群聊已读 / private=私聊已读。不传时走 mark_msg_as_read 自动路由',
      },
      { key: 'message_id', label: '消息 ID', type: 'string', required: true, idSpace: 'message_id', sample: 1728134406 },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001 },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'mark_group_msg_as_read' },
          private: { action: 'mark_private_msg_as_read' },
          '*': { action: 'mark_msg_as_read' },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'mark_group_msg_as_read' },
          private: { action: 'mark_private_msg_as_read' },
          '*': {
            action: 'mark_msg_as_read',
            notes: 'SnowLuma 的通用变体用 target_id 指代会话，需要直传该原生键时请用 call_native',
          },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, message_id: 1728134406 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '消息不存在或已失效', wording: '标记已读失败', echo: null,
      },
    },
  },

  {
    name: 'mark_all_msg_as_read',
    title: '标记全部消息已读',
    summary: '一次性清空所有会话的未读。原生 action `_mark_all_as_read` 带下划线前缀，'
      + '是协议端内部动作而非公开契约，可能随版本变动；返回结构未文档化，示例 data 写 null。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['_mark_all_as_read'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: '_mark_all_as_read' } } },
      snowluma: { variants: { '*': { action: '_mark_all_as_read' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '清空未读失败', wording: '清空未读失败', echo: null,
      },
    },
  },

  {
    name: 'set_input_status',
    title: '设置输入状态',
    summary: '向好友展示「正在输入」等状态。属于状态展示，实际上不会发出消息。'
      + 'event_type 的枚举值源快照未给出，示例里的 1（正在输入）取自 OneBot 通行约定；'
      + '返回结构未文档化，示例 data 写 null。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['set_input_status'],
    params: [
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', required: true, sample: 10001 },
      { key: 'event_type', label: '事件类型', type: 'number', required: true, sample: 1, desc: '1 = 正在输入；'
        + '具体枚举值源快照未给出，示例值来自 OneBot 通行约定而非快照；'
        + 'SnowLuma 仅强制 user_id，统一接口按 NapCat 契约同时要求此字段' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_input_status' } } },
      snowluma: { variants: { '*': { action: 'set_input_status' } } },
    },
    examples: {
      request: { user_id: 10001, event_type: 1 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '对方不是好友', wording: '设置输入状态失败', echo: null,
      },
    },
  },

  {
    name: 'get_msg_history',
    title: '获取历史消息',
    summary: '按会话拉取历史聊天记录，按 scene 派发到群历史与好友历史两个原生动作。'
      + 'data.messages 每项是一段 OneBot 消息事件，内部字段不固定，因此示例给出空数组。',
    category: 'message',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_msg_history', 'get_friend_msg_history', 'get_history_msg'],
    params: [
      { key: 'scene', label: '场景', type: 'string', required: true, sample: 'group', desc: 'group=群历史 / private=好友历史' },
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', sample: 123456 },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001 },
      {
        key: 'message_id', label: '锚点消息 ID', type: 'string', idSpace: 'message_id',
        desc: '以此为锚点：reverse_order=true 取锚点及更旧，false 取锚点及更新；不传则从服务器拉最新一段',
      },
      { key: 'count', label: '条数', type: 'number', sample: 20 },
      { key: 'reverse_order', label: '反向排序', type: 'boolean', sample: false },
      { key: 'message_seq', label: '起始消息序号', type: 'string', only: ['napcat'] },
      { key: 'disable_get_url', label: '禁用获取 URL', type: 'boolean', only: ['napcat'], sample: false },
      { key: 'parse_mult_msg', label: '解析合并消息', type: 'boolean', only: ['napcat'], sample: true },
      { key: 'quick_reply', label: '快速回复', type: 'boolean', only: ['napcat'], sample: false },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'get_group_msg_history' },
          private: { action: 'get_friend_msg_history' },
        },
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'get_group_msg_history' },
          private: { action: 'get_friend_msg_history' },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, count: 20 },
      success: { status: 'ok', retcode: 0, data: { messages: [] }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '不是群成员或历史为空', wording: '获取历史消息失败', echo: null,
      },
    },
  },

  {
    name: 'send_embed',
    title: '发送 Embed 消息',
    summary: '发送官方 embed 结构化消息（标题、字段、颜色等由调用方拼装）。官方专属能力，野生协议没有等价概念；'
      + '子频道与频道私信的 embed 请求体在源快照里没有定义，故只覆盖群聊与单聊，需要时用 call_native。',
    category: 'message',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/users/{openid}/messages', '/v2/groups/{group_openid}/messages'],
    params: [
      { key: 'scene', label: '场景', type: 'string', required: true, sample: 'group', desc: 'group=官方群聊 / private=官方单聊' },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      { key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid', sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D' },
      {
        key: 'embed', label: 'Embed 结构', type: 'object', required: true,
        sample: { title: '部署结果', prompt: '构建成功', fields: [{ name: '分支', value: 'main' }] },
        desc: '官方 embed 对象，字段名以官方文档为准，代理层原样透传',
      },
      { key: 'msg_id', label: '被动回复的消息 ID', type: 'string', desc: '被动回复时填入；单聊还需 msg_seq，群聊还需 event_id' },
      { key: 'msg_seq', label: '消息序号', type: 'number' },
      { key: 'event_id', label: '事件 ID', type: 'string' },
    ],
    impl: {
      official: {
        variantBy: 'scene',
        variants: {
          group: {
            verb: 'POST',
            path: '/v2/groups/{group_openid}/messages',
            const: { msg_type: 4 },
            notes: 'msg_type=4 即 embed 消息，由代理层注入',
          },
          private: {
            verb: 'POST',
            path: '/v2/users/{openid}/messages',
            const: { msg_type: 4 },
          },
        },
      },
    },
    examples: {
      request: {
        scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
        embed: { title: '部署结果', prompt: '构建成功' },
      },
      success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
      error: { code: 50021, message: 'embed 结构不合法' },
      byProtocol: {
        official: {
          request: {
            scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
            embed: { title: '部署结果', prompt: '构建成功' },
          },
          success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
          error: { code: 50021, message: 'embed 结构不合法' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html',
  },

  {
    name: 'send_ark',
    title: '发送 Ark 消息',
    summary: '发送官方 Ark（模板 23 / 37 等）结构化消息。官方专属能力；'
      + '野生的 send_ark_share（推荐联系人卡片）是另一回事，不要混用。'
      + '同样只覆盖群聊与单聊，子频道 / 私信的 ark 请求体源快照未定义。',
    category: 'message',
    scope: 'official-only',
    support: ['official'],
    risk: 'write',
    status: 'stable',
    alias: ['/v2/users/{openid}/messages', '/v2/groups/{group_openid}/messages'],
    params: [
      { key: 'scene', label: '场景', type: 'string', required: true, sample: 'group', desc: 'group=官方群聊 / private=官方单聊' },
      { key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid', sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D' },
      { key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid', sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D' },
      {
        key: 'ark', label: 'Ark 结构', type: 'object', required: true,
        sample: { template_id: 23, kv: [{ key: '#DESC#', value: '描述' }, { key: '#PROMPT#', value: '提示' }] },
        desc: '官方 ark 对象（template_id + kv），代理层原样透传',
      },
      { key: 'msg_id', label: '被动回复的消息 ID', type: 'string' },
      { key: 'msg_seq', label: '消息序号', type: 'number' },
      { key: 'event_id', label: '事件 ID', type: 'string' },
    ],
    impl: {
      official: {
        variantBy: 'scene',
        variants: {
          group: {
            verb: 'POST',
            path: '/v2/groups/{group_openid}/messages',
            const: { msg_type: 3 },
            notes: 'msg_type=3 即 ark 消息，由代理层注入',
          },
          private: {
            verb: 'POST',
            path: '/v2/users/{openid}/messages',
            const: { msg_type: 3 },
          },
        },
      },
    },
    examples: {
      request: {
        scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
        ark: { template_id: 23, kv: [{ key: '#DESC#', value: '描述' }] },
      },
      success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
      error: { code: 50021, message: 'ark 结构不合法' },
      byProtocol: {
        official: {
          request: {
            scene: 'group', group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
            ark: { template_id: 23, kv: [{ key: '#DESC#', value: '描述' }] },
          },
          success: { id: '08c0e0b0f1a2b3c4d5e6f708192a3b4c', timestamp: '2026-10-24T16:00:00+08:00' },
          error: { code: 50021, message: 'ark 结构不合法' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/send-receive/send.html',
  },

  {
    name: 'send_custom_face',
    title: '发送收藏表情',
    summary: '发送当前账号收藏的表情，保留原生显示样式。SnowLuma 专属，NapCat 没有同名动作；'
      + '表情本身的增删查由 account 类接口负责。',
    category: 'message',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['send_custom_face'],
    params: [
      { key: 'emoji_id', label: '表情 ID', type: 'string', required: true, sample: '9f8e7d6c5b4a39281706f5e4d3c2b1a', desc: '收藏表情的完整 ID，也可填 32 位 MD5' },
      { key: 'group_id', label: '目标群号', type: 'number', idSpace: 'qq_number', sample: 123456, desc: '与 user_id 二选一' },
      { key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number', sample: 10001, desc: '与 group_id 二选一' },
      { key: 'reply_to', label: '回复的消息 ID', type: 'number', idSpace: 'message_id', sample: 1728134408 },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'send_custom_face' } } },
    },
    examples: {
      request: { group_id: 123456, emoji_id: '9f8e7d6c5b4a39281706f5e4d3c2b1a' },
      success: { status: 'ok', retcode: 0, data: { message_id: 1728134409 }, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '表情不存在或不属于当前账号', wording: '发送表情失败', echo: null,
      },
    },
  },
];
