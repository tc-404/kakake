import { registerMessages } from '@/lib/i18n';

registerMessages({
  // 搜索 / 筛选
  'logs.searchKeyword': { zh: '搜索关键词…', en: 'Search keywords…' },
  'logs.catShort': { zh: '分类', en: 'Category' },
  'logs.catAll': { zh: '全部分类', en: 'All categories' },
  // 具体分类名：下拉选项、行首类型段、详情弹窗共用
  'logs.cat.system': { zh: '系统', en: 'System' },
  'logs.cat.event': { zh: '上报', en: 'Event' },
  'logs.cat.action': { zh: '输出', en: 'Action' },
  'logs.cat.plugin': { zh: '插件', en: 'Plugin' },
  'logs.cat.gf_event': { zh: '官方上报', en: 'Official Event' },
  'logs.cat.gf_action': { zh: '官方输出', en: 'Official Action' },
  'logs.cat.gf_plugin': { zh: '官方插件', en: 'Official Plugin' },
  'logs.cat.sim_event': { zh: '模拟上报', en: 'Simulated Event' },
  'logs.cat.sim_action': { zh: '模拟输出', en: 'Simulated Action' },
  'logs.levelShort': { zh: '级别', en: 'Level' },
  'logs.levelAll': { zh: '全部级别', en: 'All levels' },
  'logs.levelInfo': { zh: '信息', en: 'Info' },
  'logs.levelWarn': { zh: '警告', en: 'Warning' },
  'logs.levelError': { zh: '错误', en: 'Error' },
  'logs.levelDebug': { zh: '调试', en: 'Debug' },
  'logs.selectPlaceholder': { zh: '选择', en: 'Select' },
  'logs.liveShort': { zh: '实时', en: 'Live' },
  'logs.live': { zh: '实时日志', en: 'Live logs' },
  'logs.noLogFiles': { zh: '暂无日志文件', en: 'No log files' },

  // 空状态 / 暂停提示
  'logs.empty': { zh: '暂无日志', en: 'No logs' },
  'logs.noMatch': { zh: '无匹配日志', en: 'No matching logs' },
  'logs.paused': { zh: '日志接收已暂停，点击刷新获取最新数据', en: 'Log receiving paused, click refresh to get the latest data' },

  // 工具条
  'logs.copyVisible': { zh: '复制可见日志', en: 'Copy visible logs' },
  'logs.clearDisabledTitle': { zh: '查看文件时不可清空', en: 'Cannot clear while viewing a file' },
  'logs.autoScroll': { zh: '自动滚动', en: 'Auto-scroll' },

  // 清空确认弹窗
  'logs.clearConfirmTitle': { zh: '确定要清空所有日志吗？', en: 'Clear all logs?' },
  'logs.clearConfirmDesc': { zh: '此操作不可恢复，但新日志会继续产生。', en: 'This cannot be undone, but new logs will keep coming.' },
  'logs.clearing': { zh: '清空中…', en: 'Clearing…' },

  // 详情浮窗
  'logs.detailView': { zh: '查看完整日志内容', en: 'View full log content' },
  'logs.detailTitle': { zh: '日志详情', en: 'Log details' },
  'logs.copiedContent': { zh: '日志内容已复制', en: 'Log content copied' },
  'logs.copyFailed': { zh: '复制失败，请手动选中复制', en: 'Copy failed, please select and copy manually' },
  'logs.copyFull': { zh: '一键复制完整内容', en: 'Copy full content' },
  'logs.copyAll': { zh: '复制全部日志', en: 'Copy all logs' },

  // toast 提示
  'logs.loaded': { zh: '已载入 {file}', en: 'Loaded {file}' },
  'logs.downloaded': { zh: '已下载当前进程日志', en: 'Current process logs downloaded' },
  'logs.copiedN': { zh: '已复制 {n} 条日志', en: 'Copied {n} logs' },
  'logs.cleared': { zh: '已清空日志', en: 'Logs cleared' },
  'logs.reread': { zh: '重新读取 {file}', en: 'Reload {file}' },
});
