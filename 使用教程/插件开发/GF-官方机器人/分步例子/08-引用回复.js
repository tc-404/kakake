// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onmessage 收到的那些。
//
// ========== 引用回复（QQ 官方机器人 / GF-）==========
//
// 官方发消息时带 message_reference，就会以「引用」的形式展示，关联上下文。
//
// ⚠️ 关键是 message_reference.message_id 从哪来，规则和消息 id 完全不是一回事：
//
//   引用【用户发的消息】 → 取该消息事件的 message_scene.ext 里 msg_idx 的值
//   引用【机器人自己发的消息】 → 取发送接口响应的 ext_info.ref_idx
//
//   值长这样：REFIDX_xxxxxxxxxxxxxxxxxxxx==

// —— 小工具：从 message_scene.ext（["msg_idx=…", "auth_token=…"]）里读一个 key ——
function readExt(event, key) {
  const ext = (event && event.message_scene && event.message_scene.ext) || [];
  for (const item of ext) {
    const s = String(item);
    const i = s.indexOf('=');
    if (i > 0 && s.slice(0, i) === key) return s.slice(i + 1);
  }
  return '';
}

// ========== 场景一：引用「用户刚发的这条消息」==========
async function replyQuotingUser(ctx, event, text) {
  const refIdx = readExt(event, 'msg_idx');   // ← 本条消息自己的索引
  // 顺带一提：ext 里如果还有 ref_msg_idx，那是「用户引用的那条」的索引
  const body = {
    content: text,
    msg_type: 0,
    msg_id: event.id,
    msg_seq: 1,
  };
  if (refIdx) body.message_reference = { message_id: refIdx };

  if (event.group_openid) {
    return ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
  }
  const openid = event.author && (event.author.user_openid || event.author.member_openid);
  if (openid) return ctx.actions.call(`/v2/users/${openid}/messages`, body);
}

// ========== 场景二：引用「机器人自己刚发的那条消息」==========
async function sendThenQuoteSelf(ctx, event, firstText, secondText) {
  const path = event.group_openid
    ? `/v2/groups/${event.group_openid}/messages`
    : `/v2/users/${event.author.user_openid || event.author.member_openid}/messages`;

  // 第一条：普通发送
  const resp = await ctx.actions.call(path, {
    content: firstText,
    msg_type: 0,
    msg_id: event.id,
    msg_seq: 1,
  });

  // 响应里的 ext_info.ref_idx 就是「机器人这条消息」的引用索引
  const selfRef = resp && resp.ext_info && resp.ext_info.ref_idx;

  // 第二条：引用第一条（msg_seq 必须递增，否则会被去重）
  const body = { content: secondText, msg_type: 0, msg_id: event.id, msg_seq: 2 };
  if (selfRef) body.message_reference = { message_id: selfRef };
  return ctx.actions.call(path, body);
}

// ========== 场景三：用户引用了一段话再问（message_type = 103）==========
// 这种情况被引用的内容在 event.msg_elements 里，机器人可以一次性引用回去：
async function replyQuotingQuoted(ctx, event, text) {
  if (event.message_type !== 103) {
    // 不是引用消息，退化成普通回复
    return replyQuotingUser(ctx, event, text);
  }
  const els = Array.isArray(event.msg_elements) ? event.msg_elements : [];
  const quotedIdx = String((els[0] && els[0].msg_idx) || '') || readExt(event, 'msg_idx');

  const body = { content: text, msg_type: 0, msg_id: event.id, msg_seq: 1 };
  if (quotedIdx) body.message_reference = { message_id: quotedIdx };

  if (event.group_openid) {
    return ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
  }
  const openid = event.author && (event.author.user_openid || event.author.member_openid);
  if (openid) return ctx.actions.call(`/v2/users/${openid}/messages`, body);
}

module.exports = { readExt, replyQuotingUser, sendThenQuoteSelf, replyQuotingQuoted };
