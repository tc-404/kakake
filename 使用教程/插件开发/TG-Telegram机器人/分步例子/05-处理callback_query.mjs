// 分步 ⑤：处理 callback_query（内联键盘按钮点击）
//
// ★ 三件最容易错的事：
//   1. callback_query 不是 message，框架把它规范化成 **notice**，交给
//      **plugin_onevent**（所有事件），不会进 plugin_onmessage。写在 onmessage 里永远收不到。
//   2. 必须调 answerCallbackQuery ACK，否则客户端按钮一直转圈。
//   3. 框架把字段拍平了：callback_query_id / callback_data / chat_id 在**顶层**，
//      原始对象在 event.raw.callback_query——别直接读 event.callback_query。

function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.callback_query?.message?.chat?.id
    ?? event.raw?.callback_query?.from?.id;
}

// —— 在 plugin_onevent 里处理 ——
async function plugin_onevent(context, event) {
  if (event?.telegram !== true) return;        // ★ 认协议
  const rawCq = event.raw?.callback_query;
  if (event.notice_type !== 'callback_query' && !rawCq) return;  // 不是回调

  const id = event.callback_query_id ?? rawCq?.id;
  const data = String(event.callback_data ?? rawCq?.data ?? '');
  const chatId = chatIdOf(event);

  // ① 先 ACK（建议放在任何慢操作之前）
  try {
    await context.actions.call('answerCallbackQuery', {
      callback_query_id: id,
      text: data.startsWith('ok:') ? '已确认 ✅' : '已取消',
      show_alert: false,        // true = 弹窗而不是顶部提示
      cache_time: 0,
    });
  } catch (err) {
    context.logger.warn(`[TG] ACK 失败：${err?.message ?? err}`);
    return;
  }

  // ② 再按 callback_data 做业务
  if (data.startsWith('ok:') && chatId) {
    const key = data.slice(3);
    await context.actions.call('sendMessage', {
      chat_id: chatId,
      text: `收到确认（id=${key}）👌`,
    });
  }

  // ③ 可选：把原消息的键盘去掉 / 改成「已处理」
  //    用 editMessageReplyMarkup，需要 message_id（框架已提到顶层）
  // const mid = event.message_id ?? rawCq?.message?.message_id;
  // if (mid && chatId) {
  //   await context.actions.call('editMessageReplyMarkup', {
  //     chat_id: chatId, message_id: mid, reply_markup: { inline_keyboard: [] },
  //   });
  // }
}

// callback_data 上限 64 字节：只放短 key（如 'ok:42'），
// 真正的状态存到 ctx.dataPath 下的文件里，别把整个 JSON 塞进去。
// 同一个 callback_query_id 只能 ACK 一次，重复 ACK 会报错。

export { plugin_onevent, chatIdOf };
