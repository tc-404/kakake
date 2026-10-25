// ⚠️ 片段：不能单独运行。它假设 ctx / event 就是 plugin_onmessage 收到的那些。
//
// ========== 发 Markdown + 按钮（QQ 官方机器人 / GF-）==========
//
// 官方发 Markdown 用 msg_type = 2，内容放在 markdown.content（原生 markdown 语法）。
// 单聊 / 群聊现在都开放，**不用申请模板**（频道才需要内邀）。
//
// ⚠️ 三条硬规则：
//   1. 传了 markdown，content 就必须为空（二选一，不能都填）。
//   2. 按钮（keyboard）**只有 Markdown 消息才显示**，纯文本消息带键盘不生效。
//   3. 发送参数里同样要带 msg_id（被动回复）和递增的 msg_seq。

// async = 里面有 await 网络请求
async function sendMarkdownWithButtons(ctx, event, markdownText, seq) {
  const body = {
    msg_type: 2,                     // 2 = Markdown
    markdown: {
      content: markdownText,         // 原生 markdown，例："## 每日签到\n\n今日签到成功！"
      // ⚠️ 不要同时给 content（纯文本字段），会冲突
    },
    // —— 内嵌键盘：按钮 ——
    keyboard: {
      content: {
        rows: [
          {
            buttons: [
              {
                id: 'btn_signin',                     // 按钮 id，同一键盘内唯一
                render_data: {
                  label: '签到',                      // 按钮文字，**最多 10 个字符**
                  visited_label: '已签到',            // 点击后显示的文字
                  style: 1,                          // 0灰框 1蓝框 3白底红字 4蓝底白字
                },
                action: {
                  // 0 = 跳转按钮（打开网页/小程序）
                  // 1 = 回调按钮（点完推 INTERACTION_CREATE 给机器人，需要 ACK）
                  // 2 = 指令按钮（在输入框自动插入 @机器人 + data）
                  type: 2,
                  permission: { type: 2 },            // 0指定用户 1管理员 2所有人
                  data: '/签到',                       // type=1/2 时必填
                  enter: true,                        // 指令按钮：点击后直接发送（仅单聊）
                },
              },
            ],
          },
        ],
      },
    },
    msg_id: event.id,                // 被动回复：触发消息的 id
    msg_seq: seq || 1,               // 同一条消息的第几次回复，1、2、3… 递增
  };

  if (event.group_openid) {
    return ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, body);
  }
  const openid = event.author && (event.author.user_openid || event.author.member_openid);
  if (openid) {
    return ctx.actions.call(`/v2/users/${openid}/messages`, body);
  }
}

// —— 调用示例 ——
// await sendMarkdownWithButtons(
//   ctx, event,
//   '## 每日签到\n\n今日签到成功！获得 **50** 积分\n连续签到 **7** 天',
//   1,
// );

// ========== Markdown 支持的语法速查（想用哪个就写哪个）==========
//   # 一级标题 / ## 二级标题
//   **加粗** / __加粗__ / _斜体_ / *斜体* / ***加粗斜体*** / ~~删除线~~
//   [链接文字](https://example.com)  或  <https://example.com>
//   ![描述 #208px #320px](https://公网可访问的图片.png)   ← 图片必须公网可达
//   1. 有序列表      - 无序列表      列表嵌套（二级前空 4 空格）
//   > 块引用         ***  水平分割线
//   需要连续空行时用 \u200B（零宽空格）撑一下
