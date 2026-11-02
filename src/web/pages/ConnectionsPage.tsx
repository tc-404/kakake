import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Plus, RefreshCw, CloudDownload, CloudUpload, Bot,
  Server, Radio, Globe, MessageCircle, Mic, Share2, FileInput, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { ConnectionMode, ConnectionStatus, ConnectionType } from '@/lib/types';
import { useEventSource } from '@/lib/sse';
import { sortConnectionsForList } from '@/lib/conn-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ConnectionPluginsDialog } from '@/components/connection-plugins-dialog';
import { ForwardReconnectDialog } from '@/components/forward-reconnect-dialog';
import { ConnectionCard } from '@/components/connection-card';
import { ConnectionManageDialog } from '@/components/connection-manage-dialog';
import { WeixinBotLoginDialog } from '@/components/weixin-bot-login-dialog';
import { usePageHeader } from '@/components/header-actions';
import { t, useT } from '@/lib/i18n';
import { errText, resText } from '@/lib/server-error';

/** 导入只认 .json，文件名或 MIME 任一像 JSON 都收（部分系统拖进来的 MIME 不准） */
function isJsonFile(file: File): boolean {
  return /\.json$/i.test(file.name || '') || file.type === 'application/json';
}

/** 导出文件名带时间戳，同一次会话导多份也不会互相盖掉 */
function connectionsExportName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `kakake-connections-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
}

/** 把对象当 JSON 文件存下来 */
function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function defaultPortForMode(mode?: ConnectionMode): number {
  if (mode === 'forward') return 3001;
  if (mode === 'http' || mode === 'http_sse') return 6701;
  if (mode === 'http_client') return 3000;
  return 6700;
}

function needsApiUrl(mode?: ConnectionMode): boolean {
  return mode === 'http' || mode === 'http_sse';
}

const MODE_OPTIONS: {
  type: ConnectionType;
  mode?: ConnectionMode;
  titleKey: string;
  descKey: string;
  icon: typeof CloudDownload;
}[] = [
  {
    type: 'onebot',
    mode: 'reverse',
    titleKey: 'connections.modeReverseWs',
    descKey: 'connections.modeReverseWsDesc',
    icon: CloudDownload,
  },
  {
    type: 'onebot',
    mode: 'forward',
    titleKey: 'connections.modeForwardWs',
    descKey: 'connections.modeForwardWsDesc',
    icon: CloudUpload,
  },
  {
    type: 'onebot',
    mode: 'http',
    titleKey: 'connections.modeHttpServer',
    descKey: 'connections.modeHttpServerDesc',
    icon: Server,
  },
  {
    type: 'onebot',
    mode: 'http_sse',
    titleKey: 'connections.modeHttpSseServer',
    descKey: 'connections.modeHttpSseServerDesc',
    icon: Radio,
  },
  {
    type: 'onebot',
    mode: 'http_client',
    titleKey: 'connections.modeHttpClient',
    descKey: 'connections.modeHttpClientDesc',
    icon: Globe,
  },
  {
    type: 'qq_official',
    titleKey: 'connections.modeQqWs',
    descKey: 'connections.modeQqWsDesc',
    icon: Bot,
  },
  {
    type: 'qq_official',
    mode: 'https',
    titleKey: 'connections.modeQqHttps',
    descKey: 'connections.modeQqHttpsDesc',
    icon: Globe,
  },
  {
    type: 'weixin_bot',
    titleKey: 'connections.modeWeixinBot',
    descKey: 'connections.modeWeixinBotDesc',
    icon: MessageCircle,
  },
  {
    type: 'kook',
    titleKey: 'connections.modeKook',
    descKey: 'connections.modeKookDesc',
    icon: Mic,
  },
];

function addFormMeta(type: ConnectionType, mode: ConnectionMode) {
  if (type === 'kook') {
    return {
      title: t('connections.formKookTitle'),
      desc: t('connections.formKookDesc'),
    };
  }
  if (type === 'weixin_bot') {
    return {
      title: t('connections.formWeixinTitle'),
      desc: t('connections.formWeixinDesc'),
    };
  }
  if (type === 'qq_official') {
    if (mode === 'https') {
      return {
        title: t('connections.formQqHttpsTitle'),
        desc: t('connections.formQqHttpsDesc'),
      };
    }
    return {
      title: t('connections.formQqWsTitle'),
      desc: t('connections.formQqWsDesc'),
    };
  }
  switch (mode) {
    case 'forward':
      return { title: t('connections.formForwardTitle'), desc: t('connections.formForwardDesc') };
    case 'http':
      return {
        title: t('connections.formHttpTitle'),
        desc: t('connections.formHttpDesc'),
      };
    case 'http_sse':
      return {
        title: t('connections.formHttpSseTitle'),
        desc: t('connections.formHttpSseDesc'),
      };
    case 'http_client':
      return {
        title: t('connections.formHttpClientTitle'),
        desc: t('connections.formHttpClientDesc'),
      };
    default:
      return {
        title: t('connections.formReverseTitle'),
        desc: t('connections.formReverseDesc'),
      };
  }
}

export default function ConnectionsPage() {
  const t = useT();
  const [connections, setConnections] = useState<ConnectionStatus[]>([]);
  const [typeModalOpen, setTypeModalOpen] = useState(false);
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [addType, setAddType] = useState<ConnectionType>('onebot');
  const [addMode, setAddMode] = useState<ConnectionMode>('reverse');
  const [submitting, setSubmitting] = useState(false);
  const [pluginsConn, setPluginsConn] = useState<ConnectionStatus | null>(null);
  const [forwardConn, setForwardConn] = useState<ConnectionStatus | null>(null);
  const [manageConnId, setManageConnId] = useState<string | null>(null);
  const [weixinLoginConn, setWeixinLoginConn] = useState<ConnectionStatus | null>(null);
  /** 扫码成功后是否自动启用该连接 */
  const [weixinEnableAfterLogin, setWeixinEnableAfterLogin] = useState(false);
  const [deleteConn, setDeleteConn] = useState<ConnectionStatus | null>(null);
  const [avatarMap, setAvatarMap] = useState<Record<string, { dataUrl: string; updatedAt?: string }>>({});
  const avatarMetaRef = useRef<Record<string, string | undefined>>({});

  const [name, setName] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(6700);
  const [apiUrl, setApiUrl] = useState('http://127.0.0.1:3000');
  const [accessToken, setAccessToken] = useState('');
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [webhookBaseUrl, setWebhookBaseUrl] = useState('');
  const [kookToken, setKookToken] = useState('');
  const [qqPreview, setQqPreview] = useState<ConnectionStatus['botProfile'] | null>(null);
  const [qqPreviewing, setQqPreviewing] = useState(false);
  const [loading, setLoading] = useState(true);
  /** 导入连接配置：读文件 → 校验 → 上传，整个过程锁住按钮与拖拽 */
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);

  const manageConn = manageConnId
    ? (connections.find((c) => c.id === manageConnId) ?? null)
    : null;

  const syncAvatars = useCallback(async (list: ConnectionStatus[]) => {
    const tasks: Promise<void>[] = [];
    for (const c of list) {
      if (c.type === 'weixin_bot' || !c.hasAvatar) {
        if (avatarMetaRef.current[c.id]) {
          delete avatarMetaRef.current[c.id];
          setAvatarMap((prev) => {
            if (!(c.id in prev)) return prev;
            const next = { ...prev };
            delete next[c.id];
            return next;
          });
        }
        continue;
      }
      const stamp = c.avatarUpdatedAt || '1';
      if (avatarMetaRef.current[c.id] === stamp) continue;
      tasks.push(
        (async () => {
          try {
            const r = await api.connections.avatar(c.id);
            if (!r.ok || !r.dataUrl) return;
            avatarMetaRef.current[c.id] = stamp;
            setAvatarMap((prev) => ({
              ...prev,
              [c.id]: { dataUrl: r.dataUrl!, updatedAt: r.updatedAt },
            }));
          } catch {
            /* ignore */
          }
        })(),
      );
    }
    if (tasks.length) await Promise.all(tasks);
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean; notify?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const r = await api.connections.list();
      setConnections(sortConnectionsForList(r.connections));
      void syncAvatars(r.connections);
      if (opts?.notify) {
        toast.success(t('connections.refreshedN', { n: r.connections.length }));
      }
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  }, [syncAvatars]);

  /**
   * 导入连接配置。
   *
   * 语法是硬门槛：JSON.parse 过不了就直接判失败，不做任何「宽容修复」——
   * 半截文件、Excel 另存的伪 json、BOM 没清干净的都在这里被挡住。
   * 过了语法这关再交给后端，由后端按指纹决定每条是覆盖还是新增。
   */
  const runImport = useCallback(async (files: File[]) => {
    if (importing) return;
    const jsons = files.filter(isJsonFile);
    const skippedFiles = files.length - jsons.length;
    if (!jsons.length) {
      toast.error(t('connections.onlyJsonFiles'));
      return;
    }

    setImporting(true);
    let added = 0;
    let updated = 0;
    let failed = 0;

    for (const file of jsons) {
      let text: string;
      try {
        text = await file.text();
      } catch {
        failed += 1;
        toast.error(t('connections.readFailed', { name: file.name }));
        continue;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch (e) {
        failed += 1;
        toast.error(t('connections.invalidJson', { name: file.name, err: e instanceof Error ? e.message : t('connections.syntaxError') }));
        continue;
      }

      const obj = payload as { connections?: unknown } | null;
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.connections)) {
        failed += 1;
        toast.error(t('connections.notConnConfig', { name: file.name }));
        continue;
      }

      try {
        const r = await api.connections.importConfig(payload);
        if (r.ok) {
          added += r.added ?? 0;
          updated += r.updated ?? 0;
        } else {
          failed += 1;
          toast.error(resText(r) || t('connections.importFailed'));
        }
      } catch (e) {
        failed += 1;
        toast.error(errText(e));
      }
    }

    setImporting(false);
    if (added > 0 || updated > 0) await load({ silent: true });

    const parts: string[] = [];
    if (added > 0) parts.push(t('connections.addedN', { n: added }));
    if (updated > 0) parts.push(t('connections.updatedN', { n: updated }));
    if (failed > 0) parts.push(t('connections.failedN', { n: failed }));
    if (parts.length) {
      const msg = parts.join('，');
      if (failed > 0 && added === 0 && updated === 0) toast.error(msg);
      else if (failed > 0) toast.message(msg);
      else toast.success(msg);
    }
    if (skippedFiles > 0) toast.message(t('connections.ignoredN', { n: skippedFiles }));
  }, [importing, load]);

  /**
   * 整页拖拽导入：监听挂在 **window** 上，不是页面 div 上。
   *
   * 连接页是可滚动的 flow 布局（不像插件页是 fixed 撑满视口），页面 div 的高度只跟内容走
   * ——只有一两条连接时热区就那么点高，拖到空白处不触发，看着就是「拖了没反应」。
   * 挂 window 之后整个界面任意位置都能接住，遮罩也改成 fixed 铺满视口。
   */
  useEffect(() => {
    if (importing) return;
    const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types?.includes('Files'));

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current += 1;
      setDragActive(true);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // 不阻止默认行为的话，浏览器会直接把这个 json 当文件打开
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setDragActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setDragActive(false);
      const files = e.dataTransfer?.files;
      if (files?.length) void runImport(Array.from(files));
    };

    window.addEventListener('dragenter', onEnter);
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onEnter);
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [importing, runImport]);

  const handleExport = useCallback(async () => {
    try {
      const data = await api.connections.exportConfig();
      downloadJson(connectionsExportName(), data);
      toast.success(t('connections.exportedN', { n: data.connections?.length ?? 0 }));
    } catch (e) {
      toast.error(errText(e));
    }
  }, []);

  // 刷新与「添加连接」交给顶栏承载：手机与电脑同一个位置，不再在页面里各放一份
  usePageHeader(
    () => ({
      actions: (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            disabled={loading}
            title={t('connections.refresh')}
            aria-label={t('connections.refresh')}
            onClick={() => void load({ notify: true })}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            disabled={importing}
            title={t('connections.exportConfigLabel')}
            aria-label={t('connections.exportConfigLabel')}
            data-tour="connections-export"
            onClick={() => void handleExport()}
          >
            <Share2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            disabled={importing}
            title={t('connections.importConfigLabel')}
            aria-label={t('connections.importConfigLabel')}
            data-tour="connections-import"
            onClick={() => fileRef.current?.click()}
          >
            {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileInput className="h-4 w-4" />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-600 hover:bg-white/35"
            title={t('connections.addAllLabel')}
            aria-label={t('connections.addAllLabel')}
            data-tour="connections-add"
            onClick={() => setTypeModalOpen(true)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </>
      ),
    }),
    [loading, load, importing, handleExport],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api.connections.list();
        if (cancelled) return;
        setConnections(sortConnectionsForList(r.connections));
        void syncAvatars(r.connections);
      } catch (e) {
        if (!cancelled) toast.error(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [syncAvatars]);

  useEventSource((msg) => {
    if (msg.type === 'status' && (msg.data as { connections?: ConnectionStatus[] }).connections) {
      const list = (msg.data as { connections: ConnectionStatus[] }).connections;
      setConnections(sortConnectionsForList(list));
      void syncAvatars(list);
    }
  });

  const pickMode = (type: ConnectionType, mode?: ConnectionMode) => {
    const m = mode ?? 'reverse';
    setAddType(type);
    setAddMode(m);
    setTypeModalOpen(false);
    setName('');
    setHost('127.0.0.1');
    setPort(defaultPortForMode(m));
    setApiUrl('http://127.0.0.1:3000');
    setAccessToken('');
    setAppId('');
    setAppSecret('');
    setSandbox(true);
    setWebhookBaseUrl('');
    setKookToken('');
    setQqPreview(null);
    setFormModalOpen(true);
  };

  const previewQqBot = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error(t('connections.fillAppIdSecret'));
      return;
    }
    setQqPreviewing(true);
    try {
      const res = await api.connections.previewQqOfficial({
        appId: appId.trim(),
        appSecret: appSecret.trim(),
        sandbox,
      });
      if (!res.ok || !res.profile) {
        toast.error(resText(res) || t('connections.fetchProfileFailed'));
        return;
      }
      setQqPreview(res.profile);
      toast.success(t('connections.recognizedBot', { name: res.profile.username }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setQqPreviewing(false);
    }
  };

  const onAdd = async () => {
    setSubmitting(true);
    try {
      if (addType === 'kook') {
        if (!kookToken.trim()) {
          toast.error(t('connections.fillKookToken'));
          return;
        }
        await api.connections.add({
          name: name.trim() || t('connections.phKookBot'),
          type: 'kook',
          kookToken: kookToken.trim(),
        });
        toast.success(t('connections.addedKook'));
      } else if (addType === 'weixin_bot') {
        await api.connections.add({
          name: name.trim() || t('connections.phWeixinBot'),
          type: 'weixin_bot',
        });
        toast.success(t('connections.addedWeixin'));
      } else if (addType === 'qq_official') {
        if (!appId.trim() || !appSecret.trim()) {
          toast.error(t('connections.fillAppIdSecret'));
          return;
        }
        await api.connections.add({
          type: 'qq_official',
          mode: addMode === 'https' ? 'https' : undefined,
          appId: appId.trim(),
          appSecret: appSecret.trim(),
          sandbox,
          webhookBaseUrl: addMode === 'https' ? webhookBaseUrl.trim() || undefined : undefined,
        });
        toast.success(
          addMode === 'https'
            ? t('connections.addedQqHttps')
            : t('connections.addedQqWs'),
        );
      } else {
        if (!name.trim()) {
          toast.error(t('connections.enterName'));
          return;
        }
        if (needsApiUrl(addMode) && !apiUrl.trim()) {
          toast.error(t('connections.fillHttpApi'));
          return;
        }
        await api.connections.add({
          name: name.trim(),
          type: 'onebot',
          mode: addMode,
          host,
          port,
          accessToken,
          apiUrl: needsApiUrl(addMode) ? apiUrl.trim() : undefined,
        });
        toast.success(t('connections.addedConn'));
      }
      setFormModalOpen(false);
      void load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const formMeta = addFormMeta(addType, addMode);

  return (
    <div className="relative space-y-4">
      {/* 隐藏的文件选择器：顶栏「导入」按钮通过 fileRef 触发它 */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) void runImport(Array.from(files));
          e.target.value = '';
        }}
      />
      {dragActive ? (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-teal-500/10 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-teal-400/60 bg-white/70 px-6 py-4 text-center shadow-lg">
            <FileInput className="mx-auto h-8 w-8 text-teal-600" />
            <p className="mt-2 text-sm font-medium text-slate-800">{t('connections.dropToImport')}</p>
          </div>
        </div>
      ) : null}
      {/* 界面标题由顶栏显示，操作按钮也在顶栏，这里直接从列表开始 */}
      {connections.length === 0 ? (
        <div data-tour="connections-list" className="kk-card kk-stagger-item kk-stagger-2 border border-dashed border-border/80 py-16 text-center shadow-none">
          <p className="mb-4 text-sm text-muted-foreground">
            {loading ? t('label.loading') : t('connections.noConnConfig')}
          </p>
          {!loading && (
            <Button size="sm" onClick={() => setTypeModalOpen(true)}>
              <Plus className="h-3.5 w-3.5" />
              {t('connections.addFirstConn')}
            </Button>
          )}
        </div>
      ) : (
        <div data-tour="connections-list" className="kk-conn-grid">
          {connections.map((conn, index) => (
            <ConnectionCard
              key={conn.id}
              conn={conn}
              index={index}
              avatarDataUrl={avatarMap[conn.id]?.dataUrl}
              onOpen={(c) => setManageConnId(c.id)}
            />
          ))}
        </div>
      )}

      <ConnectionManageDialog
        open={!!manageConn}
        conn={manageConn}
        avatarDataUrl={manageConn ? avatarMap[manageConn.id]?.dataUrl : undefined}
        onClose={() => setManageConnId(null)}
        onSaved={async () => {
          await load({ silent: true });
        }}
        onOpenPlugins={(c) => setPluginsConn(c)}
        onOpenReconnectStrategy={(c) => setForwardConn(c)}
        onRequestDelete={(c) => setDeleteConn(c)}
        onRequestWeixinLogin={(c, enableAfter) => {
          setWeixinEnableAfterLogin(!!enableAfter);
          setWeixinLoginConn(c);
        }}
      />

      <ConnectionPluginsDialog
        open={!!pluginsConn}
        connectionId={pluginsConn?.id ?? ''}
        connectionName={pluginsConn?.name ?? ''}
        connectionType={pluginsConn?.type}
        onClose={() => setPluginsConn(null)}
      />
      <WeixinBotLoginDialog
        open={!!weixinLoginConn}
        conn={weixinLoginConn}
        onClose={() => {
          setWeixinLoginConn(null);
          setWeixinEnableAfterLogin(false);
        }}
        onLoggedIn={async (list) => {
          const connId = weixinLoginConn?.id;
          const shouldEnable = weixinEnableAfterLogin;
          setWeixinEnableAfterLogin(false);
          if (list) {
            setConnections(sortConnectionsForList(list));
            void syncAvatars(list);
          } else {
            await load({ silent: true });
          }
          if (shouldEnable && connId) {
            try {
              const r = await api.connections.toggle(connId) as {
                ok?: boolean;
                message?: string;
                enable?: boolean;
              };
              if (r && r.ok === false) {
                toast.error(resText(r) || t('connections.loginOkEnableFailed'));
                return;
              }
              toast.success(t('connections.loginOkEnabled'));
              await load({ silent: true });
            } catch (e) {
              toast.error(errText(e));
            }
          }
        }}
      />
      <ForwardReconnectDialog open={!!forwardConn} conn={forwardConn} onClose={() => setForwardConn(null)} onSaved={load} />

      <Dialog open={typeModalOpen} onOpenChange={setTypeModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('connections.selectType')}</DialogTitle>
          </DialogHeader>
          <div data-tour="conn-type-list" className="grid max-h-[70vh] gap-2 overflow-y-auto no-scrollbar">
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const title = t(opt.titleKey);
              const desc = t(opt.descKey);
              return (
                <button
                  key={`${opt.type}-${opt.mode ?? 'ws'}`}
                  type="button"
                  data-tour={opt.type === 'onebot' && (opt.mode ?? 'reverse') === 'reverse' ? 'conn-type-reverse' : undefined}
                  className="kk-btn-press flex gap-3 rounded-xl bg-white/35 p-3.5 text-left transition-colors hover:bg-white/55"
                  onClick={() => pickMode(opt.type, opt.mode)}
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block font-medium">{title}</span>
                    <span className="text-xs text-muted-foreground">{desc}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={formModalOpen} onOpenChange={setFormModalOpen}>
        <DialogContent data-tour="conn-form">
          <DialogHeader>
            <DialogTitle>{formMeta.title}</DialogTitle>
            <DialogDescription>{formMeta.desc}</DialogDescription>
          </DialogHeader>

          {addType === 'qq_official' ? (
            <div className="space-y-3">
              {qqPreview && (
                <div className="flex items-center gap-3 rounded-md border p-3">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qqPreview.avatar} alt="" className="h-12 w-12 rounded-full object-cover" />
                  <div className="min-w-0">
                    <div className="font-medium">{qqPreview.username}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {qqPreview.desc || t('connections.noIntro')}
                    </div>
                  </div>
                </div>
              )}
              <div className="space-y-2">
                <Label>AppID</Label>
                <Input value={appId} onChange={(e) => setAppId(e.target.value)} autoComplete="off" />
              </div>
              <div className="space-y-2">
                <Label>AppSecret</Label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label htmlFor="sandbox">{t('connections.sandboxEnv')}</Label>
                <Switch id="sandbox" checked={sandbox} onCheckedChange={setSandbox} />
              </div>
              {addMode === 'https' && (
                <div className="space-y-2">
                  <Label>{t('connections.publicCallbackBase')}</Label>
                  <Input
                    value={webhookBaseUrl}
                    onChange={(e) => setWebhookBaseUrl(e.target.value)}
                    placeholder="https://bot.example.com"
                    autoComplete="off"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    {t('connections.callbackHint')}
                  </p>
                </div>
              )}
              <Button variant="outline" className="w-full" onClick={previewQqBot} disabled={qqPreviewing}>
                {qqPreviewing ? t('connections.fetching') : t('connections.previewBotProfile')}
              </Button>
            </div>
          ) : addType === 'weixin_bot' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('connections.phWeixinBot')}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('connections.weixinAddHint')}
              </p>
            </div>
          ) : addType === 'kook' ? (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('connections.phKookBot')}
                />
              </div>
              <div className="space-y-2">
                <Label>{t('connections.botToken')}</Label>
                <Input
                  type="password"
                  value={kookToken}
                  onChange={(e) => setKookToken(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t('connections.kookAddHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div data-tour="conn-form-name" className="space-y-2">
                <Label>{t('label.name')}</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={
                    addMode === 'http'
                      ? t('connections.modeHttpServer')
                      : addMode === 'http_sse'
                        ? t('connections.phHttpSse')
                        : addMode === 'http_client'
                          ? t('connections.modeHttpClient')
                          : addMode === 'forward'
                            ? t('connections.modeForwardWs')
                            : t('connections.modeReverseWs')
                  }
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div data-tour="conn-form-host" className="space-y-2">
                  <Label>
                    {addMode === 'forward' || addMode === 'http_client' ? t('connections.peerAddress') : t('connections.listenAddress')}
                  </Label>
                  <Input value={host} onChange={(e) => setHost(e.target.value)} />
                </div>
                <div data-tour="conn-form-port" className="space-y-2">
                  <Label>
                    {addMode === 'forward' || addMode === 'http_client' ? t('connections.peerPort') : t('connections.listenPort')}
                  </Label>
                  <Input
                    type="number"
                    min={1}
                    max={65535}
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || defaultPortForMode(addMode))}
                  />
                </div>
              </div>
              {needsApiUrl(addMode) && (
                <div className="space-y-2">
                  <Label>{t('connections.httpApiAddress')}</Label>
                  <Input
                    value={apiUrl}
                    onChange={(e) => setApiUrl(e.target.value)}
                    placeholder="http://127.0.0.1:3000"
                  />
                </div>
              )}
              {addMode === 'http_client' && (
                <p className="text-xs text-muted-foreground">
                  {t('connections.httpClientHint')}
                </p>
              )}
              {addMode === 'http_sse' && (
                <p className="text-xs text-muted-foreground">
                  {t('connections.httpSseHint')}
                </p>
              )}
              <div data-tour="conn-form-token" className="space-y-2">
                <Label>{t('connections.accessTokenOptional')}</Label>
                <Input
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  autoComplete="off"
                />
              </div>
            </div>
          )}

          <DialogFooter className="!flex-row !justify-center gap-3 space-x-0 sm:!flex-row sm:!justify-center sm:space-x-0">
            <Button variant="outline" data-tour="conn-form-cancel" className="min-w-0 flex-1" onClick={() => setFormModalOpen(false)}>
              {t('btn.cancel')}
            </Button>
            <Button className="min-w-0 flex-1" data-tour="conn-form-submit" onClick={onAdd} disabled={submitting}>
              {t('btn.add')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteConn} onOpenChange={(v) => !v && setDeleteConn(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connections.confirmDeleteConn')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connections.deleteDesc', { name: deleteConn?.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            <AlertDialogCancel>{t('btn.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                if (!deleteConn) return;
                const id = deleteConn.id;
                try {
                  await api.connections.remove(id);
                  toast.success(t('connections.deletedName', { name: deleteConn.name }));
                  setDeleteConn(null);
                  setManageConnId((cur) => (cur === id ? null : cur));
                  setAvatarMap((prev) => {
                    if (!(id in prev)) return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                  });
                  delete avatarMetaRef.current[id];
                  await load();
                } catch (e) {
                  toast.error(errText(e));
                }
              }}
            >
              {t('btn.delete')}
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!deleteConn) return;
                const id = deleteConn.id;
                try {
                  await api.connections.remove(id, { clearData: true });
                  toast.success(t('connections.deletedAndCleared', { name: deleteConn.name }));
                  setDeleteConn(null);
                  setManageConnId((cur) => (cur === id ? null : cur));
                  setAvatarMap((prev) => {
                    if (!(id in prev)) return prev;
                    const next = { ...prev };
                    delete next[id];
                    return next;
                  });
                  delete avatarMetaRef.current[id];
                  await load();
                } catch (e) {
                  toast.error(errText(e));
                }
              }}
            >
              {t('connections.deleteAndClear')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
