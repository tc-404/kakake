// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onevent / plugin_onmessage 收到的那些。
//
// ========== 处理按钮点击（互动事件，QQ 官方机器人 / GF-）==========
//
// 用户在 Markdown 消息里点「回调按钮」时，平台会推一个事件：
//     event.t === 'INTERACTION_CREATE'，event.type === 11
// （单聊快捷菜单是 type = 12，处理方式一样）
//
// ⚠️ 两条硬规则：
//   1. **必须在 3 秒内 ACK**，否则用户客户端一直转圈到超时：
//        ctx.actions.call(`/interactions/${event.id}`, { __method: 'PUT', code: 0 })
//   2. 同一个 interaction_id 只能 ACK 一次。
//
// ⚠️ 注意事件字段位置和消息事件不同：
//   · 单聊：用户 openid 在 event.user_openid（**不是** event.author.user_openid）
//   · 群聊：群 openid 在 event.group_openid，群成员在 event.group_member_openid
//   · 点了哪个按钮：event.data.resolved.button_id
//   · 按钮带的数据：event.data.resolved.button_data

async function handleInteraction(ctx, event) {
  if (!event || event.t !== 'INTERACTION_CREATE') return;

  // 只处理「消息按钮」（11）和「单聊快捷菜单」（12）；其它类型（13反馈/14清空会话/18授权…）无需 ACK
  if (event.type !== 11 && event.type !== 12) return;

  const resolved = (event.data && event.data.resolved) || {};
  const buttonId = String(resolved.button_id || '');
  const buttonData = String(resolved.button_data || '');

  // —— 第 1 步：先 ACK（能早尽早，别等业务算完再 ACK）——
  try {
    await ctx.actions.call(`/interactions/${event.id}`, { __method: 'PUT', code: 0 });
  } catch (e) {
    ctx.logger?.warn?.('[interaction] ACK 失败：' + (e && e.message));
  }

  // —— 第 2 步：按按钮数据做业务，并回一条消息 ——
  // 注意：这里没有 event.author！用 event.user_openid / event.group_openid 判断场景
  const isGroup = !!event.group_openid;
  const target = isGroup ? event.group_openid : event.user_openid;
  if (!target) return;

  const path = isGroup ? `/v2/groups/${target}/messages` : `/v2/users/${target}/messages`;

  try {
    await ctx.actions.call(path, {
      content: '你点了按钮：' + (buttonData || buttonId || '（没带数据）'),
      msg_type: 0,
      // ⚠️ 互动事件用 event_id 做被动回复凭证（不是 msg_id）：
      //    群支持 event_id 的事件：INTERACTION_CREATE / GROUP_ADD_ROBOT / GROUP_MSG_RECEIVE
      //    单聊支持 event_id 的事件：INTERACTION_CREATE / C2C_MSG_RECEIVE / FRIEND_ADD
      event_id: event.id,
      msg_seq: 1,
    });
  } catch (e) {
    ctx.logger?.error?.('[interaction] 回复失败：' + (e && e.message));
  }
}

module.exports = { handleInteraction };

// ========== 别忘了在 plugin_onevent 里调用它 ==========
// async function plugin_onevent(ctx, event) {
//   await handleInteraction(ctx, event);
// }
