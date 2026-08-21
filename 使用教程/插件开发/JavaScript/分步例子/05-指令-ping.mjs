// 精准匹配指令「ping」
// 对方发「ping」时，回一个「pong」（常用来测试机器人活着）

if (text === 'ping') {
  await sendReply(ctx, event, 'pong');
}
