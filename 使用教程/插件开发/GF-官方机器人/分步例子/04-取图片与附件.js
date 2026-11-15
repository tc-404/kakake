// ⚠️ 片段：不能单独运行。它假设 event 就是 plugin_onmessage / plugin_onevent 收到的那个事件。
//
// ========== 取出图片 / 语音 / 文件（QQ 官方机器人 / GF-）==========
//
// ⚠️ 这是官方和 OneBot 差别最大的地方之一：
//
//   OneBot：图片在 event.message 消息段数组里，形如 { type:'image', data:{ url } }
//   官方：图片等**不在** event.content，也不在消息段数组里，
//         而是挂在 event.attachments 数组上，用 content_type 区分类型。
//
//   event.content 只有**文字**（而且群聊里 @机器人 的前缀已被平台去掉）。

function pickAttachments(event) {
  const list = Array.isArray(event.attachments) ? event.attachments : [];
  const out = { images: [], videos: [], voices: [], files: [] };

  for (const a of list) {
    // content_type 是 MIME 风格的值，具体取值：
    //   voice        = 语音
    //   image/jpeg   = JPEG 图片
    //   image/png    = PNG 图片
    //   image/gif    = GIF 图片
    //   video/mp4    = MP4 视频
    //   file         = 群文件
    const ct = String(a.content_type || '');

    // ⚠️ 别写成 ct === 'image' —— 图片实际是 image/jpeg 这种，用 startsWith 才稳
    if (ct.startsWith('image')) out.images.push(a);
    else if (ct.startsWith('video')) out.videos.push(a);
    else if (ct === 'voice') out.voices.push(a);
    else out.files.push(a);
  }
  return out;
}

// —— 用法 ——
const att = pickAttachments(event);

// 每张图片的下载地址（⚠️ url 有时效，尽快下载）
// att.images[0].url

// 语音特别值：官方直接给了「转好的 WAV」和「平台 ASR 识别文本」，省得你自己转 silk
// att.voices[0].voice_wav_url   // WAV 下载地址
// att.voices[0].asr_refer_text  // 平台识别出来的文字

// 文件：att.files[0].filename / .url / .size(字节)

// ========== 卡片消息（小程序 / 图文 / 位置…）不是 attachments ==========
// 这类消息的 event.message_type === 3，内容在 event.ark_data 里：
//   ark_data.ark_type  = 'miniapp' | 'tuwen' | 'feed' | 'map' | ...
//   ark_data.ark_name  = 中文名，如 '小程序'
//   ark_data.fields    = { title, desc, jump_url, preview, source, ... }
if (event.message_type === 3 && event.ark_data) {
  const title = (event.ark_data.fields && event.ark_data.fields.title) || '';
  const jump = (event.ark_data.fields && event.ark_data.fields.jump_url) || '';
  // 这里可以回：「你发的卡片是《title》，链接 jump」
}

// ========== 引用消息（用户引用了一段话再问）==========
// 这类消息 event.message_type === 103，被引用的内容在 event.msg_elements 里：
if (event.message_type === 103) {
  const els = Array.isArray(event.msg_elements) ? event.msg_elements : [];
  const quoted = els.map((e) => String(e.content || '')).filter(Boolean).join('\n');
  // quoted = 用户引用的那段原文
}
