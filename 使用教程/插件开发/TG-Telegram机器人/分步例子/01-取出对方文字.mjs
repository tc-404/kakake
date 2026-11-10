// 分步 ①：认协议 + 取出对方文字 / 会话 ID
//
// Telegram 插件的第一件事永远是「认协议」：event.telegram === true。
// 框架把 Telegram Update 规范化成事件对象后分发，事件上带 telegram: true 标记，
// 与 KOOK 的 event.kook === true、微信的 event.weixin_bot === true 是同一套约定。
//
// ★ 框架输出的事件形状（OneBot v11 风格 + raw 原生 Update）：
//   · 纯文本在 raw_message（字符串），**不是** event.message.text
//   · event.message 是 OneBot 风格的**消息段数组**（[{type:'text',data:{text}}]）
//   · 发送者在 sender（= 原生 from）
//   · chat_id / message_id / user_id / group_id / message_type 都提到顶层
//   · event.raw 保留整个原生 Telegram Update（raw.message / raw.callback_query …）
// 这和 OneBot 插件的字段几乎同名，习惯 kakake-plugin-* 写法的插件能平滑迁移。
//
// 第一次接线建议先在 plugin_onevent 里打一条
//   context.logger.info(JSON.stringify(event))
// 对照真实形状确认字段名与层级。

// —— 认协议（推荐写法：事件标记 + frameworkEnv 双重保险）——
function isTelegram(context, event) {
  if (event?.telegram !== true) return false;          // 事件标记：最直接
  return context?.frameworkEnv?.protocol !== 'onebot'; // 兜底，别把 OneBot 事件误判
}

// —— 取会话 ID：发消息要用它（框架已提到顶层，raw 兜底）——
function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id
    ?? event.raw?.callback_query?.from?.id;
}

// —— 取纯文字：优先 raw_message，兜底读原生 Update ——
function textOf(event) {
  return String(
    event.raw_message ?? event.raw?.message?.text ?? event.raw?.message?.caption ?? '',
  ).trim();
}

// —— 是不是机器人发的（防 Bot-to-Bot 死循环）——
function isFromBot(event) {
  return Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
}

// —— 一个最小的 plugin_onmessage 骨架 ——
async function plugin_onmessage(context, event) {
  if (event?.telegram !== true) return;
  if (isFromBot(event)) return;
  const chatId = chatIdOf(event);
  const text = textOf(event);
  context.logger.info(`[TG] chat_id=${chatId} text=${text}`);
}

export { isTelegram, chatIdOf, textOf, isFromBot, plugin_onmessage };
