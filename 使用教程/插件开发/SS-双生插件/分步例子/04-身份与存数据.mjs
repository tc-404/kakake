// 分步 ④：身份标识 + 存数据（两套身份体系，数据各存各的）
//
// · OneBot：user_id 是 QQ 号（数字），群是 group_id（群号）
// · 官方  ：author.member_openid 是「这个人在**这个群**里」的标识，换个群就变了；
//           author.user_openid 是单聊场景的标识；群是 group_openid（不是群号）
//           三者互不通用，别用 `a || b || c` 一条链跨场景兜底。

import fs from 'node:fs';
import path from 'node:path';

function protocolOf(ctx, event) {
  const p = ctx.frameworkEnv?.protocol;
  if (p === 'onebot' || p === 'qq_official') return p;
  return event?.qq_official ? 'qq_official' : 'onebot';
}

/** 官方侧：这次是群聊还是单聊（按事件名判断，别靠 openid 猜） */
function isC2C(event) {
  return String(event?.t ?? '').startsWith('C2C');   // C2C_MESSAGE_CREATE
}

/**
 * 取「这个人」在本协议下的稳定标识
 * 官方侧按场景分路：群取 member_openid、单聊取 user_openid。
 */
function who(ctx, event) {
  if (protocolOf(ctx, event) !== 'qq_official') return String(event.user_id ?? '');
  return isC2C(event)
    ? String(event.author?.user_openid ?? '')
    : String(event.author?.member_openid ?? '');
  // ⚠️ member_openid 是**按群**变的：同一个人换个群，这个 id 就不一样。
  //    所以拿它当积分 / 用户主键时，同一个人在每个群会各有一份数据。
  //    想要跨群打通，得你自己再做一层映射，框架不代劳。
}

/** 取「这个会话」的标识（群 / 私聊） */
function where(ctx, event) {
  return protocolOf(ctx, event) === 'qq_official'
    ? { group: String(event.group_openid ?? ''), user: String(event.author?.user_openid ?? '') }
    : { group: String(event.group_id ?? ''), user: String(event.user_id ?? '') };
}

// —— 数据只写 ctx.dataPath ——
// data/<账号键>/<插件名>/ ，账号键：OneBot = QQ 号，官方 = AppID。
// 也就是同一个插件在两条协议下的两份数据是**互不相通**的，要共用得自己实现。
function dataFile(ctx, name = 'data.json') {
  return path.join(ctx.dataPath, name);
}
function loadData(ctx, name) {
  try {
    return JSON.parse(fs.readFileSync(dataFile(ctx, name), 'utf-8'));
  } catch {
    return {};
  }
}
function saveData(ctx, data, name) {
  fs.mkdirSync(ctx.dataPath, { recursive: true });
  fs.writeFileSync(dataFile(ctx, name), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 今天的日期 —— 按**本地时区**（做签到 / 每日限额这类逻辑几乎都要用到）
 *
 * 别写 new Date().toISOString().slice(0, 10)，那是 **UTC** 日期：
 * 东八区在早上 8 点前会算成前一天，结果是「一天能签两次」，
 * 以及「昨晚签过 → 第二天清晨被判成已经签过」。
 * 项目里的统一写法是本地时区，见 src/core/log-time.ts 的 formatLocalDate。
 */
function todayLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export { who, where, isC2C, loadData, saveData, todayLocal };
