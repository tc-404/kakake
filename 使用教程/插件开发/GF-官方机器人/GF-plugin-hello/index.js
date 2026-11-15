// ============================================================================
// QQ 官方机器人（GF-）完整示例插件
//
// ⚠️ 这是「官方机器人」插件，和 OneBot / NapCat（kakake- 开头）**不是一回事**：
//    · 取文字：  event.content（纯文本字符串）
//    · 发送者：  event.author.user_openid / member_openid（openid，不是 QQ 号）
//    · 群：      event.group_openid
//    · 消息 id： event.id
//    · 事件类型：event.t（如 GROUP_AT_MESSAGE_CREATE / GROUP_MESSAGE_CREATE）
//    · 发消息：  ctx.actions.call('/v2/groups/{group_openid}/messages', { content, msg_id, msg_seq })
//
//    官方事件里没有 event.message / 消息段数组 / raw_message / CQ 码 / user_id / group_id。
//
// 装法：整个 GF-plugin-hello 文件夹放进 plugins/ 下。
//      文件夹名**必须以 GF- 开头**（大小写敏感），写成 gf-hello 宿主不会加载。
// ============================================================================

const fs = require('fs');
const path = require('path');

// ========== 加载时 ==========
async function plugin_init(ctx) {
  ctx.logger.info('[GF-plugin-hello] 已加载，数据目录：' + ctx.dataPath);
}

// ========== 小工具：取出对方文字 ==========
// 官方直接用 event.content；没有就是空串。
// ⚠️ 实测开了「接收所有消息」后，群消息的 content 可能是 `<@机器人openid> 帮助` 这种
//    带尖括号的 @ 前缀（并不总是像文档写的那样已剥掉），所以统一在这里剥一次，
//    后面比较指令时就不用管前缀了。
function getText(event) {
  let t = String((event && event.content) || '').trim();
  t = t.replace(/^(?:<@!?[^>]*>\s*)+/, ''); // <@openid> / <@!openid>
  t = t.replace(/^(?:@\S+\s*)+/, '');        // @openid / @昵称
  return t.trim();
}

// ========== 小工具：取发送者 openid ==========
function getUserOpenid(event) {
  const a = (event && event.author) || {};
  return String(a.user_openid || a.member_openid || a.union_openid || '');
}

// ========== 小工具：发一句话 ==========
// 群聊 → /v2/groups/{group_openid}/messages
// 单聊 → /v2/users/{user_openid}/messages
// 被动回复必须带 msg_id（= 触发消息的 event.id），否则发不出去
async function sendReply(ctx, event, text) {
  const body = {
    content: text,
    msg_type: 0,
    msg_id: event.id,
    msg_seq: 1,
  };

  if (event.group_openid) {
    await ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
    return;
  }

  const userOpenid = getUserOpenid(event);
  if (userOpenid) {
    await ctx.actions.call(`/v2/users/${userOpenid}/messages`, body);
  }
}

// ========== 小工具：签到数据读写 ==========
// 存到 ctx.dataPath（按机器人账号隔离）；别写在插件自己目录里，覆盖插件会被清掉
function dataFile(ctx) {
  return path.join(ctx.dataPath, 'checkin.json');
}
function loadData(ctx) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(ctx), 'utf-8'));
  } catch {
    return {};
  }
}
function saveData(ctx, data) {
  fs.mkdirSync(ctx.dataPath, { recursive: true });
  fs.writeFileSync(dataFile(ctx), JSON.stringify(data, null, 2), 'utf-8');
}

// ========== 收到消息时 ==========
/** 群消息有**两个**事件名，必须同时接受：
 *   · GROUP_AT_MESSAGE_CREATE —— 群里 @ 机器人
 *   · GROUP_MESSAGE_CREATE    —— 机器人开了「接收所有消息」后，群里的每一条消息
 *  两者字段完全一致；只判前者会让插件对这种机器人完全没反应。 */
const GROUP_MESSAGE_TYPES = ['GROUP_AT_MESSAGE_CREATE', 'GROUP_MESSAGE_CREATE'];

async function plugin_onmessage(ctx, event) {
  // 只在群消息或单聊时处理；其它事件（进群/退群/按钮回调等）忽略
  if (!event) return;
  if (!GROUP_MESSAGE_TYPES.includes(event.t) && event.t !== 'C2C_MESSAGE_CREATE') return;

  const text = getText(event);
  if (!text) return;

  try {
    // —— 帮助 ——
    if (text === '帮助') {
      await sendReply(ctx, event, '可用指令：帮助、ping、签到、查积分');
      return;
    }

    // —— ping ——
    if (text === 'ping') {
      await sendReply(ctx, event, 'pong');
      return;
    }

    // —— 签到 / 查积分 ——
    if (text === '签到' || text === '查积分') {
      const userOpenid = getUserOpenid(event);
      if (!userOpenid) {
        await sendReply(ctx, event, '拿不到你的 openid，请稍后再试');
        return;
      }

      const data = loadData(ctx);
      const today = new Date().toISOString().slice(0, 10);

      if (text === '查积分') {
        const score = (data[userOpenid] && data[userOpenid].score) || 0;
        await sendReply(ctx, event, '你当前积分：' + score);
        return;
      }

      const rec = data[userOpenid] || { score: 0, last: '' };
      if (rec.last === today) {
        await sendReply(ctx, event, '今天已经签过啦，明天再来～');
        return;
      }
      rec.score += 10;
      rec.last = today;
      data[userOpenid] = rec;
      saveData(ctx, data);
      await sendReply(ctx, event, '签到成功 +10，当前积分：' + rec.score);
      return;
    }

    // —— 其它：回声 ——
    await sendReply(ctx, event, '你说了：' + text);
  } catch (err) {
    // 被动回复超时、机器人被限制、连接断了都会走到这里
    const msg = err && err.message ? err.message : String(err);
    ctx.logger.error('[GF-plugin-hello] 处理失败：' + msg);
  }
}

module.exports = { plugin_init, plugin_onmessage };
