// ========== 调用协议端接口（以禁言为例）==========
//
// 通式（记牢）：
//   await ctx.actions.call(接口名, 参数对象)
//
//   ctx              = 框架给的上下文
//   ctx.actions      = 「可以调协议接口」的入口
//   call             = 调用
//   接口名（action） = 字符串，来自 OneBot11，例如 'set_group_ban'
//   参数对象（params）= 这个接口要的字段，键名也来自协议，不能乱改
//
// 正式插件还可写成：
//   ctx.actions.call(接口名, 参数, ctx.adapterName, ctx.pluginManager?.config)
// 教程里两参就够。
//
// —— 禁言接口 set_group_ban ——
//   group_id = 在哪个群禁言
//   user_id  = 禁谁（QQ 号）
//   duration = 禁多久（秒）；0 = 解除禁言
//
// 前提：只能在群聊用；机器人账号要有群管/禁言权限。
// 指令格式（纯文字，空格分开）：禁言 QQ号 秒数
// 例：禁言 123456789 60

// trim() = 去掉首尾空格
// split(/\s+/) = 按空白拆成多段
const parts = text.trim().split(/\s+/);

if (parts.length >= 3 && parts[0] === '禁言') {
  // Number(...) = 转成数字；Number.isFinite = 是不是有效数字
  const qq = Number(parts[1]);
  const seconds = Number(parts[2]);

  if (!Number.isFinite(qq) || !Number.isFinite(seconds)) {
    await sendReply(ctx, event, '格式：禁言 QQ号 秒数（秒数可为 0 表示解除）');
  } else if (event.message_type !== 'group') {
    await sendReply(ctx, event, '禁言只能在群里用');
  } else {
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
