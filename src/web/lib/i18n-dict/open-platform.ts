import { registerMessages } from '@/lib/i18n';

/**
 * 开放平台页文案。
 * 注意：品牌词「咔咔珂 / Kakake」「QQ」「腾讯」「AppID / AppSecret」等保留原样，不翻译。
 */
const openPlatformMessages = {
  // ───────── 账号卡片状态 / 徽标 ─────────
  'open-platform.statusPending': { zh: '待接入', en: 'Pending' },
  'open-platform.statusConnected': { zh: '连接正常', en: 'Connected' },
  'open-platform.statusConnecting': { zh: '连接中', en: 'Connecting' },
  'open-platform.statusDisconnected': { zh: '已断开', en: 'Disconnected' },
  'open-platform.statusDisabled': { zh: '已停用', en: 'Disabled' },
  'open-platform.badgeNotConnected': { zh: '未接入', en: 'Not connected' },
  'open-platform.badgeSandbox': { zh: '沙箱', en: 'Sandbox' },
  'open-platform.badgeOfficial': { zh: '正式', en: 'Official' },
  'open-platform.tipConnected': { zh: '已连接', en: 'Connected' },
  'open-platform.tipNotConnected': { zh: '未连接', en: 'Not connected' },

  'open-platform.unnamedAccount': { zh: '未命名账号', en: 'Unnamed account' },
  'open-platform.unnamedBot': { zh: '未命名机器人', en: 'Unnamed bot' },
  'open-platform.pendingNote': { zh: '仅登记了 AppID，补上密钥即可接入咔咔珂', en: 'Only AppID registered — add the secret to connect to Kakake' },

  // ───────── 日活小标签 ─────────
  'open-platform.dauToday': { zh: '今日', en: 'Today' },
  'open-platform.dauYesterday': { zh: '昨日', en: 'Yesterday' },
  'open-platform.dau7d': { zh: '近7天', en: '7 days' },
  'open-platform.dauTotal': { zh: '累计', en: 'Total' },

  // ───────── 扫码接入 ─────────
  'open-platform.qrAlt': { zh: '接入二维码', en: 'Connection QR code' },
  'open-platform.scanTitle': { zh: '请用手机 QQ 扫码接入', en: 'Scan with the QQ mobile app to connect' },
  'open-platform.scanDesc': { zh: '扫码后自动取回 AppID 与密钥并接入，无需任何配置', en: 'Scanning auto-fetches the AppID and secret and connects — no configuration needed' },
  'open-platform.scanNote': { zh: '腾讯官方通道（q.qq.com），须用 QQ 摄像头直接扫', en: 'Official Tencent channel (q.qq.com); scan directly with the QQ camera' },
  'open-platform.loginBoundTitle': { zh: '已通过扫码接入机器人', en: 'Bot connected via scan' },
  'open-platform.loginUnboundTitle': { zh: '扫码接入机器人', en: 'Connect a bot by scanning' },
  'open-platform.loginBoundDesc': { zh: '再次扫码可继续接入其它机器人', en: 'Scan again to connect more bots' },
  'open-platform.loginUnboundDesc': { zh: '腾讯官方扫码通道，不用申请开发者账号、不用手填密钥', en: "Official Tencent scan channel — no developer account or manual secret entry required" },
  'open-platform.scanConnectBtn': { zh: '扫码接入', en: 'Scan to connect' },
  // 二维码悬浮窗已呼出、又被关掉后，卡上按钮变成「继续扫码」重新呼出
  'open-platform.continueScanBtn': { zh: '继续扫码', en: 'Show QR code' },
  'open-platform.scanNoteMulti': { zh: '腾讯这条扫码通道一次只授权你在手机上选中的那一个机器人。账号下还有其它机器人的话，再扫一次、在页面里选另一个即可。', en: 'This scan channel authorizes only the one bot you selected on your phone. If the account has more bots, scan again and pick another on the page.' },

  // ───────── 统计概览 ─────────
  'open-platform.statBots': { zh: '机器人账号', en: 'Bot accounts' },
  'open-platform.statConnected': { zh: '连接中', en: 'Connecting' },
  'open-platform.statDauToday': { zh: '今日日活', en: "Today's DAU" },

  // ───────── 账号列表 ─────────
  'open-platform.accountsSummary': { zh: '共 {count} 个账号', en: '{count} account(s) in total' },
  'open-platform.includingPending': { zh: '（含未接入）', en: '(incl. unconnected)' },
  'open-platform.addAccountBtn': { zh: '添加账号', en: 'Add account' },
  'open-platform.noAccounts': { zh: '还没有机器人账号', en: 'No bot accounts yet' },
  'open-platform.emptyHint': { zh: '一次扫码接入一个机器人。已在开放平台建好、但不想重新扫码的，也可以先登记 AppID，之后补密钥接入。', en: 'Connect one bot per scan. If you already created it on the Open Platform but do not want to scan again, register the AppID first and add the secret later.' },
  'open-platform.registerOrConnectBtn': { zh: '登记 / 接入账号', en: 'Register / connect account' },

  // ───────── 详情弹窗 ─────────
  'open-platform.detailPendingDesc': { zh: '仅登记了 AppID，尚未接入', en: 'AppID registered only, not yet connected' },
  'open-platform.sandboxEnv': { zh: '沙箱环境', en: 'Sandbox environment' },
  'open-platform.officialEnv': { zh: '正式环境', en: 'Production environment' },
  'open-platform.websocketGateway': { zh: 'WebSocket 网关', en: 'WebSocket gateway' },
  'open-platform.pendingDetailNote': { zh: '该账号只登记了 AppID，还没有接入咔咔珂，因此无法拉取机器人资料、频道列表与日活。补上 AppSecret 后即可接入并解锁全部能力。', en: 'This account only has its AppID registered and is not yet connected to Kakake, so bot profile, channel list and DAU cannot be fetched. Add the AppSecret to connect and unlock all features.' },
  'open-platform.dauTitle': { zh: '日活（DAU）', en: 'Daily active (DAU)' },
  'open-platform.noDau': { zh: '暂无日活数据（收到消息后自动统计）', en: 'No DAU data yet (auto-counted after messages are received)' },
  'open-platform.officialApiData': { zh: '官方接口数据', en: 'Official API data' },
  'open-platform.fetching': { zh: '拉取中…', en: 'Fetching…' },
  'open-platform.refetch': { zh: '重新拉取', en: 'Refetch' },
  'open-platform.fetchingFrom': { zh: '正在从 bots.qq.com 拉取…', en: 'Fetching from bots.qq.com…' },
  'open-platform.noSecret': { zh: '未配置 AppSecret，无法调用官方接口', en: 'AppSecret not configured; official API cannot be called' },
  'open-platform.wssGateway': { zh: 'WSS 网关接入点', en: 'WSS gateway endpoint' },
  'open-platform.guildsIn': { zh: '所在频道（{count}）', en: 'Guilds ({count})' },
  'open-platform.memberCount': { zh: '{count} 人', en: '{count} members' },
  'open-platform.loadingChannels': { zh: '加载子频道…', en: 'Loading sub-channels…' },
  'open-platform.noChannels': { zh: '暂无子频道', en: 'No sub-channels' },
  'open-platform.noGuilds': { zh: '该机器人未加入任何频道（公域机器人无权拉取频道列表）', en: 'This bot has not joined any guild (public bots cannot fetch the channel list)' },
  'open-platform.interactiveConfig': { zh: '交互配置', en: 'Interactive config' },
  'open-platform.addSecretAndConnect': { zh: '补密钥并接入', en: 'Add secret & connect' },
  'open-platform.refreshProfile': { zh: '刷新资料', en: 'Refresh profile' },

  // ───────── 添加 / 接入账号 ─────────
  'open-platform.addTitleConnected': { zh: '接入机器人', en: 'Connect bot' },
  'open-platform.addTitle': { zh: '添加机器人账号', en: 'Add bot account' },
  'open-platform.addDesc': { zh: '填 AppID 即可先登记为「未接入」；同时填 AppSecret 会直接创建连接并接入咔咔珂。', en: 'Entering an AppID registers it as "unconnected"; also entering an AppSecret creates the connection and connects to Kakake.' },
  'open-platform.appIdPlaceholder': { zh: '开放平台机器人的 AppID', en: "Open Platform bot's AppID" },
  'open-platform.namePlaceholder': { zh: '留空则用机器人昵称', en: 'Leave blank to use the bot nickname' },
  'open-platform.secretPlaceholder': { zh: '填写后立即接入并拉取真实资料', en: 'Connects immediately and fetches real profile once filled' },
  'open-platform.useSandbox': { zh: '使用沙箱环境（正式环境需配置 IP 白名单）', en: 'Use sandbox environment (production requires an IP allowlist)' },
  'open-platform.connectBtn': { zh: '接入', en: 'Connect' },
  'open-platform.registerBtn': { zh: '登记', en: 'Register' },

  // ───────── 删除确认 ─────────
  'open-platform.confirmRemovePending': { zh: '移除该登记账号？', en: 'Remove this registered account?' },
  'open-platform.confirmDeleteBot': { zh: '删除机器人账号？', en: 'Delete this bot account?' },
  'open-platform.removePendingDesc': { zh: '将移除「{appId}」的登记记录，此操作不可恢复。', en: 'The registration record for "{appId}" will be removed. This cannot be undone.' },
  'open-platform.deleteBotDesc': { zh: '将删除「{name}」的连接配置，此操作不可恢复。', en: 'The connection config for "{name}" will be deleted. This cannot be undone.' },

  // ───────── 通道类型（CHANNEL_TYPE_TEXT，数字→key） ─────────
  'open-platform.chanText': { zh: '文字', en: 'Text' },
  'open-platform.chanVoice': { zh: '语音', en: 'Voice' },
  'open-platform.chanGroup': { zh: '分组', en: 'Group' },
  'open-platform.chanLive': { zh: '直播', en: 'Live' },
  'open-platform.chanApp': { zh: '应用', en: 'App' },
  'open-platform.chanForum': { zh: '论坛', en: 'Forum' },

  // ───────── Toast 文案 ─────────
  'open-platform.qrGenFailed': { zh: '生成二维码失败', en: 'Failed to generate QR code' },
  'open-platform.waitingScan': { zh: '等待扫码', en: 'Waiting for scan' },
  'open-platform.scanFailed': { zh: '扫码接入失败', en: 'Scan connection failed' },
  'open-platform.connectedN': { zh: '已接入 {n} 个机器人', en: 'Connected {n} bot(s)' },
  'open-platform.connectSuccess': { zh: '接入成功', en: 'Connected' },
  'open-platform.scanNoteMultiN': { zh: '本次扫码一次授权了 {n} 个机器人。', en: 'This scan authorized {n} bot(s) at once.' },
  'open-platform.fillAppId': { zh: '请填写 AppID', en: 'Please enter the AppID' },
  'open-platform.botConnected': { zh: '已接入机器人', en: 'Bot connected' },
  'open-platform.registeredPending': { zh: '已登记为未接入账号', en: 'Registered as unconnected account' },
  'open-platform.botDeleted': { zh: '已删除机器人', en: 'Bot deleted' },
  'open-platform.removedPending': { zh: '已移除登记', en: 'Registration removed' },
  'open-platform.enabledToast': { zh: '已启用', en: 'Enabled' },
  'open-platform.disabledToast': { zh: '已停用', en: 'Disabled' },
  'open-platform.profileRefreshed': { zh: '资料已刷新', en: 'Profile refreshed' },
  'open-platform.fetchFailed': { zh: '拉取失败', en: 'Fetch failed' },
  'open-platform.fetchChannelsFailed': { zh: '拉取子频道失败', en: 'Failed to fetch sub-channels' },

  // ───────── 补充：按钮 / 通用标签 / 占位 ─────────
  'open-platform.opFailed': { zh: '操作失败', en: 'Operation failed' },
  'open-platform.minutes': { zh: '分钟', en: 'minutes' },
  'open-platform.refreshBtn': { zh: '刷新', en: 'Refresh' },
  'open-platform.cancelBtn': { zh: '取消', en: 'Cancel' },
  'open-platform.loading': { zh: '加载中…', en: 'Loading…' },
  'open-platform.details': { zh: '详情', en: 'Details' },
  'open-platform.disableBtn': { zh: '停用', en: 'Disable' },
  'open-platform.enableBtn': { zh: '启用', en: 'Enable' },
  'open-platform.removeBtn': { zh: '移除', en: 'Remove' },
  'open-platform.deleteBtn': { zh: '删除', en: 'Delete' },
  'open-platform.nameLabel': { zh: '备注名称（可选）', en: 'Display name (optional)' },
  'open-platform.secretLabel': { zh: 'AppSecret（可选）', en: 'AppSecret (optional)' },

  // ───────── 交互配置（bot-interactive-config）─────────
  // 菜单类型
  'open-platform.interactive.menuSendMessage': { zh: '发送消息', en: 'Send message' },
  'open-platform.interactive.menuLink': { zh: '链接跳转', en: 'Open link' },
  'open-platform.interactive.menuSwitch': { zh: '开关', en: 'Switch' },
  'open-platform.interactive.menuSubmenu': { zh: '折叠子菜单', en: 'Collapsible submenu' },
  // 生效场景
  'open-platform.interactive.scopeC2c': { zh: '单聊', en: 'Direct message' },
  'open-platform.interactive.scopeGroup': { zh: '群聊', en: 'Group' },
  'open-platform.interactive.scopeChannel': { zh: '文字子频道', en: 'Text channel' },
  'open-platform.interactive.scopeDm': { zh: '频道私信', en: 'Channel DM' },
  // 面板元素类型
  'open-platform.interactive.itemCommand': { zh: '指令', en: 'Command' },
  // 字段标签 / 提示
  'open-platform.interactive.fSendContent': { zh: '发送内容', en: 'Message content' },
  'open-platform.interactive.hFillInput': { zh: '点击后填入聊天输入框', en: 'Filled into the chat input on click' },
  'open-platform.interactive.fLink': { zh: '跳转链接', en: 'Link' },
  'open-platform.interactive.hHttpsRequired': { zh: '必须以 https:// 开头', en: 'Must start with https://' },
  'open-platform.interactive.fSwitchId': { zh: '开关标识', en: 'Switch ID' },
  'open-platform.interactive.hExtCallback': { zh: '切换后在消息 ext 里回传', en: 'Returned in message ext after toggling' },
  'open-platform.interactive.fRemark': { zh: '备注', en: 'Remark' },
  'open-platform.interactive.hDevOnly': { zh: '仅开发者可见', en: 'Visible to developers only' },
  'open-platform.interactive.hDevOnlyOpt': { zh: '仅开发者可见，选填', en: 'Visible to developers only (optional)' },
  'open-platform.interactive.hOpenBrowser': { zh: '用户点击后在浏览器打开', en: 'Opens in the browser on click' },
  'open-platform.interactive.fGroupOpenid': { zh: '群 openid', en: 'Group openid' },
  'open-platform.interactive.fUserOpenid': { zh: '用户 openid', en: 'User openid' },
  'open-platform.interactive.hCommaSeparated': { zh: '逗号分隔，最多 20 个', en: 'Comma-separated, up to 20' },
  // 提示 / 错误（toast）
  'open-platform.interactive.errGetMenu': { zh: '查询自定义菜单失败', en: 'Failed to fetch the custom menu' },
  'open-platform.interactive.errMenuName': { zh: '每个菜单项都要填名称', en: 'Every menu item needs a name' },
  'open-platform.interactive.errSave': { zh: '保存失败', en: 'Save failed' },
  'open-platform.interactive.menuSaved': { zh: '自定义菜单已保存', en: 'Custom menu saved' },
  'open-platform.interactive.errGetPanel': { zh: '查询指令面板失败', en: 'Failed to fetch the command panel' },
  'open-platform.interactive.errPanelName': { zh: '每个面板元素都要填名称', en: 'Every panel element needs a name' },
  'open-platform.interactive.errAtLeastOne': { zh: '至少加一个面板元素', en: 'Add at least one panel element' },
  'open-platform.interactive.errCreate': { zh: '创建失败', en: 'Creation failed' },
  'open-platform.interactive.panelCreated': { zh: '指令面板已创建', en: 'Command panel created' },
  'open-platform.interactive.panelUpdated': { zh: '指令面板已更新', en: 'Command panel updated' },
  'open-platform.interactive.errDelete': { zh: '删除失败', en: 'Delete failed' },
  'open-platform.interactive.panelDeleted': { zh: '指令面板已删除', en: 'Command panel deleted' },
  // 文案 / 标签
  'open-platform.interactive.menuMax': { zh: '最多 {n} 项', en: 'Up to {n} items' },
  'open-platform.interactive.currentVersion': { zh: '当前版本 {version}', en: 'Current version {version}' },
  'open-platform.interactive.unsaved': { zh: '有未保存的修改', en: 'Unsaved changes' },
  'open-platform.interactive.save': { zh: '保存', en: 'Save' },
  'open-platform.interactive.addMenuItem': { zh: '添加菜单项', en: 'Add menu item' },
  'open-platform.interactive.noMenu': { zh: '还没有配置菜单', en: 'No menu configured yet' },
  'open-platform.interactive.submenuLabel': { zh: '子菜单', en: 'Submenu' },
  'open-platform.interactive.submenuMax': { zh: '最多 {n} 个，不可再嵌套', en: 'Up to {n}, no further nesting' },
  'open-platform.interactive.subItem': { zh: '子项', en: 'Sub-item' },
  'open-platform.interactive.noSubItems': { zh: '还没有子项', en: 'No sub-items yet' },
  'open-platform.interactive.itemsCount': { zh: '{count} 项', en: '{count} items' },
  'open-platform.interactive.specific': { zh: '指定对象', en: 'Specific targets' },
  'open-platform.interactive.global': { zh: '全局', en: 'Global' },
  'open-platform.interactive.effectiveScope': { zh: '生效场景', en: 'Effective scope' },
  'open-platform.interactive.noPanelInScope': { zh: '该场景下还没有指令面板', en: 'No command panel in this scope yet' },
  'open-platform.interactive.newPanel': { zh: '新建面板', en: 'New panel' },
  'open-platform.interactive.scope': { zh: '作用范围', en: 'Scope' },
  'open-platform.interactive.onlyGlobalNote': { zh: '子频道 / 私信场景仅支持全局', en: 'Sub-channel / DM scopes support global only' },
  'open-platform.interactive.element': { zh: '元素', en: 'Element' },
  'open-platform.interactive.create': { zh: '创建', en: 'Create' },
  'open-platform.interactive.adminOnly': { zh: '仅管理员可点', en: 'Admins only' },
  'open-platform.interactive.defaultOn': { zh: '默认打开', en: 'On by default' },
  // 入口 / 弹窗
  'open-platform.interactive.menuTitle': { zh: '自定义菜单', en: 'Custom menu' },
  'open-platform.interactive.menuDesc': { zh: '单聊窗口底部按钮', en: 'Button at the bottom of the DM window' },
  'open-platform.interactive.panelTitle': { zh: '指令面板', en: 'Command panel' },
  'open-platform.interactive.panelDesc': { zh: '单聊 / 群聊 / 频道指令', en: 'DM / group / channel commands' },
  'open-platform.interactive.menuDialogDesc': { zh: '展示在机器人单聊窗口底部，设置后对所有用户生效', en: 'Shown at the bottom of the bot DM window; applies to all users once set' },
  'open-platform.interactive.panelDialogDesc': { zh: '按场景分别配置，用户可在输入框旁唤起面板查看指令', en: 'Configured per scope; users can summon the panel beside the input box to view commands' },
  // 占位符
  'open-platform.interactive.phButtonName': { zh: '按钮名称', en: 'Button name' },
  'open-platform.interactive.phSubItemName': { zh: '子项名称', en: 'Sub-item name' },
  'open-platform.interactive.phSendContent': { zh: '发送内容', en: 'Message content' },
  'open-platform.interactive.phPanelUsage': { zh: '面板用途', en: 'Panel purpose' },
  'open-platform.interactive.phDescOptional': { zh: '描述（选填）', en: 'Description (optional)' },
  'open-platform.interactive.phElementName': { zh: '元素名称', en: 'Element name' },
} as const;

registerMessages(openPlatformMessages);
