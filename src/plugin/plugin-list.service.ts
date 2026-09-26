import { kakakeApp } from '../kakake-app.js';
import { configService } from '../core/config.service.js';
import {
  isKookConnection,
  isOnebotConnection,
  isQqOfficialConnection,
  isWeixinBotConnection,
} from '../core/types.js';
import { buildPluginListItem } from './plugin-meta.js';
import { connectionPluginService } from './connection-plugin.service.js';
import { pluginAccountService } from './plugin-account.service.js';
import { pluginHostConsolePath, pluginLegacyHtmlUrl, pluginModuleAssetUrl } from './plugin-host-paths.js';
import { resolvePluginPageKind, type PluginEntry, type PluginPageDefinition } from './plugin.types.js';

function normalizePagePath(p: string): string {
  return String(p || 'admin').replace(/^\/+/, '') || 'admin';
}

function pushExtensionPage(
  extensionPages: Array<Record<string, unknown>>,
  opts: {
    pluginId: string;
    pluginName?: string;
    path: string;
    title?: string;
    icon?: string;
    description?: string;
    kind: 'html' | 'module';
    module?: string;
    htmlFile?: string;
    accountKey?: string | null;
  },
) {
  const path = normalizePagePath(opts.path);
  const hostPath = pluginHostConsolePath(opts.pluginId, path, opts.accountKey || undefined);
  const legacyUrl = pluginLegacyHtmlUrl(opts.pluginId, path, opts.accountKey || undefined);
  const moduleUrl = opts.module
    ? pluginModuleAssetUrl(opts.pluginId, opts.module, opts.accountKey || undefined)
    : undefined;

  extensionPages.push({
    pluginId: opts.pluginId,
    pluginName: opts.pluginName,
    path,
    title: opts.title,
    icon: opts.icon,
    description: opts.description,
    kind: opts.kind,
    module: opts.module,
    htmlFile: opts.htmlFile,
    hostPath,
    legacyUrl,
    moduleUrl,
  });
}

function mapOneManager(
  pm: {
    getAllPlugins: () => PluginEntry[];
    getPluginRouter: (id: string, accountKey?: string) => {
      getPages: () => PluginPageDefinition[];
      hasPages: () => boolean;
    } | undefined;
    isMasterEnabled: (id: string) => boolean;
    getLoadedAccountKeys?: (id: string) => string[];
  },
  kind: 'kakake' | 'gf' | 'wx' | 'ss',
  connectionId?: string,
) {
  const extensionPages: Array<Record<string, unknown>> = [];
  const scoped = !!connectionId;
  const conn = connectionId ? configService.getConnection(connectionId) : undefined;
  const accountKey = scoped ? pluginAccountService.resolveAccountKey(conn) : null;
  const accountReady = scoped ? !!accountKey : true;

  const plugins = pm.getAllPlugins().map((p) => {
    const router = pm.getPluginRouter(p.id);
    const pages = router?.getPages() ?? [];
    const hasPages = (router?.hasPages() ?? false)
      || !!p.packageJson?.webui
      || !!p.packageJson?.webuiModule;

    const pluginName = p.packageJson?.plugin || p.name || p.id;

    for (const page of pages) {
      const pageKind = resolvePluginPageKind(page);
      const modulePath = page.module
        || (pageKind === 'module' ? p.packageJson?.webuiModule : undefined)
        || (
          !page.module
          && normalizePagePath(page.path) === 'admin'
          && p.packageJson?.webuiModule
            ? p.packageJson.webuiModule
            : undefined
        );
      const resolvedKind = modulePath ? 'module' as const : pageKind;
      pushExtensionPage(extensionPages, {
        pluginId: p.id,
        pluginName,
        path: page.path,
        title: page.title,
        icon: page.icon,
        description: page.description,
        kind: resolvedKind,
        module: modulePath,
        htmlFile: page.htmlFile || p.packageJson?.webui,
        accountKey,
      });
    }

    if (pages.length === 0 && (p.packageJson?.webui || p.packageJson?.webuiModule)) {
      const modulePath = p.packageJson?.webuiModule;
      pushExtensionPage(extensionPages, {
        pluginId: p.id,
        pluginName,
        path: 'admin',
        title: pluginName,
        kind: modulePath ? 'module' : 'html',
        module: modulePath,
        htmlFile: p.packageJson?.webui,
        accountKey,
      });
    }

    const masterEnabled = pm.isMasterEnabled(p.id);
    const connectionEnabled = scoped
      ? connectionPluginService.isEnabled(connectionId!, p.id, kind)
      : undefined;
    const runtimeInstalled = scoped && accountKey
      ? pluginAccountService.hasRuntimeCopy(accountKey, p.id)
      : undefined;
    const canEnableOnConnection = scoped
      ? masterEnabled && accountReady
      : undefined;

    const firstPage = pages[0];
    const firstPath = firstPage?.path || 'admin';

    return {
      ...buildPluginListItem(p, { hasPages, connectionEnabled, masterEnabled }),
      kind,
      masterEnabled,
      accountKey: accountKey ?? undefined,
      accountReady: scoped ? accountReady : undefined,
      runtimeInstalled,
      canEnableOnConnection,
      webUrl: scoped && accountKey && masterEnabled
        ? pluginHostConsolePath(p.id, firstPath, accountKey)
        : undefined,
      legacyWebUrl: scoped && accountKey && masterEnabled
        ? pluginLegacyHtmlUrl(p.id, firstPath, accountKey)
        : undefined,
      loadedAccounts: !scoped ? (pm.getLoadedAccountKeys?.(p.id) ?? []) : undefined,
    };
  });

  return { plugins, extensionPages };
}

/** 全局列表：合并 OneBot + GF + 微信插件 */
export function buildGlobalPluginListPayload() {
  const a = mapOneManager(kakakeApp.pluginManager, 'kakake');
  const b = mapOneManager(kakakeApp.gfPluginManager, 'gf');
  const c = mapOneManager(kakakeApp.wxPluginManager, 'wx');
  const d = mapOneManager(kakakeApp.ssPluginManager, 'ss');
  return {
    plugins: [...a.plugins, ...b.plugins, ...c.plugins, ...d.plugins],
    extensionPages: [...a.extensionPages, ...b.extensionPages, ...c.extensionPages, ...d.extensionPages],
    pluginManagerNotFound: false,
  };
}

export function buildPluginListPayload(connectionId?: string) {
  if (!connectionId) {
    return buildGlobalPluginListPayload();
  }

  const kind = resolveConnectionPluginKind(connectionId);
  const pm = kind === 'gf'
    ? kakakeApp.gfPluginManager
    : kind === 'wx'
      ? kakakeApp.wxPluginManager
      : kind === 'ss'
        ? kakakeApp.ssPluginManager
        : kakakeApp.pluginManager;
  const { plugins, extensionPages } = mapOneManager(pm, kind ?? 'kakake', connectionId);

  return { plugins, extensionPages, pluginManagerNotFound: false };
}

export function resolveConnectionPluginKind(
  connectionId?: string,
): 'kakake' | 'gf' | 'wx' | 'ss' | undefined {
  if (!connectionId) return undefined;
  const conn = configService.getConnection(connectionId);
  if (!conn) return undefined;
  if (isQqOfficialConnection(conn)) return 'gf';
  if (isWeixinBotConnection(conn)) return 'wx';
  if (isKookConnection(conn)) return 'ss';
  return 'kakake';
}

export function connectionAcceptsKakakePlugins(connectionId: string): boolean {
  const conn = configService.getConnection(connectionId);
  return conn ? isOnebotConnection(conn) : false;
}
