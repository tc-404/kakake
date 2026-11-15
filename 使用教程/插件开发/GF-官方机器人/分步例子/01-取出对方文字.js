// ⚠️ 片段：不能单独运行。它假设 event 就是 plugin_onmessage 收到的那个事件。
//
// ========== 取出对方文字（QQ 官方机器人 / GF-）==========
//
// ⚠️ 官方事件是「顶层字段」结构，和 OneBot 的消息段数组**完全不同**：
//
//   event.content = 这一次对方发的纯文字（就是一个字符串！）
//
// 官方事件里 **没有** event.message、没有消息段数组、没有 raw_message、
// 没有 CQ 码。你如果按 OneBot 去读 event.message，拿到的是 undefined，
// 所有指令都会静默失效。官方取文字就用 event.content。

// String(...) = 强制转成字符串，避免偶发空值/数字
// .trim()     = 去掉首尾空格（这样 "  签到 " 也能匹配"签到"）
const text = String(event.content || '').trim();

// ========== 顺便把「谁、在哪、这条消息 id」也取出来 ==========
//
// 官方用 openid 而不是 QQ 号。openid 是平台给每个用户/群分配的匿名 id，
// 你拿不到真实 QQ 号，也不该去猜。

// 群聊事件才有 group_openid；单聊（C2C_MESSAGE_CREATE）没有
const groupOpenid = event.group_openid || '';

// 发送者的 openid：不同事件里字段名略有差异，按顺序兜底取
// event.author = 发言人对象；user_openid / member_openid / union_openid 都是它的字段
const userOpenid =
  (event.author && (event.author.user_openid || event.author.member_openid || event.author.union_openid)) || '';

// 这条触发消息的 id：被动回复**必须**把它带上（msg_id），否则消息发不出去
const msgId = event.id || '';

// event.t = 事件类型字符串，例如：
//   GROUP_AT_MESSAGE_CREATE = 群里有人 @ 机器人
//   GROUP_MESSAGE_CREATE    = 群里普通消息（机器人开了「接收所有消息」时才会推）
//                             ⚠️ 这两个字段完全一致，过滤群消息时**两个都要接**
//   C2C_MESSAGE_CREATE      = 单聊
//   GROUP_ADD_ROBOT         = 机器人被拉进群
const eventType = event.t || '';

// 以后判断指令时，都用这个 text 去比
