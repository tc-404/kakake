/**
 * 逃生舱。
 *
 * `call_native` 刻意**不做任何翻译**：把原生 action 名 / 官方 path 原样发出去。
 * 它的存在价值是兜底 —— 三份文档里总有代理层还没收敛到的边角能力，
 * 与其让插件作者卡住，不如给一条明路。
 *
 * 它不引用任何具体 action，所以不参与覆盖率对账（对账脚本统计的是具体 action/path）。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

export const nativeEntries: ProxyApiEntry[] = [
  {
    name: 'call_native',
    title: '原生接口直通',
    summary: '绕过一切翻译，直接把原生 action 名或官方 path 发给协议端。仅用于兜底，优先使用具名接口。',
    category: 'native',
    scope: 'native',
    support: ['napcat', 'snowluma', 'official'],
    risk: 'danger',
    status: 'stable',
    alias: ['call_native', 'raw'],
    params: [
      {
        key: 'protocol', label: '目标协议', type: 'string', sample: 'napcat',
        desc: 'napcat / snowluma / official。不填则跟随当前连接自动判定',
      },
      { key: 'action', label: '原生 action 名', type: 'string', sample: 'get_group_list', desc: 'napcat / snowluma 时必填' },
      { key: 'verb', label: 'HTTP 方法', type: 'string', sample: 'GET', desc: 'official 时必填' },
      { key: 'path', label: '官方路径', type: 'string', sample: '/guilds/{guild_id}', desc: 'official 时必填，路径参数请自行填好' },
      { key: 'params', label: '请求参数', type: 'object', sample: {}, desc: '原样透传，不做任何键名映射' },
    ],
    impl: {},
    examples: {
      request: { protocol: 'napcat', action: 'get_group_list', params: {} },
      success: {
        status: 'ok', retcode: 0,
        data: [{ group_id: 123456, group_name: '咔咔交流群', member_count: 42 }],
        message: '', wording: '', echo: null,
      },
      error: {
        status: 'failed', retcode: 200, data: null,
        message: '不支持的Api get_group_lis', wording: '不支持的Api', echo: null,
      },
    },
  },
];
