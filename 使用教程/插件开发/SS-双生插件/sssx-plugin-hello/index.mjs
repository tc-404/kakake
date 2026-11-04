// ============================================================================
// 双生插件（sssx-plugin-*）完整示例
//
// 一份代码同时挂在两条协议上：
//   · OneBot11 / NapCat  → ctx.frameworkEnv.protocol === 'onebot'
//   · QQ 官方机器人       → ctx.frameworkEnv.protocol === 'qq_official'
//
// 框架只负责「双路由」：把本目录同时装载到两类连接上，各跑一份独立实例，
// 并告诉你这次事件来自哪条协议。**怎么兼容两套结构，是插件自己的事**——
// 本例的做法就是最直白的一种：按 protocol 分成两份处理函数。
//
// 事件长相（两套完全不一样，别混用）：
//   OneBot : event.post_type / event.message[] / event.user_id / event.group_id / event.raw_message
//   官方   : event.t / event.content（纯文本）/ event.author.member_openid / event.group_openid
//
// 发送长相（也是两套）：
//   OneBot : ctx.actions.call('send_group_msg', { group_id, message })
//   官方   : ctx.actions.call('/v2/groups/{group_openid}/messages', { content, msg_id, msg_seq })
//
// 装法：整个 sssx-plugin-hello 文件夹放进 plugins/ 下。
//      文件夹名**必须以 sssx-plugin- 开头**，写成 sssx-hello / SS-plugin-hello 都不会被加载。
//
// 本例里凡是标了「实测」的写法，都来自本机 log/2026-10-13.log 的真实官方事件，
// 或项目里已经在跑的插件（GF-plugin-mkai / sssx-plugin-book），不是拍脑袋想的。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';

// ========== 加载时 ==========
async function plugin_init(ctx) {
  const p = ctx.frameworkEnv?.protocol ?? '未知';
  ctx.logger.info(`[sssx-plugin-hello] 已加载：协议=${p} · 数据目录=${ctx.dataPath}`);
}

// ========== ① 认协议 ==========
// 首选读 ctx.frameworkEnv.protocol；拿不到时退回事件上的标记键（event.qq_official / event.onebot）。
function protocolOf(ctx, event) {
  const p = ctx.frameworkEnv?.protocol;
  if (p === 'onebot' || p === 'qq_official') return p;
  return event?.qq_official ? 'qq_official' : 'onebot';
}

// ========== ② 取对方文字 ==========
// OneBot：消息段数组里拼 text；官方：纯文本 content（带 @ 标记，要剥掉）
function getText(ctx, event) {
  if (protocolOf(ctx, event) === 'qq_official') {
    return String(event?.content ?? '')
      // 实测：官方群消息的 @ 是**旧格式** `<@32位openid>`，而且**位置不固定**：
      //   "<@4D8F...> 你好呀"                 ← 多数在开头
      //   " <@4D8F...> 肥鱼能咬吗"            ← 开头，还多一个前导空格
      //   "那你看看这个是什么<@4D8F...> "     ← 句尾（log/2026-10-13.log 里真实出现）
      // 所以这里**全局剥**；只剥开头的正则会漏掉句尾那种，指令就死活匹配不上。
      // 项目内既有实现同样是全局的：GF-plugin-mkai 的 RE_AT = /<@!?[A-Za-z0-9_]+>/g、
      // src/core/log-format.ts:346 的 /<@([^>]*)>/g。
      .replace(/<@[^>]*>/g, '')
      // 新格式 `<qqbot-at-user id="..." />`：实测**目前只在发送侧**见到（框架自己拼的，
      // 见 src/core/log-format.ts:342），接收侧还没出现；顺手兼容，省得平台切过去就失效。
      .replace(/<qqbot-at-user[^>]*>/gi, '')
      // 平台偶尔给 `@昵称` 这种纯文本形态，只剥开头的（全局剥会误伤正常文本）
      .replace(/^(?:@\S+\s*)+/, '')
      .trim();
  }
  if (typeof event?.raw_message === 'string' && event.raw_message.trim()) {
    return event.raw_message.trim();
  }
  const segs = Array.isArray(event?.message) ? event.message : [];
  return segs
    .filter((s) => s && s.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join('')
    .trim();
}

// ========== ③ 官方侧 msg_seq：同一条消息回多次时必须递增 ==========
// 写死 msg_seq: 1 是常见坑：官方规定「相同 msg_id + msg_seq 重复发送会失败」
// （见 `GF-官方机器人/说明.md` 发送参数表），第二条起就发不出去了。
// 做法是记住每条 msg_id 用到了第几号 —— 照抄项目里实际在跑的 sssx-plugin-book（index.mjs:44）。
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

// ========== ④ 发一句话 ==========
// 同一个 ctx.actions.call，框架按连接类型自动分流，参数各按各的协议来
async function sendReply(ctx, event, text) {
  if (protocolOf(ctx, event) === 'qq_official') {
    const body = {
      content: text,
      msg_type: 0,
      msg_id: event.id,        // 被动回复必须带
      msg_seq: nextSeq(event.id),
    };
    // 群 / 单聊按 event.t 分路，**不要**拿一个 openid 兜底去打另一套接口：
    // member_openid 只在群内有效、user_openid 只在单聊有效，两者不通用，
    // 把 member_openid 塞进 /v2/users/{id}/messages 会失败。
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

  // OneBot
  if (event.group_id) {
    await ctx.actions.call('send_group_msg', { group_id: event.group_id, message: text });
    return;
  }
  await ctx.actions.call('send_private_msg', { user_id: event.user_id, message: text });
}

// ========== ⑤ 存数据 ==========
// 写到 ctx.dataPath（按账号隔离：OneBot 用 QQ 号、官方用 AppID）
// ⚠️ 别写 ctx.pluginPath——那是运行副本，重载会被覆盖
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

// ========== ⑥ 取「这个人」的标识 ==========
// 两条协议身份体系不同：OneBot 是 QQ 号（数字），官方是 openid（字符串）
function who(ctx, event) {
  if (protocolOf(ctx, event) !== 'qq_official') return String(event.user_id ?? '');
  // 官方：群取 member_openid、单聊取 user_openid，按场景分路，别 `a || b` 兜底
  return String(event?.t ?? '').startsWith('C2C')
    ? String(event.author?.user_openid ?? '')
    : String(event.author?.member_openid ?? '');
  // ⚠️ 注意：member_openid 是「这个人在**这个群**里」的标识，换个群就变了。
  //    拿它当积分 / 用户主键，同一个人会在每个群各有一份积分（本例就是这个效果）。
  //    想跨群打通得自己做一层映射，框架不代劳。
}

// ========== 今天的日期（本地时区） ==========
// 别用 new Date().toISOString().slice(0, 10) —— 那是 **UTC** 日期。
// 东八区下早上 8 点前会算成前一天，会出现「一天能签两次」和「次日清晨被判已签」。
// 项目里的统一写法是本地时区，见 src/core/log-time.ts 的 formatLocalDate。
function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ========== 收到消息时 ==========
async function plugin_onmessage(ctx, event) {
  if (!event) return;
  const text = getText(ctx, event);
  if (!text) return;

  try {
    if (text === '帮助' || text === 'help') {
      await sendReply(ctx, event, '可用指令：帮助、ping、签到、查积分');
      return;
    }

    if (text === 'ping') {
      // 顺手演示一下「我这条是哪条协议」
      const p = protocolOf(ctx, event) === 'qq_official' ? 'QQ 官方机器人' : 'OneBot';
      await sendReply(ctx, event, `pong（当前跑在 ${p} 上）`);
      return;
    }

    if (text === '签到' || text === '查积分') {
      const uid = who(ctx, event);
      if (!uid) {
        await sendReply(ctx, event, '拿不到你的身份标识，请稍后再试');
        return;
      }

      const data = loadData(ctx);
      const day = today();

      if (text === '查积分') {
        const score = data[uid]?.score ?? 0;
        await sendReply(ctx, event, `你当前积分：${score}`);
        return;
      }

      const rec = data[uid] ?? { score: 0, last: '' };
      if (rec.last === day) {
        await sendReply(ctx, event, '今天已经签过啦，明天再来～');
        return;
      }
      rec.score += 10;
      rec.last = day;
      data[uid] = rec;
      saveData(ctx, data);
      await sendReply(ctx, event, `签到成功 +10，当前积分：${rec.score}`);
      return;
    }

    await sendReply(ctx, event, `你说了：${text}`);
  } catch (err) {
    // 发送超时、机器人被限制、连接断了都会走到这里
    ctx.logger.error(`[sssx-plugin-hello] 处理失败：${err?.message ?? err}`);
  }
}

export { plugin_init, plugin_onmessage };
