/**
 * 插件宿主全屏页：仅渲染插件自身界面（无框架顶栏）。
 */
import { useCallback, useEffect, useMemo, useState, type ComponentType } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import type { ExtensionPage, PluginItem } from '@/lib/types';
import {
  pluginExtApiBase,
  pluginHostConsolePath,
  pluginLegacyHtmlUrl,
  pluginModuleAssetUrl,
} from '@/lib/plugin-host-paths';
import type { PluginRemoteModule, PluginRemoteProps } from '@/lib/plugin-remote';
import { createPluginHostFetch, ensureKakakeSharedLibs } from '@/lib/plugin-ui-shared';

function normalizePagePath(p?: string): string {
  const raw = String(p || 'admin').replace(/^\/+/, '');
  return raw.split('/')[0] || 'admin';
}

export default function PluginHostPage() {
  const navigate = useNavigate();
  const params = useParams();
  const pluginId = decodeURIComponent(String(params.pluginId || ''));
  const accountFromRoute = params.accountKey
    ? decodeURIComponent(String(params.accountKey))
    : undefined;
  const pagePath = normalizePagePath(params['*'] || params.pagePath);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState<ExtensionPage | null>(null);
  const [accountKey, setAccountKey] = useState(accountFromRoute || '');
  const [accountChoices, setAccountChoices] = useState<string[]>([]);
  const [Remote, setRemote] = useState<ComponentType<PluginRemoteProps> | null>(null);

  const resolveMeta = useCallback(async () => {
    setLoading(true);
    setError('');
    setRemote(null);
    try {
      const res = await api.plugins.list();
      const hit = res.data.plugins.find((p: PluginItem) => p.id === pluginId);
      if (!hit) {
        setError(`未找到插件 ${pluginId}`);
        return;
      }

      const pages = res.data.extensionPages.filter((p) => p.pluginId === pluginId);
      const matched = pages.find((p) => p.path === pagePath) || pages[0] || null;
      setPage(matched);

      let account = accountFromRoute || '';
      const loaded = hit.loadedAccounts || [];
      if (!account) {
        if (loaded.length === 1) {
          account = loaded[0]!;
          navigate(pluginHostConsolePath(pluginId, pagePath, account), { replace: true });
          return;
        }
        if (loaded.length > 1) {
          setAccountChoices(loaded);
          setAccountKey('');
          return;
        }
        setError('插件尚未在任何账号上加载，请先在连接里打开子开关');
        return;
      }
      if (loaded.length && !loaded.includes(account)) {
        setError(`账号 ${account} 未加载该插件`);
        setAccountChoices(loaded);
        return;
      }
      setAccountKey(account);
      setAccountChoices([]);

      const kind = matched?.kind === 'module' || matched?.module ? 'module' : 'html';
      const moduleRel = matched?.module;
      const hasHtml = !!(matched?.htmlFile || matched?.legacyUrl || hit.hasPages);

      if (kind === 'module' && moduleRel) {
        try {
          ensureKakakeSharedLibs();
          const url = pluginModuleAssetUrl(pluginId, moduleRel, account);
          const mod = await import(/* @vite-ignore */ url) as PluginRemoteModule;
          if (!mod?.default) {
            throw new Error('远程模块未默认导出 React 组件');
          }
          setRemote(() => mod.default);
          return;
        } catch (e) {
          if (!hasHtml) throw e;
          setError('');
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [pluginId, pagePath, accountFromRoute, navigate]);

  useEffect(() => {
    void resolveMeta();
  }, [resolveMeta]);

  const hostFetch = useMemo(() => createPluginHostFetch(), []);
  const remoteProps: PluginRemoteProps | null = accountKey
    ? {
        pluginId,
        accountKey,
        pagePath,
        apiBase: pluginExtApiBase(pluginId, accountKey),
        moduleBase: `/plugin/${encodeURIComponent(pluginId)}/a/${encodeURIComponent(accountKey)}/module/`,
        navigate: (to: string) => navigate(to),
        fetch: hostFetch,
      }
    : null;

  const iframeSrc = accountKey
    ? (page?.legacyUrl || pluginLegacyHtmlUrl(pluginId, pagePath, accountKey))
    : '';

  if (loading) {
    return (
      <div className="flex h-full flex-1 items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载插件后台…
      </div>
    );
  }

  if (accountChoices.length > 1 && !accountKey) {
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-4 p-6">
        <p className="text-sm text-slate-600">该插件已在多个账号启用，请选择：</p>
        <ul className="space-y-2">
          {accountChoices.map((a) => (
            <li key={a}>
              <Link
                to={pluginHostConsolePath(pluginId, pagePath, a)}
                className="inline-flex rounded-xl border border-white/50 bg-white/30 px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-white/45"
              >
                账号 {a}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full flex-1 items-center justify-center p-6 text-sm text-rose-700">
        {error}
      </div>
    );
  }

  if (accountKey && Remote && remoteProps) {
    return (
      <div className="h-full min-h-0 w-full flex-1 overflow-hidden">
        <Remote {...remoteProps} />
      </div>
    );
  }

  if (accountKey && iframeSrc) {
    return (
      <iframe
        title="插件后台"
        src={iframeSrc}
        className="h-full min-h-0 w-full flex-1 border-0"
      />
    );
  }

  return null;
}
