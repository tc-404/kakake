// 分步 ③：怎么发回复（同一个 actions.call，框架按连接类型自动分流）
//
// 官方的 action 是 REST 路径（以 / 开头），OneBot 的是下划线动作名。
// 参数结构各按各的来，框架不做转换。

function protocolOf(ctx, event) {
  const p = ctx.frameworkEnv?.protocol;
  if (p === 'onebot' || p === 'qq_official') return p;
  return event?.qq_official ? 'qq_official' : 'onebot';
}

// —— 官方被动回复的 msg_seq：同一条消息回第二次起必须递增 ——
// 写死 1 是最常见的坑。官方规定「相同 msg_id + msg_seq 重复发送会失败」
// （GF-官方机器人/说明.md 发送参数表），第二条回复就发不出去了。
// 实现照抄项目里实际在跑的 sssx-plugin-book（index.mjs:44）。
const seqMap = new Map();
function nextSeq(messageId) {
  const key = String(messageId ?? '');
  const n = (seqMap.get(key) ?? 0) + 1;
  seqMap.set(key, n);
  // 别让 Map 无限涨：超过 500 条就裁回 200 条
  if (seqMap.size > 500) {
    for (const k of seqMap.keys()) {
      seqMap.delete(k);
      if (seqMap.size <= 200) break;
    }
  }
  return n;
}

async function sendReply(ctx, event, text) {
  // —— 官方：/v2/groups/{group_openid}/messages 或 /v2/users/{user_openid}/messages ——
  // ⚠️ 被动回复必须带 msg_id（= 触发消息的 event.id），否则发不出去
  if (protocolOf(ctx, event) === 'qq_official') {
    const body = { content: text, msg_type: 0, msg_id: event.id, msg_seq: nextSeq(event.id) };
    // 群 / 单聊按 event.t 分路，**不要**拿一个 openid 兜底去打另一套接口：
    // member_openid 只在群内有效、user_openid 只在单聊有效，两者不通用，
    // 把 member_openid 塞进 /v2/users/{id}/messages 是打不通的。
    if (String(event?.t ?? '').startsWith('C2C')) {
      const userOpenid = event.author?.user_openid;
      if (userOpenid) await ctx.actions.call(`/v2/users/${userOpenid}/messages`, body);
      return;
    }
    if (event.group_openid) {
      await ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
    }
    return;
  }

  // —— OneBot：send_group_msg / send_private_msg ——
  if (event.group_id) {
    await ctx.actions.call('send_group_msg', { group_id: event.group_id, message: text });
    return;
  }
  await ctx.actions.call('send_private_msg', { user_id: event.user_id, message: text });
}

export { sendReply, nextSeq };
