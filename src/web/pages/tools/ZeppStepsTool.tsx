import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Pencil,
  Trash2,
  Play,
  Footprints,
} from 'lucide-react';
import { api } from '@/lib/api';
import type { ZeppAccountPublic, ZeppStepsState } from '@/lib/types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

type Editor = {
  id?: string;
  user: string;
  password: string;
};

function applyState(
  setState: (s: ZeppStepsState) => void,
  setMin: (n: string) => void,
  setMax: (n: string) => void,
  data: ZeppStepsState,
) {
  setState(data);
  setMin(String(data.minStep));
  setMax(String(data.maxStep));
}

export default function ZeppStepsTool() {
  const [state, setState] = useState<ZeppStepsState | null>(null);
  const [loading, setLoading] = useState(true);
  const [minStep, setMinStep] = useState('18000');
  const [maxStep, setMaxStep] = useState('25000');
  const [fixedStep, setFixedStep] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [runningId, setRunningId] = useState<string | 'all' | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [savingAccount, setSavingAccount] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api.tools.zeppSteps.get();
    applyState(setState, setMinStep, setMaxStep, data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.tools.zeppSteps.get();
        if (cancelled) return;
        applyState(setState, setMinStep, setMaxStep, data);
      } catch (e) {
        if (!cancelled) toast.error(e instanceof Error ? e.message : '加载失败');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function saveSettings() {
    const min = Number(minStep);
    const max = Number(maxStep);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      toast.error('步数范围必须是数字');
      return;
    }
    if (min > max) {
      toast.error('最小步数不能大于最大步数');
      return;
    }
    setSavingSettings(true);
    try {
      const data = await api.tools.zeppSteps.saveSettings(min, max);
      applyState(setState, setMinStep, setMaxStep, data);
      if (!data.ok) {
        toast.error(data.message || '保存失败');
        return;
      }
      toast.success('已保存步数范围');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSavingSettings(false);
    }
  }

  async function toggleEnabled(account: ZeppAccountPublic, enabled: boolean) {
    try {
      const data = await api.tools.zeppSteps.updateAccount(account.id, { enabled });
      applyState(setState, setMinStep, setMaxStep, data);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败');
    }
  }

  async function saveAccount() {
    if (!editor) return;
    const user = editor.user.trim();
    if (!user) {
      toast.error('请填写账号');
      return;
    }
    if (!editor.id && !editor.password) {
      toast.error('请填写密码');
      return;
    }
    setSavingAccount(true);
    try {
      const data = editor.id
        ? await api.tools.zeppSteps.updateAccount(editor.id, {
            user,
            password: editor.password || undefined,
          })
        : await api.tools.zeppSteps.addAccount({
            user,
            password: editor.password,
          });
      if (!data.ok) {
        toast.error(data.message || '保存失败');
        return;
      }
      applyState(setState, setMinStep, setMaxStep, data);
      setEditor(null);
      toast.success(editor.id ? '账号已更新' : '账号已添加');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSavingAccount(false);
    }
  }

  async function confirmDelete() {
    if (!deleteId) return;
    try {
      const data = await api.tools.zeppSteps.deleteAccount(deleteId);
      if (!data.ok) {
        toast.error(data.message || '删除失败');
        return;
      }
      applyState(setState, setMinStep, setMaxStep, data);
      toast.success('已删除账号');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败');
    } finally {
      setDeleteId(null);
    }
  }

  async function run(id?: string) {
    const stepRaw = fixedStep.trim();
    const step = stepRaw ? Number(stepRaw) : undefined;
    if (stepRaw && !Number.isFinite(step)) {
      toast.error('固定步数必须是数字');
      return;
    }
    setRunningId(id || 'all');
    try {
      const data = await api.tools.zeppSteps.run({
        id,
        step: Number.isFinite(step as number) ? step : undefined,
      });
      applyState(setState, setMinStep, setMaxStep, data);
      if (data.ok) toast.success(data.message || '同步完成');
      else toast.error(data.message || '同步失败');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '同步失败');
      try {
        await load();
      } catch { /* ignore */ }
    } finally {
      setRunningId(null);
    }
  }

  if (loading || !state) {
    return (
      <div className="flex flex-1 items-center justify-center py-16 text-slate-500">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const busy = runningId != null;
  const enabledCount = state.accounts.filter((a) => a.enabled).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-4">
      <section className="kk-glass rounded-2xl border border-white/40 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[7.5rem] flex-1">
            <Label htmlFor="zepp-min">最小步数</Label>
            <Input
              id="zepp-min"
              className="mt-1.5"
              inputMode="numeric"
              value={minStep}
              onChange={(e) => setMinStep(e.target.value)}
            />
          </div>
          <div className="min-w-[7.5rem] flex-1">
            <Label htmlFor="zepp-max">最大步数</Label>
            <Input
              id="zepp-max"
              className="mt-1.5"
              inputMode="numeric"
              value={maxStep}
              onChange={(e) => setMaxStep(e.target.value)}
            />
          </div>
          <div className="min-w-[7.5rem] flex-1">
            <Label htmlFor="zepp-fixed">本次固定步数（可选）</Label>
            <Input
              id="zepp-fixed"
              className="mt-1.5"
              inputMode="numeric"
              placeholder="留空则范围内随机"
              value={fixedStep}
              onChange={(e) => setFixedStep(e.target.value)}
            />
          </div>
          <Button
            variant="outline"
            className="h-10"
            disabled={savingSettings || busy}
            onClick={() => void saveSettings()}
          >
            {savingSettings ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            保存范围
          </Button>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          className="h-10"
          disabled={busy || enabledCount === 0}
          onClick={() => void run()}
        >
          {runningId === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          同步全部
        </Button>
        <Button
          variant="outline"
          className="h-10"
          disabled={busy}
          onClick={() => setEditor({ user: '', password: '' })}
        >
          <Plus className="h-4 w-4" />
          添加账号
        </Button>
        <span className="text-xs text-slate-400">
          {state.accounts.length} 个账号，{enabledCount} 个已启用
        </span>
      </div>

      {state.accounts.length === 0 ? (
        <div className="kk-glass flex flex-col items-center gap-2 rounded-2xl border border-dashed border-white/50 px-4 py-12 text-center">
          <Footprints className="h-8 w-8 text-teal-600/70" />
          <p className="text-sm text-slate-600">还没有账号</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {state.accounts.map((account) => {
            const runBusy = runningId === account.id || runningId === 'all';
            return (
              <li
                key={account.id}
                className="kk-glass flex flex-col gap-3 rounded-2xl border border-white/40 p-4 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium text-slate-800">{account.userMasked}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px]',
                        account.lastRun?.ok
                          ? 'bg-teal-500/15 text-teal-700'
                          : account.lastRun
                            ? 'bg-rose-500/10 text-rose-600'
                            : 'bg-slate-500/10 text-slate-500',
                      )}
                    >
                      {account.lastRun
                        ? account.lastRun.ok
                          ? `成功 ${account.lastRun.step ?? ''} 步`
                          : '失败'
                        : '未同步'}
                    </span>
                  </div>
                  {account.lastRun ? (
                    <p
                      className="mt-1 truncate text-xs text-slate-400"
                      title={account.lastRun.message}
                    >
                      {account.lastRun.at} · {account.lastRun.message}
                    </p>
                  ) : (
                    <p className="mt-1 text-xs text-slate-400">{account.user}</p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant={account.enabled ? 'default' : 'outline'}
                    size="sm"
                    disabled={busy}
                    aria-label={account.enabled ? '已启用' : '已停用'}
                    onClick={() => void toggleEnabled(account, !account.enabled)}
                  >
                    {account.enabled ? '开' : '关'}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || !account.enabled}
                    onClick={() => void run(account.id)}
                  >
                    {runBusy && runningId === account.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Play className="h-4 w-4" />}
                    同步
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    onClick={() =>
                      setEditor({
                        id: account.id,
                        user: account.user,
                        password: '',
                      })
                    }
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-rose-500 hover:text-rose-600"
                    disabled={busy}
                    onClick={() => setDeleteId(account.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog open={!!editor} onOpenChange={(open) => { if (!open) setEditor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editor?.id ? '编辑账号' : '添加账号'}</DialogTitle>
            <DialogDescription>
              使用 Zepp Life 注册的邮箱或手机号，不是小米账号。
            </DialogDescription>
          </DialogHeader>
          {editor ? (
            <div className="grid gap-3">
              <div>
                <Label htmlFor="zepp-user">账号</Label>
                <Input
                  id="zepp-user"
                  className="mt-1.5"
                  placeholder="邮箱或手机号"
                  value={editor.user}
                  onChange={(e) => setEditor({ ...editor, user: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="zepp-pass">密码</Label>
                <Input
                  id="zepp-pass"
                  className="mt-1.5"
                  type="password"
                  placeholder={editor.id ? '不改则留空' : 'Zepp Life 密码'}
                  value={editor.password}
                  onChange={(e) => setEditor({ ...editor, password: e.target.value })}
                />
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditor(null)}>取消</Button>
            <Button disabled={savingAccount} onClick={() => void saveAccount()}>
              {savingAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这个账号？</AlertDialogTitle>
            <AlertDialogDescription>
              将从本机 data 中移除账号、密码和已保存的登录票据，无法恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
