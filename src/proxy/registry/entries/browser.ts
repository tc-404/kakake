/**
 * 渲染工具框架接口（framework: true）：浏览器进程拉起 / 停止 / 重启 / 状态 / 操作心跳。
 *
 * 不经协议端分发，任何连接上下文都可用；kakake_api 与外放 API（/api/v1/）调用等价。
 * 三个浏览器用 browserId（chrome / edge / chromium）区分。
 */
import type { ProxyApiEntry } from '../../proxy.types.js';

const browserIdParam = {
  key: 'browserId', label: '浏览器', type: 'string', required: true, sample: 'chrome',
  desc: 'chrome / edge / chromium',
};

function entry(
  name: string,
  title: string,
  summary: string,
  extraParams: Record<string, unknown>[] = [],
): ProxyApiEntry {
  return {
    name,
    title,
    summary,
    category: 'system',
    scope: 'common',
    support: ['napcat', 'snowluma', 'official'],
    risk: name.includes('stop') || name.includes('restart') ? 'danger' : 'read',
    status: 'stable',
    framework: true,
    alias: [],
    params: [browserIdParam, ...extraParams] as ProxyApiEntry['params'],
    impl: {},
    examples: {
      request: { browserId: 'chrome' },
      success: { status: 'ok', retcode: 0, data: { ok: true }, message: '', wording: '', echo: null },
      error: { status: 'failed', retcode: -1009, data: null, message: '调用失败', wording: '调用失败', echo: null },
    },
    notes: '框架本地接口（framework: true）。返回 data 含 CDP 地址（cdpUrl），可用 puppeteer.connect({ browserURL }) 或 playwright connectOverCDP 接入。'
      + 'browser_acquire / browser_release 供插件模式引用计数；browser_touch 供用完即停模式刷新空闲计时。',
  };
}

export const browserEntries: ProxyApiEntry[] = [
  entry('browser_start', '拉起浏览器进程', '按配置的模式拉起指定浏览器进程，返回 CDP 调试地址。'),
  entry('browser_stop', '停止浏览器进程', '停止指定浏览器进程。'),
  entry('browser_restart', '重启浏览器进程', '重启指定浏览器进程。'),
  entry('browser_status', '查询浏览器状态', '查询三个浏览器的运行状态、CDP 地址、持有者、空闲剩余秒数。'),
  entry('browser_touch', '浏览器操作心跳', '刷新用完即停模式的空闲计时；每次操作后调用可延长存活。'),
  entry(
    'browser_acquire',
    '登记浏览器使用',
    '插件模式：登记一个插件为持有者；未运行时自动拉起。pluginId 建议传自己的插件 ID。',
    [{ key: 'pluginId', label: '插件标识', type: 'string', sample: 'GF-plugin-xxx' }],
  ),
  entry(
    'browser_release',
    '归还浏览器使用',
    '插件模式：归还持有者；最后一个持有者归还后浏览器自动关闭。',
    [{ key: 'pluginId', label: '插件标识', type: 'string', sample: 'GF-plugin-xxx' }],
  ),
];
