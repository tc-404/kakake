import { registerMessages } from '@/lib/i18n';

registerMessages({
  'dashboard.notLoggedIn': { zh: '未登录', en: 'Not logged in' },
  'dashboard.listenConfig': { zh: '监听配置', en: 'Listening' },
  'dashboard.connectedIn': { zh: '已连入', en: 'Connected' },
  'dashboard.pluginTotal': { zh: '插件总数', en: 'Total Plugins' },
  'dashboard.loaded': { zh: '已加载', en: 'Loaded' },
  'dashboard.connectionStatus': { zh: '连接状态', en: 'Connection Status' },
  'dashboard.manageConnections': { zh: '管理连接', en: 'Manage Connections' },
  'dashboard.noConnections': { zh: '暂无连接', en: 'No connections' },
  'dashboard.goAdd': { zh: '去添加', en: 'Add one' },
  'dashboard.copyFailed': { zh: '复制失败，请手动选中复制', en: 'Copy failed, please select and copy manually' },
  'dashboard.reconnectTriggered': { zh: '已触发重连', en: 'Reconnect triggered' },
  'dashboard.enabledAndConnected': { zh: '已启用并连接', en: 'Enabled and connected' },
  'dashboard.retriedTimes': { zh: '已重试 {n} 次 · 可点击重试', en: 'Retried {n} times · click to retry' },
  'dashboard.connErrorRetry': { zh: '连接异常 · 可点击重试', en: 'Connection error · click to retry' },
  'dashboard.noConnectionsSep': { zh: '，', en: ', ' },

  // —— 系统信息卡片 ——
  'dashboard.infoOs': { zh: '操作系统', en: 'OS' },
  'dashboard.infoSysUptime': { zh: '系统运行时长', en: 'System uptime' },
  'dashboard.infoRuntime': { zh: 'kakake 运行时长', en: 'kakake uptime' },
  'dashboard.infoSinceBoot': { zh: '自开机以来', en: 'Since boot' },
  'dashboard.cores': { zh: '{n} 核', en: '{n} cores' },
  'dashboard.coresOnline': { zh: '{n} 核（在线 {m}）', en: '{n} cores (online {m})' },
  'dashboard.sysInfoTitle': { zh: '系统信息', en: 'System Info' },
  'dashboard.sysInfoDesc': { zh: '主机与运行环境只读信息', en: 'Host & runtime info (read-only)' },
  'dashboard.fetchFailed': { zh: '采集失败', en: 'Failed to fetch' },
  'dashboard.refreshRate': { zh: '刷新 {rate}', en: 'Refresh {rate}' },

  // —— 运行时长格式化 ——
  'dashboard.uptimeMonths': { zh: '{mo}月{d}天{h}时{m}分{r}秒', en: '{mo}mo {d}d {h}h {m}m {r}s' },
  'dashboard.uptimeDays': { zh: '{d}天{h}时{m}分{r}秒', en: '{d}d {h}h {m}m {r}s' },

  // —— 系统监控（面积图） ——
  'dashboard.sysMonitorTitle': { zh: '系统监控', en: 'System Monitor' },
  'dashboard.cpuUsage': { zh: 'CPU 占用', en: 'CPU Usage' },
  'dashboard.memUsage': { zh: '内存占用', en: 'Memory Usage' },
  'dashboard.legendSystem': { zh: '系统', en: 'System' },
  'dashboard.legendProcess': { zh: '项目', en: 'Process' },
  'dashboard.legendTotalMem': { zh: '总内存', en: 'Total Memory' },
  'dashboard.legendProc': { zh: '进程', en: 'Process' },
  'dashboard.window60s': { zh: '最近 60 秒', en: 'Last 60s' },
  'dashboard.collecting': { zh: '采集中…', en: 'Collecting…' },
  'dashboard.memTotalPrefix': { zh: '总', en: 'Total' },
  'dashboard.memProcPrefix': { zh: '进程', en: 'Process' },
  'dashboard.memHeap': { zh: '（堆 {n}）', en: ' (heap {n})' },

  // —— 指标悬浮读数 ——
  'dashboard.metricNow': { zh: '此刻', en: 'Now' },
  'dashboard.metricAgoMs': { zh: '{n}ms 前', en: '{n}ms ago' },
  'dashboard.metricAgoSec': { zh: '{n}s 前', en: '{n}s ago' },
  'dashboard.metricAgoSecInt': { zh: '{n}秒前', en: '{n}s ago' },
  'dashboard.coreOffline': { zh: '核 {i}（离线）', en: 'Core {i} (offline)' },
  'dashboard.coreLoad': { zh: '核 {i}：{pct}%', en: 'Core {i}: {pct}%' },

  // —— 磁盘卡片 ——
  'dashboard.disk': { zh: '磁盘', en: 'Disk' },
  'dashboard.allDisks': { zh: '全部磁盘', en: 'All disks' },
  'dashboard.otherN': { zh: '其他 {n} 个', en: 'Other {n}' },
  'dashboard.otherNDisks': { zh: '其他 {n} 个磁盘', en: 'Other {n} disks' },
  'dashboard.used': { zh: '已用', en: 'Used' },
  'dashboard.available': { zh: '可用', en: 'Available' },
  'dashboard.totalCapacity': { zh: '总容量', en: 'Total Capacity' },
  'dashboard.mountedAt': { zh: '挂载于 {path}', en: 'Mounted at {path}' },
  'dashboard.projectVolume': { zh: '项目所在卷', en: 'Project volume' },
});
