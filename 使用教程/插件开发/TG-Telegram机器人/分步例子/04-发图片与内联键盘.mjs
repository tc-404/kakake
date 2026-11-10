// 分步 ④：发图片与内联键盘
//
// Telegram 的媒体用「方法名 + 原生参数」，不是消息段数组：
//   sendPhoto / sendVideo / sendDocument / sendAudio / sendVoice / sendSticker …
// photo 参数可以三种给法：
//   ① file_id（同一个文件重复发，推荐，不重新上传）
//   ② 公网 URL（Telegram 自己去拉）
//   ③ 本地路径（multipart 上传，交给框架按 InputFile 处理）
// 官方服务器单文件 ≤ 50MB，更大的要上本地 Bot API Server。
//
// 内联键盘（InlineKeyboardMarkup）贴在消息下方，点击不产生聊天消息，
// 而是触发 callback_query（见分步 05）。

function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id;
}

// —— 发一张图 + 一排按钮 ——
async function sendPhotoWithKeyboard(context, event) {
  if (event?.telegram !== true) return;       // ★ 认协议
  const chatId = chatIdOf(event);
  if (!chatId) return;

  await context.actions.call('sendPhoto', {
    chat_id: chatId,
    photo: 'https://telegram.org/img/t_logo.png',   // 换成 file_id / 本地路径都行
    caption: '点一下按钮试试',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ 确认', callback_data: 'ok:42' },
          { text: '❌ 取消', callback_data: 'cancel:42' },
        ],
        [{ text: '打开网页', url: 'https://core.telegram.org/bots/api' }],
      ],
    },
  });
}

// —— 复用 file_id 发图（最省带宽，也最不容易撞限频）——
async function sendPhotoByFileId(context, event, fileId) {
  if (event?.telegram !== true) return;
  const chatId = chatIdOf(event);
  if (!chatId || !fileId) return;
  await context.actions.call('sendPhoto', {
    chat_id: chatId,
    photo: fileId,               // ★ 直接复用，别重新上传
    caption: '这是上次那张图',
  });
}

// —— 回复键盘（贴在输入框下方，点一下等于发一条文本）——
async function sendReplyKeyboard(context, event) {
  if (event?.telegram !== true) return;
  const chatId = chatIdOf(event);
  if (!chatId) return;
  await context.actions.call('sendMessage', {
    chat_id: chatId,
    text: '选一个：',
    reply_markup: {
      keyboard: [
        [{ text: '帮助' }, { text: '签到' }],
        [{ text: '📍 发位置', request_location: true }],
      ],
      resize_keyboard: true,
      one_time_keyboard: true,
    },
  });
}

// 收起回复键盘：{ reply_markup: { remove_keyboard: true } }
// callback_data 最长 64 字节，别塞大 JSON；状态放自己库里，只传短 key。

export { sendPhotoWithKeyboard, sendPhotoByFileId, sendReplyKeyboard, chatIdOf };
