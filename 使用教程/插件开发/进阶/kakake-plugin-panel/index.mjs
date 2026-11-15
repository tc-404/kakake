/**
 * kakake-plugin-panel —— 配置项 / 插件路由 / 网页后台 / 权限 四合一完整示例
 *
 * 适用范围：咔咔珂认的**全部四类连接协议的插件**——
 *   OneBot11（kakake- 前缀）、QQ 官方（GF- 前缀）、微信（WX- 前缀）、KOOK（ss-plugin- 前缀）。
 *
 * 为什么一份代码能同时给四类用：
 *   宿主给每类插件构造的 ctx 都是同一个形状——router / NapCatConfig / configPath /
 *   actions.call / frameworkEnv 全都在（见宿主 src/plugin/plugin.types.ts 的
 *   NapCatPluginContext）。所以「配置项、路由、网页后台、权限」这四件事**一字不用改**。
 *   真正随协议变的只有两处，本文件都收在下面第三节里：
 *     ① 事件字段（文字从哪个字段取、会话怎么标识）
 *     ② 发消息要调的接口名
 *
 * 装载：把整个 kakake-plugin-panel 文件夹拷到  <咔咔珂项目根目录>/plugins/ 下，
 *       控制台 → 插件 → 打开总开关 → 连接里打开本插件的子开关。
 *
 * 打开后台：控制台 → 插件 → 本插件右上角「打开控制台」。
 */

import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// ① 配置项：默认值 / 读文件 / 写文件
// ============================================================================

/** 默认配置。键名必须和下面 schema 里的 key 一模一样。 */
const DEFAULTS = {
  enableReply: true,
  welcomeText: '你好呀，我是「后台面板示例」插件',
  replyPrefix: '【面板】',
  cooldownMs: 3000,
  targetType: 'group',
  targetId: '',
};

/** 当前生效的配置（内存里的一份，改了立即生效，不用重载插件） */
let config = { ...DEFAULTS };

/** 控制台「插件配置」弹窗读的就是这个导出。先用 const 数组，init 里往里 push。 */
const plugin_config_ui = [];

/** 插件上下文，路由处理器和事件回调里都要用 */
let ctx = null;

/** 运行统计，给网页后台看 */
const stats = {
  loadedAt: Date.now(),
  messages: 0,
  replies: 0,
  apiCalls: 0,
  lastMessageAt: 0,
};

/** 每个会话的冷却计时：会话键 → 上次回复时间 */
const lastReplyAt = new Map();

/** 免登录 webhook 收到的最近几条（只留在内存里，给后台页面看） */
const hookLog = [];

function writeConfigFile(value) {
  fs.mkdirSync(path.dirname(ctx.configPath), { recursive: true });
  fs.writeFileSync(ctx.configPath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8');
}

/** 读配置：文件里的值覆盖默认值，缺字段就用默认值 */
function readConfig() {
  const next = { ...DEFAULTS };
  try {
    if (fs.existsSync(ctx.configPath)) {
      const raw = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] !== undefined && raw[key] !== null) next[key] = raw[key];
      }
    } else {
      // 第一次加载：落一份模板，方便用户直接改文件
      writeConfigFile(next);
      ctx.logger.info(`已生成配置模板：${ctx.configPath}`);
    }
  } catch (err) {
    ctx.logger.warn('config.json 解析失败，先按默认值跑：', err);
  }
  return next;
}

/** 合并式保存：只覆盖传进来的字段，其它字段保持不动 */
function applyConfig(patch) {
  const clean = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (patch && patch[key] !== undefined) clean[key] = patch[key];
  }
  config = { ...config, ...clean };
  writeConfigFile(config);
  return config;
}

// ============================================================================
// ② 配置项 Schema：控制台「插件配置」弹窗长什么样
// ============================================================================

/**
 * 控制台表单支持这几种控件：
 *   boolean      → 开关
 *   number       → 数字输入框
 *   select       → 下拉框（必须给 options）
 *   string（text）→ 文本输入框
 *   multi-select → 文本输入框（宿主没做多选框，值会存成数组）
 *
 * 两条实测得到的注意事项：
 *   1. **只有 string 和 multi-select 会把 description 显示出来**；
 *      boolean / number / select 只显示 label，说明文字写在那儿看不见。
 *   2. `ctx.NapCatConfig.html()` 和 `.plainText()` 生成的 key 以 `_` 开头，
 *      控制台会把它们**整条过滤掉**——想加说明文字，写进 string 项的 description。
 */
function buildConfigSchema() {
  const C = ctx.NapCatConfig;
  const schema = C.combine(
    C.boolean(
      'enableReply',
      '启用消息回复',
      DEFAULTS.enableReply,
    ),
    C.text(
      'welcomeText',
      '欢迎语',
      DEFAULTS.welcomeText,
      '群里发「面板」时回复的内容。说明文字只有文本框类型才显示得出来。',
    ),
    C.text(
      'replyPrefix',
      '回复前缀',
      DEFAULTS.replyPrefix,
      '每条自动回复前都加上这段文字；留空就不加。',
    ),
    C.number(
      'cooldownMs',
      '回复冷却（毫秒）',
      DEFAULTS.cooldownMs,
    ),
    C.select(
      'targetType',
      '主动发送目标类型',
      [
        { label: '群聊 / 频道', value: 'group' },
        { label: '私聊', value: 'private' },
      ],
      DEFAULTS.targetType,
    ),
    C.text(
      'targetId',
      '主动发送目标 ID',
      DEFAULTS.targetId,
      'OneBot 填群号或 QQ 号；KOOK 填频道 ID 或用户 ID；微信填用户 ID；QQ 官方填 group_openid 或 user_openid。留空则后台的「主动发送」按钮不可用。',
    ),
  );

  // 往同一个数组里塞，保证导出的引用始终是这一个（CJS 写法里也能这样保证）
  plugin_config_ui.length = 0;
  plugin_config_ui.push(...schema);
  return plugin_config_ui;
}

// ============================================================================
// ③ 协议适配层：整个插件唯一需要按协议分支的地方
// ============================================================================

/**
 * 判断这条事件来自哪类连接。
 * 宿主在把事件丢给插件前会打上标记（实测于四个 manager 的 onEvent）：
 *   KOOK  → event.kook === true        （还有 event.t / event.channel_id）
 *   QQ 官方 → event.qq_official === true
 *   微信   → event.weixin_bot === true
 *   OneBot → 以上都没有
 */
function detectProtocol(event) {
  if (event && event.kook) return 'kook';
  if (event && event.qq_official) return 'gf';
  if (event && event.weixin_bot) return 'wx';
  return 'ob';
}

/** 取出对方发的纯文字（四类协议字段不同，这里统一成字符串） */
function eventText(event) {
  // OneBot：message 是 JSON 消息段数组
  if (Array.isArray(event.message)) {
    let text = '';
    for (const part of event.message) {
      if (part && part.type === 'text' && part.data && part.data.text) {
        text += String(part.data.text);
      }
    }
    return text.trim();
  }
  // QQ 官方：content 是字符串，@ 会写成 <@!openid>，顺手去掉
  if (typeof event.content === 'string') {
    return event.content.replace(/<@!?[A-Za-z0-9_-]+>/g, '').trim();
  }
  // KOOK / 微信：message 和 raw_message 直接就是字符串
  const raw = event.message !== undefined ? event.message : event.raw_message;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** 当前会话的稳定标识，用来做冷却和记忆 */
function sessionKey(event) {
  const proto = detectProtocol(event);
  if (proto === 'ob') {
    return `${proto}:${event.group_id ?? 'private'}:${event.user_id ?? ''}`;
  }
  if (proto === 'kook') {
    return `${proto}:${event.channel_id ?? 'private'}:${event.user_id ?? ''}`;
  }
  if (proto === 'wx') {
    return `${proto}:${event.from_user_id ?? event.user_id ?? ''}`;
  }
  // QQ 官方
  const gid = event.group_openid ?? event.group_open_id ?? 'private';
  const uid = (event.author && (event.author.user_openid || event.author.member_openid))
    ?? event.user_openid
    ?? event.user_id
    ?? '';
  return `${proto}:${gid}:${uid}`;
}

/** 一条纯文字消息，回给「发来这条事件的那个会话」 */
async function replyTo(event, text) {
  const proto = detectProtocol(event);

  if (proto === 'ob') {
    const message = [{ type: 'text', data: { text } }];
    if (event.message_type === 'private') {
      await ctx.actions.call('send_private_msg', { user_id: event.user_id, message });
    } else {
      await ctx.actions.call('send_group_msg', { group_id: event.group_id, message });
    }
    return;
  }

  if (proto === 'kook') {
    if (event.message_type === 'private') {
      await ctx.actions.call('send_private_msg', { user_id: event.user_id, content: text });
    } else {
      await ctx.actions.call('send_msg', { target_id: event.channel_id, content: text });
    }
    return;
  }

  if (proto === 'wx') {
    await ctx.actions.call('send_msg', {
      to_user_id: event.from_user_id ?? event.user_id,
      text,
    });
    return;
  }

  // QQ 官方：接口名就是官方 REST 路径，主动消息必须带 msg_id + msg_seq
  const groupOpenid = String(event.group_openid ?? event.group_open_id ?? '');
  const userOpenid = String(
    (event.author && (event.author.user_openid || event.author.member_openid))
    ?? event.user_openid
    ?? '',
  );
  const body = { content: text, msg_type: 0 };
  if (event.id) {
    body.msg_id = String(event.id);
    body.msg_seq = 1;
  }
  if (groupOpenid) {
    await ctx.actions.call(`/v2/groups/${groupOpenid}/messages`, body);
    return;
  }
  if (userOpenid) {
    await ctx.actions.call(`/v2/users/${userOpenid}/messages`, body);
    return;
  }
  throw new Error('QQ 官方：拿不到发送目标（group_openid / user_openid 都是空）');
}

/**
 * 主动往配置里那个目标发文字——给网页后台的「主动发送」按钮用。
 * 注意区别：replyTo 是「回给发消息的人」，这个是「发给配置里写死的目标」。
 */
async function sendToConfiguredTarget(text) {
  const targetId = String(config.targetId || '').trim();
  if (!targetId) throw new Error('还没配置「主动发送目标 ID」');

  // 当前连接是哪类协议，看宿主给的 adapterName / ob11Mode
  const mode = String(ctx.frameworkEnv?.ob11Mode || '');

  if (mode === 'kook-gateway') {
    if (config.targetType === 'private') {
      await ctx.actions.call('send_private_msg', { user_id: targetId, content: text });
    } else {
      await ctx.actions.call('send_msg', { target_id: targetId, content: text });
    }
    return;
  }

  if (mode === 'weixin-ilink') {
    await ctx.actions.call('send_msg', { to_user_id: targetId, text });
    return;
  }

  if (mode.includes('qq-official') || mode.includes('official')) {
    const body = { content: text, msg_type: 0 };
    if (config.targetType === 'private') {
      await ctx.actions.call(`/v2/users/${targetId}/messages`, body);
    } else {
      await ctx.actions.call(`/v2/groups/${targetId}/messages`, body);
    }
    return;
  }

  // OneBot11
  const message = [{ type: 'text', data: { text } }];
  if (config.targetType === 'private') {
    await ctx.actions.call('send_private_msg', { user_id: targetId, message });
  } else {
    await ctx.actions.call('send_group_msg', { group_id: targetId, message });
  }
}

// ============================================================================
// ④ 消息处理：认指令 → 查开关 → 过冷却 → 回复
// ============================================================================

async function handleMessage(event) {
  stats.messages += 1;
  stats.lastMessageAt = Date.now();

  const text = eventText(event);
  if (!text) return;

  // 正向匹配：只有正好是这几条才做事，别的消息一律不碰
  const isPanel = text === '面板' || text === '后台' || text === '面板统计';
  if (!isPanel) return;

  if (!config.enableReply) {
    ctx.logger.debug('enableReply = false，跳过回复');
    return;
  }

  const key = sessionKey(event);
  const now = Date.now();
  const cooldown = Math.max(0, Number(config.cooldownMs) || 0);
  const prev = lastReplyAt.get(key) || 0;
  if (cooldown > 0 && now - prev < cooldown) {
    ctx.logger.debug(`冷却中（${now - prev}ms / ${cooldown}ms），本次不回复`);
    return;
  }
  lastReplyAt.set(key, now);

  const proto = detectProtocol(event);
  let body;
  if (text === '面板统计') {
    const uptimeMin = Math.round((Date.now() - stats.loadedAt) / 60000);
    body = [
      `插件已跑 ${uptimeMin} 分钟`,
      `收到消息 ${stats.messages} 条 · 回复 ${stats.replies} 条 · 路由被调 ${stats.apiCalls} 次`,
      `当前协议：${proto}`,
    ].join('\n');
  } else {
    body = [
      config.welcomeText,
      `当前协议：${proto}`,
      '打开控制台 → 插件 → 本插件「打开控制台」，能看到配置项与网页后台。',
    ].join('\n');
  }

  try {
    await replyTo(event, `${config.replyPrefix || ''}${body}`);
    stats.replies += 1;
  } catch (err) {
    // 接口失败会抛错，不接住就什么都看不到
    ctx.logger.error('回复失败：', err);
  }
}

// ============================================================================
// ⑤ 插件钩子
// ============================================================================

export async function plugin_init(context) {
  ctx = context;

  config = readConfig();
  buildConfigSchema();

  ctx.logger.info(
    `面板示例已加载 · 回复=${config.enableReply} · 冷却=${config.cooldownMs}ms`,
  );
  ctx.logger.info(`配置文件：${ctx.configPath}`);
  ctx.logger.info(`数据目录：${ctx.dataPath}`);
  ctx.logger.info('后台入口：控制台 → 插件 → 本插件「打开控制台」');

  // ---- 静态文件：把 webui/ 目录挂到 /plugin/<插件>/files/static/ 下 ----
  // 需要登录的页面里用相对路径引资源时，就靠它（宿主会自动注入 <base href>）
  ctx.router.static('/static', 'webui');

  // ---- 内存文件：不落盘也能对外提供内容，适合实时状态 ----
  ctx.router.staticOnMem('/live', [
    {
      path: 'status.json',
      contentType: 'application/json; charset=utf-8',
      content: () => JSON.stringify({
        plugin: ctx.pluginName,
        adapterName: ctx.adapterName,
        connectionId: ctx.frameworkEnv?.connectionId,
        ob11Mode: ctx.frameworkEnv?.ob11Mode,
        uptimeMs: Date.now() - stats.loadedAt,
        stats,
        config,
      }, null, 2),
    },
    {
      path: 'readme.txt',
      contentType: 'text/plain; charset=utf-8',
      content: '这个文件由 ctx.router.staticOnMem 直接从内存发出，磁盘上没有它。\n',
    },
  ]);

  // ---- 需要控制台登录的路由：给网页后台自己用 ----
  // 实际地址：/api/Plugin/ext/kakake-plugin-panel/<路径>
  //          带账号：/api/Plugin/ext/kakake-plugin-panel/a/<账号>/<路径>
  ctx.router.get('/stats', (req, res) => {
    stats.apiCalls += 1;
    res.json({
      code: 0,
      data: {
        pluginId: ctx.pluginName,
        adapterName: ctx.adapterName,
        connectionId: ctx.frameworkEnv?.connectionId,
        ob11Mode: ctx.frameworkEnv?.ob11Mode,
        uptimeMs: Date.now() - stats.loadedAt,
        stats,
        config,
      },
    });
  });

  // 后台页面改配置走这条（走的是插件自己的路由，不是控制台那张表单）
  ctx.router.post('/config', (req, res) => {
    stats.apiCalls += 1;
    const body = req.body;
    if (!body || typeof body !== 'object') {
      res.status(400).json({ code: -1, message: '请求体要是 JSON 对象' });
      return;
    }
    const next = applyConfig(body);
    ctx.logger.info(`后台页面改了配置：${JSON.stringify(body)}`);
    res.json({ code: 0, data: next });
  });

  ctx.router.get('/hooks', (req, res) => {
    stats.apiCalls += 1;
    res.json({ code: 0, data: hookLog });
  });

  // 演示「后台反过来调协议端」：从网页点一下，让机器人往配置的目标发条消息
  ctx.router.post('/say', async (req, res) => {
    stats.apiCalls += 1;
    const text = String((req.body && req.body.text) || '').trim();
    if (!text) {
      res.status(400).json({ code: -1, message: '缺少 text' });
      return;
    }
    try {
      await sendToConfiguredTarget(text);
      res.json({ code: 0, message: '已发送', data: { text } });
    } catch (err) {
      res.status(500).json({ code: -1, message: String(err && err.message ? err.message : err) });
    }
  });

  // ---- 免登录路由：给外部调用（公网可达，别放敏感数据） ----
  // 实际地址：/plugin/kakake-plugin-panel/api/<路径>
  ctx.router.getNoAuth('/ping', (req, res) => {
    stats.apiCalls += 1;
    res.json({
      code: 0,
      data: {
        plugin: ctx.pluginName,
        version: '1.0.0',
        uptimeMs: Date.now() - stats.loadedAt,
        time: new Date().toISOString(),
      },
    });
  });

  ctx.router.postNoAuth('/hook', (req, res) => {
    stats.apiCalls += 1;
    const item = {
      at: new Date().toISOString(),
      query: req.query,
      body: req.body ?? null,
      ua: String(req.headers['user-agent'] || ''),
    };
    hookLog.unshift(item);
    if (hookLog.length > 20) hookLog.pop();
    ctx.logger.info(`免登录 webhook 收到一条：${JSON.stringify(item.body)}`);
    res.json({ code: 0, data: { ok: true, received: item.body ?? null } });
  });

  // ---- 网页后台：控制台里点「打开控制台」打开的就是这个 ----
  ctx.router.page({
    path: 'admin',
    title: '后台面板示例',
    icon: 'layout-dashboard',
    description: '配置项 · 路由 · 权限演示',
    // module 优先：控制台内嵌 React 页面（webui/remote.js）
    module: 'webui/remote.js',
    // htmlFile 兜底：模块加载不了时用 iframe 打开这个经典页面
    htmlFile: 'webui/admin.html',
  });
}

export async function plugin_onmessage(context, event) {
  try {
    await handleMessage(event);
  } catch (err) {
    ctx.logger.error('处理消息出错：', err);
  }
}

export async function plugin_cleanup() {
  lastReplyAt.clear();
  hookLog.length = 0;
  if (ctx) ctx.logger.info('面板示例已卸载');
}

/**
 * 控制台读配置：返回就给控制台，不返回就退回读 config.json。
 * 这两个钩子都写了，所以点「保存」是**即时生效，不会重载插件**。
 * （只写 plugin_config_ui 而不写这两个，点保存会写文件并重载一次插件。）
 */
export function plugin_get_config() {
  return { ...config };
}

export function plugin_set_config(_context, next) {
  applyConfig(next);
  return { ...config };
}

// 配置表单本身——控制台读的就是这个导出
export { plugin_config_ui };
