import type { ProxyApiEntry } from '../../proxy.types.js';

/**
 * 系统：版本信息、运行状态、缓存清理、Cookies/CSRF、重启。
 */
export const systemEntries: ProxyApiEntry[] = [
  {
    name: 'get_version_info',
    title: '获取版本信息',
    summary: '获取当前 OneBot 实现名称、实现版本与协议版本。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_version_info'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'get_version_info' } } },
      snowluma: { variants: { '*': { action: 'get_version_info' } } },
    },
    examples: {
      request: {},
      success: {
        status: 'ok', retcode: 0,
        data: { app_name: 'NapCat.Onebot', app_version: '4.8.0', protocol_version: 'v11' },
        message: '', wording: '', echo: null,
      },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_status',
    title: '获取运行状态',
    summary: '查询机器人账号是否在线以及消息收发链路是否正常。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_status'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'get_status' } } },
      snowluma: {
        variants: { '*': { action: 'get_status', notes: 'SnowLuma 还会返回当前账号服务实例的运行秒数 time' } },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: { online: true, good: true }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'can_send_image',
    title: '检测图片发送能力',
    summary: '检测当前机器人是否具备图片发送能力。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['can_send_image'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'can_send_image' } } },
      snowluma: { variants: { '*': { action: 'can_send_image' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: { yes: true }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'can_send_record',
    title: '检测语音发送能力',
    summary: '检测当前机器人是否具备语音发送能力。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['can_send_record'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'can_send_record' } } },
      snowluma: { variants: { '*': { action: 'can_send_record' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: { yes: true }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_model_show',
    title: '获取机型展示列表',
    summary: '获取当前账号可用的设备机型展示名称列表。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['_get_model_show'],
    params: [
      { key: 'model', label: '机型名称', type: 'string', sample: 'iPhone 15 Pro', desc: '可选的机型名称过滤条件' },
    ],
    impl: {
      napcat: {
        variants: { '*': { action: '_get_model_show', notes: '返回数组元素结构在 NapCat 快照中未文档化' } },
      },
      snowluma: { variants: { '*': { action: '_get_model_show' } } },
    },
    examples: {
      request: { model: 'iPhone 15 Pro' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_online_clients',
    title: '获取在线客户端',
    summary: '获取当前登录账号的在线设备或客户端列表。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stable',
    readOnly: true,
    alias: ['get_online_clients'],
    params: [
      {
        key: 'no_cache', label: '强制刷新', type: 'boolean', only: ['snowluma'], sample: false,
        desc: 'SnowLuma 当前只提供本地快照；传 true 会明确失败',
      },
    ],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_online_clients', drop: ['no_cache'], notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: { variants: { '*': { action: 'get_online_clients' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_robot_uin_range',
    title: '获取机器人 UIN 范围',
    summary: '获取 NapCat 当前机器人账号适用的 UIN 范围。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'experimental',
    readOnly: true,
    alias: ['get_robot_uin_range'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_robot_uin_range', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_packet_status',
    title: '获取 Packet 服务状态',
    summary: '查询底层 Packet 服务的运行状态；SnowLuma 目前仅有占位实现。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stub',
    readOnly: true,
    alias: ['nc_get_packet_status'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'nc_get_packet_status', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: {
        variants: {
          '*': { action: 'nc_get_packet_status', stub: true, notes: 'SnowLuma OpenAPI 标注为占位实现，恒返回 null' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'check_url_safely',
    title: '检查 URL 安全性',
    summary: '检查指定 URL 的安全等级；SnowLuma 当前仅返回固定占位结果。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stub',
    readOnly: true,
    alias: ['check_url_safely'],
    params: [
      {
        key: 'url', label: '待检查 URL', type: 'string', required: true, only: ['napcat'],
        sample: 'https://example.com', desc: 'NapCat 需要检查的 URL；SnowLuma 占位实现不接收此参数',
      },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'check_url_safely', notes: '安全等级返回结构在 NapCat 快照中未文档化' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'check_url_safely', stub: true, drop: ['url'],
            notes: 'SnowLuma OpenAPI 标注为占位实现，不接收 URL 且 level 恒为 1',
          },
        },
      },
    },
    examples: {
      request: { url: 'https://example.com' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'handle_quick_operation',
    title: '处理快速操作',
    summary: '依据事件上下文执行 OneBot 快速回复、禁言或请求处理等操作。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'stable',
    alias: ['.handle_quick_operation'],
    params: [
      { key: 'context', label: '事件上下文', type: 'object', required: true, sample: { post_type: 'message' } },
      { key: 'operation', label: '快速操作', type: 'object', required: true, sample: { reply: '收到' } },
    ],
    impl: {
      napcat: { variants: { '*': { action: '.handle_quick_operation' } } },
    },
    examples: {
      request: { context: { post_type: 'message' }, operation: { reply: '收到' } },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'set_model_show',
    title: '设置机型展示',
    summary: '设置当前账号的设备机型展示；SnowLuma 目前仅有占位接口。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stub',
    alias: ['_set_model_show'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: '_set_model_show' } } },
      snowluma: {
        variants: {
          '*': { action: '_set_model_show', stub: true, notes: 'SnowLuma OpenAPI 将该 action 标注为占位' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'clean_cache',
    title: '清理运行缓存',
    summary: '清理机器人运行缓存；可能影响当前服务，应谨慎调用。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['clean_cache'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'clean_cache' } } },
      snowluma: { variants: { '*': { action: 'clean_cache' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'clean_stream_temp_files',
    title: '清理流式传输临时文件',
    summary: '删除流式上传与下载目录中的临时文件。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['clean_stream_temp_file'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'clean_stream_temp_file', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: { variants: { '*': { action: 'clean_stream_temp_file' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'exit_bot',
    title: '退出机器人登录',
    summary: '让当前机器人账号退出登录并中断现有服务。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    alias: ['bot_exit'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'bot_exit' } } },
      snowluma: { variants: { '*': { action: 'bot_exit' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'restart_service',
    title: '重启机器人服务',
    summary: '重启当前机器人服务；SnowLuma 明确不支持该操作。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stub',
    alias: ['set_restart'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'set_restart' } } },
      snowluma: {
        variants: {
          '*': { action: 'set_restart', stub: true, notes: 'SnowLuma OpenAPI 将该 action 标注为不支持' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_client_key',
    title: '获取 ClientKey',
    summary: '获取当前登录账号的 ClientKey 凭证。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    readOnly: true,
    alias: ['get_clientkey'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_clientkey', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: { variants: { '*': { action: 'get_clientkey' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_cookies',
    title: '获取 Cookies',
    summary: '获取当前登录账号在指定域名下的 Cookie 字符串。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    readOnly: true,
    alias: ['get_cookies'],
    params: [
      { key: 'domain', label: '域名', type: 'string', required: true, sample: 'qun.qq.com' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_cookies' } } },
      snowluma: { variants: { '*': { action: 'get_cookies' } } },
    },
    examples: {
      request: { domain: 'qun.qq.com' },
      success: { status: 'ok', retcode: 0, data: { cookies: 'uin=...; skey=...' }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_credentials',
    title: '获取登录凭证',
    summary: '获取当前登录账号在指定域名下的 Cookie 与 CSRF 凭证。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    readOnly: true,
    alias: ['get_credentials'],
    params: [
      { key: 'domain', label: '域名', type: 'string', required: true, sample: 'qun.qq.com' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'get_credentials' } } },
      snowluma: {
        variants: { '*': { action: 'get_credentials', notes: 'SnowLuma 同时返回同值的 token 与 csrf_token 字段' } },
      },
    },
    examples: {
      request: { domain: 'qun.qq.com' },
      success: {
        status: 'ok', retcode: 0, data: { cookies: 'uin=...; skey=...', csrf_token: 123456789 },
        message: '', wording: '', echo: null,
      },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_csrf_token',
    title: '获取 CSRF Token',
    summary: '获取当前登录账号的 CSRF Token（bkn）。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'stable',
    readOnly: true,
    alias: ['get_csrf_token'],
    params: [],
    impl: {
      napcat: { variants: { '*': { action: 'get_csrf_token' } } },
      snowluma: { variants: { '*': { action: 'get_csrf_token' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: { token: 123456789 }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_rkey',
    title: '获取下载 RKey',
    summary: '获取资源下载所需的 RKey 凭证。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'experimental',
    readOnly: true,
    alias: ['get_rkey'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_rkey', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: {
        variants: { '*': { action: 'get_rkey', notes: '返回结构在 SnowLuma OpenAPI 中未文档化' } },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_rkey_server',
    title: '获取 RKey 服务器信息',
    summary: '获取 RKey 服务及其凭证过期信息。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'danger',
    status: 'experimental',
    readOnly: true,
    alias: ['get_rkey_server'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'get_rkey_server', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
      snowluma: { variants: { '*': { action: 'get_rkey_server' } } },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_native_rkey',
    title: '获取 NapCat 原生 RKey',
    summary: '通过 NapCat 扩展 action 获取资源下载 RKey。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'danger',
    status: 'experimental',
    readOnly: true,
    alias: ['nc_get_rkey'],
    params: [],
    impl: {
      napcat: {
        variants: { '*': { action: 'nc_get_rkey', notes: '返回结构在 NapCat 快照中未文档化' } },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_database_decrypt_key',
    title: '获取数据库解密密钥',
    summary: '向 SnowLuma 请求指定数据库文件的解密密钥。',
    category: 'system',
    scope: 'wild-only',
    support: ['snowluma'],
    risk: 'danger',
    status: 'experimental',
    readOnly: true,
    alias: ['request_decrypt_key'],
    params: [
      { key: 'db_path', label: '数据库路径', type: 'string', required: true, sample: 'C:/QQ/data/message.db' },
    ],
    impl: {
      snowluma: {
        variants: { '*': { action: 'request_decrypt_key', notes: '返回结构在 SnowLuma OpenAPI 中未文档化' } },
      },
    },
    examples: {
      request: { db_path: 'C:/QQ/data/message.db' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'set_diy_online_status',
    title: '设置自定义在线状态',
    summary: '设置当前机器人账号的自定义状态图标与文字。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_diy_online_status'],
    params: [
      { key: 'face_id', label: '图标 ID', type: 'number', required: true, sample: 1 },
      { key: 'face_type', label: '图标类型', type: 'number', required: true, sample: 1 },
      { key: 'wording', label: '状态文字', type: 'string', required: true, sample: '工作中' },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_diy_online_status' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'set_diy_online_status',
            notes: 'SnowLuma 仅强制 face_id；统一接口按 NapCat 的完整契约要求三个字段',
          },
        },
      },
    },
    examples: {
      request: { face_id: 1, face_type: 1, wording: '工作中' },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'set_online_status',
    title: '设置在线状态',
    summary: '设置当前机器人账号的在线、扩展与电量状态。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'write',
    status: 'stable',
    alias: ['set_online_status'],
    params: [
      { key: 'status', label: '在线状态', type: 'number', required: true, sample: 10 },
      { key: 'ext_status', label: '扩展状态', type: 'number', required: true, sample: 0 },
      { key: 'battery_status', label: '电量状态', type: 'number', required: true, sample: 100 },
    ],
    impl: {
      napcat: { variants: { '*': { action: 'set_online_status' } } },
      snowluma: {
        variants: {
          '*': {
            action: 'set_online_status',
            notes: 'SnowLuma 仅强制 status；统一接口按 NapCat 契约同时要求 ext_status 与 battery_status',
          },
        },
      },
    },
    examples: {
      request: { status: 10, ext_status: 0, battery_status: 100 },
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_word_slices',
    title: '获取分词结果',
    summary: 'OneBot 兼容分词 action；NapCat 无 handler，SnowLuma 也明确标注未实现。',
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma'],
    risk: 'read',
    status: 'stub',
    readOnly: true,
    alias: ['.get_word_slices'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: '.get_word_slices', stub: true,
            notes: 'NapCat ActionName 枚举中存在，但 unimplementedActions 明确列为无 handler',
          },
        },
      },
      snowluma: {
        variants: {
          '*': { action: '.get_word_slices', stub: true, notes: 'SnowLuma OpenAPI 明确标注为未实现' },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口未实现', wording: '接口未实现', echo: null },
    },
  },

  {
    name: 'get_unknown_action',
    title: '未知 Action 占位',
    summary: 'NapCat ActionName 枚举的 unknown 占位值，没有对应 handler。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'read',
    status: 'stub',
    readOnly: true,
    alias: ['unknown'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'unknown', stub: true,
            notes: 'NapCat unimplementedActions 明确列为无 handler；仅用于完整对账，不应实际调用',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口未实现', wording: '接口未实现', echo: null },
    },
  },

  {
    name: 'get_auto_register_test_01',
    title: '自动注册测试接口 01',
    summary: 'NapCat 内部自动注册测试 action；源快照未提供功能说明或返回结构。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'experimental',
    alias: ['test_auto_register_01'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'test_auto_register_01',
            notes: 'NapCat 源快照仅声明 handler，未提供功能说明或返回结构',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },

  {
    name: 'get_auto_register_test_02',
    title: '自动注册测试接口 02',
    summary: 'NapCat 内部自动注册测试 action；源快照未提供功能说明或返回结构。',
    category: 'system',
    scope: 'wild-only',
    support: ['napcat'],
    risk: 'write',
    status: 'experimental',
    alias: ['test_auto_register_02'],
    params: [],
    impl: {
      napcat: {
        variants: {
          '*': {
            action: 'test_auto_register_02',
            notes: 'NapCat 源快照仅声明 handler，未提供功能说明或返回结构',
          },
        },
      },
    },
    examples: {
      request: {},
      success: { status: 'ok', retcode: 0, data: null, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: 1200, data: null, message: '接口调用失败', wording: '接口调用失败', echo: null },
    },
  },
];
