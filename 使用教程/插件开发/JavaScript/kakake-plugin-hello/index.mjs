// ========== 加载时 ==========
// export = 把函数交出去给框架；框架靠名字找到它
// async = 函数里可能要 await 等待
// plugin_init = 插件初始化：加载时调用
// ctx = 上下文（工具箱）：logger、actions 等都在里面
export async function plugin_init(ctx) {
  // logger.info = 往日志里打一行说明文字
  ctx.logger.info('你好示例插件已加载');
}

// ========== 小工具：从 JSON 消息段里取出纯文字 ==========
// function = 定义可反复调用的步骤
// event = 当前消息事件；event.message = 消息段数组
// 千万不要用 raw_message，也不要解析 [CQ:...]
function getText(event) {
  // let = 可改的变量；text = 拼好的纯文字
  let text = '';
  // Array.isArray = 是不是数组；不是就用空数组
  const parts = Array.isArray(event.message) ? event.message : [];

  // for…of = 逐段查看
  for (const part of parts) {
    // type === 'text' = 这一段是纯文字；data.text = 文字内容
    if (part && part.type === 'text' && part.data && part.data.text) {
      text = text + String(part.data.text);
    }
  }

  return text;
}

// ========== 小工具：用 JSON 消息段发一句话 ==========
// ctx.actions.call(接口名, 参数) = 调协议端接口
// send_group_msg / send_private_msg = 发群消息 / 发私聊
// 不要把 CQ 码字符串塞进 message
async function sendReply(ctx, event, text) {
  // 要发送的内容：一条 type 为 text 的消息段
  const message = [
    {
      type: 'text',
      data: {
        text: text,
      },
    },
  ];

  // message_type === 'group' = 群聊；group_id = 群号
  if (event.message_type === 'group') {
    await ctx.actions.call('send_group_msg', {
      group_id: event.group_id,
      message: message,
    });
  }

  // 'private' = 私聊；user_id = 对方 QQ
  if (event.message_type === 'private') {
    await ctx.actions.call('send_private_msg', {
      user_id: event.user_id,
      message: message,
    });
  }
}

// ========== 收到消息时 ==========
// plugin_onmessage = 有人发消息时框架调用
export async function plugin_onmessage(ctx, event) {
  // —— 取出对方文字（JSON 消息段）——
  const text = getText(event);

  // —— 精准匹配：你好（=== = 一模一样）——
  if (text === '你好') {
    await sendReply(ctx, event, '你好呀');
  }

  // —— 精准匹配：帮助 ——
  if (text === '帮助') {
    await sendReply(
      ctx,
      event,
      '可用指令：你好、帮助、ping；群聊还可：禁言 QQ号 秒数',
    );
  }

  // —— 精准匹配：ping ——
  if (text === 'ping') {
    await sendReply(ctx, event, 'pong');
  }

  // —— 调用协议接口：禁言（set_group_ban）——
  // 格式：禁言 QQ号 秒数；秒数为 0 = 解除；仅群聊；机器人需有管权限
  // trim = 去首尾空格；split(/\s+/) = 按空白拆段
  const banParts = text.trim().split(/\s+/);
  if (banParts.length >= 3 && banParts[0] === '禁言') {
    const qq = Number(banParts[1]);
    const seconds = Number(banParts[2]);

    if (!Number.isFinite(qq) || !Number.isFinite(seconds)) {
      await sendReply(ctx, event, '格式：禁言 QQ号 秒数（秒数可为 0 表示解除）');
    } else if (event.message_type !== 'group') {
      await sendReply(ctx, event, '禁言只能在群里用');
    } else {
      // action = 'set_group_ban'；duration = 秒
      await ctx.actions.call('set_group_ban', {
        group_id: event.group_id,
        user_id: qq,
        duration: seconds,
      });

      if (seconds === 0) {
        await sendReply(ctx, event, `已尝试解除禁言：${qq}`);
      } else {
        await sendReply(ctx, event, `已尝试禁言 ${qq} ${seconds} 秒`);
      }
    }
  }
}
