import { kakakeApp } from '../kakake-app.js';
import { getLogCounters } from '../core/log-store.js';
import { appearanceService } from './appearance.service.js';
import { buildPublicAccounts, formatUptime, type PublicAccount } from './public-api.payload.js';

/** 无自定义标题时的默认名字，与控制台顶栏保持一致 */
const DEFAULT_TITLE = '咔咔珂';

/** 外放 API 的只读概览快照（HTTP 与 WebSocket 共用） */
export interface PublicOverview {
  ok: true;
  time: number;
  /** 框架显示名字：设置页「自定义标题名字」，未设置则为「咔咔珂」 */
  title: string;
  uptime: { seconds: number; text: string };
  logs: { received: number; sent: number };
  accounts: { count: number; list: PublicAccount[] };
}

export function buildPublicOverview(): PublicOverview {
  const uptimeSec = Math.floor(process.uptime());
  const counters = getLogCounters();
  const accounts = buildPublicAccounts(kakakeApp.connectionManager.getStatusList());
  return {
    ok: true,
    time: Date.now(),
    title: appearanceService.getCustomTitle() || DEFAULT_TITLE,
    uptime: { seconds: uptimeSec, text: formatUptime(uptimeSec) },
    logs: { received: counters.received, sent: counters.sent },
    accounts: { count: accounts.length, list: accounts },
  };
}
