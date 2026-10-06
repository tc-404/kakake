// 这是一个小工具函数：专门用来「把一句话发给对方」
// 发出去的内容也用 JSON 消息段，不要写 CQ 码字符串
//
// async = 这个函数里会「等一等」（等协议接口返回）
// function = 定义一个可反复调用的步骤
// sendReply = 我们自己起的函数名（发送回复）
// 括号里是参数：
//   ctx   = 框架给的上下文（里面有 actions 可调协议）
//   event = 当前这条消息事件（用来知道是群还是私聊、群号/QQ）
//   text  = 要发出去的纯文字

async function sendReply(ctx, event, text) {
  // if 的意思：如果 …… 就做大括号里的事
  // === 的意思：两边一模一样才算对

  // 把普通文字包成 OneBot 的 JSON 消息段数组
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
  // group_id = 群号
  // ctx.actions.call = 调用协议接口
  //   第 1 个参数：接口名（action），字符串
  //   第 2 个参数：参数对象（params）
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

// —— CJS 版多了这一步：把函数交出去 ——
// 这里用 module.exports 暴露，别的文件 require('./02-怎么发回复.js') 就能拿到 sendReply。
// 只在一个文件里用的私有小工具，其实不导出也行；
// 但 plugin_init / plugin_onmessage 这类**钩子必须导出**，否则框架找不到。
module.exports = { sendReply };
