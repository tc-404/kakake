// 分步 ③：指令与 /start（含 /cmd@bot 与 Deep Linking）
//
// Telegram 的指令以 / 开头。群里同时有多个机器人时用户会写
//   /ping@你的机器人
// 来指定目标，解析时必须剥掉 @用户名 后缀；明确 @ 了别的机器人时要**忽略**，
// 不然两个机器人会一起回。
//
// ★ 框架已经把命令解析好了：事件上直接有
//     event.command / event.command_args / event.command_target
//   优先用它们；拿不到时再用正则兜底（或调框架纯函数 parseTelegramCommand）。

function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id;
}

function textOf(event) {
  return String(
    event.raw_message ?? event.raw?.message?.text ?? '',
  ).trim();
}

// 正则兜底：/cmd[@bot] [args]
function parseCommand(text) {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return null;
  return { name: m[1], target: m[2], args: (m[3] ?? '').trim() };
}

async function plugin_onmessage(context, event) {
  // ★ 认协议
  if (event?.telegram !== true) return;
  if (isFromBot(event)) return;

  const chatId = chatIdOf(event);
  if (!chatId) return;

  // 优先用框架解析好的字段，正则兜底
  const cmd = event.command
    ? { name: event.command, target: event.command_target, args: event.command_args ?? '' }
    : parseCommand(textOf(event));
  if (!cmd) return;

  // ★ 明确发给别的机器人 → 忽略
  const me = String(context.frameworkEnv?.botUsername ?? '').toLowerCase();
  if (cmd.target && cmd.target.toLowerCase() !== me) return;

  // /start 可以带参数（Deep Linking）：
  //   https://t.me/你的机器人?start=ref_123  →  /start ref_123
  if (cmd.name === 'start') {
    const text = cmd.args
      ? `欢迎使用！来源：${cmd.args} 👋 发送 /help 看指令。`
      : '欢迎使用！发送 /help 看指令。';
    await context.actions.call('sendMessage', { chat_id: chatId, text });
    return;
  }

  const replies = {
    help: '可用指令：/start、/help、/ping',
    ping: 'pong',
  };
  if (replies[cmd.name]) {
    await context.actions.call('sendMessage', { chat_id: chatId, text: replies[cmd.name] });
  }
}

function isFromBot(event) {
  return Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
}

// 指令菜单只是「输入 / 时的补全提示」，不负责解析：
// 到 @BotFather 发 /setcommands，按下面格式贴进去（命令不带 /，小写、≤32 字符）：
//   start - 开始使用
//   help - 查看帮助
//   ping - 连通性测试

export { parseCommand, plugin_onmessage, chatIdOf, textOf, isFromBot };
