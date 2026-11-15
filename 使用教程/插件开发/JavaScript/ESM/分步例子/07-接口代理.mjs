// ⚠️ 片段：不能单独运行。发送部分依赖分步 ② 的 sendReply（或换成你自己的发送逻辑）。
//
// ========== 接口代理：ctx.kakake_api（kakake ≥ 0.6.6 推荐写法）==========
//
// 分步 ⑥ 教的是 ctx.actions.call：用 OneBot 原生接口名，失败会抛错、必须 try/catch。
// 宿主还提供一层「接口代理」：同一套接口短名打到 NapCat / SnowLuma / QQ 官方任何一条
// 连接，返回值是统一信封 —— 永不抛错、永不空返回，判断 res.status 一种写法就够。
//
// 通式（记牢）：
//   const res = await ctx.kakake_api(接口短名, 'POST', 参数对象, { conn: '连接名或id' })
//
//   接口短名 = 比 action 更好记的统一名字，控制台「接口代理」页可查全部（带中文说明）
//   返回 res = { status: 'ok' | 'failed', retcode, data, message, _proxy }
//     status = 成功还是失败（你唯一需要判断的东西）
//     data   = 上游原文，一个字段不改（透传）
//     _proxy = 元信息：实际落到哪个协议、哪个原生接口、耗时 —— 排查问题看它
//
// conn 不传时默认打到「事件来源的那条连接」，消息从哪来回哪去，不会串门。

// —— 例 1：发群文本（等价于分步 ⑥ 的 actions.call('send_group_msg', ...)）——
const res = await ctx.kakake_api('send_msg', 'POST', {
  scene: 'group',              // group=群聊 / private=私聊；官方连接则是 channel / dms
  group_id: event.group_id,    // 官方连接要换 group_openid，代理层会校验并明确报错
  message: '大家好',
});
if (res.status === 'ok') {
  ctx.logger.info(`已发出，消息 ID ${res.data.message_id}，实际原生接口 ${res._proxy.native}`);
} else {
  // 失败也一定有值：message 是人话说明，_proxy.failure 是失败分类
  // （timeout / network / unsupported / missing-param / not-connected ...）
  await sendReply(ctx, event, `发送失败：${res.message}`);
}

// —— 例 2：单发一张图（本地路径 / 远程 URL / base64 三种写法权重相同）——
await ctx.kakake_api('send_msg', 'POST', {
  scene: 'group', group_id: event.group_id,
  file: 'C:/pictures/cat.jpg',   // 也可以写 'https://...' 或 'base64://...'
});
// 语音 / 视频：加 media_type —— 'record' / 'video'，默认 'image'

// —— 例 3：图文一起发（消息段数组，text/image/record/video 任意组合）——
await ctx.kakake_api('send_msg', 'POST', {
  scene: 'group', group_id: event.group_id,
  message: [
    { type: 'text',  data: { text: '看这张图 ' } },
    { type: 'image', data: { file: 'https://example.com/cat.jpg' } },
  ],
});

// —— 例 4：查接口能力（插件自检用）——
// list() = 全部接口摘要；get(短名) = 单条详情（参数表、各协议实现对照）
const all = ctx.kakake_api.list();
ctx.logger.info(`接口代理共 ${all.length} 条统一接口，当前协议可用 ${ctx.kakake_api.list({ protocol: 'snowluma' }).length} 条`);

// 完整教程：使用教程/接口代理教程.md（conn 寻址、失败分类表、before/after/error
// 钩子、native 逃生舱、外放 HTTP API、排错速查表）
