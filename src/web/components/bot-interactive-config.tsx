import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Plus, Trash2, RefreshCw, Save, Loader2, ListTree, LayoutPanelTop, ChevronRight,
} from 'lucide-react';
import { api } from '@/lib/api';
import { useT } from '@/lib/i18n';
import type {
  MenuItem, MenuItemType, MenuSubItem, PanelItem, PanelRecord, PanelScope,
} from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { errText, resText } from '@/lib/server-error';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';

/**
 * 自定义菜单与指令面板配置。
 * 接口与字段完全按 https://bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel/
 */

const MENU_TYPES: Array<{ value: MenuItemType; i18nKey: string }> = [
  { value: 'send_message', i18nKey: 'open-platform.interactive.menuSendMessage' },
  { value: 'link', i18nKey: 'open-platform.interactive.menuLink' },
  { value: 'switch', i18nKey: 'open-platform.interactive.menuSwitch' },
  { value: 'menu', i18nKey: 'open-platform.interactive.menuSubmenu' },
];

const SCOPES: Array<{ value: PanelScope; i18nKey: string }> = [
  { value: 'c2c', i18nKey: 'open-platform.interactive.scopeC2c' },
  { value: 'group', i18nKey: 'open-platform.interactive.scopeGroup' },
  { value: 'channel', i18nKey: 'open-platform.interactive.scopeChannel' },
  { value: 'dm', i18nKey: 'open-platform.interactive.scopeDm' },
];

const MENU_MAX = 10;
const SUB_MENU_MAX = 5;
const PANEL_ITEM_MAX = 20;

function blankMenuItem(type: MenuItemType = 'send_message'): MenuItem {
  const base: MenuItem = { name: '', type };
  if (type === 'send_message') base.send_message = '';
  if (type === 'link') base.link = '';
  if (type === 'switch') base.switch = { switch_id: '', default: false };
  if (type === 'menu') base.sub_menu_items = [];
  return base;
}

function blankPanelItem(type: 'command' | 'link' = 'command'): PanelItem {
  return type === 'link' ? { name: '', type, desc: '', link: '' } : { name: '', type, desc: '' };
}

function fieldRow(label: string, hint: string, children: React.ReactNode) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-[11px] text-slate-500">
        {label}
        <span className="text-slate-400">{hint}</span>
      </span>
      {children}
    </label>
  );
}

/* ------------------------------ 自定义菜单 ------------------------------ */

function MenuItemEditor({
  item,
  index,
  onChange,
  onRemove,
}: {
  item: MenuItem;
  index: number;
  onChange: (next: MenuItem) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const type = item.type ?? 'send_message';
  const subs = item.sub_menu_items ?? [];

  return (
    <div className="rounded-xl border border-white/30 bg-white/15 p-3">
      <div className="flex items-center gap-2">
        <span className="w-5 shrink-0 text-center text-[11px] tabular-nums text-slate-400">{index + 1}</span>
        <Input
          value={item.name ?? ''}
          onChange={(e) => onChange({ ...item, name: e.target.value })}
          placeholder={t('open-platform.interactive.phButtonName')}
          className="h-9 flex-1"
        />
        <Select
          value={type}
          onValueChange={(v) => onChange({ ...blankMenuItem(v as MenuItemType), name: item.name })}
        >
          <SelectTrigger className="h-9 w-32 shrink-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MENU_TYPES.map((m) => (
              <SelectItem key={m.value} value={m.value}>{t(m.i18nKey)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-9 w-9 shrink-0 text-slate-400 hover:text-rose-600"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-2.5 grid grid-cols-1 gap-2 pl-7 sm:grid-cols-2">
        {type === 'send_message' ? (
          <div className="sm:col-span-2">
            {fieldRow(
              t('open-platform.interactive.fSendContent'),
              t('open-platform.interactive.hFillInput'),
              (
                <Input
                  value={item.send_message ?? ''}
                  onChange={(e) => onChange({ ...item, send_message: e.target.value })}
                  placeholder="/help"
                  className="h-9"
                />
              ),
            )}
          </div>
        ) : null}

        {type === 'link' ? (
          <div className="sm:col-span-2">
            {fieldRow(
              t('open-platform.interactive.fLink'),
              t('open-platform.interactive.hHttpsRequired'),
              (
                <Input
                  value={item.link ?? ''}
                  onChange={(e) => onChange({ ...item, link: e.target.value })}
                  placeholder="https://example.com"
                  className="h-9"
                />
              ),
            )}
          </div>
        ) : null}

        {type === 'switch' ? (
          <>
            {fieldRow(
              t('open-platform.interactive.fSwitchId'),
              t('open-platform.interactive.hExtCallback'),
              (
                <Input
                  value={item.switch?.switch_id ?? ''}
                  onChange={(e) => onChange({ ...item, switch: { ...item.switch, switch_id: e.target.value } })}
                  placeholder="search"
                  className="h-9"
                />
              ),
            )}
            <div className="flex items-end gap-2 pb-1">
              <Switch
                id={`menu-switch-${index}`}
                checked={item.switch?.default === true}
                onCheckedChange={(v) => onChange({ ...item, switch: { ...item.switch, default: v } })}
              />
              <Label htmlFor={`menu-switch-${index}`} className="text-[11px] text-slate-500">{t('open-platform.interactive.defaultOn')}</Label>
            </div>
          </>
        ) : null}

        {type === 'menu' ? (
          <div className="sm:col-span-2">
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-[11px] text-slate-500">
                {t('open-platform.interactive.submenuLabel')}{' '}
                <span className="text-slate-400">{t('open-platform.interactive.submenuMax', { n: SUB_MENU_MAX })}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7"
                disabled={subs.length >= SUB_MENU_MAX}
                onClick={() => onChange({
                  ...item,
                  sub_menu_items: [...subs, { name: '', type: 'send_message', send_message: '' }],
                })}
              >
                <Plus className="h-3.5 w-3.5" /> {t('open-platform.interactive.subItem')}
              </Button>
            </div>
            <div className="flex flex-col gap-2">
              {subs.map((sub, si) => (
                <SubMenuRow
                  key={si}
                  sub={sub}
                  onChange={(next) => onChange({
                    ...item,
                    sub_menu_items: subs.map((s, i) => (i === si ? next : s)),
                  })}
                  onRemove={() => onChange({
                    ...item,
                    sub_menu_items: subs.filter((_, i) => i !== si),
                  })}
                />
              ))}
              {subs.length === 0 ? (
                <p className="text-[11px] text-slate-400">{t('open-platform.interactive.noSubItems')}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SubMenuRow({
  sub,
  onChange,
  onRemove,
}: {
  sub: MenuSubItem;
  onChange: (next: MenuSubItem) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const type = sub.type ?? 'send_message';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        value={sub.name ?? ''}
        onChange={(e) => onChange({ ...sub, name: e.target.value })}
        placeholder={t('open-platform.interactive.phSubItemName')}
        className="h-8 w-32"
      />
      <Select
        value={type}
        onValueChange={(v) => onChange({
          name: sub.name,
          type: v as 'send_message' | 'link',
          ...(v === 'link' ? { link: '' } : { send_message: '' }),
        })}
      >
        <SelectTrigger className="h-8 w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="send_message">{t('open-platform.interactive.menuSendMessage')}</SelectItem>
          <SelectItem value="link">{t('open-platform.interactive.menuLink')}</SelectItem>
        </SelectContent>
      </Select>
      <Input
        value={type === 'link' ? (sub.link ?? '') : (sub.send_message ?? '')}
        onChange={(e) => onChange(
          type === 'link' ? { ...sub, link: e.target.value } : { ...sub, send_message: e.target.value },
        )}
        placeholder={type === 'link' ? 'https://…' : t('open-platform.interactive.phSendContent')}
        className="h-8 min-w-40 flex-1"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-slate-400 hover:text-rose-600"
        onClick={onRemove}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function MenuSection({ accountId }: { accountId: string }) {
  const t = useT();
  const [items, setItems] = useState<MenuItem[]>([]);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.openPlatform.getMenu(accountId);
      if (!res.ok) {
        toast.error(resText(res) || t('open-platform.interactive.errGetMenu'));
        return;
      }
      setItems(res.items ?? []);
      setVersion(res.version ?? 0);
      setDirty(false);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    if (items.some((i) => !String(i.name ?? '').trim())) {
      toast.error(t('open-platform.interactive.errMenuName'));
      return;
    }
    setSaving(true);
    try {
      const res = await api.openPlatform.putMenu(accountId, items);
      if (!res.ok) {
        toast.error(resText(res) || t('open-platform.interactive.errSave'));
        return;
      }
      setVersion(res.version ?? version);
      setDirty(false);
      toast.success(t('open-platform.interactive.menuSaved'));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] leading-relaxed text-slate-500">
          {t('open-platform.interactive.menuMax', { n: MENU_MAX })}
          {version ? <span className="ml-1 text-slate-400">{t('open-platform.interactive.currentVersion', { version })}</span> : null}
          {dirty ? <span className="ml-1 text-amber-700">{t('open-platform.interactive.unsaved')}</span> : null}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={loading || saving} onClick={() => void load()}>
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> {t('open-platform.refetch')}
          </Button>
          <Button size="sm" disabled={loading || saving || !dirty} onClick={() => void save()}>
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} {t('open-platform.interactive.save')}
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="py-4 text-center text-[11px] text-slate-400">{t('open-platform.loading')}</p>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {items.map((item, i) => (
              <MenuItemEditor
                key={i}
                item={item}
                index={i}
                onChange={(next) => {
                  setItems(items.map((x, xi) => (xi === i ? next : x)));
                  setDirty(true);
                }}
                onRemove={() => {
                  setItems(items.filter((_, xi) => xi !== i));
                  setDirty(true);
                }}
              />
            ))}
            {items.length === 0 ? (
              <p className="rounded-xl border border-white/30 bg-white/10 px-3 py-3 text-center text-[11px] text-slate-400">
                {t('open-platform.interactive.noMenu')}
              </p>
            ) : null}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={items.length >= MENU_MAX}
            onClick={() => { setItems([...items, blankMenuItem()]); setDirty(true); }}
          >
            <Plus className="h-4 w-4" /> {t('open-platform.interactive.addMenuItem')}
          </Button>
        </>
      )}
    </div>
  );
}

/* ------------------------------ 指令面板 ------------------------------ */

function PanelItemRow({
  item,
  onChange,
  onRemove,
}: {
  item: PanelItem;
  onChange: (next: PanelItem) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const type = item.type ?? 'command';
  return (
    <div className="rounded-xl border border-white/30 bg-white/15 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={item.name ?? ''}
          onChange={(e) => onChange({ ...item, name: e.target.value })}
          placeholder={t('open-platform.interactive.phElementName')}
          className="h-8 w-32"
        />
        <Select
          value={type}
          onValueChange={(v) => onChange({
            ...item,
            type: v as 'command' | 'link',
            ...(v === 'link' ? { link: '' } : {}),
          })}
        >
          <SelectTrigger className="h-8 w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="command">{t('open-platform.interactive.itemCommand')}</SelectItem>
            <SelectItem value="link">{t('open-platform.interactive.menuLink')}</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={item.desc ?? ''}
          onChange={(e) => onChange({ ...item, desc: e.target.value })}
          placeholder={t('open-platform.interactive.phDescOptional')}
          className="h-8 min-w-32 flex-1"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-slate-400 hover:text-rose-600"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-4 pl-1">
        {type === 'link' ? (
          <div className="flex-1">
            {fieldRow(
              t('open-platform.interactive.fLink'),
              t('open-platform.interactive.hOpenBrowser'),
              (
                <Input
                  value={item.link ?? ''}
                  onChange={(e) => onChange({ ...item, link: e.target.value })}
                  placeholder="https://example.com"
                  className="h-8"
                />
              ),
            )}
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <Switch
            id={`panel-admin-${String(item.name ?? '')}-${String(item.desc ?? '')}`}
            checked={item.only_admin === true}
            onCheckedChange={(v) => onChange({ ...item, only_admin: v })}
          />
          <Label
            htmlFor={`panel-admin-${String(item.name ?? '')}-${String(item.desc ?? '')}`}
            className="text-[11px] text-slate-500"
          >
            {t('open-platform.interactive.adminOnly')}
          </Label>
        </div>
      </div>
    </div>
  );
}

function PanelCard({
  accountId,
  record,
  onChanged,
}: {
  accountId: string;
  record: PanelRecord;
  onChanged: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<PanelItem[]>(record.panel?.items ?? []);
  const [remark, setRemark] = useState(record.panel?.remark ?? '');
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const panelId = String(record.panel_id ?? '');

  async function save() {
    if (items.some((i) => !String(i.name ?? '').trim())) {
      toast.error(t('open-platform.interactive.errPanelName'));
      return;
    }
    setSaving(true);
    try {
      const res = await api.openPlatform.updatePanel(panelId, accountId, items, remark.trim() || undefined);
      if (!res.ok) { toast.error(resText(res) || t('open-platform.interactive.errSave')); return; }
      toast.success(t('open-platform.interactive.panelUpdated'));
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      const res = await api.openPlatform.deletePanel(panelId, accountId);
      if (!res.ok) { toast.error(resText(res) || t('open-platform.interactive.errDelete')); return; }
      toast.success(t('open-platform.interactive.panelDeleted'));
      onChanged();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="rounded-xl border border-white/30 bg-white/15 p-3">
      <button
        type="button"
        className="flex w-full items-center gap-2 text-left"
        onClick={() => setOpen(!open)}
      >
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{panelId}</span>
        <span className="shrink-0 rounded-full bg-slate-500/10 px-2 py-0.5 text-[10px] text-slate-600">
          {record.target_type === 'specific' ? t('open-platform.interactive.specific') : t('open-platform.interactive.global')}
        </span>
        <span className="shrink-0 text-[10px] text-slate-400">{t('open-platform.interactive.itemsCount', { count: items.length })}</span>
      </button>

      {open ? (
        <div className="mt-2.5 flex flex-col gap-2">
          {fieldRow(
            t('open-platform.interactive.fRemark'),
            t('open-platform.interactive.hDevOnly'),
            (
              <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={t('open-platform.interactive.phPanelUsage')} className="h-8" />
            ),
          )}
          <div className="flex flex-col gap-2">
            {items.map((item, i) => (
              <PanelItemRow
                key={i}
                item={item}
                onChange={(next) => setItems(items.map((x, xi) => (xi === i ? next : x)))}
                onRemove={() => setItems(items.filter((_, xi) => xi !== i))}
              />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={items.length >= PANEL_ITEM_MAX}
                onClick={() => setItems([...items, blankPanelItem()])}
              >
                <Plus className="h-3.5 w-3.5" /> {t('open-platform.interactive.element')}
              </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-rose-600 hover:bg-rose-500/10"
                disabled={removing}
                onClick={() => void remove()}
              >
                {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} {t('open-platform.deleteBtn')}
              </Button>
              <Button size="sm" className="h-8" disabled={saving} onClick={() => void save()}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />} {t('open-platform.interactive.save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function PanelSection({ accountId }: { accountId: string }) {
  const t = useT();
  const [scope, setScope] = useState<PanelScope>('c2c');
  const [records, setRecords] = useState<PanelRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const [targetType, setTargetType] = useState<'all' | 'specific'>('all');
  const [openids, setOpenids] = useState('');
  const [items, setItems] = useState<PanelItem[]>([]);
  const [remark, setRemark] = useState('');
  const [creating, setCreating] = useState(false);

  const specificAllowed = scope === 'c2c' || scope === 'group';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.openPlatform.getPanels(accountId, scope);
      if (!res.ok) {
        toast.error(resText(res) || t('open-platform.interactive.errGetPanel'));
        return;
      }
      setRecords(res.records ?? []);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setLoading(false);
    }
  }, [accountId, scope]);

  useEffect(() => { void load(); }, [load]);

  const effectiveTarget = specificAllowed ? targetType : 'all';

  async function create() {
    if (items.length === 0) { toast.error(t('open-platform.interactive.errAtLeastOne')); return; }
    if (items.some((i) => !String(i.name ?? '').trim())) { toast.error(t('open-platform.interactive.errPanelName')); return; }
    const list = openids.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
    setCreating(true);
    try {
      const res = await api.openPlatform.createPanel({
        id: accountId,
        scope,
        targetType: effectiveTarget,
        ...(scope === 'c2c' ? { userOpenids: list } : {}),
        ...(scope === 'group' ? { groupOpenids: list } : {}),
        items,
        ...(remark.trim() ? { remark: remark.trim() } : {}),
      });
      if (!res.ok) { toast.error(resText(res) || t('open-platform.interactive.errCreate')); return; }
      toast.success(t('open-platform.interactive.panelCreated'));
      setItems([]);
      setOpenids('');
      setRemark('');
      await load();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-500">{t('open-platform.interactive.effectiveScope')}</span>
          <Select value={scope} onValueChange={(v) => setScope(v as PanelScope)}>
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCOPES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{t(s.i18nKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" size="sm" disabled={loading} onClick={() => void load()}>
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} /> {t('open-platform.refetch')}
        </Button>
      </div>

      {loading ? (
        <p className="py-4 text-center text-[11px] text-slate-400">{t('open-platform.loading')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {records.map((r) => (
            <PanelCard key={String(r.panel_id ?? '')} accountId={accountId} record={r} onChanged={() => void load()} />
          ))}
          {records.length === 0 ? (
            <p className="rounded-xl border border-white/30 bg-white/10 px-3 py-3 text-center text-[11px] text-slate-400">
              {t('open-platform.interactive.noPanelInScope')}
            </p>
          ) : null}
        </div>
      )}

      <div className="rounded-xl border border-white/30 bg-white/10 p-3">
        <p className="mb-2 text-[11px] font-medium text-slate-600">{t('open-platform.interactive.newPanel')}</p>
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-500">{t('open-platform.interactive.scope')}</span>
            <Select
              value={effectiveTarget}
              onValueChange={(v) => setTargetType(v as 'all' | 'specific')}
              disabled={!specificAllowed}
            >
              <SelectTrigger className="h-8 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('open-platform.interactive.global')}</SelectItem>
                <SelectItem value="specific">{t('open-platform.interactive.specific')}</SelectItem>
              </SelectContent>
            </Select>
            {!specificAllowed ? (
              <span className="text-[10px] text-slate-400">{t('open-platform.interactive.onlyGlobalNote')}</span>
            ) : null}
          </div>

          {specificAllowed && targetType === 'specific' ? (
            <div>
              {fieldRow(
                scope === 'group' ? t('open-platform.interactive.fGroupOpenid') : t('open-platform.interactive.fUserOpenid'),
                t('open-platform.interactive.hCommaSeparated'),
                (
                  <Input
                    value={openids}
                    onChange={(e) => setOpenids(e.target.value)}
                    placeholder="openid1, openid2"
                    className="h-8"
                  />
                ),
              )}
            </div>
          ) : null}

          {fieldRow(
            t('open-platform.interactive.fRemark'),
            t('open-platform.interactive.hDevOnlyOpt'),
            (
              <Input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={t('open-platform.interactive.phPanelUsage')} className="h-8" />
            ),
          )}

          <div className="flex flex-col gap-2">
            {items.map((item, i) => (
              <PanelItemRow
                key={i}
                item={item}
                onChange={(next) => setItems(items.map((x, xi) => (xi === i ? next : x)))}
                onRemove={() => setItems(items.filter((_, xi) => xi !== i))}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              disabled={items.length >= PANEL_ITEM_MAX}
              onClick={() => setItems([...items, blankPanelItem()])}
            >
              <Plus className="h-3.5 w-3.5" /> {t('open-platform.interactive.element')}
            </Button>
            <Button size="sm" className="ml-auto h-8" disabled={creating} onClick={() => void create()}>
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} {t('open-platform.interactive.create')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ 入口 ------------------------------ */

/** 详情弹窗里的两个入口，各自打开一个独立子窗口 */
export function BotInteractiveConfig({ accountId }: { accountId: string }) {
  const t = useT();
  const [open, setOpen] = useState<'menu' | 'panel' | null>(null);

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <EntryButton
          icon={ListTree}
          title={t('open-platform.interactive.menuTitle')}
          desc={t('open-platform.interactive.menuDesc')}
          onClick={() => setOpen('menu')}
        />
        <EntryButton
          icon={LayoutPanelTop}
          title={t('open-platform.interactive.panelTitle')}
          desc={t('open-platform.interactive.panelDesc')}
          onClick={() => setOpen('panel')}
        />
      </div>

      <Dialog open={open === 'menu'} onOpenChange={(v) => { if (!v) setOpen(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader className="pr-6 text-left">
            <DialogTitle className="flex items-center gap-2">
              <ListTree className="h-4 w-4 text-teal-700" /> {t('open-platform.interactive.menuTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('open-platform.interactive.menuDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          {open === 'menu' ? <MenuSection accountId={accountId} /> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={open === 'panel'} onOpenChange={(v) => { if (!v) setOpen(null); }}>
        <DialogContent className="max-w-xl">
          <DialogHeader className="pr-6 text-left">
            <DialogTitle className="flex items-center gap-2">
              <LayoutPanelTop className="h-4 w-4 text-teal-700" /> {t('open-platform.interactive.panelTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('open-platform.interactive.panelDialogDesc')}
            </DialogDescription>
          </DialogHeader>
          {open === 'panel' ? <PanelSection accountId={accountId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function EntryButton({
  icon: Icon,
  title,
  desc,
  onClick,
}: {
  icon: typeof ListTree;
  title: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-2.5 rounded-xl border border-white/30 bg-white/10 px-3 py-2.5 text-left transition-colors hover:border-teal-400/50 hover:bg-white/25"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-teal-500/15 text-teal-700">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-slate-800">{title}</span>
        <span className="block truncate text-[10px] text-slate-500">{desc}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
