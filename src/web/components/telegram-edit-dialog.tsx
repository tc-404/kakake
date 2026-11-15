import { useEffect, useState, type ReactNode } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, type TelegramConnectionConfig } from '@/lib/api';
import type { ConnectionStatus } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { errText, resText } from '@/lib/server-error';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * Telegram Bot 连接配置（UI 状态）。
 *
 * 比后端 ConnectionConfig 更适合表单：数字用 number、allowed_updates 用逗号分隔字符串，
 * 保存时由 telegramConfigToBody 转成后端要的形状。密钥类字段留空 = 不修改。
 * 这个形状被「添加表单」和「编辑对话框」共用，避免两处字段各写一份。
 */
export interface TelegramConfigValues {
  telegramToken: string;
  telegramMode: 'polling' | 'webhook';
  telegramApiBase: string;
  telegramTestEnv: boolean;
  telegramWebhookUrl: string;
  telegramWebhookSecret: string;
  telegramProxyUrl: string;
  telegramPollingTimeout: number;
  telegramPollingLimit: number;
  telegramAllowedUpdates: string;
  telegramDropPendingUpdates: boolean;
  telegramWebhookMaxConnections: number;
  telegramWebhookIpAddress: string;
  telegramWebhookCertificatePath: string;
  telegramParseMode: 'HTML' | 'MarkdownV2' | 'Markdown';
  telegramWebhookReplyInResponse: boolean;
  telegramOffset: number;
}

export const DEFAULT_TELEGRAM_CONFIG: TelegramConfigValues = {
  telegramToken: '',
  telegramMode: 'polling',
  telegramApiBase: 'https://api.telegram.org',
  telegramTestEnv: false,
  telegramWebhookUrl: '',
  telegramWebhookSecret: '',
  telegramProxyUrl: '',
  telegramPollingTimeout: 30,
  telegramPollingLimit: 100,
  telegramAllowedUpdates: '',
  telegramDropPendingUpdates: false,
  telegramWebhookMaxConnections: 40,
  telegramWebhookIpAddress: '',
  telegramWebhookCertificatePath: '',
  telegramParseMode: 'HTML',
  telegramWebhookReplyInResponse: false,
  telegramOffset: 0,
};

/** 从连接状态初始化编辑表单：状态接口回传的字段才灌，其余用默认值；密钥绝不回显。 */
export function telegramConfigFromConn(conn: ConnectionStatus | null): TelegramConfigValues {
  if (!conn) return { ...DEFAULT_TELEGRAM_CONFIG };
  const mode: TelegramConfigValues['telegramMode'] =
    conn.telegramMode === 'webhook' || conn.mode === 'webhook' ? 'webhook' : 'polling';
  return {
    ...DEFAULT_TELEGRAM_CONFIG,
    telegramMode: mode,
    telegramApiBase: conn.telegramApiBase || DEFAULT_TELEGRAM_CONFIG.telegramApiBase,
    telegramTestEnv: conn.telegramTestEnv === true,
    telegramWebhookUrl: conn.telegramWebhookUrl || '',
    telegramAllowedUpdates: (conn.telegramAllowedUpdates ?? []).join(','),
  };
}

/** UI 状态 → 后端 update/add body（字段名与 ConnectionConfig 契约一致）。 */
export function telegramConfigToBody(
  v: TelegramConfigValues,
): TelegramConnectionConfig & { mode: 'polling' | 'webhook' } {
  const allowed = v.telegramAllowedUpdates
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const body: TelegramConnectionConfig & { mode: 'polling' | 'webhook' } = {
    mode: v.telegramMode,
    telegramMode: v.telegramMode,
    telegramApiBase: v.telegramApiBase.trim() || DEFAULT_TELEGRAM_CONFIG.telegramApiBase,
    telegramTestEnv: v.telegramTestEnv,
    telegramWebhookUrl: v.telegramWebhookUrl.trim(),
    telegramPollingTimeout: v.telegramPollingTimeout,
    telegramPollingLimit: v.telegramPollingLimit,
    telegramAllowedUpdates: allowed,
    telegramDropPendingUpdates: v.telegramDropPendingUpdates,
    telegramWebhookMaxConnections: v.telegramWebhookMaxConnections,
    telegramWebhookIpAddress: v.telegramWebhookIpAddress.trim(),
    telegramWebhookCertificatePath: v.telegramWebhookCertificatePath.trim(),
    telegramParseMode: v.telegramParseMode,
    telegramWebhookReplyInResponse: v.telegramWebhookReplyInResponse,
    telegramOffset: v.telegramOffset,
    telegramProxyUrl: v.telegramProxyUrl.trim(),
  };
  // 密钥类字段留空表示不修改（新增时 token 必填，由 requireToken 校验保证非空）
  if (v.telegramToken.trim()) body.telegramToken = v.telegramToken.trim();
  if (v.telegramWebhookSecret.trim()) body.telegramWebhookSecret = v.telegramWebhookSecret.trim();
  return body;
}

/**
 * 保存前校验：返回 i18n key（由调用方 t() 取文案），通过返回 null。
 * requireToken = 新增连接时必须填 Token；编辑时留空表示沿用旧值。
 */
export function validateTelegramConfig(v: TelegramConfigValues, requireToken: boolean): string | null {
  if (requireToken && !v.telegramToken.trim()) return 'connections.fillTelegramToken';
  if (v.telegramWebhookSecret.trim() && !/^[A-Za-z0-9_-]{1,256}$/.test(v.telegramWebhookSecret.trim())) {
    return 'connections.tg.invalidSecret';
  }
  if (v.telegramMode === 'webhook' && !/^https?:\/\/\S+/i.test(v.telegramWebhookUrl.trim())) {
    return 'connections.tg.invalidWebhookUrl';
  }
  if (
    !Number.isFinite(v.telegramPollingTimeout) || v.telegramPollingTimeout < 0
    || !Number.isFinite(v.telegramPollingLimit) || v.telegramPollingLimit < 1 || v.telegramPollingLimit > 100
    || !Number.isFinite(v.telegramWebhookMaxConnections)
    || v.telegramWebhookMaxConnections < 1 || v.telegramWebhookMaxConnections > 100000
  ) {
    return 'connections.tg.invalidNumber';
  }
  return null;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ToggleRow({
  label, hint, checked, disabled, onCheckedChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 px-3 py-2">
      <div className="min-w-0">
        <Label className="text-xs">{label}</Label>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * Telegram 专用字段集：添加表单（ConnectionsPage）与编辑对话框共用。
 * 三种对接方式都在这里配置：polling / webhook 单选 + 本地 Bot API Server（API 基址）。
 */
export function TelegramFields({
  values,
  onChange,
  disabled,
  onVerified,
}: {
  values: TelegramConfigValues;
  onChange: (patch: Partial<TelegramConfigValues>) => void;
  disabled?: boolean;
  /** 验证（测试连接）成功后的回调，由父组件决定是否自动启用连接 */
  onVerified?: (profile: { username: string; first_name?: string }) => void | Promise<void>;
}) {
  const t = useT();
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ username: string; first_name?: string } | null>(null);

  const patch = (p: Partial<TelegramConfigValues>) => onChange(p);

  const onVerify = async () => {
    const token = values.telegramToken.trim();
    if (!token) {
      toast.error(t('connections.tg.tokenRequired'));
      return;
    }
    setPreviewing(true);
    try {
      const res = await api.connections.previewTelegramBot({
        token,
        apiBase: values.telegramApiBase.trim() || undefined,
        testEnv: values.telegramTestEnv,
      });
      if (!res.ok || !res.profile) {
        toast.error(resText(res) || t('connections.tg.verifyFailed'));
        return;
      }
      setPreview({ username: res.profile.username, first_name: res.profile.first_name });
      toast.success(t('connections.tg.verifiedAs', { name: res.profile.username }));
      // 验证通过即视为可用：交给父组件决定是否自动启用，避免「测试连接通过
      // 却仍在连接管理中显示未启用」的困惑。
      await onVerified?.(res.profile);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setPreviewing(false);
    }
  };

  return (
    <div className="space-y-3">
      {/* Bot Token + 验证 */}
      <Field label={t('connections.tg.token')} hint={t('connections.tg.tokenPlaceholder')}>
        <div className="flex gap-2">
          <Input
            type="password"
            value={values.telegramToken}
            disabled={disabled}
            onChange={(e) => patch({ telegramToken: e.target.value })}
            autoComplete="new-password"
          />
          <Button
            type="button"
            variant="outline"
            className="shrink-0"
            disabled={disabled || previewing}
            onClick={() => void onVerify()}
          >
            {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {previewing ? t('connections.tg.verifying') : t('connections.tg.verify')}
          </Button>
        </div>
      </Field>
      {preview && (
        <div className="flex items-center gap-2 rounded-md border border-emerald-300/60 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-800">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
          <span className="font-medium">@{preview.username}</span>
          {preview.first_name && <span className="text-muted-foreground">· {preview.first_name}</span>}
        </div>
      )}

      {/* 接入方式 */}
      <Field
        label={t('connections.tg.mode')}
        hint={values.telegramMode === 'polling' ? t('connections.tg.modePollingHint') : t('connections.tg.modeWebhookHint')}
      >
        <div className="grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant={values.telegramMode === 'polling' ? 'default' : 'outline'}
            aria-pressed={values.telegramMode === 'polling'}
            disabled={disabled}
            onClick={() => patch({ telegramMode: 'polling' })}
          >
            {t('connections.tg.modePolling')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={values.telegramMode === 'webhook' ? 'default' : 'outline'}
            aria-pressed={values.telegramMode === 'webhook'}
            disabled={disabled}
            onClick={() => patch({ telegramMode: 'webhook' })}
          >
            {t('connections.tg.modeWebhook')}
          </Button>
        </div>
      </Field>

      {/* Webhook 专属字段 */}
      {values.telegramMode === 'webhook' && (
        <>
          <Field label={t('connections.tg.webhookUrl')} hint={t('connections.tg.webhookUrlHint')}>
            <Input
              value={values.telegramWebhookUrl}
              disabled={disabled}
              onChange={(e) => patch({ telegramWebhookUrl: e.target.value })}
              placeholder={t('connections.tg.webhookUrlPlaceholder')}
              autoComplete="off"
            />
          </Field>
          <Field label={t('connections.tg.secret')} hint={t('connections.tg.secretHint')}>
            <Input
              type="password"
              value={values.telegramWebhookSecret}
              disabled={disabled}
              onChange={(e) => patch({ telegramWebhookSecret: e.target.value })}
              placeholder={t('connections.tg.secretPlaceholder')}
              autoComplete="new-password"
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('connections.tg.maxConnections')} hint={t('connections.tg.maxConnectionsHint')}>
              <Input
                type="number"
                min={1}
                max={100000}
                value={values.telegramWebhookMaxConnections}
                disabled={disabled}
                onChange={(e) => patch({ telegramWebhookMaxConnections: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label={t('connections.tg.ipAddress')}>
              <Input
                value={values.telegramWebhookIpAddress}
                disabled={disabled}
                onChange={(e) => patch({ telegramWebhookIpAddress: e.target.value })}
                placeholder={t('connections.tg.ipAddressPlaceholder')}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field label={t('connections.tg.certPath')} hint={t('connections.tg.certPathHint')}>
            <Input
              value={values.telegramWebhookCertificatePath}
              disabled={disabled}
              onChange={(e) => patch({ telegramWebhookCertificatePath: e.target.value })}
              placeholder={t('connections.tg.certPathPlaceholder')}
              autoComplete="off"
            />
          </Field>
          <ToggleRow
            label={t('connections.tg.replyInResponse')}
            hint={t('connections.tg.replyInResponseHint')}
            checked={values.telegramWebhookReplyInResponse}
            disabled={disabled}
            onCheckedChange={(v) => patch({ telegramWebhookReplyInResponse: v })}
          />
        </>
      )}

      {/* 长轮询专属字段 */}
      {values.telegramMode === 'polling' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('connections.tg.pollingTimeout')}>
            <Input
              type="number"
              min={0}
              value={values.telegramPollingTimeout}
              disabled={disabled}
              onChange={(e) => patch({ telegramPollingTimeout: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={t('connections.tg.pollingLimit')} hint={t('connections.tg.pollingLimitHint')}>
            <Input
              type="number"
              min={1}
              max={100}
              value={values.telegramPollingLimit}
              disabled={disabled}
              onChange={(e) => patch({ telegramPollingLimit: Number(e.target.value) || 0 })}
            />
          </Field>
          <Field label={t('connections.tg.offset')}>
            <Input
              type="number"
              min={0}
              value={values.telegramOffset}
              disabled={disabled}
              onChange={(e) => patch({ telegramOffset: Number(e.target.value) || 0 })}
            />
          </Field>
        </div>
      )}

      {/* 通用字段 */}
      <Field label={t('connections.tg.apiBase')} hint={t('connections.tg.apiBaseHint')}>
        <Input
          value={values.telegramApiBase}
          disabled={disabled}
          onChange={(e) => patch({ telegramApiBase: e.target.value })}
          placeholder={t('connections.tg.apiBasePlaceholder')}
          autoComplete="off"
        />
      </Field>
      <Field label={t('connections.tg.proxy')}>
        <Input
          value={values.telegramProxyUrl}
          disabled={disabled}
          onChange={(e) => patch({ telegramProxyUrl: e.target.value })}
          placeholder={t('connections.tg.proxyPlaceholder')}
          autoComplete="off"
        />
      </Field>
      <Field label={t('connections.tg.allowedUpdates')} hint={t('connections.tg.allowedUpdatesHint')}>
        <Input
          value={values.telegramAllowedUpdates}
          disabled={disabled}
          onChange={(e) => patch({ telegramAllowedUpdates: e.target.value })}
          placeholder={t('connections.tg.allowedUpdatesPlaceholder')}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label={t('connections.tg.parseMode')} hint={t('connections.tg.parseModeHint')}>
        <Select
          value={values.telegramParseMode}
          onValueChange={(v) => patch({ telegramParseMode: v as TelegramConfigValues['telegramParseMode'] })}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="HTML">HTML</SelectItem>
            <SelectItem value="MarkdownV2">MarkdownV2</SelectItem>
            <SelectItem value="Markdown">Markdown</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <ToggleRow
        label={t('connections.tg.testEnv')}
        hint={t('connections.tg.testEnvHint')}
        checked={values.telegramTestEnv}
        disabled={disabled}
        onCheckedChange={(v) => patch({ telegramTestEnv: v })}
      />
      <ToggleRow
        label={t('connections.tg.dropPending')}
        hint={t('connections.tg.dropPendingHint')}
        checked={values.telegramDropPendingUpdates}
        disabled={disabled}
        onCheckedChange={(v) => patch({ telegramDropPendingUpdates: v })}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-all text-right font-mono text-[11px]">{value}</span>
    </div>
  );
}

/**
 * Telegram Bot 连接编辑对话框。
 * 保存走与其它编辑对话框相同的 api.connections.update，字段名按 ConnectionConfig 契约。
 */
export function TelegramEditDialog({
  open,
  conn,
  onClose,
  onSaved,
}: {
  open: boolean;
  conn: ConnectionStatus | null;
  onClose: () => void;
  onSaved?: () => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [values, setValues] = useState<TelegramConfigValues>({ ...DEFAULT_TELEGRAM_CONFIG });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !conn) return;
    setName(conn.name || '');
    setValues(telegramConfigFromConn(conn));
    setError('');
    // 只在打开或切换连接时灌表单；SSE 每 3s 换新对象不能回写输入
    // eslint-disable-next-line react-hooks/exhaustive-deps -- conn 快照仅用于初始化
  }, [open, conn?.id]);

  const onSave = async () => {
    if (!conn) return;
    const errKey = validateTelegramConfig(values, false);
    if (errKey) {
      setError(t(errKey));
      return;
    }
    if (!name.trim()) {
      setError(t('connections.enterName'));
      return;
    }
    setError('');
    setSaving(true);
    try {
      const res = await api.connections.update(conn.id, {
        name: name.trim(),
        ...telegramConfigToBody(values),
        // 状态接口不回传机器人身份明文，编辑时把已有值原样带回，避免被清空
        ...(conn.telegramBotUserId ? { telegramBotUserId: conn.telegramBotUserId } : {}),
        ...(conn.telegramBotUsername ? { telegramBotUsername: conn.telegramBotUsername } : {}),
      });
      if (res && res.ok === false) {
        setError(resText(res) || t('connections.tg.saveFailed'));
        return;
      }
      toast.success(t('connections.tg.saved'));
      await onSaved?.();
      onClose();
    } catch (e) {
      setError(errText(e) || t('connections.tg.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // 验证（测试连接）成功后的处理：若当前未启用，自动启用并启动连接，
  // 解决「测试通过却仍在连接管理中显示未启用」的困惑。
  const onVerified = async (profile: { username: string; first_name?: string }) => {
    if (!conn) return;
    if (conn.enable) return;
    try {
      const r = await api.connections.toggle(conn.id) as { ok?: boolean; message?: string };
      if (r && r.ok === false) {
        toast.error(
          t('connections.tg.enableAfterVerifyFailed', { msg: resText(r) || t('connections.operationFailed') }),
        );
        return;
      }
      toast.success(t('connections.tg.verifiedAndEnabled', { name: profile.username }));
      await onSaved?.();
    } catch (e) {
      toast.error(t('connections.tg.enableAfterVerifyFailed', { msg: errText(e) }));
    }
  };

  // 启用 / 停用开关：Telegram 卡片点开的是编辑弹窗，没有「管理弹窗」里的开关，
  // 因此这里直接提供开关，让用户无需绕路即可启停连接。
  const onToggleEnable = async () => {
    if (!conn) return;
    setSaving(true);
    try {
      const r = await api.connections.toggle(conn.id) as { ok?: boolean; message?: string };
      if (r && r.ok === false) {
        toast.error(resText(r) || t('connections.operationFailed'));
        return;
      }
      toast.success(conn.enable ? t('connections.connDisabled') : t('connections.connEnabled'));
      await onSaved?.();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('connections.tg.editTitle', { name: conn?.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('connections.tg.editDesc')}</DialogDescription>
        </DialogHeader>

        {conn && (
          <div data-tour="conn-dialog-enable" className="flex items-center justify-between gap-3 rounded-xl border bg-muted/20 p-3">
            <div>
              <div className="text-sm font-medium">{t('connections.tg.enableTitle')}</div>
              <div className="text-xs text-muted-foreground">
                {conn.enable ? t('connections.tg.enabledHint') : t('connections.tg.disabledHint')}
              </div>
            </div>
            <Switch
              checked={conn.enable}
              disabled={saving}
              aria-label={conn.enable ? t('connections.ariaDisable') : t('connections.ariaEnable')}
              onCheckedChange={() => void onToggleEnable()}
            />
          </div>
        )}

        {conn && (
          <div className="space-y-3">
            {/* 机器人身份（只读）+ Webhook 诊断（仅 Webhook 模式） */}
            <div className="space-y-1.5 rounded-xl border bg-muted/20 p-3 text-xs">
              <div className="font-medium">{t('connections.tg.infoTitle')}</div>
              <InfoRow
                label={t('connections.tg.infoUsername')}
                value={conn.telegramBotUsername
                  ? `@${conn.telegramBotUsername}`
                  : conn.telegramBotUserId || t('connections.tg.dash')}
              />
              <InfoRow
                label={t('connections.tg.infoMode')}
                value={conn.telegramMode === 'webhook'
                  ? t('connections.tg.badgeWebhook')
                  : t('connections.tg.badgePolling')}
              />
              {conn.telegramMode === 'webhook' && (
                <>
                  <InfoRow
                    label={t('connections.tg.infoWebhookUrl')}
                    value={conn.telegramWebhookInfo?.url || conn.telegramWebhookUrl || t('connections.tg.dash')}
                  />
                  {typeof conn.telegramWebhookInfo?.pending_update_count === 'number' && (
                    <InfoRow
                      label="pending_update_count"
                      value={t('connections.tg.infoWebhookPending', { n: conn.telegramWebhookInfo.pending_update_count })}
                    />
                  )}
                  {conn.telegramWebhookInfo?.last_error_message && (
                    <p className="text-[11px] text-destructive">
                      {t('connections.tg.infoWebhookError', { msg: conn.telegramWebhookInfo.last_error_message })}
                    </p>
                  )}
                  {conn.telegramWebhookInfo?.has_custom_certificate && (
                    <p className="text-[11px] text-muted-foreground">{t('connections.tg.infoCustomCert')}</p>
                  )}
                </>
              )}
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">{t('label.name')}</Label>
              <Input value={name} disabled={saving} onChange={(e) => setName(e.target.value)} />
            </div>

            <TelegramFields
              values={values}
              onChange={(p) => setValues((prev) => ({ ...prev, ...p }))}
              disabled={saving}
              onVerified={onVerified}
            />

            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter className="!flex-row !justify-center gap-3 space-x-0 sm:!flex-row sm:!justify-center sm:space-x-0">
          <Button variant="outline" className="min-w-0 flex-1" onClick={onClose} disabled={saving}>
            {t('btn.cancel')}
          </Button>
          <Button className="min-w-0 flex-1" onClick={() => void onSave()} disabled={saving || !conn}>
            {saving ? t('connections.tg.saving') : t('connections.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
