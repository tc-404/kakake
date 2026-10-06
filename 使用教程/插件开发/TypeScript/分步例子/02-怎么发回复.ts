// 这是一个小工具函数：专门用来「把一句话发给对方」
// 发出去的内容也用 JSON 消息段，不要写 CQ 码字符串
//
// async = 这个函数里会「等一等」（等协议接口返回）
// function = 定义一个可反复调用的步骤
// Ctx / MsgEvent = 上面【照抄】的类型名（TypeScript 用来描述形状）
// 括号里是参数：
//   ctx   = 框架给的上下文（里面有 actions 可调协议）
//   event = 当前这条消息事件
//   text  = 要发出去的纯文字

async function sendReply(ctx: Ctx, event: MsgEvent, text: string) {
  // if = 如果 …… 就做大括号里的事
  // === = 两边一模一样才算对

  // message 这里是「要发送的内容」，不要和 event.message（收到的内容）搞混
  const message = [
    {
      type: 'text', // 消息段类型：文字
      data: {
        text: text, // 真正发出去的字
      },
    },
  ];

  // message_type = 消息场景；'group' = 群聊
  // ctx.actions.call(接口名, 参数对象) = 调协议
  // 正式插件还可再传 adapterName 等；教程用两参即可
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
