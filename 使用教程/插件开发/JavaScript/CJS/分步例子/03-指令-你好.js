// ⚠️ 片段：不能单独运行。它依赖分步 ① 拼好的 text 和分步 ② 的 sendReply 函数。
//
// 精准匹配指令「你好」
// text = 分步 ① 里拼好的纯文字
// === = 两边一模一样才算对（多一个空格都不行）
// 只有对方发的字 完完全全 是「你好」时，才做回复

if (text === '你好') {
  // await = 等 sendReply 发完再往下
  // sendReply(ctx, event, '你好呀') = 用上下文、当前事件，把「你好呀」发给对方
  await sendReply(ctx, event, '你好呀');
}

// 这段判断逻辑本身与 ESM 版完全相同；CJS 的差别只在于文件顶部的引入方式：
//   const { sendReply } = require('./02-怎么发回复.js');
