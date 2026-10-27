/**
 * 服务端错误文案本地化：EXACT → RULES（$1 回填）→ SYS → CODES，未命中则原样返回。
 * 组件内用 useSvcText()，组件外用 svcText() / errText()。
 */

import { getLang, useLang } from '@/lib/i18n';

export type SvcTextFn = (raw?: string | null) => string;

/**
 * 后端显式错误码 → 双语。
 * 由服务层抛出的结构化错误携带（如商城的超时 / 网络失败），比文案匹配更可靠。
 */
const CODES: Record<string, { zh: string; en: string }> = {
  timeout: { zh: '请求超时，请检查网络后重试', en: 'Request timed out. Check your network and try again.' },
  network: { zh: '网络连接失败，请检查网络后重试', en: 'Network connection failed. Check your network and try again.' },
  http: { zh: '服务端返回异常状态码', en: 'Server returned an unexpected status code' },
  tls: { zh: 'HTTPS 证书校验失败，请检查系统时间或网络环境', en: 'HTTPS certificate check failed. Check your system time or network.' },
  sha256_mismatch: { zh: '安装包校验未通过，文件可能被篡改或损坏', en: 'Package checksum failed; the file may be tampered with or corrupted.' },
};

/** 精确匹配表：后端原文 → 双语。键必须与后端字符串完全一致。 */
const EXACT: Array<[string, string, string]> = [
  // ===== 资源商城 =====
  ['资源不存在或不在咔咔插件分区', '资源不存在或不在咔咔插件分区', 'Resource does not exist, or is not in the Kakake plugin section'],
  ['该资源不允许下载', '该资源不允许下载', 'This resource is not available for download'],
  ['该资源不允许封面预览', '该资源不允许封面预览', 'Cover preview is not allowed for this resource'],
  ['无法获取商城分类', '无法获取商城分类', 'Could not fetch the store categories'],
  ['商城列表格式无效', '商城列表格式无效', 'Invalid store list format'],
  ['GitHub 源 index.json 格式无效', 'GitHub 源 index.json 格式无效', 'Invalid index.json format for the GitHub source'],
  ['releases 格式无效', 'releases 格式无效', 'Invalid releases format'],
  ['封面过大', '封面过大', 'Cover image is too large'],
  ['封面内容过小', '封面内容过小', 'Cover image is too small'],
  ['封面不可用', '封面不可用', 'Cover image unavailable'],
  ['下载内容过大', '下载内容过大', 'Downloaded file is too large'],
  ['下载内容过小，可能不是有效插件包', '下载内容过小，可能不是有效插件包', 'Downloaded file is too small; it may not be a valid plugin package'],
  ['下载地址无效', '下载地址无效', 'Invalid download URL'],
  ['获取商城列表失败', '获取商城列表失败', 'Failed to fetch the store list'],
  ['获取评论失败', '获取评论失败', 'Failed to fetch comments'],
  ['获取文档失败', '获取文档失败', 'Failed to fetch documentation'],
  ['无效的来源（仅 kakake / github）', '无效的来源（仅 kakake / github）', 'Invalid source (only kakake / github)'],
  ['缺少 repo 参数', '缺少 repo 参数', 'Missing "repo" parameter'],
  ['缺少有效的资源 id', '缺少有效的资源 id', 'Missing a valid resource id'],
  ['未找到文档', '未找到文档', 'Documentation not found'],
  ['安装失败', '安装失败', 'Installation failed'],
  ['sha256 校验不通过（包体可能损坏或被篡改）', 'sha256 校验不通过（包体可能损坏或被篡改）', 'sha256 check failed (package may be corrupted or tampered with)'],

  // ===== 插件 =====
  ['插件不存在', '插件不存在', 'Plugin not found'],
  ['插件已解压，但注册到管理器失败，请到插件页点刷新重试', '插件已解压，但注册到管理器失败，请到插件页点刷新重试', 'Plugin extracted, but registering it failed. Go to the plugin page and refresh to retry'],
  ['插件已解压，但注册到管理器失败，请点刷新重试', '插件已解压，但注册到管理器失败，请点刷新重试', 'Plugin extracted, but registering it failed. Refresh and retry'],
  ['插件结构无效：缺少入口文件或 plugin_init', '插件结构无效：缺少入口文件或 plugin_init', 'Invalid plugin structure: missing entry file or plugin_init'],
  ['插件总开关已关闭，无法访问后台', '插件总开关已关闭，无法访问后台', 'Plugin master switch is off; the admin page is unavailable'],
  ['插件未加载，无法访问后台（请开启总开关，并在至少一个连接打开子开关）', '插件未加载，无法访问后台（请开启总开关，并在至少一个连接打开子开关）', 'Plugin not loaded; admin page unavailable (turn on the master switch and enable it on at least one connection)'],
  ['多账号已加载，请指定账号路径 /plugin/<插件>/a/<账号>/page/...', '多账号已加载，请指定账号路径 /plugin/<插件>/a/<账号>/page/...', 'Multiple accounts loaded; specify a path like /plugin/<plugin>/a/<account>/page/...'],
  ['无效的插件包结构', '无效的插件包结构', 'Invalid plugin package structure'],
  ['缺少 plugin_init', '缺少 plugin_init', 'Missing plugin_init'],
  ['缺少插件 ID', '缺少插件 ID', 'Missing plugin ID'],
  ['总开关已关闭，无法在连接上启用或复制该插件', '总开关已关闭，无法在连接上启用或复制该插件', 'Master switch is off; cannot enable or copy this plugin onto a connection'],
  ['账号尚未上报，请等待连接成功后再启用插件', '账号尚未上报，请等待连接成功后再启用插件', 'Account not reported yet; enable the plugin after the connection succeeds'],
  ['该插件没有说明文档', '该插件没有说明文档', 'This plugin has no documentation'],
  ['下载 zip 失败', '下载 zip 失败', 'Failed to download the zip'],
  ['上传超时', '上传超时', 'Upload timed out'],

  // ===== 连接 =====
  ['连接不存在', '连接不存在', 'Connection not found'],
  ['连接不存在或不是微信 BOT', '连接不存在或不是微信 BOT', 'Connection not found, or it is not a WeChat bot'],
  ['这份文件里没有任何连接', '这份文件里没有任何连接', 'This file contains no connections'],
  ['数据格式不对：缺少 connections 数组', '数据格式不对：缺少 connections 数组', 'Invalid data format: missing "connections" array'],
  ['缺少 qrcode', '缺少 qrcode', 'Missing qrcode'],
  ['请先扫码登录微信 AI×BOT', '请先扫码登录微信 AI×BOT', 'Scan the QR code to log in to WeChat AI×BOT first'],
  ['仅正向 WS / HTTP 客户端连接支持重连设置', '仅正向 WS / HTTP 客户端连接支持重连设置', 'Reconnect settings only apply to forward WS / HTTP client connections'],
  ['请填写 AppID', '请填写 AppID', 'Please enter AppID'],
  ['请填写 AppID 与 AppSecret', '请填写 AppID 与 AppSecret', 'Please enter AppID and AppSecret'],
  ['请填写 KOOK 机器人 Token', '请填写 KOOK 机器人 Token', 'Please enter the KOOK bot token'],
  ['无法获取机器人资料，请检查凭证或连接状态', '无法获取机器人资料，请检查凭证或连接状态', 'Could not fetch the bot profile; check credentials or connection status'],
  ['该账号未配置 AppID / AppSecret', '该账号未配置 AppID / AppSecret', 'This account has no AppID / AppSecret configured'],
  ['账号不存在', '账号不存在', 'Account not found'],
  ['缺少频道 ID', '缺少频道 ID', 'Missing channel ID'],
  ['二维码已过期，已换新', '二维码已过期，已换新', 'QR code expired; a new one has been issued'],
  ['扫码已结束，请重新生成二维码', '扫码已结束，请重新生成二维码', 'Scan session ended, please generate a new QR code'],
  ['等待扫码', '等待扫码', 'Waiting for scan'],
  ['未返回登录链接', '未返回登录链接', 'No login link returned'],
  ['登录确认但未返回 token 或 bot_id', '登录确认但未返回 token 或 bot_id', 'Login confirmed but no token or bot_id returned'],
  ['KOOK Token 未配置', 'KOOK Token 未配置', 'KOOK token not configured'],
  ['KOOK 网关地址为空', 'KOOK 网关地址为空', 'KOOK gateway address is empty'],
  ['KOOK 未连接', 'KOOK 未连接', 'KOOK is not connected'],
  ['NapCat 未连接', 'NapCat 未连接', 'NapCat is not connected'],
  ['NapCat 未连接（正向 WS）', 'NapCat 未连接（正向 WS）', 'NapCat is not connected (forward WS)'],
  ['HTTP 客户端未就绪', 'HTTP 客户端未就绪', 'HTTP client is not ready'],
  ['HTTP 服务器未就绪', 'HTTP 服务器未就绪', 'HTTP server is not ready'],
  ['HTTP SSE 未连接', 'HTTP SSE 未连接', 'HTTP SSE is not connected'],
  ['HTTP SSE 服务器未就绪', 'HTTP SSE 服务器未就绪', 'HTTP SSE server is not ready'],
  ['HTTP API 空响应', 'HTTP API 空响应', 'HTTP API returned an empty response'],
  ['无法打开 HTTP SSE 事件流', '无法打开 HTTP SSE 事件流', 'Could not open the HTTP SSE event stream'],
  ['微信 BOT 未登录', '微信 BOT 未登录', 'WeChat bot is not logged in'],
  ['非 QQ 官方连接', '非 QQ 官方连接', 'Not a QQ official connection'],
  ['QQ 官方连接缺少 AppID，无法调用官方接口', 'QQ 官方连接缺少 AppID，无法调用官方接口', 'QQ official connection has no AppID; official APIs are unavailable'],
  ['QQ 官方连接缺少 AppID / AppSecret，无法获取 AccessToken', 'QQ 官方连接缺少 AppID / AppSecret，无法获取 AccessToken', 'QQ official connection has no AppID / AppSecret; cannot obtain an access token'],

  // ===== 登录 / 会话 =====
  ['登录密钥错误', '登录密钥错误', 'Incorrect login key'],
  ['会话已失效，请重新登录', '会话已失效，请重新登录', 'Session expired, please log in again'],
  ['两次输入的密码不一致', '两次输入的密码不一致', 'The two passwords do not match'],
  ['当前已是自定义密码，无需再次设置', '当前已是自定义密码，无需再次设置', 'A custom password is already set'],
  ['密码不能为空', '密码不能为空', 'Password cannot be empty'],
  ['该接口仅允许本机 / 内网访问', '该接口仅允许本机 / 内网访问', 'This endpoint is only accessible from localhost or the LAN'],
  ['非法会话 id', '非法会话 id', 'Invalid session id'],

  // ===== 在线更新 =====
  ['已有安装任务进行中', '已有安装任务进行中', 'An install task is already running'],
  ['缺少目标版本', '缺少目标版本', 'Missing target version'],
  ['正在解析下载地址…', '正在解析下载地址…', 'Resolving download URL…'],
  ['重启已在进行中…', '重启已在进行中…', 'Restart already in progress…'],
  ['当前启动方式不支持自动重启，请手动重启进程后生效。', '当前启动方式不支持自动重启，请手动重启进程后生效。', 'This launch mode does not support auto-restart; restart the process manually.'],
  ['便携包不是有效的 zip 归档', '便携包不是有效的 zip 归档', 'The portable package is not a valid zip archive'],
  ['便携包体积异常', '便携包体积异常', 'Portable package size looks wrong'],
  ['当前平台无对应便携发行包', '当前平台无对应便携发行包', 'No portable release for the current platform'],
  ['远程公告暂不可用（双源均未取到）', '远程公告暂不可用（双源均未取到）', 'Remote announcement unavailable (both sources failed)'],
  ['远程公告为空', '远程公告为空', 'Remote announcement is empty'],

  // ===== 设置 / 外观 / Token =====
  ['Token 无效或已被撤销', 'Token 无效或已被撤销', 'Token is invalid or has been revoked'],
  ['不支持该文件格式', '不支持该文件格式', 'Unsupported file format'],
  ['文件为空', '文件为空', 'File is empty'],
  ['文件过大', '文件过大', 'File is too large'],
  ['未收到文件', '未收到文件', 'No file received'],
  ['没有收到文件', '没有收到文件', 'No file received'],
  ['参数错误', '参数错误', 'Invalid parameters'],
  ['端口无效', '端口无效', 'Invalid port'],
  ['外放 API 未开启（请在设置页开启「外放 API」开关）', '外放 API 未开启（请在设置页开启「外放 API」开关）', 'Public API is disabled (turn it on in Settings)'],
  ['未找到可用的 npm，无法在控制台安装；请在项目目录手动执行 npm install。', '未找到可用的 npm，无法在控制台安装；请在项目目录手动执行 npm install。', 'No usable npm found; cannot install from the console. Run npm install in the project folder manually.'],
  ['正在执行 npm install…', '正在执行 npm install…', 'Running npm install…'],
  ['sharp 入口不是可调用的模块导出', 'sharp 入口不是可调用的模块导出', 'The sharp entry is not a callable module export'],

  // ===== AI =====
  ['请先填写 API Key', '请先填写 API Key', 'Please enter your API key first'],
  ['请先填写服务器地址', '请先填写服务器地址', 'Please enter the server URL first'],
  ['请先填写模型名称（可点「获取模型」从上游拉取列表）', '请先填写模型名称（可点「获取模型」从上游拉取列表）', 'Please enter a model name first (use "Fetch models" to pull the list from upstream)'],
  ['请先选择请求协议（OpenAI 兼容 / Anthropic）', '请先选择请求协议（OpenAI 兼容 / Anthropic）', 'Please choose a protocol first (OpenAI-compatible / Anthropic)'],
  ['档案不存在', '档案不存在', 'Profile not found'],
  ['档案不存在，请先保存再试', '档案不存在，请先保存再试', 'Profile not found; save it first and retry'],
  ['上游响应无内容', '上游响应无内容', 'Upstream returned no content'],
  ['上游未返回任何内容（模型回复为空）。请检查档案配置/密钥/模型名，或换一个上游。', '上游未返回任何内容（模型回复为空）。请检查档案配置/密钥/模型名，或换一个上游。', 'Upstream returned nothing (empty model reply). Check the profile config, key and model name, or switch upstream.'],
  ['上游连接超时', '上游连接超时', 'Upstream connection timed out'],

  // ===== 工具 =====
  ['仅支持 http/https', '仅支持 http/https', 'Only http/https is supported'],
  ['重定向次数过多', '重定向次数过多', 'Too many redirects'],
  ['上游返回了无法解析的跳转地址', '上游返回了无法解析的跳转地址', 'Upstream returned an unparsable redirect URL'],
  ['无效的任务 ID', '无效的任务 ID', 'Invalid task ID'],
  ['任务不存在（可能已被清空）', '任务不存在（可能已被清空）', 'Task not found (it may have been cleared)'],
  ['找不到待处理的文件，请重新上传', '找不到待处理的文件，请重新上传', 'File to process not found; please upload it again'],
  ['结果已失效，请重新处理', '结果已失效，请重新处理', 'The result has expired; please process again'],
  ['无效的 token', '无效的 token', 'Invalid token'],
  ['读取失败', '读取失败', 'Failed to read'],
  ['读取文件失败', '读取文件失败', 'Failed to read the file'],
  ['压缩包内存在非法条目名，已拒绝解压', '压缩包内存在非法条目名，已拒绝解压', 'Archive contains an illegal entry name; extraction refused'],
  ['压缩包解压体积超限，已中止解压', '压缩包解压体积超限，已中止解压', 'Archive exceeds the size limit; extraction aborted'],
  ['压缩包内含符号链接或特殊文件条目，已拒绝解压', '压缩包内含符号链接或特殊文件条目，已拒绝解压', 'Archive contains symlinks or special entries; extraction refused'],
  ['包体超过大小上限', '包体超过大小上限', 'Package exceeds the size limit'],
  ['图片解码失败', '图片解码失败', 'Failed to decode the image'],
  ['无法生成图片', '无法生成图片', 'Failed to generate the image'],
  ['无法创建画布上下文', '无法创建画布上下文', 'Could not create a canvas context'],
  ['无法创建 2D 画布上下文', '无法创建 2D 画布上下文', 'Could not create a 2D canvas context'],
  ['无法读取图片尺寸（图片可能已损坏）', '无法读取图片尺寸（图片可能已损坏）', 'Could not read image size (the image may be corrupted)'],
  ['无法读取图片尺寸（文件可能已损坏）', '无法读取图片尺寸（文件可能已损坏）', 'Could not read image size (the file may be corrupted)'],
  ['无法解码该图片（请确认是有效的图片文件）', '无法解码该图片（请确认是有效的图片文件）', 'Could not decode this image (make sure it is a valid image file)'],
  ['当前浏览器无法解码该图片格式（像素置乱仅支持 PNG/JPEG/WebP/BMP/GIF 等光栅图）', '当前浏览器无法解码该图片格式（像素置乱仅支持 PNG/JPEG/WebP/BMP/GIF 等光栅图）', 'This browser cannot decode the image format (pixel scrambling supports raster images only: PNG / JPEG / WebP / BMP / GIF)'],
  ['当前浏览器不支持本地压缩，请换用较新的 Chrome / Edge / Firefox / Safari', '当前浏览器不支持本地压缩，请换用较新的 Chrome / Edge / Firefox / Safari', 'This browser does not support local compression; use a newer Chrome / Edge / Firefox / Safari'],
  ['当前浏览器不支持本地解压，请换用较新的 Chrome / Edge / Firefox / Safari', '当前浏览器不支持本地解压，请换用较新的 Chrome / Edge / Firefox / Safari', 'This browser does not support local decompression; use a newer Chrome / Edge / Firefox / Safari'],
  ['当前环境不是安全上下文（需 https 或 localhost），无法使用加密；可改用「像素置乱」路线', '当前环境不是安全上下文（需 https 或 localhost），无法使用加密；可改用「像素置乱」路线', 'Not a secure context (https or localhost required); encryption unavailable. Use the "pixel scramble" mode instead.'],
  ['不是有效的混淆文件（文件头不符）', '不是有效的混淆文件（文件头不符）', 'Not a valid obfuscated file (wrong file header)'],
  ['解密失败：密码不正确或文件已损坏', '解密失败：密码不正确或文件已损坏', 'Decryption failed: wrong password or corrupted file'],
  ['解密失败：文件已损坏（分片长度异常）', '解密失败：文件已损坏（分片长度异常）', 'Decryption failed: file corrupted (abnormal chunk length)'],
  ['解密结果为空', '解密结果为空', 'Decryption produced no data'],
  ['加密载荷过短，无法解密', '加密载荷过短，无法解密', 'Encrypted payload is too short to decrypt'],
  ['绑定密钥不是 32 字节 AES 密钥', '绑定密钥不是 32 字节 AES 密钥', 'Binding key is not a 32-byte AES key'],
  ['编码失败（浏览器不支持该输出格式？）', '编码失败（浏览器不支持该输出格式？）', 'Encoding failed (browser does not support this output format?)'],
  ['压缩 / 解压失败', '压缩 / 解压失败', 'Compression / decompression failed'],
  ['源码包不是有效的 gzip 归档', '源码包不是有效的 gzip 归档', 'The source package is not a valid gzip archive'],
  ['教程 manifest.json 解析失败', '教程 manifest.json 解析失败', 'Failed to parse the guide manifest.json'],
  ['未能识别平台（支持 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram）', '未能识别平台（支持 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram）', 'Unrecognized platform (supported: Bilibili / Douyin / Xiaohongshu / Kuaishou / TikTok / YouTube / X / Telegram)'],
  ['请输入链接或含链接的文本', '请输入链接或含链接的文本', 'Please enter a link or text containing a link'],
  ['请输入小红书链接', '请输入小红书链接', 'Please enter a Xiaohongshu link'],
  ['请输入要转换的数字', '请输入要转换的数字', 'Please enter a number to convert'],
  ['Base64 含非法字符，请检查是否复制完整', 'Base64 含非法字符，请检查是否复制完整', 'Base64 contains illegal characters; check that you copied it completely'],
  ['Base64 长度不合法（可能被截断）', 'Base64 长度不合法（可能被截断）', 'Invalid Base64 length (it may be truncated)'],
  ['没有可解码的 Base64 内容', '没有可解码的 Base64 内容', 'No decodable Base64 content'],
  ['没有可解码的 Base32 内容', '没有可解码的 Base32 内容', 'No decodable Base32 content'],
  ['没有可解码的十六进制内容', '没有可解码的十六进制内容', 'No decodable hex content'],
  ['十六进制长度必须是偶数（两个字符表示一个字节）', '十六进制长度必须是偶数（两个字符表示一个字节）', 'Hex length must be even (two characters per byte)'],
  ['含非十六进制字符，请检查输入', '含非十六进制字符，请检查输入', 'Contains non-hex characters; check your input'],
  ['名称不能为空', '名称不能为空', 'Name cannot be empty'],
  ['地址不能为空', '地址不能为空', 'Address cannot be empty'],
  ['缺少账号', '缺少账号', 'Missing account'],
  ['缺少 content', '缺少 content', 'Missing content'],
  ['缺少 text', '缺少 text', 'Missing text'],
  ['缺少 user_id（私聊目标用户）', '缺少 user_id（私聊目标用户）', 'Missing user_id (private chat target)'],
  ['缺少 to_user_id', '缺少 to_user_id', 'Missing to_user_id'],
  ['缺少 target_id（频道）或 user_id（私聊）', '缺少 target_id（频道）或 user_id（私聊）', 'Missing target_id (channel) or user_id (private chat)'],
  ['缺少 file_path 或 url', '缺少 file_path 或 url', 'Missing file_path or url'],
  ['缺少 path（如 /friend?type=request）', '缺少 path（如 /friend?type=request）', 'Missing path (e.g. /friend?type=request)'],
  ['缺少下载地址', '缺少下载地址', 'Missing download URL'],
  // ===== 前端自身抛的兜底文案（也是中文原文，同样要能翻）=====
  ['添加失败', '添加失败', 'Failed to add'],
  ['操作失败', '操作失败', 'Operation failed'],
  ['卸载失败', '卸载失败', 'Uninstall failed'],
  ['删除运行副本失败', '删除运行副本失败', 'Failed to delete the runtime copy'],
  ['保存失败', '保存失败', 'Failed to save'],
  ['上传失败', '上传失败', 'Upload failed'],
  ['下载失败', '下载失败', 'Download failed'],
  ['请求失败', '请求失败', 'Request failed'],
  ['背景图上传失败', '背景图上传失败', 'Failed to upload the background image'],
  ['背景图移除失败', '背景图移除失败', 'Failed to remove the background image'],
  ['无法截取封面', '无法截取封面', 'Could not capture the cover image'],
  ['请求超时', '请求超时', 'Request timed out'],
  ['网络超时', '网络超时', 'Network timed out'],
  ['响应超时', '响应超时', 'Response timed out'],
  ['下载超时', '下载超时', 'Download timed out'],
  ['连接超时', '连接超时', 'Connection timed out'],
  ['网络请求超时', '网络请求超时', 'Network request timed out'],
  ['上传超时', '上传超时', 'Upload timed out'],
  ['已取消', '已取消', 'Cancelled'],
  ['7z 解压未产生任何文件', '7z 解压未产生任何文件', '7z produced no files'],
  // ===== 其余会出现在报错窗口里的兜底短句 =====
  ['未知原因', '未知原因', 'Unknown reason'],
  ['未知错误', '未知错误', 'Unknown error'],
  // 成功 / 完成类（后端也会回中文，同样要能翻）
  ['上传成功', '上传成功', 'Uploaded'],
  ['安装成功', '安装成功', 'Installed'],
  ['保存成功', '保存成功', 'Saved'],
  ['操作成功', '操作成功', 'Done'],
  ['删除成功', '删除成功', 'Deleted'],
  ['添加成功', '添加成功', 'Added'],
  ['已保存', '已保存', 'Saved'],
  ['登录成功', '登录成功', 'Logged in'],
  ['解析失败', '解析失败', 'Parse failed'],
  ['创建连接失败', '创建连接失败', 'Failed to create the connection'],
  ['无法开始安装', '无法开始安装', 'Could not start the installation'],
  ['未能接入任何机器人', '未能接入任何机器人', 'Could not connect to any bot'],
  ['当前环境不支持在线更新', '当前环境不支持在线更新', 'Online update is not supported in this environment'],
  ['未找到可用的 sharp 包', '未找到可用的 sharp 包', 'No usable sharp package found'],
  ['你的账号在其它设备登录，已被迫下线', '你的账号在其它设备登录，已被迫下线', 'Your account signed in on another device, so this session was logged out'],
  ['获取视频信息失败', '获取视频信息失败', 'Failed to fetch video info'],
  ['番剧信息获取失败（可能需要大会员或地区受限）', '番剧信息获取失败（可能需要大会员或地区受限）', 'Failed to fetch the bangumi info (membership or region restrictions may apply)'],
  ['动态信息获取失败（可能已删除或仅好友可见）', '动态信息获取失败（可能已删除或仅好友可见）', 'Failed to fetch the post (it may be deleted or friends-only)'],
  ['（上游无响应体——多为网关/渠道瞬断，并非业务报错）', '（上游无响应体——多为网关/渠道瞬断，并非业务报错）', '(Upstream returned no body — usually a gateway hiccup, not a business error)'],
  ['当前 Node 不支持 CommonJS 兼容加载（缺少 Module._compile），请把插件入口改成 .mjs', '当前 Node 不支持 CommonJS 兼容加载（缺少 Module._compile），请把插件入口改成 .mjs', 'This Node build lacks CommonJS compat loading (no Module._compile); rename the plugin entry to .mjs'],

  ['已停止', '已停止', 'Stopped'],
  ['未配置代理', '未配置代理', 'No proxy configured'],
  ['代理请求仅支持 https 目标', '代理请求仅支持 https 目标', 'Proxy requests support https targets only'],
  ['代理请求超时', '代理请求超时', 'Proxy request timed out'],
  ['代理连接超时', '代理连接超时', 'Proxy connection timed out'],
  ['AppSecret 为空，无法派生 Ed25519 签名密钥', 'AppSecret 为空，无法派生 Ed25519 签名密钥', 'AppSecret is empty; cannot derive the Ed25519 signing key'],
  ['AppSecret 解密失败（密钥不匹配或载荷损坏）', 'AppSecret 解密失败（密钥不匹配或载荷损坏）', 'AppSecret decryption failed (key mismatch or corrupted payload)'],
  ['CDN 上传地址缺失', 'CDN 上传地址缺失', 'Missing CDN upload URL'],
  ['CDN 响应缺少 x-encrypted-param', 'CDN 响应缺少 x-encrypted-param', 'CDN response is missing x-encrypted-param'],
  ['q.qq.com 未返回绑定任务 ID', 'q.qq.com 未返回绑定任务 ID', 'q.qq.com did not return a bind task ID'],
  ['解析失败：分享页抓取失败（请求被拒或超时）', '解析失败：分享页抓取失败（请求被拒或超时）', 'Parse failed: could not fetch the share page (request rejected or timed out)'],
];

/** 正则匹配表：带变量的文案，`$1`/`$2` 回填捕获组。 */
const RULES: Array<[RegExp, string, string]> = [
  // 商城 / 下载 / HTTP
  [/^商城接口 HTTP (\d+)$/, '商城接口 HTTP $1', 'Store API returned HTTP $1'],
  [/^封面获取失败 HTTP (\d+)$/, '封面获取失败 HTTP $1', 'Failed to fetch cover (HTTP $1)'],
  [/^下载失败 HTTP (\d+)$/, '下载失败 HTTP $1', 'Download failed (HTTP $1)'],
  [/^下载失败 (\d+): (.+)$/, '下载失败（$1）', 'Download failed ($1)'],
  [/^获取版本信息失败 HTTP (\d+)$/, '获取版本信息失败 HTTP $1', 'Failed to fetch version info (HTTP $1)'],
  [/^获取二维码失败: (\d+)$/, '获取二维码失败（$1）', 'Failed to get QR code ($1)'],
  [/^轮询二维码状态失败: (\d+)$/, '轮询二维码状态失败（$1）', 'Failed to poll QR status ($1)'],
  [/^CDN 上传失败 (\d+): (.+)$/, 'CDN 上传失败（$1）', 'CDN upload failed ($1)'],
  [/^上游返回 HTTP (\d+)：(.+)$/, '上游返回 HTTP $1', 'Upstream returned HTTP $1'],
  [/^KOOK API 响应异常（HTTP (\d+)）: (.+)$/, 'KOOK API 响应异常（HTTP $1）', 'KOOK API returned an abnormal response (HTTP $1)'],
  [/^KOOK 资源上传响应异常（HTTP (\d+)）: (.+)$/, 'KOOK 资源上传响应异常（HTTP $1）', 'KOOK resource upload failed (HTTP $1)'],
  [/^HTTP API 响应非 JSON \((\d+)\): (.+)$/, 'HTTP API 响应非 JSON（$1）', 'HTTP API returned non-JSON response ($1)'],
  [/^公告加载失败 HTTP (\d+)$/, '公告加载失败 HTTP $1', 'Failed to load the announcement (HTTP $1)'],
  [/^网络请求失败: (.+)$/, '网络请求失败：$1', 'Network request failed: $1'],
  [/^请求 q.qq.com 失败：(.+)$/, '请求 q.qq.com 失败：$1', 'q.qq.com request failed: $1'],
  [/^q.qq.com 返回失败：(.+)$/, 'q.qq.com 返回失败：$1', 'q.qq.com returned an error: $1'],
  [/^上游错误：(.+)$/, '上游错误：$1', 'Upstream error: $1'],
  [/^API 超时: (.+)$/, 'API 超时：$1', 'API timed out: $1'],
  [/^KOOK API 请求超时: (.+)$/, 'KOOK API 请求超时：$1', 'KOOK API request timed out: $1'],

  // 分类 / 路径 / 版本
  [/^未找到分类「(.+)」$/, '未找到分类「$1」', 'Category "$1" not found'],
  [/^插件 (.+) 不存在$/, '插件 $1 不存在', 'Plugin $1 does not exist'],
  [/^插件安装目录不存在: (.+)$/, '插件安装目录不存在：$1', 'Plugin install directory does not exist: $1'],
  [/^教程文件未找到：(.+)$/, '教程文件未找到：$1', 'Guide file not found: $1'],
  [/^跳转目标不在白名单：(.+)$/, '跳转目标不在白名单：$1', 'Redirect target not in the allowlist: $1'],
  [/^该版本未提供 (.+) 便携包资产$/, '该版本未提供 $1 便携包资产', 'This version ships no portable package for $1'],
  [/^无法识别的压缩包格式，仅支持 (.+)$/, '无法识别的压缩包格式，仅支持 $1', 'Unrecognized archive format; only $1 is supported'],

  // 压缩包
  [/^压缩包内含符号链接或特殊文件条目，已拒绝解压：(.+)$/, '压缩包含特殊条目，已拒绝解压：$1', 'Archive contains symlinks or special entries; extraction refused: $1'],
  [/^压缩包内含绝对路径条目，已拒绝解压：(.+)$/, '压缩包含绝对路径条目，已拒绝解压：$1', 'Archive contains an absolute path entry; extraction refused: $1'],
  [/^压缩包内非法路径：(.+)$/, '压缩包内非法路径：$1', 'Illegal path inside the archive: $1'],
  [/^压缩包条目过多（(\d+) 个），已拒绝解压$/, '压缩包条目过多（$1 个），已拒绝解压', 'Archive has too many entries ($1); extraction refused'],
  [/^7z 解压失败（code (\d+)）$/, '7z 解压失败（code $1）', '7z extraction failed (code $1)'],

  // 适配器 / 动作
  [/^\[(.+)\] (.+) 未连接，请检查连接管理中的 OneBot 配置$/, '[$1] $2 未连接，请检查连接管理中的 OneBot 配置', '[$1] $2 is not connected; check the OneBot settings in connection management'],
  [/^\[(.+)\] KOOK 连接未就绪$/, '[$1] KOOK 连接未就绪', '[$1] KOOK connection is not ready'],
  [/^\[(.+)\] QQ 官方连接未就绪$/, '[$1] QQ 官方连接未就绪', '[$1] QQ official connection is not ready'],
  [/^\[(.+)\] 微信 BOT 连接未就绪$/, '[$1] 微信 BOT 连接未就绪', '[$1] WeChat bot connection is not ready'],
  [/^KOOK 不支持动作: (.+)$/, 'KOOK 不支持动作：$1', 'KOOK does not support this action: $1'],
  [/^微信 BOT 不支持动作: (.+)$/, '微信 BOT 不支持动作：$1', 'WeChat bot does not support this action: $1'],
  [/^Gateway 响应缺少 url \[(.+)\] (.+)$/, 'Gateway 响应缺少 url', 'Gateway response is missing the url field'],

  // 编码 / 进制
  [/^混淆文件版本不兼容（v(\d+)）$/, '混淆文件版本不兼容（v$1）', 'Incompatible obfuscated file version (v$1)'],
  [/^「(.+)」不是 (\d+) 进制的有效数字$/, '「$1」不是 $2 进制的有效数字', '"$1" is not a valid base-$2 number'],
  [/^Base32 含非法字符「(.+)」$/, 'Base32 含非法字符「$1」', 'Base32 contains an illegal character "$1"'],
  [/^链接格式错误，无法提取ID。处理后的链接: (.+)$/, '链接格式错误，无法提取 ID', 'Malformed link: could not extract the ID'],
  [/^已达单轮最大步数（(\d+)），已中断。你可以继续发消息让它接着做。$/, '已达单轮最大步数（$1），已中断', 'Reached the max steps for one round ($1) and stopped. Send another message to continue.'],
  [/^封面不是有效图片（远端类型: (.+)）$/, '封面不是有效图片（远端类型：$1）', 'Cover is not a valid image (remote type: $1)'],
  // 兜底：任何没精确收录的「…超时」都归到超时（放最后，不抢精确条目的位置）
  [/超时$/, '请求超时，请检查网络后重试', 'Request timed out. Check your network and try again.'],
  [/^安装包校验未通过：期望 (.+)，实际 (.+)，文件可能被篡改或损坏$/, '安装包校验未通过：期望 $1，实际 $2，文件可能被篡改或损坏', 'Package checksum failed: expected $1, got $2. The file may be tampered with or corrupted.'],
];

/**
 * 浏览器 / Node / undici 抛出的英文底层错误。
 * 顺序敏感：timeout 必须排在 abort 之前（超时报文里也含 "aborted"）。
 */
const SYS: Array<[RegExp, string, string]> = [
  // 注意：Node/undici 的超时报文里也含 "aborted"，所以超时必须排在「已取消」前面
  [/timed ?out|time[\s-]?out|TimeoutError|deadline exceeded/i, '请求超时，请检查网络后重试', 'Request timed out. Check your network and try again.'],
  [/ETIMEDOUT/, '连接超时，请检查网络后重试', 'Connection timed out. Check your network and try again.'],
  [/ECONNREFUSED/, '连接被拒绝（服务未启动或端口不对）', 'Connection refused (service not running or wrong port)'],
  [/ENOTFOUND|EAI_AGAIN/, '域名解析失败，请检查网络或镜像地址', 'DNS lookup failed. Check your network or the mirror address.'],
  [/ECONNRESET/, '连接被重置，请重试', 'Connection was reset, please try again.'],
  [/ECONNABORTED|EPIPE|socket hang up/, '连接中断，请重试', 'Connection aborted, please try again.'],
  [/EHOSTUNREACH|ENETUNREACH|EHOSTDOWN/, '网络不可达，请检查网络', 'Network unreachable; check your connection.'],
  [/certificate|SSL|TLS|self.signed/i, 'HTTPS 证书校验失败，请检查系统时间或网络环境', 'HTTPS certificate check failed. Check your system time or network.'],
  [/fetch failed|failed to fetch|networkerror|network request failed|load failed/i, '网络请求失败，请检查网络后重试', 'Network request failed. Check your connection and try again.'],
  [/unexpected token|unexpected end of json|is not valid json|JSON\.parse/i, '响应不是合法 JSON（可能是代理页或错误页）', 'Response is not valid JSON (probably a proxy or error page).'],
  [/aborted|AbortError/, '请求已取消', 'Request cancelled'],
  [/HTTP (\d{3})/, '服务端返回 HTTP $1', 'Server returned HTTP $1'],
  [/status code (\d{3})/i, '服务端返回状态码 $1', 'Server returned status code $1'],
];

/** 精确表转 Map，避免每次线性查找。 */
const EXACT_MAP: Map<string, { zh: string; en: string }> = new Map(
  EXACT.map(([raw, zh, en]) => [raw, { zh, en }]),
);

/**
 * 把后端（或底层）回传的错误文案翻成当前语言。
 * 没命中任何规则时原样返回 —— 中文模式下原文就是对的，不会比误翻更糟。
 */
export function svcText(raw?: string | null, code?: string | null, lang = getLang()): string {
  // 1) 结构化错误码优先
  if (code) {
    const hit = CODES[code];
    if (hit) return lang === 'en' ? hit.en : hit.zh;
  }
  const s = (raw || '').trim();
  if (!s) return '';

  // 2) 精确匹配
  const exact = EXACT_MAP.get(s);
  if (exact) return lang === 'en' ? exact.en : exact.zh;

  const pick = (zh: string, en: string) => (lang === 'en' ? en : zh);
  // 模板里的 $1/$2 用捕获组回填；整串替换，避免残留原文片段（底层英文尤其明显）
  const fill = (tpl: string, m: RegExpMatchArray | null) =>
    tpl.replace(/\$(\d)/g, (_, i: string) => m?.[Number(i)] ?? '');

  // 3) 带变量的后端文案
  for (const [re, zh, en] of RULES) {
    const m = s.match(re);
    if (m) return fill(pick(zh, en), m);
  }

  // 4) 底层英文错误（超时 / DNS / 连接被拒 / JSON…）
  for (const [re, zh, en] of SYS) {
    const m = s.match(re);
    if (m) return fill(pick(zh, en), m);
  }

  return s;
}

/** 组件内使用：随语言切换重渲染。用法 `const svc = useSvcText();` */
export function useSvcText(): SvcTextFn {
  const lang = useLang();
  return (raw?: string | null) => svcText(raw, undefined, lang);
}

/** 任意异常 → 当前语言的错误文案（拿不到就空串，交给调用方的兜底 key）。 */
export function errText(e: unknown, lang = getLang()): string {
  if (e == null) return '';
  if (e instanceof Error) return svcText(e.message, undefined, lang);
  if (typeof e === 'string') return svcText(e, undefined, lang);
  return svcText(String(e), undefined, lang);
}

/**
 * 后端响应 → 文案：优先用结构化 code，其次 message，都没有返回空串
 * （调用方再 `|| t('xxx.failed')` 兜底）。
 */
export function resText(
  res: { ok?: boolean; message?: string | null; code?: unknown } | null | undefined,
  lang = getLang(),
): string {
  if (!res) return '';
  // code 既可能是后端错误码（string），也可能是业务状态码（number，如 OneBot 的 retcode）
  return svcText(res.message, typeof res.code === 'string' ? res.code : undefined, lang);
}
