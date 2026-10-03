// ⚠️ 片段：不能单独运行。它假设 event 就是 plugin_onmessage 收到的那个事件。
//
// ========== 取出对方文字（只用 JSON 消息段）==========
//
// event          = 这一次「有人发了消息」整包数据
// event.message  = 消息内容，推荐是「消息段」数组
// 消息段例子：[{ type: 'text', data: { text: '你好' } }]
//   type = 这一段是什么类型（'text' = 纯文字）
//   data = 这一段的具体内容
//   data.text = 文字本身
//
// 千万不要用 raw_message，也不要自己解析 [CQ:...] 字符串
// CQ 码不稳定，用久了容易出怪问题
//
// ⚠️ 如果协议端上报的是 CQ 字符串（event.message 不是数组），
//    下面会安静地拿到空串、所有指令都会失效。
//    完整源码里加了一行自检：typeof event.message === 'string' 时打警告，见 src/index.ts。

// let = 声明一个可以改的变量
let text = '';

// const = 声明一个一般不再改绑定的变量
// Array.isArray(x) = 判断 x 是不是数组
const parts = Array.isArray(event.message) ? event.message : [];

// for…of = 把数组里每一项依次拿出来
for (const part of parts) {
  // && = 并且
  if (part && part.type === 'text' && part.data && part.data.text) {
    // String(...) = 强制变成字符串
    text = text + String(part.data.text);
  }
}

// 以后判断指令时，都用这个 text 去比
