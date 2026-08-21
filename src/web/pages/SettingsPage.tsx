import { FormEvent, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ExternalLink, Loader2, RotateCcw, Save } from 'lucide-react';
import { toast } from 'sonner';
import { api, setStoredToken } from '@/lib/api';
import type { KakakeConfig, LogLevel } from '@/lib/types';
import { DEFAULT_KAKAKE_CONFIG } from '@/lib/types';
import { PLUGIN_STORE_OFFICIAL_URL } from '@/lib/plugin-store-origin';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QuietExternal } from '@/components/quiet-link';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

const LOG_LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'Debug · 调试',
  info: 'Info · 信息',
  warn: 'Warn · 警告',
  error: 'Error · 错误',
};

function SettingsCard({
  title,
  description,
  children,
  className,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'kk-glass flex h-full flex-col rounded-[1.25rem] p-5 sm:p-6',
        className,
      )}
    >
      <header className="mb-5 shrink-0">
        <h2 className="text-lg font-semibold tracking-tight text-slate-800">{title}</h2>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-slate-400">{description}</p>
        ) : null}
      </header>
      <div className="min-w-0 flex-1 space-y-4">{children}</div>
    </section>
  );
}

function FormRow({
  label,
  htmlFor,
  hint,
  error,
  children,
  align = 'center',
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  error?: string;
  children: ReactNode;
  align?: 'center' | 'start';
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-2 sm:flex-row sm:gap-4',
        align === 'center' ? 'sm:items-center' : 'sm:items-start',
      )}
    >
      <Label
        htmlFor={htmlFor}
        className="w-full shrink-0 text-sm font-medium text-slate-600 sm:w-32 sm:pt-0"
      >
        {label}
      </Label>
      <div className="min-w-0 flex-1 space-y-1.5">
        {children}
        {error ? (
          <p className="text-xs font-medium text-rose-500">{error}</p>
        ) : hint ? (
          <p className="text-xs text-slate-400">{hint}</p>
        ) : null}
      </div>
    </div>
  );
}

export default function SettingsPage() {
  const [config, setConfig] = useState<KakakeConfig>(DEFAULT_KAKAKE_CONFIG);
  const [defaults, setDefaults] = useState<KakakeConfig>(DEFAULT_KAKAKE_CONFIG);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [portText, setPortText] = useState('8787');
  const [timeoutText, setTimeoutText] = useState('120');
  const [loading, setLoading] = useState(true);
  const [portTouched, setPortTouched] = useState(false);
  const [timeoutTouched, setTimeoutTouched] = useState(false);

  useEffect(() => {
    api.settings
      .get()
      .then((r) => {
        setDefaults(r.defaults ?? DEFAULT_KAKAKE_CONFIG);
        setConfig(r.config);
        setPortText(String(r.config.port ?? 8787));
        setTimeoutText(String(Math.round((r.config.apiTimeoutMs ?? 120000) / 1000)));
      })
      .catch((e) => toast.error(String(e)))
      .finally(() => setLoading(false));
  }, []);

  const portError = useMemo(() => {
    if (!portTouched && !saving) return '';
    if (!/^\d+$/.test(portText.trim())) return '请输入有效数字';
    const n = Number(portText);
    if (n < 1 || n > 65535) return '端口须在 1–65535 之间';
    return '';
  }, [portText, portTouched, saving]);

  const timeoutError = useMemo(() => {
    if (!timeoutTouched && !saving) return '';
    if (!/^\d+$/.test(timeoutText.trim())) return '请输入有效数字';
    const n = Number(timeoutText);
    if (n < 5 || n > 600) return '超时时间需在 5–600 秒范围内';
    return '';
  }, [timeoutText, timeoutTouched, saving]);

  const onSave = async (e: FormEvent) => {
    e.preventDefault();
    setPortTouched(true);
    setTimeoutTouched(true);

    if (!/^\d+$/.test(portText.trim()) || Number(portText) < 1 || Number(portText) > 65535) {
      toast.error('请修正端口后再保存');
      return;
    }
    if (!/^\d+$/.test(timeoutText.trim()) || Number(timeoutText) < 5 || Number(timeoutText) > 600) {
      toast.error('请修正超时时间后再保存');
      return;
    }

    const port = Number(portText);
    const timeoutSec = Number(timeoutText);
    setSaving(true);
    try {
      const res = await api.settings.save({
        ...config,
        host: config.host?.trim() || '0.0.0.0',
        token: '',
        port,
        apiTimeoutMs: timeoutSec * 1000,
      });
      setConfig(res.config);
      setPortText(String(res.config.port));
      setTimeoutText(String(Math.round((res.config.apiTimeoutMs ?? 120000) / 1000)));
      setStoredToken('');
      toast.success('保存成功，请重启服务后端口/地址变更才会生效');
    } catch (err) {
      toast.error(String(err));
    } finally {
      setSaving(false);
    }
  };

  const onReset = async () => {
    setResetting(true);
    try {
      const res = await api.settings.reset();
      setConfig(res.config);
      setPortText(String(res.config.port));
      setTimeoutText(String(Math.round((res.config.apiTimeoutMs ?? 120000) / 1000)));
      setPortTouched(false);
      setTimeoutTouched(false);
      setStoredToken('');
      toast.success('已恢复默认设置（登录密码保持不变）');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex w-full items-center gap-2 py-16 text-sm text-slate-400">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-6 lg:gap-8">
      <div className="kk-stagger-item kk-stagger-slow-1 hidden shrink-0 md:block">
        <h1 className="kk-page-title">系统设置</h1>
      </div>

      <form
        id="kakake-settings-form"
        onSubmit={onSave}
        className="relative flex min-h-0 flex-1 flex-col gap-6 pb-24 md:pb-0 lg:gap-8"
        noValidate
      >
        <div className="grid flex-1 grid-cols-1 content-start gap-6 lg:grid-cols-2 lg:gap-8">
          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-2"
            title="监听地址"
            description={`默认 ${defaults.host}:${defaults.port}，修改后需重启咔咔珂`}
          >
            <div className="space-y-4">
              <FormRow
                label="监听地址"
                htmlFor="host"
                hint="0.0.0.0 表示允许所有网卡访问"
              >
                <Input
                  id="host"
                  value={config.host}
                  onChange={(e) => setConfig((c) => ({ ...c, host: e.target.value }))}
                  placeholder="0.0.0.0"
                  autoComplete="off"
                />
              </FormRow>
              <FormRow
                label="后台端口"
                htmlFor="port"
                hint={!portError ? '范围 1–65535' : undefined}
                error={portError || undefined}
              >
                <Input
                  id="port"
                  inputMode="numeric"
                  autoComplete="off"
                  value={portText}
                  aria-invalid={portError ? true : undefined}
                  onChange={(e) => {
                    setPortText(e.target.value);
                    setPortTouched(true);
                  }}
                  onBlur={() => setPortTouched(true)}
                  placeholder="8787"
                />
              </FormRow>
            </div>
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-3"
            title="运行参数"
            description={`默认日志 ${defaults.logLevel} · API 超时 ${Math.round((defaults.apiTimeoutMs ?? 120000) / 1000)} 秒`}
          >
            <div className="space-y-4">
              <FormRow label="日志级别" htmlFor="logLevel">
                <Select
                  value={config.logLevel}
                  onValueChange={(v) => setConfig((c) => ({ ...c, logLevel: v as LogLevel }))}
                >
                  <SelectTrigger id="logLevel" aria-label="日志级别">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(['debug', 'info', 'warn', 'error'] as const).map((v) => (
                      <SelectItem key={v} value={v}>
                        {LOG_LEVEL_LABEL[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormRow>
              <FormRow
                label="API 超时"
                htmlFor="timeout"
                hint={!timeoutError ? '单位：秒，修改后立即生效' : undefined}
                error={timeoutError || undefined}
              >
                <Input
                  id="timeout"
                  inputMode="numeric"
                  autoComplete="off"
                  value={timeoutText}
                  aria-invalid={timeoutError ? true : undefined}
                  onChange={(e) => {
                    setTimeoutText(e.target.value);
                    setTimeoutTouched(true);
                  }}
                  onBlur={() => setTimeoutTouched(true)}
                  placeholder="120"
                />
              </FormRow>
            </div>
          </SettingsCard>

          <SettingsCard
            className="kk-stagger-item kk-stagger-slow-3 lg:col-span-2"
            title="资源官网"
            description="咔咔插件资源站，可在浏览器中浏览与下载"
          >
            <QuietExternal
              href={PLUGIN_STORE_OFFICIAL_URL}
              className="inline-flex w-full items-center gap-2 rounded-xl border border-white/40 bg-white/20 px-3.5 py-2.5 text-sm text-teal-700 backdrop-blur-sm transition-colors hover:bg-white/30 hover:text-teal-800"
            >
              <ExternalLink className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{PLUGIN_STORE_OFFICIAL_URL}</span>
            </QuietExternal>
          </SettingsCard>
        </div>

        {/* 桌面：底部常规按钮 */}
        <div className="kk-stagger-item kk-stagger-slow-4 hidden shrink-0 flex-col-reverse gap-3 border-t border-white/40 pt-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3 md:flex">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                disabled={resetting || saving}
                className="h-11 rounded-xl px-5 text-slate-600"
              >
                {resetting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                恢复默认
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>恢复默认设置？</AlertDialogTitle>
                <AlertDialogDescription>
                  将恢复为监听 {defaults.host}:{defaults.port}，日志 {defaults.logLevel}；登录密码不会被清空。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction onClick={onReset}>确认恢复</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          <Button
            type="submit"
            disabled={saving || resetting}
            className="h-11 rounded-xl px-6 text-[15px] shadow-md active:scale-95"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {saving ? '保存中…' : '保存设置'}
          </Button>
        </div>

        {/* 手机：右下角悬浮圆钮（portal 避免被滚动容器裁切） */}
        {typeof document !== 'undefined'
          ? createPortal(
              <div
                className="pointer-events-none fixed z-40 flex flex-col items-center gap-3 md:hidden"
                style={{
                  right: 'max(1rem, env(safe-area-inset-right, 0px))',
                  bottom: 'calc(var(--mobile-nav-h) + var(--safe-bottom) + 1rem)',
                }}
              >
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <button
                      type="button"
                      disabled={resetting || saving}
                      title="恢复默认"
                      className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-white/45 bg-white/35 text-slate-600 shadow-lg shadow-slate-300/40 backdrop-blur-md transition active:scale-95 disabled:opacity-50"
                    >
                      {resetting ? <Loader2 className="h-5 w-5 animate-spin" /> : <RotateCcw className="h-5 w-5" />}
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>恢复默认设置？</AlertDialogTitle>
                      <AlertDialogDescription>
                        将恢复为监听 {defaults.host}:{defaults.port}，日志 {defaults.logLevel}；登录密码不会被清空。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>取消</AlertDialogCancel>
                      <AlertDialogAction onClick={onReset}>确认恢复</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <button
                  type="button"
                  disabled={saving || resetting}
                  title="保存设置"
                  onClick={() => {
                    const form = document.getElementById('kakake-settings-form') as HTMLFormElement | null;
                    form?.requestSubmit();
                  }}
                  className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full border border-teal-400/40 bg-teal-500/90 text-white shadow-lg shadow-teal-500/35 backdrop-blur-md transition active:scale-95 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-5 w-5 animate-spin" /> : <Save className="h-5 w-5" />}
                </button>
              </div>,
              document.body,
            )
          : null}
      </form>
    </div>
  );
}
