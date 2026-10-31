import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { logAction } from '../core/log-store.js';
import { isGfPluginDir } from '../plugin/gf-plugin-id.js';
import { isWxPluginDir } from '../plugin/wx-plugin-id.js';
import { isSsPluginDir } from '../plugin/ss-plugin-id.js';
import { isSssxPluginDir } from '../plugin/sssx-plugin-id.js';

/**
 * 媒体代理被域名白名单拒绝时告警：同一主机只报一次。
 * 预览是逐张图片请求的，去重后既能从日志发现「该补白名单」，又不会被图集刷屏。
 */
const warnedProxyHosts = new Set<string>();
/** 告警去重的上限：Set 只增不减，被白名单拒绝的任意主机名都能往里塞 */
const WARNED_HOST_LIMIT = 256;

export function warnProxyDenied(message: string): void {
  const marker = '不允许代理下载：';
  const idx = message.indexOf(marker);
  if (idx < 0) return;
  const host = message.slice(idx + marker.length).trim();
  if (!host || warnedProxyHosts.has(host)) return;
  if (warnedProxyHosts.size >= WARNED_HOST_LIMIT) warnedProxyHosts.clear();
  warnedProxyHosts.add(host);
  logAction(
    '【视频解析】',
    `媒体代理被白名单拒绝：${host}`,
    '若该 CDN 属于已支持平台，请补进 media-proxy-download.ts 的 ALLOWED_HOST_SUFFIXES',
    'warn',
  );
}

export function resolveConnectionPluginKindFromConn(connectionId: string): 'kakake' | 'gf' | 'wx' | 'ss' {
  const type = configService.getConnection(connectionId)?.type ?? 'onebot';
  if (type === 'qq_official') return 'gf';
  if (type === 'weixin_bot') return 'wx';
  if (type === 'kook') return 'ss';
  return 'kakake';
}

/**
 * 连接状态变化后同步所有插件管理器。
 * 双生插件（sssx）同时挂在两条协议上，所以五套管理器一个都不能漏。
 */
export function syncAllPluginManagers(): void {
  void kakakeApp.pluginManager?.syncAllPluginRuntimes();
  void kakakeApp.gfPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.wxPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.sssxPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.ssPluginManager?.syncAllPluginRuntimes();
}

/** 按 ID 路由到 双生 / GF / 微信 / KOOK / 普通插件管理器 */
export function resolvePluginManager(id: string) {
  const trimmed = String(id || '').trim();
  if (
    kakakeApp.wxPluginManager?.getPluginInfo(trimmed)
    || isWxPluginDir(trimmed)
    || /^wx-plugin-/i.test(trimmed)
    || /^wxbot/i.test(trimmed)
  ) {
    return { kind: 'wx' as const, manager: kakakeApp.wxPluginManager };
  }
  // 双生插件必须早于 KOOK：sssx-plugin-* 的宽松别名正则会被 ss 的规则误吞
  if (
    kakakeApp.sssxPluginManager?.getPluginInfo(trimmed)
    || isSssxPluginDir(trimmed)
    || /^sssx[-_]?plugin/i.test(trimmed)
  ) {
    return { kind: 'sssx' as const, manager: kakakeApp.sssxPluginManager };
  }
  if (
    kakakeApp.ssPluginManager?.getPluginInfo(trimmed)
    || isSsPluginDir(trimmed)
    || /^ss[-_]?plugin/i.test(trimmed)
  ) {
    return { kind: 'ss' as const, manager: kakakeApp.ssPluginManager };
  }
  if (
    kakakeApp.gfPluginManager.getPluginInfo(trimmed)
    || isGfPluginDir(trimmed)
    || /^gf-plugin-/i.test(trimmed)
  ) {
    return { kind: 'gf' as const, manager: kakakeApp.gfPluginManager };
  }
  return { kind: 'kakake' as const, manager: kakakeApp.pluginManager };
}
