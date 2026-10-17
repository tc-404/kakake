// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onmessage 收到的那些。
//
// ========== 怎么发回复（QQ 官方机器人 / GF-）==========
//
// ⚠️ 和 OneBot 最大的一点不同：
//   OneBot 是 ctx.actions.call('send_group_msg', { group_id, message })
//   官方   是 ctx.actions.call('/v2/groups/{group_openid}/messages', { content, ... })
//
// 也就是说：官方的第一个参数是 **REST 接口路径**，不是接口名。
// 官方**没有** send_group_msg / send_private_msg 这些接口，写错了直接报错。

// async = 函数里要 await 等待网络请求
async function sendReply(ctx, event, text) {
  // content = 要发的纯文本（官方就是字符串，不是消息段数组）
  // msg_type = 0 表示纯文本
  // msg_id = 触发消息的 id（被动回复必须带，不带发不出去）
  // msg_seq = 同一条触发消息的第几次回复，从 1 开始；连发多条就 1、2、3…
  const body = {
    content: text,
    msg_type: 0,
    msg_id: event.id,
    msg_seq: 1,
  };

  // 有 group_openid = 群聊 → 发到群
  if (event.group_openid) {
    await ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
    return;
  }

  // 没有 group_openid = 单聊 → 发到用户
  const userOpenid = event.author && (event.author.user_openid || event.author.member_openid);
  if (userOpenid) {
    await ctx.actions.call(`/v2/users/${userOpenid}/messages`, body);
  }
}

// 调用时要 try / catch：被动回复超时、机器人被限制、连接断了都会抛错
//   try   { await sendReply(ctx, event, '你好呀'); }
//   catch (e) { ctx.logger.error('回复失败：' + (e && e.message)); }
//
// ⚠️ 官方平台**不提供**禁言 / 撤回 / 踢人 / 改名片这些能力，
//    那是 OneBot 协议端才有的，别硬写。
