import { registerMessages } from '@/lib/i18n';

/**
 * 共享 UI 组件文案：对话框、空状态、toast、确认提示、通用页头、工具提示，
 * 以及控制台外壳（侧边栏 / 顶栏）。导航标签一律复用 common.nav.*，不要在这里重定义。
 */
registerMessages({
  // ───────── 控制台外壳 / 侧边栏 / 顶栏 ─────────
  'components.githubRepo': { zh: 'GitHub 仓库', en: 'GitHub Repository' },
  'components.logout': { zh: '退出登录', en: 'Log out' },
  // 侧栏压到两字短名模式（< 140px）时的退出登录：中文取前两字，英文换更短的 Exit
  'components.logoutShort': { zh: '退出', en: 'Exit' },
  'components.sidebarCollapse': { zh: '收起侧边栏', en: 'Collapse sidebar' },
  'components.sidebarExpand': { zh: '展开侧边栏', en: 'Expand sidebar' },

  // ───────── 下拉组合框（combobox） ─────────
  'components.comboboxExpand': { zh: '展开模型列表', en: 'Expand model list' },
  'components.comboboxEmpty': { zh: '无可选项，可直接输入', en: 'No options; type to add' },

  // ───────── Markdown 渲染器 ─────────
  'components.codeCopied': { zh: '已复制代码', en: 'Code copied' },
  'components.copyFailed': { zh: '复制失败', en: 'Copy failed' },
  'components.code': { zh: '代码', en: 'Code' },

  // ───────── 页面级错误边界 ─────────
  'components.errorChunk': { zh: '界面资源已更新，需要重新加载', en: 'The interface resources have been updated; a reload is required' },
  'components.errorGeneric': { zh: '这个界面加载失败了', en: 'This page failed to load' },
  'components.errorChunkDesc': { zh: '咔咔珂刚更新过，你看到的还是上一版页面。重新加载后即可正常切换。', en: 'Kakake has just been updated; you are still viewing the previous version. Reload to switch to the new one.' },
  'components.errorGenericDesc': { zh: '已拦下这次异常，界面不会白屏。可以先重试，不行再整页刷新。', en: 'The error was caught so the screen will not go blank. You can retry first, or reload the whole page if that does not work.' },
  'components.reload': { zh: '重新加载', en: 'Reload' },
  'components.errorDetail': { zh: '错误详情（请复制后发给我）', en: 'Error details (please copy and send to me)' },

  // ───────── 公告更新弹窗 ─────────
  'components.announceUnderstood': { zh: '已了解公告更新', en: 'Announcement update acknowledged' },
  'components.announcementUpdated': { zh: '公告已更新', en: 'Announcement updated' },
  'components.announcementDesc': { zh: '用户协议与公告有新版本，请阅读以下内容后关闭。', en: 'The user agreement and announcement have a new version. Please read the following and close.' },
  'components.announcementLoading': { zh: '正在加载公告…', en: 'Loading announcement…' },
  'components.iUnderstand': { zh: '我知道了', en: 'I understand' },

  // ───────── 插件说明弹窗 ─────────
  'components.cannotLoadDocs': { zh: '无法加载说明文档', en: 'Unable to load documentation' },
  'components.pluginDocs': { zh: '插件说明', en: 'Plugin documentation' },

  // ───────── 连接插件弹窗（标题前缀） ─────────
  'components.connPluginsGf': { zh: 'GF 插件', en: 'GF Plugins' },
  'components.connPluginsWeixin': { zh: '微信插件', en: 'WeChat Plugins' },
  'components.connPluginsKook': { zh: 'KOOK 插件', en: 'KOOK Plugins' },
  'components.connPluginsDefault': { zh: '插件', en: 'Plugins' },

  // ───────── 正向重连弹窗 ─────────
  'components.reconnectSaved': { zh: '重连设置已保存', en: 'Reconnect settings saved' },
  'components.reconnectDesc': { zh: '意外断开时自动重连；关闭连接开关或手动停止后不再重连。', en: 'Automatically reconnect when disconnected unexpectedly; stops after the connection is turned off or manually stopped.' },
  'components.reconnectAbandoned': { zh: '已达最大重连次数，自动重连已停止。调整设置后保存可重新开始。', en: 'Maximum reconnect attempts reached; automatic reconnection has stopped. Adjust the settings and save to restart.' },
  'components.reconnecting': { zh: '正在重连…', en: 'Reconnecting…' },
  'components.notConnected': { zh: '未连接', en: 'Not connected' },
  'components.reconnectIntervalLabel': { zh: '重连间隔（毫秒）', en: 'Reconnect interval (ms)' },
  'components.reconnectMin': { zh: '最小 500ms', en: 'Min 500ms' },
  'components.reconnectMaxLabel': { zh: '最大重试次数', en: 'Max retry attempts' },
  'components.reconnectInfinite': { zh: '0 表示无限重试', en: '0 means infinite retries' },

  // ───────── 微信扫码登录弹窗 ─────────
  'components.gettingQr': { zh: '正在获取二维码…', en: 'Getting QR code…' },
  'components.getQrFailed': { zh: '获取二维码失败', en: 'Failed to get QR code' },
  'components.qrImageFailed': { zh: '二维码图片生成失败，请用下方链接', en: 'Failed to generate QR image; please use the link below' },
  'components.scanWithWeixin': { zh: '请使用微信扫码，并在手机上确认', en: 'Please scan with WeChat and confirm on your phone' },
  'components.qrScanned': { zh: '已扫码，请在手机上确认…', en: 'Scanned, please confirm on your phone…' },
  'components.qrExpired': { zh: '二维码已过期，正在刷新…', en: 'QR code expired, refreshing…' },
  'components.loginSuccess': { zh: '登录成功', en: 'Login successful' },
  'components.weixinLoginTitle': { zh: '微信 AI×BOT 扫码登录', en: 'WeChat AI×BOT Scan to Log In' },
  'components.weixinLoginDesc': { zh: '使用微信扫描下方二维码完成 iLink 登录', en: 'Use WeChat to scan the QR code below to complete iLink login' },
  'components.weixinQrAlt': { zh: '微信登录二维码', en: 'WeChat login QR code' },
  'components.weixinFallbackLink': { zh: '备用：浏览器打开登录链接', en: 'Fallback: open login link in browser' },
  'components.refreshQr': { zh: '刷新二维码', en: 'Refresh QR code' },

  // ───────── 下载 / 更新进度 toast ─────────
  'components.downloading': { zh: '下载中', en: 'Downloading' },
  'components.download': { zh: '下载', en: 'Download' },
  'components.downloadDone': { zh: '下载完成', en: 'Download complete' },
  'components.downloadFailed': { zh: '下载失败', en: 'Download failed' },
  'components.installing': { zh: '安装中', en: 'Installing' },
  'components.downloadedPrefix': { zh: '已下载', en: 'Downloaded' },
  'components.cancelDownload': { zh: '取消下载', en: 'Cancel download' },
  'components.downloadStatusTimeout': { zh: '下载状态查询超时', en: 'Lost track of the download status' },

  // ───────── 资源分页条 ─────────
  'components.pagination': { zh: '分页', en: 'Pagination' },
  'components.prevPage': { zh: '上一页', en: 'Previous page' },
  'components.nextPage': { zh: '下一页', en: 'Next page' },
  'components.jumpToPage': { zh: '跳转到页码', en: 'Jump to page' },

  // ───────── 全局兜底界面 ─────────
  'components.enteringConsole': { zh: '正在进入控制台…', en: 'Entering the console…' },
  'components.pageLoading': { zh: '页面加载中', en: 'Page loading' },
  'components.usage': { zh: '占用', en: 'Usage' },

  // ───────── 会话输入框（prompt-bar） ─────────
  'pb.menuAttach': { zh: '附件来源', en: 'Attachment sources' },
  'pb.menuSlash': { zh: '指令', en: 'Commands' },
  'pb.menuModel': { zh: '模型服务', en: 'Model provider' },
  'pb.menuCommands': { zh: '指令面板', en: 'Command palette' },
  'pb.effort': { zh: '强度', en: 'Effort' },
  'pb.effortHint': { zh: '强度越高，回答前思考得越久', en: 'Higher effort thinks longer before answering' },
  'pb.deleteSkillNamed': { zh: '删除 {name}', en: 'Delete {name}' },
  'pb.delete': { zh: '删除', en: 'Delete' },
  'pb.removeNamed': { zh: '移除 {name}', en: 'Remove {name}' },
  'pb.unloadNamed': { zh: '卸载 {name}', en: 'Unload {name}' },
  'pb.unloadHint': { zh: '卸载（停止注入）', en: 'Unload (stop injecting)' },
  'pb.inputLabel': { zh: '输入内容', en: 'Message input' },
  'pb.selectModel': { zh: '选择模型服务', en: 'Select model provider' },
  'pb.selectEffort': { zh: '选择思考强度', en: 'Select thinking effort' },
  'pb.stop': { zh: '停止', en: 'Stop' },
  'pb.send': { zh: '发送', en: 'Send' },
});
