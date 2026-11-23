/**
 * 非协议代理接口目录：框架 / 对内 / 对外。
 *
 * 这些接口**不经过** kakake_api 的协议分发，也不在 registry 的 292 条短名里。
 * 它们本来是什么调用方式，这里就显示什么：真实 HTTP 方法、路径模板、鉴权与参数。
 * 分类含义：
 *  - framework  框架自身能力（插件操作、浏览器、重启），控制台会话 / framework 动作；
 *  - internal   默认只给本机 / 内网用的入口（无 token 时按来源 IP 判定）；
 *  - external   面向公网入站或外部程序调用的入口（开关 / 密钥 / 签名 / webhook）。
 *
 * 中英文文案直接随数据下发，前端按当前语言取，避免两边字典各写一份又对不上。
 */

export type NativeCategory = 'framework' | 'internal' | 'external';

export type NativeText = { zh: string; en: string };

export type NativeParamLocation = 'path' | 'query' | 'body' | 'header' | 'ws';

export interface NativeParam {
  key: string;
  label: NativeText;
  /** 参数所在位置：决定调用方往哪儿放 */
  in: NativeParamLocation;
  type: 'string' | 'number' | 'boolean' | 'object' | 'file' | 'json';
  required?: boolean;
  sample?: string;
  desc: NativeText;
}

export interface NativeEndpoint {
  /** 短名：fw_ / in_ / out_ 前缀标明类别，不与代理注册表短名冲突 */
  name: string;
  title: NativeText;
  summary: NativeText;
  category: NativeCategory;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'WS' | 'ALL';
  /** 真实路径模板；占位符用 :name 或 <name> 表示 */
  path: string;
  auth: NativeText;
  /** 开关 / IP 限制 / 限流等额外放行条件 */
  gate: NativeText;
  params: NativeParam[];
  response: NativeText;
  /** 源码出处，便于核对（控制台详情里展示） */
  source: string;
  notes?: NativeText;
}

const T = (zh: string, en: string): NativeText => ({ zh, en });
const P = (
  key: string,
  zh: string,
  en: string,
  location: NativeParamLocation,
  type: NativeParam['type'],
  descZh: string,
  descEn: string,
  extra: Partial<NativeParam> = {},
): NativeParam => ({
  key, label: T(zh, en), in: location, type, desc: T(descZh, descEn), ...extra,
});

const idPath = (entityZh: string, entityEn: string): NativeParam =>
  P('id', `${entityZh}ID`, `${entityEn} ID`, 'path', 'string',
    '路径中的目标标识，按插件 / 连接的实际 ID 替换', 'Replace with the actual plugin or connection ID',
    { required: true, sample: 'GF-plugin-demo' });

export const NATIVE_ENDPOINTS: NativeEndpoint[] = [
  /* ───────────────────────── 框架 ───────────────────────── */

  {
    name: 'fw_restart_app',
    title: T('重启框架', 'Restart Framework'),
    summary: T('优雅退出咔咔珂进程，由受管启动器拉起；可选清理临时目录与浏览器存储。',
      'Gracefully exit the framework so the managed launcher restarts it; optionally clear temp files and browser storage.'),
    category: 'framework',
    method: 'POST',
    path: '/api/maintenance/restart',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('仅受管启动方式会真正重启，否则返回失败说明', 'Only managed launchers perform the restart; otherwise a failure envelope is returned'),
    params: [
      P('cleanTemp', '清理临时文件', 'Clean temp files', 'body', 'boolean',
        '是否清理 data/tmp 与打包缓存，默认 false', 'Whether to clear data/tmp and build cache; default false', { sample: 'false' }),
      P('clearBrowserStorage', '清理浏览器存储', 'Clear browser storage', 'body', 'boolean',
        '是否连浏览器存储一起清理，默认 false', 'Whether to also clear browser storage; default false', { sample: 'false' }),
    ],
    response: T('{ ok, canRestart, willApplyUpdate, message, report }', '{ ok, canRestart, willApplyUpdate, message, report }'),
    source: 'src/admin/api.controller.ts:445',
    notes: T('同能力的 framework 动作是 kakake_api(\'restart_kakake\')，不经 HTTP；见接口代理的 restart_kakake 条目。',
      'The equivalent framework action is kakake_api("restart_kakake") without HTTP; see the restart_kakake proxy entry.'),
  },
  {
    name: 'fw_plugin_reload',
    title: T('重载插件', 'Reload Plugin'),
    summary: T('重新加载指定插件，不重启框架。插件改完代码后最常用的一条。',
      'Reload one plugin without restarting the framework — the usual call after editing plugin code.'),
    category: 'framework', method: 'POST', path: '/api/plugins/:id/reload',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('插件必须存在且已加载', 'The plugin must exist and be loaded'),
    params: [idPath('插件', 'Plugin')],
    response: T('{ ok: boolean }', '{ ok: boolean }'),
    source: 'src/admin/admin-api.controller.ts:263',
  },
  {
    name: 'fw_plugin_rescan',
    title: T('扫描插件', 'Rescan Plugins'),
    summary: T('重新扫描插件目录，发现新增或删除的插件。',
      'Rescan plugin directories to discover added or removed plugins.'),
    category: 'framework', method: 'POST', path: '/api/plugins/rescan',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('无额外开关', 'No extra switch'),
    params: [
      P('connectionId', '连接 ID', 'Connection ID', 'query', 'string',
        '只扫描该连接名下的插件；不传则扫描全部', 'Scan only this connection’s plugins; omit to scan all'),
    ],
    response: T('{ code, message, data: { count, ... } }', '{ code, message, data: { count, ... } }'),
    source: 'src/admin/admin-api.controller.ts:227',
    notes: T('旧路径 POST /api/Plugin/Rescan 等价，参数相同。', 'The legacy POST /api/Plugin/Rescan is equivalent with the same parameters.'),
  },
  {
    name: 'fw_plugin_import',
    title: T('导入插件', 'Import Plugin'),
    summary: T('上传 zip 包安装插件。', 'Install a plugin from an uploaded zip archive.'),
    category: 'framework', method: 'POST', path: '/api/plugins/import',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('multipart/form-data；zip 需通过插件包校验', 'multipart/form-data; the zip must pass plugin package validation'),
    params: [
      P('file', '插件包', 'Plugin archive', 'body', 'file',
        'zip 格式的插件安装包', 'Plugin package in zip format', { required: true, sample: 'plugin-demo.zip' }),
    ],
    response: T('导入结果（成功 / 失败原因）', 'Import result (success or failure reason)'),
    source: 'src/admin/admin-api.controller.ts:200',
  },
  {
    name: 'fw_plugin_remove',
    title: T('删除插件', 'Remove Plugin'),
    summary: T('删除指定插件，可选择同时清理它的数据目录。',
      'Delete a plugin, optionally removing its data directory as well.'),
    category: 'framework', method: 'DELETE', path: '/api/plugins/:id',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('删除不可撤销', 'Deletion cannot be undone'),
    params: [
      idPath('插件', 'Plugin'),
      P('cleanData', '清理数据', 'Clean data', 'query', 'boolean',
        "'1' 或 'true' 表示连插件数据一起删", "'1' or 'true' deletes plugin data too", { sample: '1' }),
    ],
    response: T('{ ok: boolean }', '{ ok: boolean }'),
    source: 'src/admin/admin-api.controller.ts:349',
  },
  {
    name: 'fw_plugin_config',
    title: T('写入插件配置', 'Set Plugin Config'),
    summary: T('按插件声明的配置结构写入配置，可指定账号维度。',
      'Write config following the plugin’s declared schema, optionally per account.'),
    category: 'framework', method: 'POST', path: '/api/Plugin/Config',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('config 必须符合插件 schema', 'config must match the plugin schema'),
    params: [
      P('id', '插件 ID', 'Plugin ID', 'body', 'string', '目标插件', 'Target plugin', { required: true, sample: 'GF-plugin-demo' }),
      P('config', '配置对象', 'Config object', 'body', 'object', '按插件 schema 填写的配置', 'Config values matching the plugin schema', { required: true, sample: '{"key":"value"}' }),
      P('account', '账号', 'Account', 'body', 'string', '多账号时指定账号；不传为全局配置', 'Account key for multi-account plugins; omit for global config'),
    ],
    response: T('{ code, message }', '{ code, message }'),
    source: 'src/admin/api.controller.ts:726',
  },
  {
    name: 'fw_plugin_status',
    title: T('设置插件开关', 'Set Plugin Status'),
    summary: T('启用或停用插件；不传连接 ID 时改总开关。',
      'Enable or disable a plugin; omit the connection ID to change the global switch.'),
    category: 'framework', method: 'POST', path: '/api/Plugin/SetStatus',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('无额外开关', 'No extra switch'),
    params: [
      P('id', '插件 ID', 'Plugin ID', 'body', 'string', '目标插件', 'Target plugin', { required: true, sample: 'GF-plugin-demo' }),
      P('enable', '启用', 'Enable', 'body', 'boolean', 'true 启用，false 停用', 'true enables, false disables', { required: true, sample: 'true' }),
      P('connectionId', '连接 ID', 'Connection ID', 'body', 'string', '指定连接；不传则改全局开关', 'Target connection; omit for the global switch'),
    ],
    response: T('{ code, message, data: { plugin } }', '{ code, message, data: { plugin } }'),
    source: 'src/admin/api.controller.ts:741',
  },
  {
    name: 'fw_browser_status',
    title: T('浏览器状态', 'Browser Status'),
    summary: T('查询三个内置浏览器的运行状态、CDP 地址、持有者与空闲剩余秒数。',
      'Query status, CDP address, holder and idle countdown for the three built-in browsers.'),
    category: 'framework', method: 'GET', path: '/api/browser/status',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('无额外开关', 'No extra switch'),
    params: [
      P('refresh', '强制重探', 'Force refresh', 'query', 'string',
        "'1' 时强制重新探测进程", "'1' forces a fresh process probe", { sample: '1' }),
    ],
    response: T('{ ok, browsers[], installBlocks, runtimes, settings, job }', '{ ok, browsers[], installBlocks, runtimes, settings, job }'),
    source: 'src/admin/browser-api.controller.ts:23',
    notes: T('返回的 cdpUrl 可交给 puppeteer.connect({ browserURL })；不要泄露。',
      'The returned cdpUrl can be passed to puppeteer.connect({ browserURL }); keep it private.'),
  },
  {
    name: 'fw_browser_start',
    title: T('启动浏览器', 'Start Browser'),
    summary: T('按配置拉起指定浏览器进程并返回 CDP 地址。',
      'Start the selected browser process with current settings and return its CDP address.'),
    category: 'framework', method: 'POST', path: '/api/browser/start',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('浏览器需已安装，或配置允许自动下载', 'The browser must be installed or auto-download must be enabled'),
    params: [
      P('browserId', '浏览器', 'Browser', 'body', 'string',
        'chrome / edge / chromium', 'chrome / edge / chromium', { required: true, sample: 'chrome' }),
    ],
    response: T('{ ok, cdpUrl, pid, mode }', '{ ok, cdpUrl, pid, mode }'),
    source: 'src/admin/browser-api.controller.ts:92',
  },
  {
    name: 'fw_browser_stop',
    title: T('停止浏览器', 'Stop Browser'),
    summary: T('停止指定浏览器进程。', 'Stop the selected browser process.'),
    category: 'framework', method: 'POST', path: '/api/browser/stop',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('无额外开关', 'No extra switch'),
    params: [
      P('browserId', '浏览器', 'Browser', 'body', 'string',
        'chrome / edge / chromium', 'chrome / edge / chromium', { required: true, sample: 'chrome' }),
    ],
    response: T('{ ok, message }', '{ ok, message }'),
    source: 'src/admin/browser-api.controller.ts:103',
  },
  {
    name: 'fw_browser_restart',
    title: T('重启浏览器', 'Restart Browser'),
    summary: T('重启指定浏览器进程，等价于停止后再启动。',
      'Restart the selected browser process — equivalent to stop followed by start.'),
    category: 'framework', method: 'POST', path: '/api/browser/restart',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('无额外开关', 'No extra switch'),
    params: [
      P('browserId', '浏览器', 'Browser', 'body', 'string',
        'chrome / edge / chromium', 'chrome / edge / chromium', { required: true, sample: 'chrome' }),
    ],
    response: T('重启结果，含 cdpUrl', 'Restart result including cdpUrl'),
    source: 'src/admin/browser-api.controller.ts:114',
  },
  {
    name: 'fw_browser_install',
    title: T('安装浏览器', 'Install Browser'),
    summary: T('下载并安装指定浏览器；长任务，可用取消接口中止。',
      'Download and install a browser; long-running and cancellable.'),
    category: 'framework', method: 'POST', path: '/api/browser/install',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('同时只允许一个安装任务', 'Only one install job may run at a time'),
    params: [
      P('browserId', '浏览器', 'Browser', 'body', 'string',
        'chrome / edge / chromium', 'chrome / edge / chromium', { required: true, sample: 'chrome' }),
    ],
    response: T('安装任务启动结果', 'Install job start result'),
    source: 'src/admin/browser-api.controller.ts:61',
    notes: T('取消：POST /api/browser/cancel；卸载：POST /api/browser/uninstall（同样传 browserId）。',
      'Cancel with POST /api/browser/cancel; uninstall with POST /api/browser/uninstall (same browserId).'),
  },
  {
    name: 'fw_browser_config',
    title: T('写入浏览器配置', 'Set Browser Config'),
    summary: T('修改内置浏览器的运行模式、空闲超时等设置。',
      'Change built-in browser runtime mode, idle timeout and other settings.'),
    category: 'framework', method: 'PUT', path: '/api/browser/config',
    auth: T('控制台会话或 Bearer 控制台密钥', 'Console session or Bearer console key'),
    gate: T('字段按浏览器设置结构校验', 'Fields are validated against the browser settings schema'),
    params: [
      P('settings', '设置对象', 'Settings object', 'body', 'object',
        '完整或部分浏览器设置，见 GET /api/browser/config 返回结构',
        'Full or partial browser settings; see GET /api/browser/config response', { required: true, sample: '{"idleTimeoutSec":120}' }),
    ],
    response: T('{ ok, settings }', '{ ok, settings }'),
    source: 'src/admin/browser-api.controller.ts:54',
  },

  /* ───────────────────────── 对内 ───────────────────────── */

  {
    name: 'in_local_connections',
    title: T('本机连接概览', 'Local Connections'),
    summary: T('给本机脚本用的连接状态快照，无需登录，但公网来源直接拒绝。',
      'Connection snapshot for local scripts. No login, but public sources are rejected outright.'),
    category: 'internal', method: 'GET', path: '/api/local/connections',
    auth: T('无密钥；按来源 IP 判定', 'No key; source IP decides'),
    gate: T('仅回环 / 私网来源；带反代头视为公网并拒绝',
      'Loopback / private sources only; any reverse-proxy header is treated as public and rejected'),
    params: [],
    response: T('{ ok, time, count, connections[] }', '{ ok, time, count, connections[] }'),
    source: 'src/admin/local-api.controller.ts:31',
  },
  {
    name: 'in_onebot_report',
    title: T('OneBot 事件上报', 'OneBot Event Report'),
    summary: T('协议端把 OneBot 11 事件 POST 给框架；HTTP 客户端模式挂在主端口。',
      'Protocol adapters POST OneBot 11 events here; in HTTP client mode this lives on the main port.'),
    category: 'internal', method: 'POST', path: '/onebot/http/:connectionId',
    auth: T('配置 access_token 时：Bearer / access_token / X-Signature 三选一；未配置时按来源 IP',
      'With access_token: Bearer / access_token / X-Signature; without it: source IP check'),
    gate: T('无 token 时仅本机 / 内网；公网协议端必须配 token',
      'Without a token only local / private sources pass; public adapters must configure a token'),
    params: [
      P('connectionId', '连接 ID', 'Connection ID', 'path', 'string',
        '创建连接时生成的 ID', 'The ID generated when the connection was created', { required: true, sample: 'c_123456' }),
      P('event', '事件对象', 'Event object', 'body', 'json',
        'OneBot 11 事件 JSON，须含 post_type', 'OneBot 11 event JSON with post_type', { required: true, sample: '{"post_type":"message"}' }),
    ],
    response: T('成功 204；鉴权失败 401；格式错误 400', '204 on success; 401 on auth failure; 400 on bad payload'),
    source: 'src/connection/onebot-http.client.ts:32',
    notes: T('HTTP 服务器模式下改为 POST 到连接自己的 host:port 根路径。',
      'In HTTP server mode, POST to the root path of the connection’s own host:port instead.'),
  },
  {
    name: 'in_onebot_stream',
    title: T('OneBot 事件取流', 'OneBot Event Stream'),
    summary: T('HTTP SSE 服务器模式下，从连接端口长连接读取事件流。',
      'In HTTP SSE server mode, read the event stream from the connection port over a long-lived connection.'),
    category: 'internal', method: 'GET', path: 'http://<连接 host>:<连接 port>/  (Accept: text/event-stream)',
    auth: T('access_token：Bearer / query access_token / X-Signature；未配置时按来源 IP',
      'access_token: Bearer / query access_token / X-Signature; otherwise source IP'),
    gate: T('仅 HTTP SSE 服务器模式；无 token 时限本机 / 内网',
      'Only in HTTP SSE server mode; local / private sources only without a token'),
    params: [
      P('Accept', '请求头', 'Header', 'header', 'string',
        '必须为 text/event-stream', 'Must be text/event-stream', { required: true, sample: 'text/event-stream' }),
      P('access_token', '访问令牌', 'Access token', 'query', 'string',
        '连接配置了 token 时必传（也可走 Authorization 头）',
        'Required when the connection has a token (Authorization header also works)'),
    ],
    response: T('text/event-stream 持续推送；上报仍走同端口 POST /', 'Streaming text/event-stream; reports still POST to / on the same port'),
    source: 'src/connection/onebot-http-sse.server.ts:156',
  },
  {
    name: 'in_onebot_ws',
    title: T('OneBot 反向 WS', 'OneBot Reverse WS'),
    summary: T('协议端主动连到框架监听的 WebSocket，双向传事件与 API 响应。',
      'The adapter connects to this WebSocket; events and API responses flow both ways.'),
    category: 'internal', method: 'WS', path: 'ws://<连接 host>:<连接 port>',
    auth: T('握手时 Authorization / query access_token；未配置 token 时按来源 IP',
      'Authorization / query access_token during handshake; otherwise source IP'),
    gate: T('仅反向 WS 模式；无 token 时限本机 / 内网',
      'Only in reverse WS mode; local / private sources only without a token'),
    params: [
      P('access_token', '访问令牌', 'Access token', 'query', 'string',
        '连接配置了 token 时必传，也可放 Authorization: Bearer',
        'Required when a token is configured; Authorization: Bearer also works'),
    ],
    response: T('WebSocket 帧：OneBot 事件 / 带 echo 的 API 响应', 'WebSocket frames: OneBot events / API responses with echo'),
    source: 'src/connection/onebot-ws.server.ts:74',
  },

  /* ───────────────────────── 对外 ───────────────────────── */

  {
    name: 'out_public_overview',
    title: T('公开运行概览', 'Public Overview'),
    summary: T('免登录的只读状态页数据：运行时长、收发计数、连接列表。',
      'Login-free read-only status data: uptime, message counters and connection list.'),
    category: 'external', method: 'GET', path: '/api/public',
    auth: T('无密钥', 'No key'),
    gate: T('设置页「外放 API」开关开启才返回数据，否则 403；不校验来源 IP',
      'Requires the "Public API" switch; otherwise 403. Source IP is not checked'),
    params: [],
    response: T('{ ok, time, title, uptime, logs, accounts }', '{ ok, time, title, uptime, logs, accounts }'),
    source: 'src/admin/public-api.controller.ts:20',
    notes: T('监听 0.0.0.0 时同局域网设备也能读取；只读，不含配置或密钥。',
      'With 0.0.0.0 listening, LAN devices can read it too; read-only, no config or keys.'),
  },
  {
    name: 'out_public_stream',
    title: T('公开状态推送', 'Public Status Stream'),
    summary: T('公开概览的 WebSocket 实时版，连上即发快照，状态变化再增量推。',
      'WebSocket counterpart of the public overview: snapshot on connect, then status updates.'),
    category: 'external', method: 'WS', path: '/api/public/ws',
    auth: T('无密钥', 'No key'),
    gate: T('同样受「外放 API」开关控制；被封禁来源拒绝升级；客户端消息一律忽略',
      'Same Public API switch; banned sources are rejected; client messages are ignored'),
    params: [],
    response: T('JSON 消息，结构与 /api/public 相同；5 秒心跳', 'JSON payloads shaped like /api/public; 5-second heartbeat'),
    source: 'src/admin/public-ws.ts:25',
  },
  {
    name: 'out_proxy_gateway',
    title: T('代理 API 外放', 'Proxy API Gateway'),
    summary: T('把接口代理的全部短名以 HTTP 形式开放给外部程序，参数与代理入口一致。',
      'Expose every proxy short name over HTTP to trusted external callers.'),
    category: 'external', method: 'ALL', path: '/api/v1/<接口短名>',
    auth: T('Authorization: Bearer <控制台密钥>', 'Authorization: Bearer <console key>'),
    gate: T('设置页「接口代理外放 API」开关；IP+短名 60 次/分钟；失败密钥计入登录限速',
      'Requires the "Proxy API" switch; 60 req/min per IP+short name; bad keys count toward login throttle'),
    params: [
      P('shortName', '接口短名', 'API short name', 'path', 'string',
        '路径最后一段，见接口代理列表；框架条目同样可调',
        'Last path segment, see the proxy list; framework entries work too', { required: true, sample: 'send_msg' }),
      P('params', '调用参数', 'Call parameters', 'query', 'object',
        'GET 走 query；POST 走 JSON body，body 同名键覆盖 query；嵌套对象只能走 body',
        'GET uses query; POST uses JSON body which overrides query; nested objects must use body'),
      P('conn', '指定连接', 'Connection', 'query', 'string',
        '可选，指定连接 ID / QQ 号 / appId；不会转发给协议端',
        'Optional connection ID / QQ number / appId; not forwarded to the protocol adapter'),
    ],
    response: T('HTTP 恒 200（受理即成功），真实成败在 { status, retcode, data, message, _proxy }；边界错误 401/403/404/429',
      'HTTP 200 once accepted; real outcome is in { status, retcode, data, message, _proxy }; boundary errors use 401/403/404/429'),
    source: 'src/admin/proxy-api.controller.ts:82',
    notes: T('不按 risk 分级：danger 接口、重启、浏览器 CDP 地址都可通过此入口访问。密钥泄露等于交出机器人控制权。',
      'No risk-based filtering: danger APIs, restart and browser CDP addresses are reachable. A leaked key means full bot control.'),
  },
  {
    name: 'out_qq_official_callback',
    title: T('QQ 官方回调', 'QQ Official Callback'),
    summary: T('QQ 官方机器人平台把事件与回调校验 POST 到框架；公网 HTTPS 反代到此路径。',
      'QQ Official platform POSTs events and validation callbacks here; terminate HTTPS in a reverse proxy.'),
    category: 'external', method: 'POST', path: '/gfbot/:connectionId  (别名 /gf_bot/:connectionId)',
    auth: T('Ed25519 签名头 X-Signature-Ed25519 + X-Signature-Timestamp',
      'Ed25519 headers X-Signature-Ed25519 + X-Signature-Timestamp'),
    gate: T('时间戳防重放；事件 ID 10 分钟去重；无签名头仅兼容模式限速 10/min',
      'Timestamp skew check; event IDs deduplicated for 10 min; unsigned compatibility mode limited to 10/min'),
    params: [
      P('connectionId', '连接 ID', 'Connection ID', 'path', 'string', '官方机器人连接的 ID',
        'ID of the QQ Official connection', { required: true, sample: 'c_qqofficial' }),
      P('body', '回调对象', 'Callback body', 'body', 'json',
        '官方 JSON：{ op, t, d, id, s }', 'Official JSON: { op, t, d, id, s }', { required: true, sample: '{"op":0,"t":"MESSAGE_CREATE","d":{}}' }),
    ],
    response: T('op=13 → { plain_token, signature }；事件 → { op: 12 } ACK',
      'op=13 → { plain_token, signature }; events → { op: 12 } ACK'),
    source: 'src/connection/qq-official-https.server.ts:417',
  },
  {
    name: 'out_telegram_webhook',
    title: T('Telegram Webhook', 'Telegram Webhook'),
    summary: T('Telegram 把 Update POST 到框架，鉴权用 setWebhook 时设置的 secret_token。',
      'Telegram POSTs Updates here using the secret_token configured with setWebhook.'),
    category: 'external', method: 'POST', path: '/tgbot/:connectionId',
    auth: T('请求头 X-Telegram-Bot-Api-Secret-Token', 'Header X-Telegram-Bot-Api-Secret-Token'),
    gate: T('每连接 600 次/分钟；token 不符 403', '600 requests/min per connection; 403 on token mismatch'),
    params: [
      P('connectionId', '连接 ID', 'Connection ID', 'path', 'string', 'Telegram 连接的 ID',
        'ID of the Telegram connection', { required: true, sample: 'c_telegram' }),
      P('body', 'Update 对象', 'Update', 'body', 'json',
        'Telegram Update，update_id 必须是数字', 'Telegram Update with numeric update_id', { required: true, sample: '{"update_id":123}' }),
    ],
    response: T('成功 { ok: true } 或插件首个 send* 方法响应；失败 400/403',
      '{ ok: true } or the first plugin send* response; 400/403 on failure'),
    source: 'src/connection/telegram-webhook.server.ts:73',
  },
  {
    name: 'out_plugin_noauth_api',
    title: T('插件免登录 API', 'Plugin No-Auth API'),
    summary: T('插件显式声明 noauth 的 HTTP 路由，挂载在 /plugin/<插件>/api/ 下。',
      'HTTP routes explicitly declared noauth by a plugin, mounted under /plugin/<plugin>/api/.'),
    category: 'external', method: 'ALL', path: '/plugin/:pluginId/api/*',
    auth: T('无控制台会话；由插件自己决定鉴权', 'No console session; the plugin decides its own auth'),
    gate: T('仅命中插件声明的 noauth 路由；入站防护下非本机来源 120 次/分钟',
      'Only routes declared noauth by the plugin match; 120 req/min for non-local sources when inbound guard is on'),
    params: [
      P('pluginId', '插件 ID', 'Plugin ID', 'path', 'string', '目标插件目录名',
        'Target plugin directory name', { required: true, sample: 'GF-plugin-demo' }),
      P('route', '子路径', 'Sub-path', 'path', 'string',
        '插件注册的具体路由，如 /api/ping', 'The specific route registered by the plugin, e.g. /api/ping', { required: true, sample: '/api/ping' }),
    ],
    response: T('完全由插件决定', 'Entirely defined by the plugin'),
    source: 'src/plugin/plugin-http.handler.ts:821',
    notes: T('多账号路径为 /plugin/:id/a/:account/api/*；需会话的同类入口是 /api/Plugin/ext/:id/*。',
      'Multi-account form is /plugin/:id/a/:account/api/*; the session-based counterpart is /api/Plugin/ext/:id/*.'),
  },
];
