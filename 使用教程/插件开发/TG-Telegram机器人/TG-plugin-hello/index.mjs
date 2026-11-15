// ============================================================================
// Telegram Bot 插件（TG-plugin-*）完整最小示例
//
// 归属协议：Telegram Bot（type: 'telegram'）
//   · 目录名必须以 TG-plugin- 开头（大小写敏感），写成 tg-plugin-hello 不规范
//   · frameworkEnv.protocol === 'telegram'
//   · frameworkEnv.ob11Mode === 'telegram-bot-api'
//   · 事件对象带 telegram: true 标记（event.telegram === true）
//   · 账号隔离键是 telegramBotUserId，数据落在
//     plugins_two/<telegramBotUserId>/TG-plugin-hello/
//
// ★ 事件形状（框架把 Telegram Update 规范化成 OneBot v11 风格 + raw 原生 Update）：
//   · 消息类：post_type='message'、message_type='private'|'group'|'channel'、
//     chat_id、message_id、user_id、group_id、raw_message（纯文本字符串）、
//     message（OneBot 风格段数组）、sender（= 原生 from）、chat
//   · 命令：command / command_args / command_target（框架已解析 /cmd@bot）
//   · 回调：post_type='notice'、notice_type='callback_query'、
//     callback_query_id、callback_data、chat_id、message_id
//   · 内联查询：post_type='request'、request_type='inline_query'、
//     query_id、query、offset、user_id
//   · 通用：telegram:true、platform、protocol、update_id、update_type、t、
//     **raw（整个原生 Telegram Update，含 raw.callback_query / raw.inline_query）**
//
// 发消息用 Bot API 的原生参数（chat_id / text），**不是** OneBot 的 message 段数组：
//   await ctx.actions.call('sendMessage', { chat_id, text })
// actions.call 的第一个参数可以是任意 Bot API 方法名（sendPhoto /
// answerCallbackQuery / answerInlineQuery / getFile / sendMessageDraft …），
// 框架不做白名单、不做协议翻译，新方法出来即可直接用。
//
// 装法：整个 TG-plugin-hello/ 文件夹放进咔咔珂的 plugins/ 目录（整夹拷）。
// ============================================================================

// ========== 加载时 ==========
// plugin_init 必须导出：框架靠它认插件，缺了直接判无效
export async function plugin_init(ctx) {
  ctx.logger.info(
    `[TG-plugin-hello] 已加载 · 协议=${ctx.frameworkEnv?.protocol} ` +
    `· 模式=${ctx.frameworkEnv?.ob11Mode} · 数据目录=${ctx.dataPath}`,
  );
}

// ========== 小工具：从事件里取会话 ID ==========
// 框架已把 chat_id 提到顶层；下面用 raw 兜底，兼容直接读原生 Update 的写法
function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id
    ?? event.raw?.callback_query?.from?.id;
}

// ========== 小工具：从事件里取纯文字 ==========
// 框架给 raw_message（字符串）；message 是 OneBot 段数组，别当对象取 .text
function textOf(event) {
  return String(
    event.raw_message ?? event.raw?.message?.text ?? event.raw?.message?.caption ?? '',
  ).trim();
}

// ========== 小工具：是不是机器人发的（防 Bot-to-Bot 死循环） ==========
function isFromBot(event) {
  return Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
}

// ========== 发一句话：Telegram 的标准写法 ==========
async function sendText(ctx, chatId, text) {
  // ★ 关键写法：方法名 = Bot API 方法，参数 = Bot API 原生参数
  await ctx.actions.call('sendMessage', { chat_id: chatId, text });
}

// ========== 所有事件都先进这里 ==========
// 消息、回调、内联查询、成员变动、动作回执（telegram/action_result）都会进来
export async function plugin_onevent(ctx, event) {
  if (!event || event.telegram !== true) return;

  // —— 内联键盘回调：必须先 answerCallbackQuery ACK，否则客户端一直转圈 ——
  // 框架已把回调规范化成 callback_query_id / callback_data，
  // 原始对象在 event.raw.callback_query（两者都兼容）
  const rawCq = event.raw?.callback_query;
  if (event.notice_type === 'callback_query' || rawCq) {
    const id = event.callback_query_id ?? rawCq?.id;
    const data = String(event.callback_data ?? rawCq?.data ?? '');
    const chatId = chatIdOf(event);
    try {
      await ctx.actions.call('answerCallbackQuery', {
        callback_query_id: id,
        text: data.startsWith('ok:') ? '已确认 ✅' : '已取消',
        show_alert: false,
      });
      if (chatId && data.startsWith('ok:')) {
        await sendText(ctx, chatId, '收到你的确认 👌');
      }
    } catch (err) {
      ctx.logger.warn(`[TG-plugin-hello] 回调处理失败：${err?.message ?? err}`);
    }
    return;
  }

  // —— Inline Mode：任意聊天框输入 @机器人 关键词 ——
  // 框架给 query_id / query，原始对象在 event.raw.inline_query
  const rawIq = event.raw?.inline_query;
  if (event.request_type === 'inline_query' || rawIq) {
    const id = event.query_id ?? rawIq?.id;
    const q = String(event.query ?? rawIq?.query ?? '');
    try {
      await ctx.actions.call('answerInlineQuery', {
        inline_query_id: id,
        cache_time: 300,
        results: [{
          type: 'article',
          id: 'hello-1',
          title: `你搜了：${q || '（空）'}`,
          input_message_content: { message_text: `🔎 ${q || '（空）'}` },
        }],
      });
    } catch (err) {
      ctx.logger.warn(`[TG-plugin-hello] Inline 回结果失败：${err?.message ?? err}`);
    }
  }
}

// ========== 消息类事件 ==========
// plugin_onmessage 只收消息类 Update；动作回执不进这里
export async function plugin_onmessage(ctx, event) {
  // ① 认协议：event.telegram === true 才处理
  if (event.telegram !== true) return;
  // ② 防循环：机器人发的消息一律不回
  if (isFromBot(event)) return;

  const chatId = chatIdOf(event);
  if (!chatId) return;
  const text = textOf(event);
  if (!text) return;

  try {
    // ③ 指令：/start /help /ping /photo
    //   框架已解析好 command / command_args / command_target（含剥掉 @bot 后缀），
    //   优先用它；拿不到再用正则兜底。
    let cmd = event.command
      ? { name: event.command, target: event.command_target, args: event.command_args ?? '' }
      : null;
    if (!cmd) {
      const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
      if (m) cmd = { name: m[1], target: m[2], args: (m[3] ?? '').trim() };
    }
    if (cmd) {
      // 群里写成 /ping@别的机器人 → 明确不是发给自己的，忽略
      const me = String(ctx.frameworkEnv?.botUsername ?? '').toLowerCase();
      if (cmd.target && cmd.target.toLowerCase() !== me) return;

      if (cmd.name === 'start') {
        await sendText(ctx, chatId, `欢迎使用！${cmd.args ? `来源：${cmd.args}。` : ''}发送 /help 看指令。`);
      } else if (cmd.name === 'help') {
        await sendText(ctx, chatId, '可用指令：/start、/help、/ping、/photo；也可以直接发「你好」。');
      } else if (cmd.name === 'ping') {
        await sendText(ctx, chatId, 'pong');
      } else if (cmd.name === 'photo') {
        // 发图片 + 内联键盘（见分步例子 04）
        await ctx.actions.call('sendPhoto', {
          chat_id: chatId,
          photo: 'https://telegram.org/img/t_logo.png',
          caption: '点一下按钮试试',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ 确认', callback_data: 'ok:1' },
              { text: '❌ 取消', callback_data: 'cancel:1' },
            ]],
          },
        });
      } else {
        await sendText(ctx, chatId, `未知指令：/${cmd.name}`);
      }
      return;
    }

    // ④ 普通文本回声
    if (text === '你好') {
      await sendText(ctx, chatId, '你好呀 👋（来自 TG-plugin-hello）');
    }
  } catch (err) {
    // 发送失败（429 限频、400 参数错、连接断开）会 throw，必须 catch
    ctx.logger.error(`[TG-plugin-hello] 处理失败：${err?.message ?? err}`);
  }
}

// ========== 卸载 / 重载收尾 ==========
export async function plugin_cleanup() {
  // 有定时器、监听器、待落盘数据时在这里清理
}
