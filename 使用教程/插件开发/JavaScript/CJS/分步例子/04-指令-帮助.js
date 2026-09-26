// ⚠️ 片段：不能单独运行。它依赖分步 ① 拼好的 text 和分步 ② 的 sendReply 函数。
//
// 精准匹配指令「帮助」
// 对方发「帮助」时，告诉他有哪些指令可以用

if (text === '帮助') {
  await sendReply(
    ctx,
    event,
    '可用指令：你好、帮助、ping；群聊还可：禁言 QQ号 秒数',
  );
}
