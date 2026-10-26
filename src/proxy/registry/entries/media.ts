import type { ProxyApiEntry } from '../../proxy.types.js';

/**
 * 富媒体：图片/语音/视频/文件上传下载、OCR、群相册、闪传文件集、在线文件、流式传输。
 *
 * 写入约定见同目录 `_CONVENTIONS.md`，风格参照 `message.ts` 的 `send_text`。
 *
 * 收录边界（与其他文件的分工，重叠处以各自文件为准）：
 *   - 本文件收：upload_* / download_* / *file* / *record* / ocr_* / translate_* /
 *     get_image / get_file / 群相册（album）/ 闪传文件集（fileset、flash）/
 *     在线文件（online file）/ 流式传输（stream）/ 底层发包 send_packet
 *   - 让给 system.ts：can_send_image、can_send_record、get_rkey、get_rkey_server、
 *     nc_get_rkey、nc_get_packet_status、clean_stream_temp_file（源快照里这些一律打的是
 *     「系统接口 / 系统扩展」标签，system.ts 已各自建条目）
 *   - 让给 message.ts / wild.ts：send_flash_msg（wild.ts 已建）
 *   - 不收：自定义表情与表情收藏（add_custom_face、create_collection 等，归 account.ts）、
 *           消息表态（set_msg_emoji_like、get_emoji_likes 等，归 message.ts）、
 *           纯消息发送（send_msg / send_forward_msg 等，归 message.ts）
 *
 * 返回结构说明：NapCat 与 SnowLuma 两份源快照都没有给出 returnSchema（NapCat 侧大量为
 * Type.Any()），因此除少数明确可推断的之外，`examples.success.data` 一律写 `null`，
 * 并在 summary / variant notes 里标注「返回结构未在源快照中文档化」——宁可信息少，不可信息假。
 */
export const mediaEntries: ProxyApiEntry[] = [
  {
    name: 'upload_file',
    title: '上传文件',
    summary: '把一个文件上传到群聊或私聊。野生侧落到群文件/私聊文件接口；官方侧走富媒体上传接口，'
      + '返回可随消息发出的 file_info。两侧返回结构均未在源快照中文档化。',
    category: 'media',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'write',
    status: 'stable',
    alias: [
      'upload_group_file', 'upload_private_file',
      '/v2/users/{openid}/files', '/v2/groups/{group_openid}/files',
    ],
    params: [
      {
        key: 'scene', label: '场景', type: 'string', required: true, sample: 'group',
        desc: 'group=上传到群文件 / private=上传到私聊会话。官方连接同样是这两种',
      },
      {
        key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number',
        only: ['napcat', 'snowluma'], sample: 123456, desc: 'scene=group 且当前是野生连接时必填',
      },
      {
        key: 'group_openid', label: '群 openid', type: 'string', idSpace: 'group_openid',
        only: ['official'], sample: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
        desc: 'scene=group 且当前是官方连接时必填',
      },
      {
        key: 'user_id', label: '目标 QQ 号', type: 'number', idSpace: 'qq_number',
        only: ['napcat', 'snowluma'], sample: 10001, desc: 'scene=private 且当前是野生连接时必填',
      },
      {
        key: 'openid', label: '用户 openid', type: 'string', idSpace: 'openid',
        only: ['official'], sample: 'AF4C2B8D1E5F4A6B8C0D2E4F6A8B0C2D',
        desc: 'scene=private 且当前是官方连接时必填',
      },
      {
        key: 'file', label: '文件', type: 'file', required: true, sample: 'C:/tmp/report.zip',
        desc: '本地绝对路径或 http(s) URL。官方接口只接受 http(s) URL，传本地路径会失败',
      },
      {
        key: 'name', label: '文件名', type: 'string', only: ['napcat', 'snowluma'],
        sample: 'report.zip', desc: '保存到群文件/私聊时使用的文件名',
      },
      {
        key: 'folder', label: '父目录 ID', type: 'string', only: ['napcat', 'snowluma'],
        sample: '/', desc: '群文件父目录 ID，留空为根目录；私聊场景无此参数',
      },
      {
        key: 'file_type', label: '文件类型', type: 'number', only: ['official'], sample: 1,
        desc: '1=图片 / 2=视频 / 3=语音 / 4=文件',
      },
    ],
    impl: {
      napcat: {
        variantBy: 'scene',
        variants: {
          group: { action: 'upload_group_file', const: { upload_file: true } },
          private: { action: 'upload_private_file', const: { upload_file: true } },
        },
        notes: 'upload_file 是 Go-CQHTTP 遗留的「是否真正落盘上传」开关，固定为 true',
      },
      snowluma: {
        variantBy: 'scene',
        variants: {
          group: { action: 'upload_group_file', const: { upload_file: true } },
          private: { action: 'upload_private_file', const: { upload_file: true } },
        },
      },
      official: {
        variantBy: 'scene',
        variants: {
          group: {
            verb: 'POST',
            path: '/v2/groups/{group_openid}/files',
            map: { file: 'url' },
            const: { srv_send_msg: false },
            drop: ['name', 'folder'],
            notes: 'srv_send_msg=false 表示只上传不发送；要连发消息请用 send_image / send_text 系列',
          },
          private: {
            verb: 'POST',
            path: '/v2/users/{openid}/files',
            map: { file: 'url' },
            const: { srv_send_msg: false },
            drop: ['name', 'folder'],
          },
        },
      },
    },
    examples: {
      request: { scene: 'group', group_id: 123456, file: 'C:/tmp/report.zip', name: 'report.zip' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传失败: 文件不存在或无权限', wording: '上传失败', echo: null,
      },
      byProtocol: {
        official: {
          request: {
            scene: 'group',
            group_openid: '9A0B0C1D2E3F4A5B6C7D8E9F0A1B2C3D',
            file: 'https://example.com/report.zip',
            file_type: 4,
          },
          success: { file_info: 'NDIzMTU4...' },
          error: { code: 11261, message: '富媒体文件上传失败' },
        },
      },
    },
    docUrl: 'https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/rich-media.html',
  },


  {
    name: 'download_file',
    title: '下载文件到本地',
    summary: '把一个网络文件（URL 或 base64）下载到机器人的 data/downloads 目录。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['download_file'],
    params: [
      { key: 'url', label: '下载链接', type: 'string', sample: 'https://example.com/a.zip' },
      { key: 'base64', label: 'Base64 数据', type: 'string', desc: '与 url 二选一' },
      { key: 'name', label: '保存文件名', type: 'string', sample: 'a.zip' },
      {
        key: 'headers', label: '请求头', type: 'array', sample: ['Referer: https://example.com'],
        desc: '字符串数组；部分协议端也接受单个字符串',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'download_file' } } },
      snowluma: { variants: { '*': { action: 'download_file' } } },
    },
    examples: {
      request: { url: 'https://example.com/a.zip', name: 'a.zip' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '下载失败: 链接不可达', wording: '下载失败', echo: null,
      },
    },
  },





  {
    name: 'get_group_root_files',
    title: '获取群根目录文件列表',
    summary: '列出群文件根目录下的文件与文件夹。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_root_files'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'file_count', label: '数量', type: 'number', sample: 50,
        desc: '一次返回的文件数量，默认 50',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_root_files' } } },
      snowluma: { variants: { '*': { action: 'get_group_root_files' } } },
    },
    examples: {
      request: { group_id: 123456, file_count: 50 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群文件列表失败: 不是群成员', wording: '获取群文件列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_files_by_folder',
    title: '获取群子目录文件列表',
    summary: '列出群文件某个子目录下的文件与子文件夹。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_files_by_folder'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'folder_id', label: '文件夹 ID', type: 'string', sample: '/a1b2c3',
        desc: '不传时行为由协议端决定（多数实现等同于根目录）',
      },
      { key: 'file_count', label: '数量', type: 'number', sample: 50, only: ['napcat'] },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_files_by_folder' } } },
      snowluma: { variants: { '*': { action: 'get_group_files_by_folder' } } },
    },
    examples: {
      request: { group_id: 123456, folder_id: '/a1b2c3' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '目录不存在', wording: '目录不存在', echo: null,
      },
    },
  },

  {
    name: 'create_group_file_folder',
    title: '创建群文件夹',
    summary: '在群文件系统中新建一个文件夹。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['create_group_file_folder'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'name', label: '文件夹名称', type: 'string', required: true, sample: '活动照片' },
      {
        key: 'parent_id', label: '父目录 ID', type: 'string', only: ['snowluma'],
        desc: '留空表示建在根目录',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'create_group_file_folder' } } },
      snowluma: { variants: { '*': { action: 'create_group_file_folder' } } },
    },
    examples: {
      request: { group_id: 123456, name: '活动照片' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '创建文件夹失败: 无管理权限', wording: '创建文件夹失败', echo: null,
      },
    },
  },

  {
    name: 'delete_group_file',
    title: '删除群文件',
    summary: '删除群文件系统中的指定文件。群文件删除对全群可见且不可恢复，属危险操作。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_group_file'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
      {
        key: 'bus_id', label: '业务 ID', type: 'number', sample: 102,
        desc: '文件业务 ID；不传时协议端取文件列表里的 busid',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'delete_group_file' } } },
      snowluma: { variants: { '*': { action: 'delete_group_file' } } },
    },
    examples: {
      request: { group_id: 123456, file_id: '/a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除失败: 需要群主或管理员权限', wording: '删除失败', echo: null,
      },
    },
  },

  {
    name: 'delete_group_folder',
    title: '删除群文件夹',
    summary: '删除群文件系统中的指定文件夹。不可恢复，属危险操作。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_group_folder'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'folder_id', label: '文件夹 ID', type: 'string', required: true, sample: '/a1b2c3' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'delete_group_folder' } } },
      snowluma: { variants: { '*': { action: 'delete_group_folder' } } },
    },
    examples: {
      request: { group_id: 123456, folder_id: '/a1b2c3' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除失败: 需要群主或管理员权限', wording: '删除失败', echo: null,
      },
    },
  },

  {
    name: 'delete_group_file_folder',
    title: '删除群文件夹（SnowLuma 兼容名）',
    summary: '删除群文件夹。SnowLuma 的 OpenAPI 同时暴露了 delete_group_folder 与 '
      + 'delete_group_file_folder 两个语义相同的接口，本条覆盖后者以保证老接口名仍可调用；'
      + '新代码请优先用 delete_group_folder。',
    category: 'media',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['delete_group_file_folder'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'folder_id', label: '文件夹 ID', type: 'string', required: true, sample: '/a1b2c3' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'delete_group_file_folder' } } },
    },
    examples: {
      request: { group_id: 123456, folder_id: '/a1b2c3' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除失败: 需要群主或管理员权限', wording: '删除失败', echo: null,
      },
    },
  },

  {
    name: 'rename_group_file',
    title: '重命名群文件',
    summary: '修改群文件系统中某个文件的名字。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['rename_group_file'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
      { key: 'new_name', label: '新文件名', type: 'string', required: true, sample: '报表-最终版.xlsx' },
      {
        key: 'current_parent_directory', label: '当前父目录', type: 'string',
        only: ['napcat'], sample: '/', desc: 'NapCat 要求必填；SnowLuma 下可省略',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'rename_group_file' } } },
      snowluma: { variants: { '*': { action: 'rename_group_file' } } },
    },
    examples: {
      request: {
        group_id: 123456, file_id: '/a1b2c3-d4e5',
        new_name: '报表-最终版.xlsx', current_parent_directory: '/',
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '重命名失败: 文件不存在', wording: '重命名失败', echo: null,
      },
    },
  },

  {
    name: 'rename_group_file_folder',
    title: '重命名群文件夹',
    summary: '修改群文件系统中某个文件夹的名字。仅 SnowLuma 提供；返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['rename_group_file_folder'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'folder_id', label: '文件夹 ID', type: 'string', required: true, sample: '/a1b2c3' },
      { key: 'new_folder_name', label: '新名称', type: 'string', required: true, sample: '2026 活动' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'rename_group_file_folder' } } },
    },
    examples: {
      request: { group_id: 123456, folder_id: '/a1b2c3', new_folder_name: '2026 活动' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '重命名失败: 文件夹不存在', wording: '重命名失败', echo: null,
      },
    },
  },

  {
    name: 'move_group_file',
    title: '移动群文件',
    summary: '把群文件从一个目录移动到另一个目录。两侧参数命名不同，由代理层按协议改写键名。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['move_group_file'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
      { key: 'current_parent_directory', label: '当前父目录', type: 'string', required: true, sample: '/' },
      { key: 'target_parent_directory', label: '目标父目录', type: 'string', required: true, sample: '/archive' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'move_group_file' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'move_group_file',
            map: {
              current_parent_directory: 'parent_directory',
              target_parent_directory: 'target_directory',
            },
            notes: 'SnowLuma 用 parent_directory / target_directory 这对键名',
          },
        },
      },
    },
    examples: {
      request: {
        group_id: 123456, file_id: '/a1b2c3-d4e5',
        current_parent_directory: '/', target_parent_directory: '/archive',
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '移动失败: 目标目录不存在', wording: '移动失败', echo: null,
      },
    },
  },

  {
    name: 'trans_group_file',
    title: '转存群文件',
    summary: '把群里的一个文件转存（转发到自己的文件中转站）。'
      + '两家都有同名接口，但参数与返回均未在源快照中完整文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['trans_group_file'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'trans_group_file' } } },
      snowluma: { variants: { '*': { action: 'trans_group_file' } } },
    },
    examples: {
      request: { group_id: 123456, file_id: '/a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '转存失败: 文件不存在', wording: '转存失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_file_url',
    title: '获取群文件下载链接',
    summary: '按群号 + 文件 ID 换取群文件的下载直链。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_file_url'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
      { key: 'busid', label: '业务 ID', type: 'number', only: ['snowluma'], sample: 102 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_file_url' } } },
      snowluma: { variants: { '*': { action: 'get_group_file_url' } } },
    },
    examples: {
      request: { group_id: 123456, file_id: '/a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取下载链接失败: 文件不存在', wording: '获取下载链接失败', echo: null,
      },
    },
  },

  {
    name: 'get_private_file_url',
    title: '获取私聊文件下载链接',
    summary: '按文件 ID 换取私聊文件的下载直链。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_private_file_url'],
    params: [
      { key: 'file_id', label: '文件 ID', type: 'string', required: true, sample: '/a1b2c3-d4e5' },
      { key: 'user_id', label: '对方 QQ 号', type: 'number', idSpace: 'qq_number', only: ['snowluma'], sample: 10001 },
      { key: 'file_hash', label: '文件哈希', type: 'string', only: ['snowluma'] },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_private_file_url' } } },
      snowluma: { variants: { '*': { action: 'get_private_file_url' } } },
    },
    examples: {
      request: { file_id: '/a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取下载链接失败: 文件已过期', wording: '获取下载链接失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_file_system_info',
    title: '获取群文件系统信息',
    summary: '查询群文件系统的空间占用与状态。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_file_system_info'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_file_system_info' } } },
      snowluma: { variants: { '*': { action: 'get_group_file_system_info' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群文件系统信息失败', wording: '获取群文件系统信息失败', echo: null,
      },
    },
  },

  {
    name: 'get_file',
    title: '获取文件信息',
    summary: '获取指定文件的信息与下载路径。SnowLuma 文档注明仅覆盖图片/语音缓存，'
      + '群文件请用 get_group_file_url；NapCat 侧参数表未在源快照中给出。返回结构未文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_file'],
    params: [
      { key: 'file_id', label: '文件 ID', type: 'string', sample: 'a1b2c3-d4e5' },
      { key: 'file', label: '文件', type: 'file', sample: 'C:/tmp/pic.jpg', desc: '与 file_id 二选一' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_file' } } },
      snowluma: { variants: { '*': { action: 'get_file' } } },
    },
    examples: {
      request: { file_id: 'a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '文件不存在或已过期', wording: '文件不存在或已过期', echo: null,
      },
    },
  },

  {
    name: 'get_image',
    title: '获取图片信息',
    summary: '获取指定图片的信息与本地路径。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_image'],
    params: [
      { key: 'file_id', label: '图片 ID', type: 'string', sample: 'a1b2c3-d4e5' },
      { key: 'file', label: '图片', type: 'file', sample: 'https://example.com/pic.jpg', desc: '与 file_id 二选一' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_image' } } },
      snowluma: { variants: { '*': { action: 'get_image' } } },
    },
    examples: {
      request: { file_id: 'a1b2c3-d4e5' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '图片不存在', wording: '图片不存在', echo: null,
      },
    },
  },

  {
    name: 'get_record',
    title: '获取语音',
    summary: '获取指定语音文件的信息；传 out_format 时由服务端转码。'
      + '返回结构未在源快照中文档化（SnowLuma 注明转码时会附带 base64）。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_record'],
    params: [
      {
        key: 'out_format', label: '输出格式', type: 'string', required: true, sample: 'mp3',
        desc: '如 mp3 / amr / silk / wav。NapCat 侧标记为必填；SnowLuma 侧可省略以只取信息',
      },
      { key: 'file', label: '语音', type: 'file', sample: 'https://example.com/voice.amr' },
      { key: 'file_id', label: '语音 ID', type: 'string', desc: '与 file 二选一' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_record' } } },
      snowluma: { variants: { '*': { action: 'get_record' } } },
    },
    examples: {
      request: { file_id: 'a1b2c3-d4e5', out_format: 'mp3' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '语音不存在或格式不支持', wording: '语音不存在或格式不支持', echo: null,
      },
    },
  },



  {
    name: 'get_ptt_text',
    title: '获取语音转文字结果',
    summary: '按消息 ID 取一条语音消息的转文字结果。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['fetch_ptt_text'],
    params: [
      {
        key: 'message_id', label: '消息 ID', type: 'string', required: true,
        idSpace: 'message_id', sample: 1728134400, desc: '语音消息的消息 ID',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'fetch_ptt_text' } } },
      snowluma: { variants: { '*': { action: 'fetch_ptt_text' } } },
    },
    examples: {
      request: { message_id: 1728134400 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '该消息不是语音或尚未转写完成', wording: '该消息不是语音或尚未转写完成', echo: null,
      },
    },
  },

  {
    name: 'ocr_image',
    title: '图片 OCR 识别',
    summary: '对一张图片做 OCR 文字识别。SnowLuma 要求传图片 URL 或已缓存的图片 file_id；'
      + 'NapCat 的参数表未在源快照中给出，按 OneBot 生态惯用的 image 键映射，'
      + '若协议端实际键名不同请改用 call_native。返回结构未文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['ocr_image', '.ocr_image'],
    params: [
      {
        key: 'file', label: '图片', type: 'file', required: true,
        sample: 'https://example.com/pic.jpg',
        desc: '图片 URL、本地路径或已缓存的 file_id，协议端对应键名为 image',
      },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'ocr_image',
            map: { file: 'image' },
            notes: 'NapCat 快照未给出 ocr_image 的参数表，image 键名为按 OneBot 生态推断，未证实',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'ocr_image', map: { file: 'image' } } } },
    },
    examples: {
      request: { file: 'https://example.com/pic.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: 'OCR 失败: 图片不可解析', wording: 'OCR 失败', echo: null,
      },
    },
  },

  {
    name: 'ocr_image_internal',
    title: '图片 OCR 识别（NapCat 内部版）',
    summary: 'NapCat 快照里与 ocr_image 并存的带点前缀内部版本 .ocr_image。'
      + '参数与返回均未文档化，仅为覆盖原生接口名而登记，日常请用 ocr_image。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['.ocr_image'],
    params: [
      { key: 'file', label: '图片', type: 'file', sample: 'https://example.com/pic.jpg' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: '.ocr_image',
            notes: 'NapCat 源码标注为「内部」接口，参数表与返回结构均未文档化',
          },
        },
      },
    },
    examples: {
      request: { file: 'https://example.com/pic.jpg' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: 'OCR 失败', wording: 'OCR 失败', echo: null,
      },
    },
  },









  {
    name: 'rename_flash_file',
    title: '重命名闪传文件',
    summary: '修改闪传文件集的名字。仅 SnowLuma 提供；返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['rename_flash_file'],
    params: [
      { key: 'fileset_id', label: '文件集 ID', type: 'string', required: true, sample: 'fs-7f3a1c9d' },
      { key: 'new_name', label: '新名称', type: 'string', required: true, sample: '活动照片 2026' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'rename_flash_file' } } },
    },
    examples: {
      request: { fileset_id: 'fs-7f3a1c9d', new_name: '活动照片 2026' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '重命名失败: 文件集不存在', wording: '重命名失败', echo: null,
      },
    },
  },







  {
    name: 'get_group_album_list',
    title: '获取群相册列表',
    summary: '列出群里的相册。NapCat 的原生名是 get_qun_album_list，SnowLuma 两种名字都有；'
      + '本条在 NapCat 侧落到 get_qun_album_list，在 SnowLuma 侧落到 get_group_album_list。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_qun_album_list', 'get_group_album_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      {
        key: 'attach_info', label: '分页游标', type: 'string',
        desc: '上一次返回的 attach_info，用于翻页；首次留空',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_qun_album_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_album_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群相册列表失败: 不是群成员', wording: '获取群相册列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_qun_album_list',
    title: '获取群相册列表（SnowLuma 兼容名）',
    summary: '获取群相册列表。SnowLuma 同时提供 get_group_album_list 与 get_qun_album_list，'
      + '本条覆盖后一个原生名以保证老接口名仍可调用；新代码请优先用 get_group_album_list。',
    category: 'media',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_qun_album_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'attach_info', label: '分页游标', type: 'string' },
    ],
    impl: {
      snowluma: { variants: { '*': { action: 'get_qun_album_list' } } },
    },
    examples: {
      request: { group_id: 123456 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '获取群相册列表失败', wording: '获取群相册列表失败', echo: null,
      },
    },
  },

  {
    name: 'get_group_album_media_list',
    title: '获取群相册媒体列表',
    summary: '列出某个群相册里的图片与视频。返回结构未在源快照中文档化'
      + '（NapCat 说明 batch_id 可从返回里的 batch.link_id 或 media[].batch_id 取得）。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_group_album_media_list'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'attach_info', label: '分页游标', type: 'string', desc: '上一次返回的 attach_info' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_group_album_media_list' } } },
      snowluma: { variants: { '*': { action: 'get_group_album_media_list' } } },
    },
    examples: {
      request: { group_id: 123456, album_id: 'album-7f3a1c9d' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '相册不存在', wording: '相册不存在', echo: null,
      },
    },
  },

  {
    name: 'upload_album_image',
    title: '上传图片到群相册',
    summary: '往群相册里上传一张图片。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['upload_image_to_qun_album'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'album_name', label: '相册名称', type: 'string', required: true, sample: '2026 年会' },
      {
        key: 'file', label: '图片', type: 'file', required: true, sample: 'C:/tmp/pic.jpg',
        desc: '图片路径、URL 或 Base64',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'upload_image_to_qun_album' } } },
      snowluma: { variants: { '*': { action: 'upload_image_to_qun_album' } } },
    },
    examples: {
      request: {
        group_id: 123456, album_id: 'album-7f3a1c9d', album_name: '2026 年会', file: 'C:/tmp/pic.jpg',
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传失败: 图片格式不支持', wording: '上传失败', echo: null,
      },
    },
  },

  {
    name: 'upload_album_images',
    title: '批量上传图片到群相册',
    summary: '一次上传多张图片，这些图片在群相册里显示为同一条上传记录。'
      + '仅 NapCat 提供；返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['upload_images_to_qun_album'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'album_name', label: '相册名称', type: 'string', required: true, sample: '2026 年会' },
      {
        key: 'files', label: '图片列表', type: 'array', required: true,
        sample: ['C:/tmp/a.jpg', 'C:/tmp/b.jpg'],
        desc: '图片路径、URL 或 Base64 组成的数组',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'upload_images_to_qun_album' } } },
    },
    examples: {
      request: {
        group_id: 123456, album_id: 'album-7f3a1c9d', album_name: '2026 年会',
        files: ['C:/tmp/a.jpg', 'C:/tmp/b.jpg'],
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传失败: 图片格式不支持', wording: '上传失败', echo: null,
      },
    },
  },

  {
    name: 'upload_album_video',
    title: '上传视频到群相册',
    summary: '往群相册里上传一个视频，封面自动取首帧（取帧失败时用内置默认封面）。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['upload_video_to_qun_album'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'album_name', label: '相册名称', type: 'string', required: true, sample: '2026 年会' },
      { key: 'file', label: '视频', type: 'file', required: true, sample: 'C:/tmp/clip.mp4' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'upload_video_to_qun_album' } } },
      snowluma: { variants: { '*': { action: 'upload_video_to_qun_album' } } },
    },
    examples: {
      request: {
        group_id: 123456, album_id: 'album-7f3a1c9d', album_name: '2026 年会', file: 'C:/tmp/clip.mp4',
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '上传失败: 视频过大', wording: '上传失败', echo: null,
      },
    },
  },

  {
    name: 'delete_group_album_media',
    title: '删除群相册媒体',
    summary: '删除群相册里的一张图片或一个视频。不可恢复，属危险操作。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['del_group_album_media'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      {
        key: 'lloc', label: '媒体 ID', type: 'string', required: true, sample: 'lloc-7f3a1c9d',
        desc: '图片的长定位标识 lloc，或视频 id',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'del_group_album_media' } } },
      snowluma: { variants: { '*': { action: 'del_group_album_media' } } },
    },
    examples: {
      request: { group_id: 123456, album_id: 'album-7f3a1c9d', lloc: 'lloc-7f3a1c9d' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '删除失败: 需要相册管理权限', wording: '删除失败', echo: null,
      },
    },
  },

  {
    name: 'set_group_album_media_like',
    title: '点赞群相册媒体',
    summary: '给群相册里的图片或整个上传批次点赞。'
      + 'NapCat 侧参数表未在源快照中给出；返回结构未文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['set_group_album_media_like'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'batch_id', label: '批次 ID', type: 'string', required: true, sample: 'batch-7f3a1c9d' },
      {
        key: 'lloc', label: '媒体 ID', type: 'string',
        desc: '图片 lloc；对整个上传批次点赞时不填',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_group_album_media_like' } } },
      snowluma: { variants: { '*': { action: 'set_group_album_media_like' } } },
    },
    examples: {
      request: { group_id: 123456, album_id: 'album-7f3a1c9d', batch_id: 'batch-7f3a1c9d' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '点赞失败: 媒体不存在', wording: '点赞失败', echo: null,
      },
    },
  },

  {
    name: 'cancel_group_album_media_like',
    title: '取消群相册媒体点赞',
    summary: '取消对群相册图片或上传批次的点赞。两家快照都没有给出参数表与返回结构，'
      + '参数按对称的 set_group_album_media_like 推定。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'experimental',
    alias: ['cancel_group_album_media_like'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      { key: 'batch_id', label: '批次 ID', type: 'string', required: true, sample: 'batch-7f3a1c9d' },
      { key: 'lloc', label: '媒体 ID', type: 'string' },
    ],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'cancel_group_album_media_like',
            notes: 'NapCat 快照未给出参数表，此处按 set_group_album_media_like 对称推定，未证实',
          },
        },
      },
      snowluma: { variants: { '*': { action: 'cancel_group_album_media_like' } } },
    },
    examples: {
      request: { group_id: 123456, album_id: 'album-7f3a1c9d', batch_id: 'batch-7f3a1c9d' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '取消点赞失败: 媒体不存在', wording: '取消点赞失败', echo: null,
      },
    },
  },

  {
    name: 'create_group_album_comment',
    title: '发表群相册评论',
    summary: '给群相册里的图片或整个上传批次发表评论。'
      + 'NapCat 说明：传入 lloc 时评论单张图片；仅传 batch_id 时评论整个上传批次。'
      + '返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['do_group_album_comment'],
    params: [
      { key: 'group_id', label: '群号', type: 'number', idSpace: 'qq_number', required: true, sample: 123456 },
      { key: 'album_id', label: '相册 ID', type: 'string', required: true, sample: 'album-7f3a1c9d' },
      {
        key: 'message', label: '评论内容', type: 'string', required: true, sample: '这张拍得真好',
        desc: '协议端键名为 content，由代理层映射',
      },
      {
        key: 'lloc', label: '媒体 ID', type: 'string',
        desc: '图片 lloc；评论整个上传批次时不填，此时必须提供 batch_id',
      },
      {
        key: 'batch_id', label: '批次 ID', type: 'string', only: ['napcat'],
        sample: 'batch-7f3a1c9d',
        desc: '可从 get_group_album_media_list 返回的 batch.link_id 或 media[].batch_id 取得',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'do_group_album_comment', map: { message: 'content' } } } },
      snowluma: { variants: { '*': { action: 'do_group_album_comment', map: { message: 'content' } } } },
    },
    examples: {
      request: {
        group_id: 123456, album_id: 'album-7f3a1c9d',
        lloc: 'lloc-7f3a1c9d', message: '这张拍得真好',
      },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '评论失败: 图片不存在', wording: '评论失败', echo: null,
      },
    },
  },

  {
    name: 'translate_en2zh',
    title: '英文翻译为中文',
    summary: '把一批英文单词翻译成中文。返回结构未在源快照中文档化。',
    category: 'media',
    scope: 'wild-only',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['translate_en2zh'],
    params: [
      {
        key: 'words', label: '单词列表', type: 'array', required: true,
        sample: ['hello', 'world'], desc: '待翻译的英文单词数组',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'translate_en2zh' } } },
      snowluma: { variants: { '*': { action: 'translate_en2zh' } } },
    },
    examples: {
      request: { words: ['hello', 'world'] },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: {
        status: 'failed', retcode: 1200, data: null,
        message: '翻译失败', wording: '翻译失败', echo: null,
      },
    },
  },



];
