// 精准匹配指令「你好」
// text = 分步 ① 里拼好的纯文字
// === = 两边一模一样才算对（多一个空格都不行）
// 只有对方发的字 完完全全 是「你好」时，才做回复

if (text === '你好') {
  // await = 等 sendReply 发完再往下
  await sendReply(ctx, event, '你好呀');
}
