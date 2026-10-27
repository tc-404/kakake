import { registerMessages } from '@/lib/i18n';

/**
 * 更新中心（版本号徽标 + 点击呼出的悬浮窗）文案。
 *
 * 这一块最早是纯中文硬编码，切英文后整个弹窗仍是中文，
 * 因此把弹窗里的标签、状态、按钮、进度提示全部抽到这里双语化。
 *
 * 通用按钮（关闭/取消）复用 common.ts 的 key，不在此重复定义。
 */
registerMessages({
  // ───────── 徽标 / 关闭 ─────────
  'uc.checkUpdate': { zh: '检查更新', en: 'Check for updates' },
  'uc.title': { zh: '更新中心', en: 'Update center' },
  'uc.lastCheckedNever': { zh: '尚未检查', en: 'Not checked yet' },
  'uc.lastCheckedJustNow': { zh: '上次检查：刚刚', en: 'Last checked: just now' },
  'uc.lastCheckedMinutes': { zh: '上次检查：{n} 分钟前', en: 'Last checked: {n} min ago' },
  'uc.lastCheckedHours': { zh: '上次检查：{n} 小时前', en: 'Last checked: {n} h ago' },
  'uc.lastCheckedAt': { zh: '上次检查：{time}', en: 'Last checked: {time}' },

  // ───────── 顶部状态 ─────────
  'uc.statusChecking': { zh: '正在检测…', en: 'Checking…' },
  'uc.statusFoundNew': { zh: '发现新版本', en: 'Update available' },
  'uc.statusLatest': { zh: '已是最新版本', en: 'Up to date' },
  'uc.statusUnreachable': { zh: '镜像暂时无法连接', en: 'Mirror unreachable' },
  'uc.statusIdle': { zh: '未检测', en: 'Not checked' },
  'uc.statusFoundPre': { zh: '发现预发布版本', en: 'Pre-release available' },
  'uc.statusLatestStable': { zh: '正式版已是最新', en: 'Stable channel is up to date' },

  // ───────── 发布通道标签 ─────────
  // 产品约定：正式版统一打 LTS 标；BETA / RC / ALPHA 为非正式发布。
  // 标签本身用拉丁字母（跨语言通用），这里只提供悬浮说明与中文全称。
  'uc.channelStable': { zh: '正式版（稳定版）', en: 'Stable release' },
  'uc.channelBeta': { zh: '公测版', en: 'Beta' },
  'uc.channelRc': { zh: '候选发布版', en: 'Release candidate' },
  'uc.channelAlpha': { zh: '内测版', en: 'Alpha' },
  'uc.channelUnknown': { zh: '未识别的预发布通道', en: 'Unrecognized pre-release channel' },
  'uc.currentBadge': { zh: '当前', en: 'Current' },
  'uc.prereleaseAvailable': { zh: '预发布版本 v{v} 可用', en: 'Pre-release v{v} is available' },
  'uc.prereleaseHint': { zh: '不影响正式版更新，可手动选择', en: 'Does not affect stable updates — select manually' },
  'uc.prereleaseSelect': { zh: '选用', en: 'Select' },
  'uc.prereleaseSelected': {
    zh: '当前选择的是预发布版本（{channel}），可能不稳定，请谨慎安装。',
    en: 'You selected a pre-release ({channel}) — it may be unstable.',
  },

  // ───────── 两个选择器 ─────────
  'uc.mirrorLabel': { zh: '镜像源', en: 'Mirror' },
  'uc.installVersion': { zh: '安装版本', en: 'Install version' },
  'uc.chooseVersion': { zh: '选择其他版本', en: 'Choose another version' },
  'uc.restoreRecommended': { zh: '恢复推荐版本', en: 'Restore recommended' },
  'uc.customVersion': { zh: '自选', en: 'Custom' },
  'uc.downgrade': { zh: '降级', en: 'Downgrade' },
  'uc.reinstall': { zh: '重新安装当前版本', en: 'Reinstall current version' },
  'uc.installDowngrade': { zh: '降级安装', en: 'Downgrade to this version' },
  'uc.advanced': { zh: '高级 · 镜像源 / 测速', en: 'Advanced · mirror / speed test' },
  'uc.noMirror': { zh: '（无可用镜像）', en: '(No mirror available)' },
  'uc.currentMark': { zh: '· 当前', en: '· Current' },
  'uc.noVersionData': { zh: '暂无版本数据', en: 'No version data' },
  'uc.noVersionHint': { zh: '尚未获取版本，请先「检查更新」', en: 'No versions fetched yet — check for updates first' },

  // ───────── 测速结果 ─────────
  'uc.latencyUntested': { zh: '未测', en: 'Untested' },
  'uc.latencyOk': { zh: '正常', en: 'OK' },
  'uc.latencyTimeout': { zh: '超时', en: 'Timeout' },
  'uc.latencyFailed': { zh: '失败', en: 'Failed' },
  'uc.pingAllDone': { zh: '测速完成', en: 'Speed test done' },
  'uc.pingAllDown': { zh: '所有镜像均无法连接', en: 'All mirrors are unreachable' },
  'uc.available': { zh: '可用 · {ms}ms', en: 'Available · {ms}ms' },
  'uc.unavailable': { zh: '不可用 · {err}', en: 'Unavailable · {err}' },
  'uc.connectFailed': { zh: '连接失败', en: 'Connection failed' },
  'uc.cancelled': { zh: '已取消', en: 'Cancelled' },

  // ───────── 底部操作 ─────────
  'uc.pingAll': { zh: '一键 Ping', en: 'Ping all' },
  'uc.testSelected': { zh: '测试所选', en: 'Test selected' },
  'uc.viewRelease': { zh: '查看发布说明', en: 'View release notes' },
  'uc.installThis': { zh: '安装此版本', en: 'Install this version' },
  'uc.installUpdate': { zh: '安装更新', en: 'Install update' },
  'uc.installTitleHint': { zh: '下载并暂存该版本，完成后按提示重启应用', en: 'Download and stage this version; restart from the prompt when ready' },
  'uc.onlineUnsupported': { zh: '当前环境不支持在线更新', en: 'Online update is not supported in this environment' },

  // ───────── 安装进度 / 结果 ─────────
  'uc.processing': { zh: '处理中…', en: 'Processing…' },
  'uc.cancelDownload': { zh: '取消下载', en: 'Cancel download' },
  'uc.installFailed': { zh: '安装失败', en: 'Install failed' },
  'uc.stagedReady': { zh: '新版本 v{v} 已下载就绪，点下方「查看重启提示」继续。', en: 'New version v{v} is downloaded and ready — use "View restart prompt" below.' },
  'uc.viewStagedPrompt': { zh: '查看重启提示', en: 'View restart prompt' },

  // ───────── 安装前风险提示弹窗 ─────────
  'uc.readCarefully': { zh: '请仔细阅读', en: 'Please read' },
  'uc.riskTitle': { zh: '安装前风险提示', en: 'Before you install' },
  'uc.riskIntroPrefix': { zh: '即将下载并安装', en: 'About to download and install' },
  'uc.riskIntroSuffix': { zh: '，请知悉：', en: '. Please note:' },
  'uc.minutes': { zh: '分钟', en: 'minutes' },
  'uc.riskItem1': { zh: '安装会替换程序文件；点击「重启」后将中断服务并重新启动，期间控制台会短暂离线。', en: 'Installing replaces program files. Clicking "Restart" stops the service and starts it again — the console will be offline briefly.' },
  'uc.riskItem2Prefix': { zh: '源码版重启需重新构建，配置较低的设备可能需要 ', en: 'Source builds are rebuilt on restart; low-end devices may need ' },
  'uc.riskItem2Suffix': { zh: '，请耐心等待，其间勿断电或关闭窗口。', en: ' — please be patient, and do not power off or close the window.' },
  'uc.riskItem3': { zh: 'data / 日志 / 插件 等数据目录会被保留；新版已移除的多余文件会被清理，建议提前备份重要数据。', en: 'Data directories (data / logs / plugins) are kept; files dropped in the new version are cleaned up. Back up important data beforehand.' },
  'uc.riskItem4': { zh: '若当前启动方式不支持自动重启，需下载完成后手动重启才会生效。', en: 'If the current launch mode has no auto-restart, you must restart manually after the download for it to take effect.' },
  'uc.riskPrerelease': { zh: '这是预发布版本（非正式版），可能不稳定，请勿在生产环境使用。', en: 'This is a pre-release (not a stable release) and may be unstable — do not use it in production.' },
  'uc.iKnowStart': { zh: '我已知悉，开始安装', en: 'I understand, install now' },
  'uc.pleaseRead': { zh: '请阅读须知…', en: 'Please read the notes…' },
  'uc.startDownload': { zh: '开始下载 v{v}', en: 'Start downloading v{v}' },
  'uc.cannotStartInstall': { zh: '无法开始安装', en: 'Unable to start installation' },

  // ───────── 已下载就绪弹窗 ─────────
  'uc.stagedTitle': { zh: '新版本 v{v} 已下载就绪', en: 'New version v{v} is ready' },
  'uc.stagedBody': { zh: '点击「重启」应用更新。重启期间控制台会短暂离线，配置较低的设备可能需要 2–5 分钟，完成后本页将自动刷新，请勿关闭。', en: 'Click "Restart" to apply. The console goes offline briefly; low-end devices may take 2–5 minutes. This page refreshes automatically when done — do not close it.' },
  'uc.restartUnsupportedShort': { zh: '当前启动方式不支持自动重启', en: 'Auto-restart is unsupported by the current launch mode' },
  'uc.restartManual': { zh: '当前启动方式不支持自动重启，请手动重启进程后新版本生效。', en: 'Auto-restart is unsupported by the current launch mode — restart the process manually for the new version to take effect.' },
  'uc.restartRequestFailed': { zh: '重启请求失败', en: 'Restart request failed' },
  'uc.applyingUpdate': { zh: '正在应用更新并重启…', en: 'Applying update and restarting…' },
  'uc.restarting': { zh: '正在重启…', en: 'Restarting…' },
  'uc.undoInstall': { zh: '撤销安装', en: 'Undo install' },
  'uc.iSee': { zh: '我知道了', en: 'Got it' },

  // ───────── 重启等待遮罩 ─────────
  'uc.restartingTitle': { zh: '正在重启并应用更新…', en: 'Restarting and applying the update…' },
  'uc.restartingBodyPrefix': { zh: '控制台已断开连接。配置较低的设备重建可能需要 ', en: 'Console disconnected. Rebuilds on low-end devices may take ' },
  'uc.restartingBodySuffix': { zh: '，请保持本页开启——服务恢复后将自动刷新并重新登录。', en: ' — keep this page open; it will refresh and sign you back in once the service is up.' },
});
