import { registerMessages } from '@/lib/i18n';

/**
 * 插件市场页（PluginStorePage）+ 分页条（store-pagination）文案。
 * 复用 common.* 的共享按钮/标签（如 btn.refresh / btn.close / btn.cancel）。
 * 分类与角标按 id 拆成 cat-<id> / badge-<id>，便于在渲染处用模板键复用。
 */
registerMessages({
  // ───────── 列表 / 顶栏 ─────────
  'plugin-store.searchPlaceholder': { zh: '搜索标题、作者、标签…', en: 'Search title, author, tags…' },
  'plugin-store.loadingResources': { zh: '正在加载资源…', en: 'Loading resources…' },
  'plugin-store.refreshingResources': { zh: '正在刷新资源…', en: 'Refreshing resources…' },
  'plugin-store.refreshed': { zh: '资源已刷新', en: 'Resources refreshed' },
  'plugin-store.loadFailed': { zh: '加载资源失败', en: 'Failed to load resources' },
  'plugin-store.commentsLoadFailed': { zh: '评论加载失败', en: 'Failed to load comments' },

  // ───────── 搜索 / 空状态 ─────────
  'plugin-store.noMatch': { zh: '无匹配资源', en: 'No matching resources' },
  'plugin-store.noResources': { zh: '暂无资源', en: 'No resources' },
  'plugin-store.categoryEmpty': { zh: '「{label}」分类下暂无资源', en: 'No resources under the "{label}" category' },

  // ───────── 卡片 ─────────
  'plugin-store.unknownAuthor': { zh: '未知作者', en: 'Unknown author' },
  'plugin-store.pinned': { zh: '置顶', en: 'Pinned' },
  'plugin-store.noIntro': { zh: '暂无简介', en: 'No introduction' },
  'plugin-store.downloadTimes': { zh: '下载 {n} 次', en: 'Downloaded {n} times' },

  // ───────── 分类筛选 ─────────
  'plugin-store.filterByCategory': { zh: '按分类筛选', en: 'Filter by category' },
  'plugin-store.category': { zh: '分类', en: 'Category' },
  'plugin-store.clickAgainToCancel': { zh: '再次点击可取消', en: 'Click again to clear' },
  'plugin-store.categoryClearHint': { zh: '再次点击已选分类可取消；刷新或离开本页后自动清空', en: 'Click the selected category again to clear; auto-cleared after refresh or leaving this page' },

  // 分类名（顶栏筛选与下拉菜单共用）
  'plugin-store.cat-wild': { zh: '野鸡', en: 'Community' },
  'plugin-store.cat-official': { zh: '官方', en: 'Official' },
  'plugin-store.cat-twin': { zh: '双生', en: 'Twin' },
  'plugin-store.cat-wechat': { zh: '微信', en: 'WeChat' },
  'plugin-store.cat-other': { zh: '其他', en: 'Other' },
  // 角标（卡片右上角）
  'plugin-store.badge-wild': { zh: '野生', en: 'Community' },
  'plugin-store.badge-official': { zh: '官方', en: 'Official' },
  'plugin-store.badge-twin': { zh: '双生', en: 'Twin' },
  'plugin-store.badge-wechat': { zh: '微信', en: 'WeChat' },
  'plugin-store.badge-other': { zh: '其他', en: 'Other' },

  // ───────── 排序 ─────────
  'plugin-store.sort': { zh: '排序', en: 'Sort' },
  'plugin-store.sort-default': { zh: '默认', en: 'Default' },
  'plugin-store.sort-time_asc': { zh: '时间正序', en: 'Oldest first' },
  'plugin-store.sort-time_desc': { zh: '时间倒序', en: 'Newest first' },
  'plugin-store.sort-updated_near': { zh: '更新时间(近)', en: 'Recently updated' },
  'plugin-store.sort-updated_far': { zh: '更新时间(远)', en: 'Least recently updated' },
  'plugin-store.sort-stars_many': { zh: '星标数(多)', en: 'Most stars' },
  'plugin-store.sort-stars_few': { zh: '星标数(少)', en: 'Fewest stars' },
  'plugin-store.sort-author_many': { zh: '作者资源(多)', en: 'Most by author' },
  'plugin-store.sort-author_few': { zh: '作者资源(少)', en: 'Fewest by author' },
  'plugin-store.sort-views_many': { zh: '浏览次数(多)', en: 'Most viewed' },
  'plugin-store.sort-views_few': { zh: '浏览次数(少)', en: 'Least viewed' },
  'plugin-store.sort-downloads_many': { zh: '下载次数(多)', en: 'Most downloaded' },
  'plugin-store.sort-downloads_few': { zh: '下载次数(少)', en: 'Least downloaded' },

  // ───────── 顶栏入口 ─────────
  'plugin-store.openSource': { zh: '打开当前资源来源', en: 'Open resource source' },
  'plugin-store.openRepo': { zh: '打开源码仓库', en: 'Open source repo' },

  // ───────── 安装 / 更新按钮 ─────────
  'plugin-store.installed': { zh: '已安装', en: 'Installed' },
  'plugin-store.reinstall': { zh: '重新安装', en: 'Reinstall' },
  'plugin-store.install': { zh: '安装', en: 'Install' },
  'plugin-store.update': { zh: '更新', en: 'Update' },
  'plugin-store.installLocally': { zh: '安装到本地', en: 'Install locally' },
  'plugin-store.updateToLatest': { zh: '更新到最新版本', en: 'Update to latest version' },
  'plugin-store.cannotDownload': { zh: '不可下载', en: 'Not downloadable' },
  'plugin-store.downloadNotAllowed': { zh: '该资源不允许下载', en: 'This resource is not available for download' },
  'plugin-store.cannotDownloadNow': { zh: '当前不可下载安装', en: 'Not available for download or installation now' },
  'plugin-store.installFailed': { zh: '安装失败', en: 'Installation failed' },

  // ───────── 详情弹窗 ─────────
  'plugin-store.intro': { zh: '简介', en: 'Introduction' },
  'plugin-store.uploadedBy': { zh: '上传者：{name}', en: 'Uploader: {name}' },
  'plugin-store.pluginInfo': { zh: '插件信息', en: 'Plugin info' },
  'plugin-store.currentVersion': { zh: '当前版本', en: 'Current version' },
  'plugin-store.updatable': { zh: '（可更新）', en: '(Updatable)' },
  'plugin-store.minVersionReq': { zh: '最低版本要求', en: 'Minimum version required' },
  'plugin-store.versionTooLow': { zh: '（当前版本偏低）', en: '(Current version is too low)' },
  'plugin-store.repoStars': { zh: '仓库星数', en: 'Repo stars' },
  'plugin-store.docs': { zh: '文档', en: 'Docs' },
  'plugin-store.loadingDocs': { zh: '加载文档…', en: 'Loading docs…' },
  'plugin-store.comments': { zh: '评论', en: 'Comments' },
  'plugin-store.loadingComments': { zh: '加载评论…', en: 'Loading comments…' },
  'plugin-store.noComments': { zh: '暂无评论', en: 'No comments' },
  'plugin-store.commentsViewOnly': { zh: '商城内仅支持查看评论，不支持发表', en: 'Comments can only be viewed in the store, not posted' },

  // ───────── GitHub 风险声明弹窗 ─────────
  'plugin-store.riskTitle': { zh: '安装风险声明', en: 'Installation risk notice' },
  'plugin-store.riskIntro': { zh: '你即将从 GitHub 社区源安装「{title}」。此为第三方插件，非官方审核内容：', en: 'You are about to install "{title}" from the GitHub community source. This is a third-party plugin, not officially reviewed:' },
  'plugin-store.riskDetail': { zh: '插件代码由其作者维护，可能访问你的账号、消息与本机数据。请自行确认来源可信，安装即表示你自愿承担相应风险。', en: 'The plugin code is maintained by its author and may access your account, messages, and local data. Please verify the source is trustworthy; installing means you voluntarily accept the risk.' },
  'plugin-store.riskConfirm': { zh: '我已了解，继续', en: 'Understood, continue' },

  // ───────── SHA-256 校验失败弹窗 ─────────
  'plugin-store.sha256Title': { zh: '安装包校验未通过', en: 'Package verification failed' },
  'plugin-store.sha256Detail': { zh: '下载到的安装包与登记的 SHA-256 校验值不一致，文件可能在传输中损坏或被篡改。为保护你的安全，已自动中止安装。', en: 'The downloaded package does not match the registered SHA-256 checksum; the file may have been corrupted or tampered with during transfer. For your safety, the installation was automatically aborted.' },
  'plugin-store.sha256DefaultWarn': { zh: '安装包校验未通过，文件可能被篡改或损坏', en: 'Package verification failed; the file may be tampered with or corrupted' },
  'plugin-store.gotIt': { zh: '我知道了', en: 'Got it' },

  // ───────── 分页条 ─────────
  'plugin-store.pagination': { zh: '分页', en: 'Pagination' },
  'plugin-store.prevPage': { zh: '上一页', en: 'Previous page' },
  'plugin-store.nextPage': { zh: '下一页', en: 'Next page' },
  'plugin-store.jumpToPage': { zh: '跳转到页码', en: 'Jump to page' },
});
