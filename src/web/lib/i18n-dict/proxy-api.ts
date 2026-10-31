import { registerMessages } from '@/lib/i18n';

/**
 * 「接口代理」界面文案（含侧边栏导航项）。
 *
 * 协议徽章的三个展示名**不在**这里 —— 它们必须取自 proxy.types.ts 的
 * PROTOCOL_BADGE_LABEL（napcat / snowluma / q.qq.com），改那份常量即可，
 * 字典里再抄一份迟早会对不上。
 */
const proxyApiMessages = {
  // ───────── 侧边栏导航 ─────────
  'nav.proxyApi': { zh: '接口代理', en: 'API Proxy' },
  'nav.short.proxyApi': { zh: '代理', en: 'Proxy' },

  // ───────── 列表 / 筛选 ─────────
  'proxyApi.searchPh': { zh: '搜索短名 / 中文名 / 别名', en: 'Search by name / title / alias' },
  'proxyApi.protocolFilter': { zh: '协议', en: 'Protocol' },
  'proxyApi.filterHint': {
    zh: '勾选后仅显示同时支持所有所选协议的接口；全不选 = 不过滤',
    en: 'When checked, only APIs supporting ALL selected protocols are shown; none checked = no filter',
  },
  'proxyApi.filterReset': { zh: '重置', en: 'Reset' },
  'proxyApi.filterOn': { zh: '过滤中', en: 'Filtering' },
  'proxyApi.countAll': { zh: '共 {total} 个接口', en: '{total} APIs in total' },
  'proxyApi.countMatched': { zh: '匹配 {n} / {total} 个', en: 'Matched {n} of {total}' },
  'proxyApi.listEmpty': { zh: '没有匹配的接口', en: 'No matching API' },
  'proxyApi.listEmptyHint': { zh: '换个关键词，或勾选更多协议', en: 'Try another keyword, or check more protocols' },
  'proxyApi.loadFailed': { zh: '接口清单加载失败', en: 'Failed to load the API list' },

  // ───────── 详情悬浮窗（子分类） ─────────
  'proxyApi.tabOverview': { zh: '概览', en: 'Overview' },
  'proxyApi.tabImpl': { zh: '实现对照', en: 'Mapping' },
  'proxyApi.tabParams': { zh: '请求参数', en: 'Parameters' },
  'proxyApi.tabExamples': { zh: '返回示例', en: 'Examples' },
  'proxyApi.colProtocol': { zh: '协议', en: 'Protocol' },
  'proxyApi.colNative': { zh: '原生接口', en: 'Native API' },
  'proxyApi.stub': { zh: '（占位）', en: '(stub)' },
  'proxyApi.sameAs': { zh: '协议端别名', en: 'Protocol aliases' },
  'proxyApi.summary': { zh: '功能说明', en: 'Description' },
  'proxyApi.notes': { zh: '备注', en: 'Notes' },
  'proxyApi.aliases': { zh: '别名', en: 'Aliases' },
  'proxyApi.scope': { zh: '归属', en: 'Scope' },
  'proxyApi.readOnly': { zh: '只读接口', en: 'Read-only' },
  'proxyApi.params': { zh: '请求参数', en: 'Request parameters' },
  'proxyApi.paramsEmpty': { zh: '该接口无需请求参数', en: 'This API takes no parameters' },
  'proxyApi.colKey': { zh: '参数名', en: 'Key' },
  'proxyApi.colLabel': { zh: '名称', en: 'Label' },
  'proxyApi.colType': { zh: '类型', en: 'Type' },
  'proxyApi.colRequired': { zh: '必填', en: 'Required' },
  'proxyApi.colSample': { zh: '示例值', en: 'Sample' },
  'proxyApi.colDesc': { zh: '说明', en: 'Description' },
  'proxyApi.yes': { zh: '是', en: 'Yes' },
  'proxyApi.no': { zh: '否', en: 'No' },
  'proxyApi.noSample': { zh: '—', en: '—' },
  'proxyApi.onlyFor': { zh: '仅 {list} 下有效', en: 'Only on {list}' },
  'proxyApi.exRequest': { zh: '请求参数示例', en: 'Request example' },
  'proxyApi.exSuccess': { zh: '成功返回示例', en: 'Success response example' },
  'proxyApi.exError': { zh: '错误返回示例', en: 'Error response example' },
  'proxyApi.exEmpty': { zh: '（无）', en: '(none)' },

  // ───────── 枚举展示名 ─────────
  'proxyApi.risk.read': { zh: '只读', en: 'Read' },
  'proxyApi.risk.write': { zh: '写入', en: 'Write' },
  'proxyApi.risk.danger': { zh: '危险', en: 'Danger' },

  'proxyApi.status.stable': { zh: '稳定', en: 'Stable' },
  'proxyApi.status.experimental': { zh: '实验性', en: 'Experimental' },
  'proxyApi.status.stub': { zh: '占位', en: 'Stub' },

  'proxyApi.scope.common': { zh: '通用', en: 'Common' },
  'proxyApi.scope.official-only': { zh: '官方专属', en: 'Official only' },
  'proxyApi.scope.wild-only': { zh: '野生专属', en: 'Wild only' },
  'proxyApi.scope.native': { zh: '原生直通', en: 'Native passthrough' },

  'proxyApi.cat.message': { zh: '消息', en: 'Message' },
  'proxyApi.cat.media': { zh: '媒体', en: 'Media' },
  'proxyApi.cat.group': { zh: '群聊', en: 'Group' },
  'proxyApi.cat.member': { zh: '成员', en: 'Member' },
  'proxyApi.cat.friend': { zh: '好友', en: 'Friend' },
  'proxyApi.cat.account': { zh: '账号', en: 'Account' },
  'proxyApi.cat.system': { zh: '系统', en: 'System' },
  'proxyApi.cat.guild': { zh: '频道', en: 'Guild' },
  'proxyApi.cat.channel': { zh: '子频道', en: 'Channel' },
  'proxyApi.cat.role': { zh: '身份组', en: 'Role' },
  'proxyApi.cat.permission': { zh: '权限', en: 'Permission' },
  'proxyApi.cat.announce': { zh: '公告', en: 'Announcement' },
  'proxyApi.cat.pin': { zh: '精华', en: 'Pinned' },
  'proxyApi.cat.schedule': { zh: '日程', en: 'Schedule' },
  'proxyApi.cat.audio': { zh: '语音', en: 'Audio' },
  'proxyApi.cat.forum': { zh: '论坛', en: 'Forum' },
  'proxyApi.cat.reaction': { zh: '表情表态', en: 'Reaction' },
  'proxyApi.cat.interaction': { zh: '交互', en: 'Interaction' },
  'proxyApi.cat.wild-only': { zh: '野生专属', en: 'Wild only' },
  'proxyApi.cat.native': { zh: '原生直通', en: 'Native' },
} as const;

registerMessages(proxyApiMessages);
