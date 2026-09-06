async function plugin_init(ctx) {
  ctx.logger.info("你好示例插件已加载");
}
function getText(event) {
  let text = "";
  const parts = Array.isArray(event.message) ? event.message : [];
  for (const part of parts) {
    if (part && part.type === "text" && part.data && part.data.text) {
      text = text + String(part.data.text);
    }
  }
  return text;
}
async function sendReply(ctx, event, text) {
  const message = [
    {
      type: "text",
      data: {
        text
      }
    }
  ];
  if (event.message_type === "group") {
    await ctx.actions.call("send_group_msg", {
      group_id: event.group_id,
      message
    });
  }
  if (event.message_type === "private") {
    await ctx.actions.call("send_private_msg", {
      user_id: event.user_id,
      message
    });
  }
}
async function plugin_onmessage(ctx, event) {
  const text = getText(event);
  if (text === "你好") {
    await sendReply(ctx, event, "你好呀");
  }
  if (text === "帮助") {
    await sendReply(
      ctx,
      event,
      "可用指令：你好、帮助、ping；群聊还可：禁言 QQ号 秒数"
    );
  }
  if (text === "ping") {
    await sendReply(ctx, event, "pong");
  }
  const banParts = text.trim().split(/\s+/);
  if (banParts.length >= 3 && banParts[0] === "禁言") {
    const qq = Number(banParts[1]);
    const seconds = Number(banParts[2]);
    if (!Number.isFinite(qq) || !Number.isFinite(seconds)) {
      await sendReply(ctx, event, "格式：禁言 QQ号 秒数（秒数可为 0 表示解除）");
    } else if (event.message_type !== "group") {
      await sendReply(ctx, event, "禁言只能在群里用");
    } else {
      await ctx.actions.call("set_group_ban", {
        group_id: event.group_id,
        user_id: qq,
        duration: seconds
      });
      if (seconds === 0) {
        await sendReply(ctx, event, `已尝试解除禁言：${qq}`);
      } else {
        await sendReply(ctx, event, `已尝试禁言 ${qq} ${seconds} 秒`);
      }
    }
  }
}

export { plugin_init, plugin_onmessage };
