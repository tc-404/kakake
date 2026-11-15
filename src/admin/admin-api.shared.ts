import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import { logAction } from '../core/log-store.js';
import { isGfPluginDir } from '../plugin/gf-plugin-id.js';
import { isWxPluginDir } from '../plugin/wx-plugin-id.js';
import { isSsPluginDir } from '../plugin/ss-plugin-id.js';
import { isSssxPluginDir } from '../plugin/sssx-plugin-id.js';
import { isKzPluginDir } from '../plugin/kz-plugin-id.js';
import { isTgPluginDir } from '../plugin/tg-plugin-id.js';

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

export function resolveConnectionPluginKindFromConn(connectionId: string): 'kakake' | 'gf' | 'wx' | 'ss' | 'tg' {
  const type = configService.getConnection(connectionId)?.type ?? 'onebot';
  if (type === 'qq_official') return 'gf';
  if (type === 'weixin_bot') return 'wx';
  if (type === 'kook') return 'ss';
  if (type === 'telegram') return 'tg';
  return 'kakake';
}

/**
 * 连接状态变化后同步所有插件管理器。
 * 双生插件（sssx）同时挂在两条协议上，所以各套管理器一个都不能漏。
 */
export function syncAllPluginManagers(): void {
  void kakakeApp.pluginManager?.syncAllPluginRuntimes();
  void kakakeApp.gfPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.wxPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.sssxPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.ssPluginManager?.syncAllPluginRuntimes();
  void kakakeApp.tgPluginManager?.syncAllPluginRuntimes();
  // 扩展插件不依赖连接，这里只是保持「连接变化后各管理器对齐一次」的形状一致
  void kakakeApp.kzPluginManager?.syncAllPluginRuntimes();
}

/** 按 ID 路由到 扩展 / Telegram / 双生 / GF / 微信 / KOOK / 普通插件管理器 */
export function resolvePluginManager(id: string) {
  const trimmed = String(id || '').trim();
  // 扩展插件前缀与其它几套不重叠，先判省得被兜底成普通插件
  if (
    kakakeApp.kzPluginManager?.getPluginInfo(trimmed)
    || isKzPluginDir(trimmed)
    || /^kz[-_]?plugin/i.test(trimmed)
  ) {
    return { kind: 'kz' as const, manager: kakakeApp.kzPluginManager };
  }
  if (
    kakakeApp.wxPluginManager?.getPluginInfo(trimmed)
    || isWxPluginDir(trimmed)
    || /^wx-plugin-/i.test(trimmed)
    || /^wxbot/i.test(trimmed)
  ) {
    return { kind: 'wx' as const, manager: kakakeApp.wxPluginManager };
  }
  // Telegram 插件必须早于 KOOK：tgbot-plugin-* 等别名不能被 ss 的宽松正则误吞；
  // 宽松正则只认 tg/tgbot + plugin 段，不会误吞 tg- 开头的其它名字
  if (
    kakakeApp.tgPluginManager?.getPluginInfo(trimmed)
    || isTgPluginDir(trimmed)
    || /^tg[-_]?plugin/i.test(trimmed)
    || /^tgbot[-_]?plugin/i.test(trimmed)
  ) {
    return { kind: 'tg' as const, manager: kakakeApp.tgPluginManager };
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

/**
 * 导入 / 商店安装 / 分享包还原后的统一登记入口：按导入器识别出的类型
 * 交给对应管理器（七套类型各一处，别再在三个控制器里各抄一份三元链）。
 */
export async function registerImportedPluginByKind(
  pluginId: string,
  kind: string | undefined,
): Promise<boolean> {
  switch (kind) {
    case 'sssx': return kakakeApp.sssxPluginManager.registerImportedPlugin(pluginId);
    case 'gf': return kakakeApp.gfPluginManager.registerImportedPlugin(pluginId);
    case 'wx': return kakakeApp.wxPluginManager.registerImportedPlugin(pluginId);
    case 'ss': return kakakeApp.ssPluginManager.registerImportedPlugin(pluginId);
    case 'tg': return kakakeApp.tgPluginManager.registerImportedPlugin(pluginId);
    case 'kz': return kakakeApp.kzPluginManager.registerImportedPlugin(pluginId);
    default: return kakakeApp.pluginManager.registerImportedPlugin(pluginId);
  }
}
