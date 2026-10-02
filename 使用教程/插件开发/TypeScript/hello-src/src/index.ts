// ========== 【照抄】类型：插件上下文 ==========
// type = TypeScript 里「描述形状」的写法（运行时不存在）
// Ctx = 我们给上下文起的类型名（教学简化版，真实类型见宿主 src/plugin/plugin.types.ts）
type Ctx = {
  // logger = 打日志；info = 普通信息，warn = 警告
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  };
  // actions.call = 调 OneBot 协议接口
  // action = 接口名字符串；params = 参数对象
  // 成功 → 返回接口的 data；失败 → 抛错（所以要 try / catch）
  actions: { call: (action: string, params?: Record<string, unknown>) => Promise<unknown> };
};

// ========== 【照抄】类型：一条消息事件 ==========
type MsgEvent = {
  // message = 消息内容，正常情况是 JSON 消息段数组（推荐用这个取内容，不要用 raw_message / CQ）
  // 这里声明为 unknown：真实类型是消息段数组，用 Array.isArray 判断后再取更稳妥
  message?: unknown;
  // message_type = 'group' 群聊 / 'private' 私聊
  message_type?: string;
  // group_id = 群号（群聊才有）
  group_id?: number | string;
  // user_id = QQ 号
  user_id?: number | string;
};

// ========== 【照抄】加载时 ==========
// export = 交给框架；plugin_init = 插件初始化
export async function plugin_init(ctx: Ctx) {
  ctx.logger.info('你好示例插件已加载');
}

// ========== 【照抄】小工具：从 JSON 消息段取出纯文字 ==========
// 千万不要用 raw_message，也不要解析 [CQ:...]
function getText(event: MsgEvent) {
  let text = '';
  const parts = Array.isArray(event.message) ? event.message : [];

  for (const part of parts) {
    // type === 'text' = 纯文字段；data.text = 文字内容
    if (part && part.type === 'text' && part.data && part.data.text) {
      text = text + String(part.data.text);
    }
  }

  return text;
}

// ========== 【照抄】小工具：用 JSON 消息段发一句话 ==========
// ctx.actions.call('send_group_msg' | 'send_private_msg', params)
async function sendReply(ctx: Ctx, event: MsgEvent, text: string) {
  const message = [
    {
      type: 'text',
      data: {
        text: text,
      },
    },
  ];

  if (event.message_type === 'group') {
    await ctx.actions.call('send_group_msg', {
      group_id: event.group_id,
      message: message,
    });
  }

  if (event.message_type === 'private') {
    await ctx.actions.call('send_private_msg', {
      user_id: event.user_id,
      message: message,
    });
  }
}

// ========== 【核心】收到消息时 ==========
// plugin_onmessage = 有人发消息时框架调用
export async function plugin_onmessage(ctx: Ctx, event: MsgEvent) {
  // —— 【自检】协议端若上报 CQ 字符串（不是数组），取文字会得到空串、所有指令都会失效 ——
  if (typeof event.message === 'string') {
    ctx.logger.warn('当前连接上报的是 CQ 字符串，请在协议端把消息上报格式改成数组（array）');
  }

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

  // —— 【核心】调用协议接口：禁言 set_group_ban ——
  // 格式：禁言 QQ号 秒数；0 = 解除；仅群聊；机器人需有管权限
  const banParts = text.trim().split(/\s+/);
  if (banParts.length >= 3 && banParts[0] === '禁言') {
    const qq = Number(banParts[1]);
    const seconds = Number(banParts[2]);

    if (!Number.isFinite(qq) || !Number.isFinite(seconds)) {
      await sendReply(ctx, event, '格式：禁言 QQ号 秒数（秒数可为 0 表示解除）');
    } else if (event.message_type !== 'group') {
      await sendReply(ctx, event, '禁言只能在群里用');
    } else {
      // 【核心】调用接口要 try / catch：
      // 成功 = 拿到接口返回的 data；失败（没权限、连接断了、超时）= 抛错
      try {
        await ctx.actions.call('set_group_ban', {
          group_id: event.group_id,
          user_id: qq,
          duration: seconds,
        });

        if (seconds === 0) {
          await sendReply(ctx, event, `已解除禁言：${qq}`);
        } else {
          await sendReply(ctx, event, `已禁言 ${qq} ${seconds} 秒`);
        }
      } catch (err) {
        // err.message 里就是失败原因，例如机器人没有禁言权限
        const msg = err instanceof Error ? err.message : String(err);
        await sendReply(ctx, event, `操作失败：${msg}`);
      }
    }
  }
}
