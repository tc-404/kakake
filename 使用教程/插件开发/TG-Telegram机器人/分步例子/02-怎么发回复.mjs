// 分步 ②：怎么发回复 —— Telegram 插件最核心的一行
//
// ★ 标准写法（本例参数命名为 context，等价于其它例子里的 ctx）：
//
//     context.actions.call('sendMessage', { chat_id, text })
//
// 和 OneBot 的区别（别混用）：
//   · OneBot   : ctx.actions.call('send_group_msg', { group_id, message: [段数组] })
//   · Telegram : ctx.actions.call('sendMessage',    { chat_id,   text })
// Telegram 用 Bot API 的**原生参数名**（下划线命名：chat_id / parse_mode / reply_markup），
// 参数就是普通对象，不是消息段数组，也不要拼 CQ 码。
//
// chat_id 从事件里取（见分步 01）：框架已把它提到顶层，
// 私聊 / 群是数字，也可以手填 @channelusername 发频道。

function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id
    ?? event.raw?.callback_query?.from?.id;
}

// —— 发一句纯文字 ——
async function sendReply(context, event, text) {
  if (event?.telegram !== true) return;       // 认协议
  const chatId = chatIdOf(event);
  if (!chatId) return;

  // ★ 就是这一行：方法名 = Bot API 方法，参数 = Bot API 原生参数
  await context.actions.call('sendMessage', { chat_id: chatId, text });
}

// —— 带解析模式 / 引用回复的写法 ——
async function sendRich(context, event, text) {
  if (event?.telegram !== true) return;
  const chatId = chatIdOf(event);
  if (!chatId) return;

  await context.actions.call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',                        // 建议用 HTML（转义少，最省心）
    reply_to_message_id: event.message_id ?? event.reply_to_message_id,
    disable_web_page_preview: true,
  });
}

// —— 失败会 throw，必须 try/catch ——
// 常见：429 限频（按 retry_after 退避）、400 参数错、401 token 失效、连接断开
async function safeSend(context, event, text) {
  try {
    await sendReply(context, event, text);
  } catch (err) {
    context.logger.warn(`[TG] 发送失败：${err?.message ?? err}`);
  }
}

export { sendReply, sendRich, safeSend, chatIdOf };
