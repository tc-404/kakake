import { registerMessages } from '@/lib/i18n';

/**
 * 设置页文案。导航/通用按钮/通用标签见 common.ts，复用其 key，不要在此重复定义。
 * zh 必须等于原始中文（保证中文显示不变），en 为译文。
 */
registerMessages({
  // ───────── 语言切换 ─────────
  'settings.language': { zh: '语言', en: 'Language' },
  // 语言存盘失败：写的是实例级设置，没写成就回滚，不能留个「只有自己变了」的假象
  'settings.languageSaveFailed': {
    zh: '语言没能保存到服务端，已还原为原来的语言',
    en: 'Could not save the language to the server; reverted to the previous one',
  },

  // ───────── 监听地址 / 运行参数 ─────────
  'settings.listenAddress': { zh: '监听地址', en: 'Listen Address' },
  'settings.backendPort': { zh: '后台端口', en: 'Backend Port' },
  // 端口拦截：不合法就整份配置都不保存（服务端沿用原端口）
  'settings.portPrivilegedBlocked': { zh: '1–1023 为系统特权端口，不允许使用', en: 'Ports 1–1023 are system privileged ports and cannot be used' },
  'settings.portWeakBlocked': { zh: '该端口过于常见，容易被扫描或猜出，请换一个', en: 'This port is too common and easy to scan or guess — pick another one' },
  'settings.runtimeParams': { zh: '运行参数', en: 'Runtime Parameters' },
  'settings.logLevel': { zh: '日志级别', en: 'Log Level' },
  'settings.apiTimeout': { zh: 'API 超时', en: 'API Timeout' },
  'settings.aiMaxSteps': { zh: 'AI 最大步数', en: 'AI Max Steps' },
  'settings.aiStepsHint': { zh: '单次任务最多执行 10–200 步（缺省 60）', en: 'A single task runs at most 10-200 steps (default 60)' },

  // ───────── 登录防护 ─────────
  // 登录失败限速状态：分布式撞库会触发全局冷却，这里给管理员一个看得见的自救入口
  'settings.loginGuard': { zh: '登录防护', en: 'Login Guard' },
  'settings.loginGuardNormal': { zh: '正常', en: 'Normal' },
  'settings.loginGuardPressure': { zh: '高压模式：检测到短时大量失败登录', en: 'High pressure: a burst of failed logins detected' },
  'settings.loginGuardLocked': { zh: '全局冷却中：正在拒绝未验证来源', en: 'Global cooldown: unverified sources are being rejected' },
  'settings.loginGuardFails': { zh: '窗口内失败', en: 'Failed attempts' },
  'settings.loginGuardSources': { zh: '不同来源', en: 'Distinct sources' },
  'settings.loginGuardTrusted': { zh: '可信来源', en: 'Trusted sources' },
  'settings.loginGuardDesc': {
    zh: '失败登录按来源、网段、密钥指纹与全局四个维度计数；换 IP 撞库也会被全局层拦下。曾成功登录的来源不受全局冷却影响。',
    en: 'Failed logins are counted across source, subnet, key fingerprint and global buckets — rotating IPs will still hit the global layer. Sources that have signed in successfully are exempt from the global cooldown.',
  },
  'settings.loginGuardClear': { zh: '解除限制', en: 'Clear restrictions' },
  'settings.loginGuardCleared': { zh: '已解除登录限制', en: 'Login restrictions cleared' },
  'settings.loginGuardClearFailed': { zh: '解除登录限制失败', en: 'Failed to clear login restrictions' },
  'settings.loginGuardLoadFailed': { zh: '登录防护状态读取失败', en: 'Failed to load login guard status' },

  // ───────── 日志级别选项 ─────────
  'settings.logLevelDebug': { zh: 'Debug · 调试', en: 'Debug' },
  'settings.logLevelInfo': { zh: 'Info · 信息', en: 'Info' },
  'settings.logLevelWarn': { zh: 'Warn · 警告', en: 'Warn' },
  'settings.logLevelError': { zh: 'Error · 错误', en: 'Error' },

  // ───────── 自定义标题 ─────────
  'settings.customTitle': { zh: '自定义标题', en: 'Custom Title' },
  'settings.customTitleName': { zh: '自定义标题名字', en: 'Custom Title Name' },

  // ───────── 外放 API ─────────
  'settings.publicApi': { zh: '外放 API', en: 'Public API' },
  'settings.proxyApi': { zh: '接口代理外放 API', en: 'Proxy API' },
  'settings.inboundGuard': { zh: '入站防护', en: 'Inbound Guard' },

  // ───────── 日志写进文件 ─────────
  'settings.logToFile': { zh: '日志写进文件', en: 'Write Logs to File' },

  // ───────── 外观 / 配色 / 性能 / 背景 ─────────
  'settings.appearance': { zh: '界面外观', en: 'Interface Appearance' },
  'settings.colorScheme': { zh: '配色方案', en: 'Color Scheme' },
  'settings.performanceMode': { zh: '性能模式', en: 'Performance Mode' },
  'settings.performanceModeDesc': { zh: '低端设备自动降级实时模糊与氛围动画；也可手动强制开启或关闭', en: 'Low-end devices auto-downgrade real-time blur and ambient animations; can also be manually forced on or off' },
  'settings.backgroundPreset': { zh: '背景预设', en: 'Background Preset' },
  'settings.backgroundPresetDesc': { zh: '没设置自定义背景时，用它替换整片氛围底；波浪只在完整特效下绘制', en: 'When no custom background is set, use this to replace the ambient backdrop; the wave is only drawn at the full-effects tier' },

  // ───────── 资源官网 / 资源来源 ─────────
  'settings.resourceWebsite': { zh: '资源官网', en: 'Resource Website' },
  'settings.storeOrigin': { zh: '资源来源', en: 'Resource Source' },
  // 来源切换按钮上的两个选项（切英文时按钮文案要跟着变）
  'settings.originKakake': { zh: '咔咔珂源', en: 'Kakake Source' },
  'settings.originGithub': { zh: 'GitHub 源', en: 'GitHub Source' },

  // ───────── GitHub API Token ─────────
  'settings.githubTokenPlaceholder': { zh: 'ghp_… 或 github_pat_…（留空 = 匿名）', en: 'ghp_… or github_pat_… (leave blank = anonymous)' },
  'settings.hideToken': { zh: '隐藏 Token', en: 'Hide Token' },
  'settings.showToken': { zh: '显示 Token', en: 'Show Token' },
  'settings.ghTokenNewPrefix': { zh: '去', en: 'Go to' },
  'settings.ghTokenNewSuffix': { zh: '新建 Token（需 public_repo / Read-only 权限）', en: 'to create a Token (requires public_repo / Read-only permission)' },
  'settings.ghQuotaPrefix': { zh: '当前额度：剩余', en: 'Current quota: remaining' },
  'settings.ghQuotaSuffix': { zh: '次/时', en: 'requests/hour' },

  // ───────── 图片引擎环境（sharp） ─────────
  'settings.sharpEnv': { zh: '图片引擎环境', en: 'Image Engine Environment' },
  'settings.detectingEnv': { zh: '正在检测运行环境…', en: 'Detecting runtime environment…' },
  'settings.ready': { zh: '已就绪', en: 'Ready' },
  'settings.depsIncomplete': { zh: '依赖不完整', en: 'Dependencies incomplete' },
  'settings.notInstalled': { zh: '尚未安装', en: 'Not installed' },
  'settings.installing': { zh: '安装中', en: 'Installing' },
  'settings.reinstall': { zh: '重新安装', en: 'Reinstall' },
  'settings.install': { zh: '一键安装', en: 'One-click Install' },
  'settings.copyCommand': { zh: '复制命令', en: 'Copy Command' },
  'settings.redetect': { zh: '重新检测', en: 'Re-detect' },

  // ───────── 新手引导 ─────────
  'settings.tour': { zh: '新手引导', en: 'Getting Started Guide' },
  'settings.tourDesc': { zh: '再看一遍控制台的功能导览，逐步高亮每个入口与用法', en: 'Review the console feature tour again, highlighting each entry and usage step by step' },
  'settings.viewTour': { zh: '重新查看产品导览', en: 'View Product Tour Again' },

  // ───────── 动态提示 / 操作反馈 ─────────
  'settings.switchedTo': { zh: '已切换到{name}', en: 'Switched to {name}' },
  'settings.ghTokenCleared': { zh: '已清空 GitHub Token，改回匿名访问', en: 'GitHub Token cleared, switched back to anonymous access' },
  'settings.tokenSavedVerified': { zh: 'Token 已保存，校验通过', en: 'Token saved and verified' },
  'settings.tokenVerifyFailed': { zh: 'Token 校验未通过，已保存但可能无效', en: 'Token verification failed; saved but may be invalid' },
  'settings.sharpInstallDone': { zh: '图片引擎依赖安装完成，无需重启即可使用', en: 'Image engine dependencies installed; ready to use without restart' },
  'settings.installFailed': { zh: '安装失败', en: 'Installation failed' },
  'settings.installStarted': { zh: '已开始安装，可在下方查看 npm 日志', en: 'Installation started; view npm logs below' },
  'settings.cannotStartInstall': { zh: '无法开始安装', en: 'Unable to start installation' },
  'settings.switchSourceFailed': { zh: '切换资源来源失败', en: 'Failed to switch resource source' },
  'settings.autoSaveFailed': { zh: '设置自动保存失败', en: 'Settings auto-save failed' },
  'settings.bgUploadFailed': { zh: '背景图上传失败', en: 'Background image upload failed' },
  'settings.bgFitSaveFailed': { zh: '背景适配方式保存失败', en: 'Background fit save failed' },
  'settings.bgPresetSaveFailed': { zh: '背景预设保存失败', en: 'Background preset save failed' },
  'settings.bgRemoveFailed': { zh: '背景图移除失败', en: 'Background image removal failed' },
  'settings.appearanceAutoSaveFailed': { zh: '外观自动保存失败', en: 'Appearance auto-save failed' },
  'settings.titleAutoSaveFailed': { zh: '标题自动保存失败', en: 'Title auto-save failed' },
  'settings.commandCopied': { zh: '命令已复制', en: 'Command copied' },
  'settings.saveFailed': { zh: '保存失败', en: 'Save failed' },

  // ───────── 表单校验错误 ─────────
  'settings.enterValidNumber': { zh: '请输入有效数字', en: 'Please enter a valid number' },
  'settings.portRangeError': { zh: '端口须在 1–65535 之间', en: 'Port must be between 1 and 65535' },
  'settings.timeoutRangeError': { zh: '超时时间需在 5–600 秒范围内', en: 'Timeout must be between 5 and 600 seconds' },
  'settings.aiStepsRangeError': { zh: 'AI 最大步数需在 10–200 之间', en: 'AI max steps must be between 10 and 200' },

  // ───────── 外观：滑动条分组标签 ─────────
  'settings.fxSpeed': { zh: '动效速度', en: 'Animation Speed' },
  'settings.cardOpacityLabel': { zh: '卡片透明度', en: 'Card Opacity' },
  'settings.cardBlurLabel': { zh: '卡片模糊度', en: 'Card Blur' },
  'settings.card2OpacityLabel': { zh: '悬浮层透明度', en: 'Overlay Opacity' },
  'settings.card2BlurLabel': { zh: '悬浮层模糊度', en: 'Overlay Blur' },
  'settings.cardShadowLabel': { zh: '阴影透明度', en: 'Shadow Opacity' },
  'settings.bgBlurLabel': { zh: '背景模糊度', en: 'Background Blur' },
  // 电脑侧栏宽度：最低 50px；< 140px 改两字短名，< 105px 只留文字，< 80px 只留图标
  'settings.sidebarWidthPc': { zh: '侧边栏宽度 · 电脑', en: 'Sidebar Width · PC' },
  // 手机侧栏宽度：下限 20%；25–39% 只留文字（收图标），低于 25% 只留图标
  'settings.sidebarWidthMobile': { zh: '侧边栏宽度 · 手机', en: 'Sidebar Width · Mobile' },

  // ───────── 外观：数值单位 ─────────
  'settings.valTimes': { zh: '{n} 倍', en: '{n}×' },
  'settings.valPercent': { zh: '{n} 百分比', en: '{n}%' },
  'settings.valPixel': { zh: '{n} 像素', en: '{n}px' },

  // ───────── 外观：背景适配 ─────────
  'settings.bgFit': { zh: '背景适配', en: 'Background Fit' },
  'settings.bgFitCover': { zh: '铺满裁切', en: 'Cover · Crop' },
  'settings.bgFitCoverHint': { zh: '填满屏幕，多出的部分裁掉，不变形（默认）', en: 'Fill the screen; overflow is cropped, never distorted (default)' },
  'settings.bgFitStretch': { zh: '拉伸铺满', en: 'Stretch · Fill' },
  'settings.bgFitStretchHint': { zh: '强制拉满整屏，比例不符时会变形', en: 'Force to fill the whole screen; distorts when aspect ratios differ' },
  'settings.bgFitContain': { zh: '完整显示', en: 'Contain · Whole' },
  'settings.bgFitContainHint': { zh: '整张图都可见，四周用同一张图的模糊副本垫底', en: 'Whole image visible; blurred copy of the same image pads the edges' },

  // ───────── 配色：角色与提示 ─────────
  'settings.colorRoleInk': { zh: '全局字体', en: 'Global Font' },
  'settings.colorRoleComp': { zh: '组件及按钮', en: 'Components & Buttons' },
  'settings.colorRoleLogo': { zh: '品牌 Logo', en: 'Brand Logo' },
  'settings.colorHintInk': { zh: '正文、标题、图标与边框的主色；选渐变色时整条文字色阶跟着渐变走', en: 'Main color for text, icons and borders; a gradient shifts the whole text ramp' },
  'settings.colorHintComp': { zh: '按钮、开关、高亮、滑块、气泡等组件色；渐变色会铺满按钮与液态指示条', en: 'Buttons, switches, highlights, sliders and bubbles; a gradient fills buttons and the liquid indicator' },
  'settings.colorHintLogo': { zh: '品牌标识 + 侧栏图标 + 统计卡等第二强调色', en: 'Brand mark, sidebar icons and secondary accents such as stat cards' },
  'settings.adjustColor': { zh: '调整{role}颜色', en: 'Edit {role} color' },
  'settings.colorInvalid': { zh: '无法识别的颜色代码', en: 'Unrecognized color code' },

  // ───────── 页面水印 ─────────
  'settings.watermark': { zh: '页面水印', en: 'Page Watermark' },
  'settings.watermarkDesc': { zh: '开启后平铺在 8787 端口下的全部界面（含各种子路径）最上层，始终显示在弹窗之上', en: 'When enabled, tiles above every screen served on port 8787 (including all sub-paths), always on top of dialogs' },
  'settings.watermarkEnable': { zh: '启用页面水印', en: 'Enable Page Watermark' },
  'settings.watermarkEnableHint': { zh: '关闭会清空文字；重新打开会填回默认文字', en: 'Turning it off clears the text; turning it back on restores the default' },
  'settings.watermarkText': { zh: '水印内容', en: 'Watermark Text' },
  'settings.watermarkAngle': { zh: '倾斜度', en: 'Angle' },
  'settings.watermarkDensity': { zh: '密集度', en: 'Density' },
  'settings.watermarkSize': { zh: '大小', en: 'Size' },
  'settings.watermarkHint': { zh: '留空即关闭。颜色跟随「全局字体」配色，深浅主题自动适配；最多 40 个字符。', en: 'Leave empty to disable. Color follows the “Global Font” palette and adapts to light/dark themes; up to 40 characters.' },

  // ───────── 背景预设：被自定义背景压制时的提示 ─────────
  'settings.bgPresetSuppressed': { zh: '当前已设置自定义背景（图片或视频），背景预设暂时不生效；移除自定义背景后会自动恢复。', en: 'A custom background (image or video) is currently set, so the background preset is temporarily inactive; it will return once the custom background is removed.' },
  'settings.bgPortrait': { zh: '竖屏背景图', en: 'Portrait background' },
  'settings.bgLandscape': { zh: '横屏背景图', en: 'Landscape background' },
  'settings.bgRemoveAria': { zh: '移除{label}', en: 'Remove {label}' },
  'settings.bgUnsupported': { zh: '不支持该文件格式', en: 'Unsupported file format' },
  'settings.bgVideoTooBig': { zh: '视频超过 100MB', en: 'Video exceeds 100 MB' },
  'settings.bgImageTooBig': { zh: '图片超过 10MB', en: 'Image exceeds 10 MB' },
  'settings.bgPresetDefault': { zh: '默认', en: 'Default' },
  'settings.bgPresetDefaultHint': { zh: '出厂的渐变氛围底，不额外占用显卡', en: 'Factory ambient gradient backdrop; no extra GPU cost' },
  'settings.bgPresetWaves': { zh: '波浪', en: 'Waves' },
  'settings.bgPresetWavesHint': { zh: '波浪线会随鼠标起伏；只在完整特效下显示', en: 'Wave lines ripple with the cursor; shown only at the full-effects tier' },

  // ───────── 性能模式：选项与说明 ─────────
  'settings.perfAuto': { zh: '跟随设备', en: 'Follow Device' },
  'settings.perfLow': { zh: '性能模式', en: 'Performance Mode' },
  'settings.perfNormal': { zh: '完整特效', en: 'Full Effects' },
  'settings.perfAutoHint': { zh: '按设备 CPU / 内存 / 实测帧率自动判定，iOS 设备默认降一档', en: 'Auto-determined by device CPU / memory / measured frame rate; iOS devices default to one tier lower' },
  'settings.perfLowHint': { zh: '关闭实时模糊与氛围动画，暂停视频背景', en: 'Disables real-time blur and ambient animation; pauses video backgrounds' },
  'settings.perfNormalHint': { zh: '玻璃拟态、动效、视频背景全开', en: 'Enables glassmorphism, animation, and video backgrounds' },

  // ───────── 分区标题 ─────────
  'settings.sectionRuntime': { zh: '运行与安全', en: 'Runtime & Security' },
  'settings.sectionAppearance': { zh: '外观与主题', en: 'Appearance & Theme' },
  'settings.sectionStore': { zh: '资源与商店', en: 'Resources & Store' },
  'settings.sectionSystem': { zh: '环境与帮助', en: 'Environment & Help' },

  // ───────── 监听地址：行内校验与生效提示 ─────────
  'settings.hostInvalid': {
    zh: '监听地址需为 IP 或主机名，例如 0.0.0.0 / 192.168.1.10 / myhost.local',
    en: 'The listen address must be an IP or hostname, e.g. 0.0.0.0 / 192.168.1.10 / myhost.local',
  },
  'settings.restartHint': { zh: '保存后需重启框架才会生效', en: 'Takes effect after the framework restarts' },

  // ───────── 功能开关说明（此前只有标题没有解释）─────────
  'settings.publicApiDesc': {
    zh: '对外开放只读公开接口（/api/public），无需登录即可读取概览等状态，供状态页 / 外部面板使用；关闭后外部一律拒之门外。',
    en: 'Exposes read-only public endpoints (/api/public) that need no login — for status pages or external panels; when off, external access is rejected.',
  },
  'settings.proxyApiDesc': {
    zh: '允许外部程序携密钥调用机器人转发 API（「代理 API」页的接入点），按来源独立限流；关闭后该入口整体下线。',
    en: 'Lets external programs call the bot forwarding API with a key (the Proxy API endpoint), rate-limited per source; when off, the endpoint is shut down.',
  },
  'settings.inboundGuardDesc': {
    zh: '对入站请求做来源风控：全局冷却期间丢弃无密钥连接，拦下扫描与撞库流量；关闭后所有入站请求直接放行，仅在排查问题时临时关闭。',
    en: 'Screens inbound connections: drops keyless connections during global cooldown and blocks scanners / credential stuffing. When off, everything passes — only disable temporarily for troubleshooting.',
  },
  'settings.logToFileDesc': {
    zh: '把运行日志同时写入 log/ 目录文件，方便回溯排查；关闭后仅输出到屏幕，已生成的文件保留。',
    en: 'Also writes runtime logs into the log/ directory for later review; when off, logs go to the screen only. Existing files are kept.',
  },

  // ───────── 恢复默认外观 ─────────
  'settings.resetAppearance': { zh: '恢复默认', en: 'Reset' },
  'settings.resetAppearanceTitle': { zh: '恢复默认外观？', en: 'Reset appearance to defaults?' },
  'settings.resetAppearanceDesc': {
    zh: '滑动条数值、配色与渐变、背景图、自定义标题、页面水印将全部回到出厂状态，此操作不可撤销。',
    en: 'Slider values, colors & gradients, background images, the custom title, and the watermark will all return to factory defaults. This cannot be undone.',
  },
  'settings.resetAppearanceConfirm': { zh: '确认恢复', en: 'Reset now' },
  'settings.resetAppearanceDone': { zh: '外观已恢复默认', en: 'Appearance reset to defaults' },
  'settings.resetAppearanceFailed': { zh: '恢复默认失败，请稍后重试', en: 'Failed to reset the appearance — try again later' },

  // ───────── 背景预设：低性能档禁用说明 ─────────
  'settings.bgPresetLowTier': {
    zh: '当前设备处于性能模式（低配档），波浪不会渲染；切回「完整特效」后先前选择的预设立刻生效。',
    en: 'This device is in Performance Mode (low tier), so waves are not rendered; the chosen preset takes effect once you switch back to Full Effects.',
  },
});
