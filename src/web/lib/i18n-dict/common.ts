import { registerMessages } from '@/lib/i18n';

/**
 * 全局通用文案：导航、通用按钮与标签。
 * 各页面复用这里的 key，不要在不同模块重复定义。
 */
const commonMessages = {
  // ───────── 导航 ─────────
  'nav.dashboard': { zh: '系统总览', en: 'Dashboard' },
  'nav.connections': { zh: '连接管理', en: 'Connections' },
  'nav.plugins': { zh: '插件列表', en: 'Plugins' },
  'nav.pluginHost': { zh: '插件宿主', en: 'Plugin Host' },
  'nav.pluginStore': { zh: '插件市场', en: 'Plugin Store' },
  'nav.tools': { zh: '实用工具', en: 'Tools' },
  'nav.openPlatform': { zh: '开放平台', en: 'Open Platform' },
  'nav.ai': { zh: '智能助手', en: 'AI Assistant' },
  'nav.simulate': { zh: '模拟消息', en: 'Simulate' },
  'nav.logs': { zh: '运行日志', en: 'Logs' },
  'nav.settings': { zh: '系统设置', en: 'Settings' },
  'nav.announcement': { zh: '系统公告', en: 'Announcement' },

  // 导航短名：电脑侧边栏被调到很窄（< 140px）时用它，四字全称会被挤成省略号。
  // zh 统一两字；en 取能塞进窄栏的短写法。
  'nav.short.dashboard': { zh: '概览', en: 'Home' },
  'nav.short.connections': { zh: '连接', en: 'Conn' },
  'nav.short.plugins': { zh: '插件', en: 'Plugins' },
  'nav.short.pluginStore': { zh: '市场', en: 'Store' },
  'nav.short.tools': { zh: '工具', en: 'Tools' },
  'nav.short.openPlatform': { zh: '开放', en: 'Open' },
  'nav.short.ai': { zh: '助手', en: 'AI' },
  'nav.short.simulate': { zh: '模拟', en: 'Sim' },
  'nav.short.logs': { zh: '日志', en: 'Logs' },
  'nav.short.settings': { zh: '设置', en: 'Config' },

  // ───────── 侧边栏导航编辑 ─────────
  'navEdit.enter': { zh: '编辑导航', en: 'Edit navigation' },
  'navEdit.done': { zh: '完成编辑', en: 'Done' },
  'navEdit.hint': { zh: '拖动可调整顺序，点叉号隐藏该项', en: 'Drag to reorder, tap × to hide' },
  'navEdit.hide': { zh: '隐藏', en: 'Hide' },
  'navEdit.restore': { zh: '恢复显示', en: 'Restore' },
  'navEdit.locked': { zh: '此项不可移除', en: 'Cannot be removed' },
  'navEdit.hiddenNote': { zh: '已隐藏，退出编辑后不再显示', en: 'Hidden — it disappears after you finish' },
  'navEdit.saveFailed': { zh: '导航设置保存失败', en: 'Failed to save navigation settings' },
  'navEdit.drag': { zh: '拖动排序', en: 'Drag to reorder' },

  // ───────── 通用按钮 ─────────
  'btn.confirm': { zh: '确定', en: 'Confirm' },
  'btn.ok': { zh: '好的', en: 'OK' },
  'btn.cancel': { zh: '取消', en: 'Cancel' },
  'btn.save': { zh: '保存', en: 'Save' },
  'btn.saveAndApply': { zh: '保存并应用', en: 'Save & Apply' },
  'btn.delete': { zh: '删除', en: 'Delete' },
  'btn.remove': { zh: '移除', en: 'Remove' },
  'btn.edit': { zh: '编辑', en: 'Edit' },
  'btn.refresh': { zh: '刷新', en: 'Refresh' },
  'btn.close': { zh: '关闭', en: 'Close' },
  'btn.copy': { zh: '复制', en: 'Copy' },
  'btn.add': { zh: '添加', en: 'Add' },
  'btn.create': { zh: '创建', en: 'Create' },
  'btn.reset': { zh: '重置', en: 'Reset' },
  'btn.submit': { zh: '提交', en: 'Submit' },
  'btn.search': { zh: '搜索', en: 'Search' },
  'btn.clear': { zh: '清空', en: 'Clear' },
  'btn.download': { zh: '下载', en: 'Download' },
  'btn.upload': { zh: '上传', en: 'Upload' },
  'btn.retry': { zh: '重试', en: 'Retry' },
  'btn.enable': { zh: '启用', en: 'Enable' },
  'btn.disable': { zh: '禁用', en: 'Disable' },
  'btn.back': { zh: '返回', en: 'Back' },
  'btn.next': { zh: '下一步', en: 'Next' },
  'btn.prev': { zh: '上一步', en: 'Previous' },
  'btn.more': { zh: '更多', en: 'More' },
  'btn.details': { zh: '详情', en: 'Details' },
  'btn.apply': { zh: '应用', en: 'Apply' },
  'btn.start': { zh: '启动', en: 'Start' },
  'btn.stop': { zh: '停止', en: 'Stop' },
  'btn.restart': { zh: '重启', en: 'Restart' },

  // ───────── 通用标签 / 状态 ─────────
  'label.name': { zh: '名称', en: 'Name' },
  'label.status': { zh: '状态', en: 'Status' },
  'label.actions': { zh: '操作', en: 'Actions' },
  'label.time': { zh: '时间', en: 'Time' },
  'label.type': { zh: '类型', en: 'Type' },
  'label.description': { zh: '描述', en: 'Description' },
  'label.note': { zh: '说明', en: 'Note' },
  'label.enabled': { zh: '已启用', en: 'Enabled' },
  'label.disabled': { zh: '已禁用', en: 'Disabled' },
  'label.on': { zh: '开', en: 'On' },
  'label.off': { zh: '关', en: 'Off' },
  'label.loading': { zh: '加载中…', en: 'Loading…' },
  'label.noData': { zh: '暂无数据', en: 'No data' },
  'label.success': { zh: '成功', en: 'Success' },
  'label.failed': { zh: '失败', en: 'Failed' },
  'label.error': { zh: '错误', en: 'Error' },
  'label.warning': { zh: '警告', en: 'Warning' },
  'label.info': { zh: '信息', en: 'Info' },
  'label.required': { zh: '必填', en: 'Required' },
  'label.optional': { zh: '可选', en: 'Optional' },

  // ───────── 通用提示 ─────────
  'tip.saved': { zh: '已保存', en: 'Saved' },
  'tip.copied': { zh: '已复制', en: 'Copied' },
  'tip.loadingFailed': { zh: '加载失败', en: 'Failed to load' },
  'tip.operationFailed': { zh: '操作失败', en: 'Operation failed' },
  'tip.areYouSure': { zh: '确定要执行此操作吗？', en: 'Are you sure you want to do this?' },
  'tip.confirmDelete': { zh: '确定要删除吗？此操作不可撤销。', en: 'Delete this? This action cannot be undone.' },

  // ───────── 品牌 ─────────
  'brand.kakake': { zh: '咔咔珂', en: 'Kakake' },
} as const;

registerMessages(commonMessages);
