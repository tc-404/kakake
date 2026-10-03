// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onmessage 收到的那些。
//
// ========== 发图片 / 文件（富媒体，QQ 官方机器人 / GF-）==========
//
// 官方发富媒体是**两步**，和 OneBot 的「一个 image 消息段」很不一样：
//
//   第 1 步：调「上传文件」接口，拿回一个 file_info 字符串
//   第 2 步：调「发送消息」接口，msg_type=7，media 里带上 file_info
//
// ⚠️ 两个大坑：
//   · 单聊上传接口 /v2/users/{openid}/files 和 群聊 /v2/groups/{group}/files **不互通**，
//     群聊上传的 file_info 只能发到群聊，单聊同理。
//   · file_info 有 ttl（有效期），过期了要重新上传。

async function sendImage(ctx, event, imageUrl, seq) {
  const isGroup = !!event.group_openid;
  const target = isGroup
    ? event.group_openid
    : (event.author && (event.author.user_openid || event.author.member_openid)) || '';

  if (!target) throw new Error('拿不到 group_openid / user_openid，无法发送');

  const uploadPath = isGroup ? `/v2/groups/${target}/files` : `/v2/users/${target}/files`;
  const sendPath = isGroup ? `/v2/groups/${target}/messages` : `/v2/users/${target}/messages`;

  // —— 第 1 步：上传，拿 file_info ——
  const up = await ctx.actions.call(uploadPath, {
    // 1=图片(png/jpg)  2=视频(mp4)  3=语音(silk)  4=文件
    // 软限制：图片 20MB / 视频 30MB / 语音 20MB / 文件 200MB
    // 超过软限制会自动降级成「文件」上传；超过硬限制 200MB 直接报错
    file_type: 1,
    url: imageUrl,        // 必须是 http 开头的可访问地址，平台会下载转存
    srv_send_msg: false,  // false = 只上传，不发送（返回 file_info）
    // srv_send_msg: true 的话就是「上传即发送」，会占用主动消息频次
  });

  // up.file_info 是一串序列化数据，**不要解析，原样透传**；
  // up.ttl 是有效期（秒），0 表示长期有效

  // —— 第 2 步：发送，msg_type=7 ——
  return ctx.actions.call(sendPath, {
    msg_type: 7,
    media: { file_info: up.file_info },
    msg_id: event.id,     // 被动回复
    msg_seq: seq || 2,    // ⚠️ 如果前面已经用 seq=1 回过文本，这里要用 2
  });
}

// —— 调用示例 ——
// try {
//   await sendImage(ctx, event, 'https://example.com/cat.png', 1);
// } catch (e) {
//   ctx.logger.error('发图失败：' + (e && e.message));
// }

// ========== 其它类型只要改 file_type ==========
//   视频：file_type 2，mp4
//   语音：file_type 3，silk
//   文件：file_type 4，任意格式
//
// ========== 大文件（超过上面软限制）要走「分片上传」 ==========
//   1. 调 upload_prepare 拿 upload_id、block_size、各分片预签名 URL
//   2. 按 block_size 把文件切片，逐片 HTTP PUT 到预签名 URL
//   3. 每片成功后调 upload_part_finish 通知服务端
//   4. 全部完成后，带 upload_id 再调上传接口完成合并，拿 file_info
//   ⚠️ 分片的 PUT 走平台给的预签名地址，不是 ctx.actions.call 的接口路径，
//      一般直接用 Node 的 fetch 发；简单场景建议优先用上面的 URL 直传。
