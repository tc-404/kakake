import { registerMessages } from '@/lib/i18n';

/**
 * 模拟消息页（Simulate）文案字典。
 * 复用 common.ts 的通用键（nav.simulate / btn.cancel / btn.clear 等），
 * 这里只放本页专属的键。
 *
 * zh 必须等同原始中文（即被替换掉的界面文本）。
 */
const simulateMessages = {
  // ───────── 媒体查看器（MediaViewer，已预包装） ─────────
  'simulate.zoomOut': { zh: '缩小', en: 'Zoom out' },
  'simulate.zoomIn': { zh: '放大', en: 'Zoom in' },
  'simulate.resetView': { zh: '重置视图', en: 'Reset view' },
  'simulate.preview': { zh: '预览', en: 'Preview' },

  // ───────── 消息段渲染（MessageSegments，已预包装） ─────────
  'simulate.replyMsg': { zh: '回复消息', en: 'Reply message' },
  'simulate.allMembers': { zh: '全体成员', en: 'All members' },
  'simulate.face': { zh: '表情', en: 'Sticker' },
  'simulate.image': { zh: '图片', en: 'Image' },
  'simulate.video': { zh: '视频', en: 'Video' },
  'simulate.voice': { zh: '语音', en: 'Voice' },
  'simulate.cannotLoad': { zh: '无法加载', en: 'Failed to load' },
  'simulate.chatHistory': { zh: '聊天记录', en: 'Chat history' },
  'simulate.noContent': { zh: '暂无内容', en: 'No content' },
  'simulate.viewForward': { zh: '查看转发', en: 'View forward ({count})' },
  'simulate.member': { zh: '成员', en: 'Member' },
  'simulate.file': { zh: '文件', en: 'File' },
  'simulate.musicShare': { zh: '音乐分享', en: 'Music share' },
  'simulate.music': { zh: '音乐', en: 'Music' },
  'simulate.jsonCard': { zh: 'JSON卡片', en: 'JSON card' },

  // ───────── 消息段纯文本预览（plainOf） ─────────
  'simulate.seg.image': { zh: '图片', en: 'Image' },
  'simulate.seg.voice': { zh: '语音', en: 'Voice' },
  'simulate.seg.video': { zh: '视频', en: 'Video' },
  'simulate.seg.file': { zh: '文件', en: 'File' },
  'simulate.seg.face': { zh: '表情', en: 'Sticker' },
  'simulate.seg.music': { zh: '音乐', en: 'Music' },
  'simulate.seg.card': { zh: '卡片', en: 'Card' },
  'simulate.seg.chatHistory': { zh: '聊天记录', en: 'Chat history' },
  'simulate.seg.message': { zh: '消息', en: 'Message' },

  // ───────── 空消息占位（MessageSegments） ─────────
  'simulate.emptyMessage': { zh: '（空消息）', en: '(Empty message)' },

  // ───────── 主页面：提示 / Toast ─────────
  'simulate.selectAccountFirst': { zh: '请先长按发送键选择账号', en: 'Long-press the send button to choose an account first' },
  'simulate.inputContent': { zh: '请输入内容', en: 'Please enter something' },
  'simulate.groupIdRequired': { zh: '群聊需填群号，长按发送键设置', en: 'Group ID is required for group chat; long-press the send button to set it' },
  'simulate.setSenderQQ': { zh: '请设置发送者 QQ', en: 'Please set the sender QQ' },
  'simulate.sendFailed': { zh: '发送失败', en: 'Failed to send' },
  'simulate.noPluginsLoaded': { zh: '该账号没有已加载的插件', en: 'This account has no plugins loaded' },
  'simulate.noOutputThisRound': { zh: '插件已收到，本轮无输出', en: 'Plugin received it, but produced no output this round' },
  'simulate.cleared': { zh: '已清空', en: 'Cleared' },
  'simulate.clearFailed': { zh: '清空失败', en: 'Failed to clear' },

  // ───────── 主页面：空状态 / 输入区 ─────────
  'simulate.emptyHintSend': { zh: '发一条消息或事件，触发该账号已加载的插件', en: 'Send a message or event to trigger this account’s loaded plugins' },
  'simulate.emptyNoAccount': { zh: '暂无可模拟的 OneBot 账号', en: 'No OneBot account available to simulate' },
  'simulate.insertTooltip': { zh: '插入图片/@/视频/语音/卡片', en: 'Insert image/@/video/voice/card' },
  // 输入框 placeholder：手机上只有一行宽的余量，英文要压短，别折行
  // （另外 SimulatePage 的自适应高度在 text 为空时不再读 scrollHeight，双保险）
  'simulate.inputMsgPlaceholder': { zh: '输入消息…（回车换行）', en: 'Type a message… (Enter = newline)' },
  'simulate.setAccountPlaceholder': { zh: '长按发送键设置账号', en: 'Long-press send to set account' },
  'simulate.sendBtnTooltip': { zh: '点击发送 · 长按 3 秒打开设置', en: 'Click to send · Long-press 3s to open settings' },

  // ───────── 清空确认弹窗 ─────────
  'simulate.clearCacheTitle': { zh: '清空模拟缓存', en: 'Clear simulate cache' },
  'simulate.clearCacheDesc': { zh: '将删除账号 {account} 的全部模拟对话历史，不可恢复。', en: 'This will delete all simulated conversation history for account {account}. This cannot be undone.' },

  // ───────── 消息行元信息 ─────────
  'simulate.metaGroup': { zh: ' · 群{id}', en: ' · Group {id}' },
  'simulate.metaPrivate': { zh: ' · 私聊', en: ' · Private' },
  'simulate.pluginLabel': { zh: '插件 {id}', en: 'Plugin {id}' },

  // ───────── 模拟设置面板 ─────────
  'simulate.settingsTitle': { zh: '模拟设置', en: 'Simulate settings' },
  'simulate.account': { zh: '账号', en: 'Account' },
  'simulate.selectAccount': { zh: '选择账号', en: 'Select account' },
  'simulate.noSimAccount': { zh: '暂无可模拟账号', en: 'No account available' },
  'simulate.officialTag': { zh: '［官方］', en: '[Official]' },
  'simulate.notConnected': { zh: ' · 未连接', en: ' · Not connected' },
  'simulate.officialNote': { zh: 'QQ 官方机器人：走 openid 语义，事件与消息按官方格式模拟', en: 'QQ official bot: uses openid semantics; events and messages are simulated in the official format.' },
  'simulate.senderIdentity': { zh: '发送身份', en: 'Sender identity' },
  'simulate.groupChat': { zh: '群聊', en: 'Group' },
  'simulate.privateChat': { zh: '私聊', en: 'Private' },
  'simulate.groupOpenid': { zh: '群 openid', en: 'Group openid' },
  'simulate.groupId': { zh: '群号', en: 'Group ID' },
  'simulate.userOpenid': { zh: '用户 openid', en: 'User openid' },
  'simulate.senderQQ': { zh: '发送者 QQ', en: 'Sender QQ' },
  'simulate.nickname': { zh: '昵称', en: 'Nickname' },
  'simulate.clearCache': { zh: '清空缓存', en: 'Clear cache' },
  'simulate.done': { zh: '完成', en: 'Done' },

  // ───────── 事件上报面板 ─────────
  'simulate.eventReport': { zh: '事件上报', en: 'Event report' },
  'simulate.eventReportScene': { zh: '事件上报 · {type}场景', en: 'Event report · {type} scene' },
  'simulate.targetQQ': { zh: '目标 QQ', en: 'Target QQ' },
  'simulate.operatorQQ': { zh: '操作者 QQ', en: 'Operator QQ' },
  'simulate.durationSec': { zh: '时长(秒,0=解禁)', en: 'Duration (sec, 0=unban)' },
  'simulate.subType': { zh: '子类型', en: 'Sub type' },
  'simulate.value': { zh: '值', en: 'Value' },
  'simulate.verifyInfo': { zh: '验证信息', en: 'Verification info' },
  'simulate.triggerEvent': { zh: '触发事件', en: 'Trigger event' },
  'simulate.eventFired': { zh: '事件已上报', en: 'Event reported' },

  // ───────── 事件类型下拉（EVENT_TYPES / OFFICIAL_EVENT_TYPES） ─────────
  'simulate.event.group_increase': { zh: '入群', en: 'Join group' },
  'simulate.event.group_decrease': { zh: '退群/被踢', en: 'Leave/Kicked' },
  'simulate.event.group_ban': { zh: '群禁言', en: 'Group mute' },
  'simulate.event.group_admin': { zh: '管理员变动', en: 'Admin change' },
  'simulate.event.group_recall': { zh: '群撤回', en: 'Group recall' },
  'simulate.event.group_upload': { zh: '群文件上传', en: 'Group file upload' },
  'simulate.event.group_card': { zh: '群名片变更', en: 'Group card change' },
  'simulate.event.group_title': { zh: '获得头衔', en: 'Gain title' },
  'simulate.event.group_honor': { zh: '群荣誉', en: 'Group honor' },
  'simulate.event.group_essence': { zh: '设/撤精华', en: 'Set/Unset essence' },
  'simulate.event.group_poke': { zh: '群内戳一戳', en: 'Group poke' },
  'simulate.event.group_request': { zh: '加群请求', en: 'Join request' },
  'simulate.event.friend_recall': { zh: '好友撤回', en: 'Friend recall' },
  'simulate.event.friend_add': { zh: '好友添加', en: 'Friend added' },
  'simulate.event.friend_poke': { zh: '好友戳一戳', en: 'Friend poke' },
  'simulate.event.friend_request': { zh: '加好友请求', en: 'Friend request' },
  'simulate.event.profile_like': { zh: '资料被点赞', en: 'Profile liked' },
  'simulate.event.bot_offline': { zh: '被踢下线', en: 'Kicked offline' },
  'simulate.event.lifecycle_connect': { zh: '连接/上线', en: 'Connect/Online' },
  'simulate.event.gf_group_add_robot': { zh: '机器人进群', en: 'Bot joined group' },
  'simulate.event.gf_group_del_robot': { zh: '机器人被移出群', en: 'Bot removed from group' },
  'simulate.event.gf_group_member_add': { zh: '群成员增加', en: 'Member added' },
  'simulate.event.gf_group_member_remove': { zh: '群成员减少', en: 'Member removed' },
  'simulate.event.gf_group_join_request': { zh: '入群申请', en: 'Join application' },
  'simulate.event.gf_friend_add': { zh: '用户添加机器人', en: 'User added bot' },
  'simulate.event.gf_friend_del': { zh: '用户删除机器人', en: 'User removed bot' },

  // ───────── 事件 value 字段标签 / 占位 ─────────
  'simulate.val.group_upload': { zh: '文件名', en: 'File name' },
  'simulate.val.group_card': { zh: '新名片', en: 'New card' },
  'simulate.val.group_title': { zh: '头衔', en: 'Title' },
  'simulate.val.group_honor': { zh: '荣誉类型', en: 'Honor type' },
  'simulate.val.profile_like': { zh: '点赞数', en: 'Like count' },
  'simulate.val.bot_offline': { zh: '下线原因', en: 'Offline reason' },
  'simulate.ph.bot_offline': { zh: '在其它设备登录', en: 'Logged in on another device' },

  // ───────── 插入内容弹窗（AttachDialog） ─────────
  'simulate.insertContent': { zh: '插入内容', en: 'Insert content' },
  'simulate.tabImage': { zh: '图片', en: 'Image' },
  'simulate.tabVideo': { zh: '视频', en: 'Video' },
  'simulate.tabVoice': { zh: '语音', en: 'Voice' },
  'simulate.tabJson': { zh: 'JSON卡片', en: 'JSON card' },
  'simulate.phImage': { zh: '图片 URL / 本地路径 / base64（插入光标处）', en: 'Image URL / local path / base64 (insert at cursor)' },
  'simulate.phAt': { zh: 'QQ 号，或 all（插入光标处）', en: 'QQ number, or all (insert at cursor)' },
  'simulate.phVideo': { zh: '视频 URL / 本地路径（独立发送）', en: 'Video URL / local path (send standalone)' },
  'simulate.phRecord': { zh: '语音 URL / 本地路径（独立发送）', en: 'Voice URL / local path (send standalone)' },
  'simulate.phJson': { zh: 'JSON 卡片原文（独立发送）', en: 'JSON card source (send standalone)' },
  'simulate.inlineHint': { zh: '插入到输入框光标位置，可与文字混排', en: 'Inserted at the cursor in the input box; can be mixed with text' },
  'simulate.standaloneHint': { zh: '独立成一条消息发送，不与文字或其他内容混排', en: 'Sent as a separate message; not mixed with text or other content' },
  'simulate.insert': { zh: '插入', en: 'Insert' },
  'simulate.send': { zh: '发送', en: 'Send' },

  // ───────── ArkCard 组件 ─────────
  'simulate.arkCard': { zh: 'ARK 卡片', en: 'ARK card' },
  'simulate.arkTemplate': { zh: '模板', en: 'Template' },
  'simulate.cardImg': { zh: '卡片图', en: 'Card image' },

  // ───────── NativeMarkdown 组件 ─────────
  'simulate.nativeMd': { zh: '原生 Markdown', en: 'Native Markdown' },
  'simulate.emptyMd': { zh: '（空 Markdown）', en: '(Empty Markdown)' },
  'simulate.mockBtnTip': { zh: '模拟按钮（不可点击）', en: 'Mock button (not clickable)' },
  'simulate.button': { zh: '按钮', en: 'Button' },

  // ───────── OfficialOutput 组件 ─────────
  'simulate.targetGroup': { zh: '群', en: 'Group' },
  'simulate.targetPrivate': { zh: '私聊', en: 'Private' },
  'simulate.targetChannel': { zh: '频道', en: 'Channel' },
  'simulate.targetDm': { zh: '频道私信', en: 'Channel DM' },
  'simulate.officialSend': { zh: '官方发送', en: 'Official send' },
  'simulate.msgTypeText': { zh: '文本', en: 'Text' },
  'simulate.msgTypeMarkdown': { zh: 'Markdown', en: 'Markdown' },
  'simulate.msgTypeArk': { zh: 'ARK 卡片', en: 'ARK card' },
  'simulate.msgTypeEmbed': { zh: 'Embed', en: 'Embed' },
  'simulate.msgTypeRich': { zh: '富媒体', en: 'Rich media' },
  'simulate.richMediaFileInfo': { zh: '富媒体（file_info）', en: 'Rich media (file_info)' },
  'simulate.richMediaLabel': { zh: '富媒体', en: 'Rich media' },
  'simulate.rawParams': { zh: '原始参数', en: 'Raw params' },

  // ───────── PluginOutput 组件（系统动作灰字） ─────────
  'simulate.pluginTag': { zh: '［插件］', en: '[Plugin]' },
  'simulate.pluginCall': { zh: '调用', en: 'call' },
  'simulate.allBan': { zh: '全员禁言', en: 'Mute all' },
  'simulate.unban': { zh: '解除', en: 'Lift' },
  'simulate.enableBan': { zh: '开启', en: 'Enable' },
  'simulate.banUser': { zh: '禁言 {id} {dur} 秒', en: 'Mute {id} for {dur}s' },
  'simulate.kick': { zh: '踢出 {id}', en: 'Kick {id}' },
  'simulate.poke': { zh: '戳一戳 {id}', en: 'Poke {id}' },
  'simulate.setCard': { zh: '改群名片 {id} → {card}', en: 'Change group card {id} → {card}' },
  'simulate.setGroupName': { zh: '改群名 → {name}', en: 'Change group name → {name}' },
  'simulate.setTitle': { zh: '设头衔 {id} → {title}', en: 'Set title {id} → {title}' },
  'simulate.actRecall': { zh: '撤回消息 {id}', en: 'Recall message {id}' },
  'simulate.descGroup': { zh: '群 {id}', en: 'Group {id}' },
  'simulate.descPrivate': { zh: '私聊 {id}', en: 'Private {id}' },
} as const;

registerMessages(simulateMessages);
