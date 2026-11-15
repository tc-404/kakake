// 分步 ⑥：调用原生 Bot API（任意方法名 / api 透传 / 10.x 新能力）
//
// ★ 框架的设计：actions.call(action, params) 的 action 可以是**任意 Bot API 方法名**。
//   框架不维护白名单、不做协议翻译，官方出了新方法就能直接用，不用等框架升级。
//   方法名用驼峰（sendMessageDraft），参数用官方的下划线命名（chat_id、inline_query_id）。
//   也支持把方法与参数打包成对象交给 `api` 透传。
//
// 参数写错框架层不会拦，会原样交给 Telegram 报 400 —— 以官方文档为准。

// —— ① Inline Mode：任意聊天框输入 @机器人 关键词 ——
// 前提：@BotFather /setinline 已开；inline_query 没有 chat_id。
// 框架把 query_id / query 拍平到顶层，原始对象在 event.raw.inline_query。
async function answerInline(context, event) {
  if (event?.telegram !== true) return;       // ★ 认协议
  const rawIq = event.raw?.inline_query;
  if (event.request_type !== 'inline_query' && !rawIq) return;

  const id = event.query_id ?? rawIq?.id;
  const keyword = String(event.query ?? rawIq?.query ?? '').trim();
  await context.actions.call('answerInlineQuery', {
    inline_query_id: id,
    cache_time: 300,
    results: [{
      type: 'article',
      id: '1',
      title: `你搜了：${keyword || '（空）'}`,
      input_message_content: { message_text: `🔎 ${keyword || '（空）'}` },
    }],
  });
}

// —— ② 10.x 流式草稿 sendMessageDraft（AI 边生成边推）——
async function streamDraft(context, event, chunks) {
  if (event?.telegram !== true) return;
  const chatId = event.chat_id ?? event.raw?.message?.chat?.id;
  if (!chatId) return;
  for (const chunk of chunks) {
    await context.actions.call('sendMessageDraft', { chat_id: chatId, text: chunk });
  }
  await context.actions.call('sendMessage', { chat_id: chatId, text: chunks.join('') });
}

// —— ③ 任意原生方法：getFile（注意本地 Bot API Server 的 file_path 是绝对路径）——
async function resolveFile(context, fileId) {
  const file = await context.actions.call('getFile', { file_id: fileId });
  const p = String(file?.result?.file_path ?? file?.file_path ?? '');
  return p.startsWith('/')
    ? { local: true, path: p }                    // 本地服务器：直接读文件
    : { local: false, path: p };                  // 官方服务器：拼下载 URL
}

// —— ④ `api` 透传：方法名从配置 / 队列里动态取时用 ——
async function callViaApi(context, event, method, params) {
  if (event?.telegram !== true) return;
  return context.actions.call('api', { method, ...params });
}

// —— ⑤ 其它常见原生方法（照这个格式抄即可）——
//   answerCallbackQuery({ callback_query_id, text })
//   sendPhoto({ chat_id, photo, caption })
//   getFile({ file_id })
//   editMessageText({ chat_id, message_id, text })
//   deleteMessage({ chat_id, message_id })
//   sendInvoice({ chat_id, title, description, payload, currency: 'XTR', prices })
//   answerPreCheckoutQuery({ pre_checkout_query_id, ok: true })
//
// 10.x 新能力（Rich Messages / Ephemeral Messages / Widgets / Guest Mode / Managed Bots）
// 同样是「方法名 + 原生参数」，或 BotFather 的账号级开关；详见
// 《使用教程/Telegram Bot 接入教程.md》§15。

export { answerInline, streamDraft, resolveFile, callViaApi };
