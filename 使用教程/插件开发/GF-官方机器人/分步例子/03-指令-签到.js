// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onmessage 收到的那些，
//    并且已经写好 sendReply(ctx, event, text)（见 02-怎么发回复.js）。
//
// ========== 指令处理 + 存数据（QQ 官方机器人 / GF-）==========
//
// 指令匹配和 OneBot 插件一模一样（都是比字符串），
// 区别只在「取文字」和「发回复」用的是官方那套。

// require = 引入 Node 自带模块；官方插件同样能用 Node 生态
const fs = require('fs');
const path = require('path');

// —— 数据存哪：ctx.dataPath ——
// 这是「按机器人账号 AppID 隔离」的数据目录，每个账号一份，互不干扰。
// ⚠️ 千万不要把数据写在插件自己的目录里：覆盖/重装插件时那个目录会被清掉。
function dataFile(ctx) {
  return path.join(ctx.dataPath, 'checkin.json');
}

function loadData(ctx) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(ctx), 'utf-8'));
  } catch {
    return {}; // 文件还不存在 / 解析失败 → 当作空数据
  }
}

function saveData(ctx, data) {
  // recursive: true = 目录不存在就顺带建出来
  fs.mkdirSync(ctx.dataPath, { recursive: true });
  fs.writeFileSync(dataFile(ctx), JSON.stringify(data, null, 2), 'utf-8');
}

// ========== 收到消息时：处理「签到」「查积分」==========
async function handleCheckin(ctx, event) {
  const text = String(event.content || '').trim();

  // 只处理这两条指令，其它一律不管（避免误触发）
  if (text !== '签到' && text !== '查积分') return;

  // 用 openid 当用户主键——官方拿不到 QQ 号，openid 就是「这个用户」的稳定标识
  const userOpenid =
    (event.author && (event.author.user_openid || event.author.member_openid)) || '';
  if (!userOpenid) return;

  const data = loadData(ctx);
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (text === '查积分') {
    const score = (data[userOpenid] && data[userOpenid].score) || 0;
    await sendReply(ctx, event, `你当前积分：${score}`);
    return;
  }

  // —— 签到：同一天只算一次 ——
  const rec = data[userOpenid] || { score: 0, last: '' };
  if (rec.last === today) {
    await sendReply(ctx, event, '今天已经签过啦，明天再来～');
    return;
  }

  rec.score += 10;
  rec.last = today;
  data[userOpenid] = rec;
  saveData(ctx, data);

  await sendReply(ctx, event, `签到成功 +10，当前积分：${rec.score}`);
}

module.exports = { handleCheckin };
