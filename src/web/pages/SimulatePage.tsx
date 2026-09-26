import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2, Send, Plus, Image as ImageIcon, Video, Mic, AtSign, Braces, X, Trash2, Zap,
} from 'lucide-react';
import { api } from '@/lib/api';
import type {
  OB11Segment, SimulateAccount, SimulateEntry, SimulateEventInput, SimulateEventType,
} from '@/lib/simulate-types';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select-menu';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { parseCqString } from './simulate/media-source';
import { MessageSegments } from './simulate/MessageSegments';
import { PluginOutput, isMessageAction, systemActionSummary } from './simulate/PluginOutput';
import { OfficialOutput, isOfficialMessageAction } from './simulate/OfficialOutput';
import { SystemLine } from './simulate/SystemLine';
import { useSimulateStream } from './simulate/useSimulateStream';

const LS = {
  account: 'kk_sim_account',
  userId: 'kk_sim_user',
  nickname: 'kk_sim_nick',
  groupId: 'kk_sim_group',
};

type EventNeed = 'group' | 'user' | 'operator' | 'duration' | 'comment' | 'sub' | 'value';
type EventScope = 'group' | 'private' | 'account';
type EventMeta = {
  value: SimulateEventType;
  label: string;
  scope: EventScope;
  needs: EventNeed[];
  valueLabel?: string;
  valuePlaceholder?: string;
};

const EVENT_TYPES: EventMeta[] = [
  // 群
  { value: 'group_increase', label: '入群', scope: 'group', needs: ['group', 'user'] },
  { value: 'group_decrease', label: '退群/被踢', scope: 'group', needs: ['group', 'user', 'sub'] },
  { value: 'group_ban', label: '群禁言', scope: 'group', needs: ['group', 'user', 'operator', 'duration'] },
  { value: 'group_admin', label: '管理员变动', scope: 'group', needs: ['group', 'user', 'sub'] },
  { value: 'group_recall', label: '群撤回', scope: 'group', needs: ['group', 'user'] },
  { value: 'group_upload', label: '群文件上传', scope: 'group', needs: ['group', 'user', 'value'], valueLabel: '文件名', valuePlaceholder: 'test.txt' },
  { value: 'group_card', label: '群名片变更', scope: 'group', needs: ['group', 'user', 'value'], valueLabel: '新名片' },
  { value: 'group_title', label: '获得头衔', scope: 'group', needs: ['group', 'user', 'value'], valueLabel: '头衔' },
  { value: 'group_honor', label: '群荣誉', scope: 'group', needs: ['group', 'user', 'value'], valueLabel: '荣誉类型', valuePlaceholder: 'talkative / performer / emotion' },
  { value: 'group_essence', label: '设/撤精华', scope: 'group', needs: ['group', 'user', 'operator', 'sub'] },
  { value: 'group_poke', label: '群内戳一戳', scope: 'group', needs: ['group', 'user', 'operator'] },
  { value: 'group_request', label: '加群请求', scope: 'group', needs: ['group', 'user', 'comment'] },
  // 私聊 / 好友
  { value: 'friend_recall', label: '好友撤回', scope: 'private', needs: ['user'] },
  { value: 'friend_add', label: '好友添加', scope: 'private', needs: ['user'] },
  { value: 'friend_poke', label: '好友戳一戳', scope: 'private', needs: ['operator'] },
  { value: 'friend_request', label: '加好友请求', scope: 'private', needs: ['user', 'comment'] },
  // 账号 / 生命周期（任何会话都可见）
  { value: 'profile_like', label: '资料被点赞', scope: 'account', needs: ['operator', 'value'], valueLabel: '点赞数', valuePlaceholder: '1' },
  { value: 'bot_offline', label: '被踢下线', scope: 'account', needs: ['value'], valueLabel: '下线原因', valuePlaceholder: '在其它设备登录' },
  { value: 'lifecycle_connect', label: '连接/上线', scope: 'account', needs: [] },
];

/** QQ 官方机器人事件（openid 语义，与 OneBot 分开） */
const OFFICIAL_EVENT_TYPES: EventMeta[] = [
  { value: 'gf_group_add_robot', label: '机器人进群', scope: 'group', needs: ['group', 'operator'] },
  { value: 'gf_group_del_robot', label: '机器人被移出群', scope: 'group', needs: ['group', 'operator'] },
  { value: 'gf_group_member_add', label: '群成员增加', scope: 'group', needs: ['group', 'user', 'operator'] },
  { value: 'gf_group_member_remove', label: '群成员减少', scope: 'group', needs: ['group', 'user', 'operator'] },
  { value: 'gf_group_join_request', label: '入群申请', scope: 'group', needs: ['group', 'user', 'comment'] },
  { value: 'gf_friend_add', label: '用户添加机器人', scope: 'private', needs: ['user'] },
  { value: 'gf_friend_del', label: '用户删除机器人', scope: 'private', needs: ['user'] },
];

export default function SimulatePage() {
  const [accounts, setAccounts] = useState<SimulateAccount[]>([]);
  const [accountKey, setAccountKey] = useState<string>(() => localStorage.getItem(LS.account) || '');
  const [chatType, setChatType] = useState<'group' | 'private'>('group');
  const [entries, setEntries] = useState<SimulateEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [sending, setSending] = useState(false);

  const [userId, setUserId] = useState(() => localStorage.getItem(LS.userId) || '10001');
  const [nickname, setNickname] = useState(() => localStorage.getItem(LS.nickname) || '测试用户');
  const [groupId, setGroupId] = useState(() => localStorage.getItem(LS.groupId) || '10000');

  const [text, setText] = useState('');
  const [attachOpen, setAttachOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const caretRef = useRef<number>(0);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFired = useRef(false);

  const loadAccounts = useCallback(async () => {
    const r = await api.simulate.accounts();
    setAccounts(r.data);
    setAccountKey((prev) => {
      if (prev && r.data.some((a) => a.accountKey === prev)) return prev;
      return r.data[0]?.accountKey || '';
    });
  }, []);

  const loadHistory = useCallback(async (key: string) => {
    if (!key) { setEntries([]); return; }
    setLoadingHistory(true);
    try {
      const r = await api.simulate.history(key);
      setEntries(r.data.entries || []);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => { void loadAccounts(); }, [loadAccounts]);
  useEffect(() => { void loadHistory(accountKey); }, [accountKey, loadHistory]);
  useEffect(() => { if (accountKey) localStorage.setItem(LS.account, accountKey); }, [accountKey]);

  // 供产品导览调用：打开/关闭「模拟设置」面板
  useEffect(() => {
    const open = () => setConfigOpen(true);
    const close = () => setConfigOpen(false);
    window.addEventListener('kk:sim-config-open', open);
    window.addEventListener('kk:sim-config-close', close);
    return () => {
      window.removeEventListener('kk:sim-config-open', open);
      window.removeEventListener('kk:sim-config-close', close);
    };
  }, []);

  useSimulateStream(accountKey, (entry) => {
    setEntries((prev) => (prev.some((e) => e.id === entry.id) ? prev : [...prev, entry]));
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries]);

  // 自适应高度（向上生长，覆盖聊天区而非挤占）
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 168)}px`;
  }, [text]);

  const currentAccount = useMemo(
    () => accounts.find((a) => a.accountKey === accountKey),
    [accounts, accountKey],
  );
  const isOfficial = currentAccount?.kind === 'official';

  const rememberCaret = () => {
    const ta = taRef.current;
    if (ta) caretRef.current = ta.selectionStart ?? text.length;
  };

  /** 在光标处插入一段文本（图片 / at 用 CQ 码内联） */
  const insertAtCaret = (token: string) => {
    const pos = Math.min(caretRef.current, text.length);
    const next = text.slice(0, pos) + token + text.slice(pos);
    setText(next);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) {
        const p = pos + token.length;
        ta.focus();
        ta.setSelectionRange(p, p);
        caretRef.current = p;
      }
    });
  };

  const doSendSegments = async (segs: OB11Segment[]) => {
    if (!accountKey) { toast.error('请先长按发送键选择账号'); return; }
    if (segs.length === 0) { toast.error('请输入内容'); return; }
    if (chatType === 'group' && !groupId.trim()) { toast.error('群聊需填群号，长按发送键设置'); return; }
    if (!userId.trim()) { toast.error('请设置发送者 QQ'); return; }

    localStorage.setItem(LS.userId, userId);
    localStorage.setItem(LS.nickname, nickname);
    localStorage.setItem(LS.groupId, groupId);

    setSending(true);
    try {
      const r = await api.simulate.send(accountKey, {
        chatType,
        groupId: chatType === 'group' ? groupId.trim() : undefined,
        userId: userId.trim(),
        nickname: nickname.trim() || undefined,
        message: segs,
      });
      if (r.code !== 0) { toast.error(r.message || '发送失败'); return; }
      if (r.data && r.data.dispatched === 0) toast('该账号没有已加载的插件', { icon: 'ℹ️' });
      else if (r.data && r.data.captured === 0) toast('插件已收到，本轮无输出', { icon: 'ℹ️' });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const doSend = async () => {
    const segs = parseCqString(text).filter((s) => !(s.type === 'text' && !String(s.data.text ?? '').length));
    if (segs.length === 0) { toast.error('请输入内容'); return; }
    await doSendSegments(segs as OB11Segment[]);
    setText('');
  };

  // 独立轨消息（视频/语音/JSON卡片）：单独成一条，不与文本或其他混排
  const sendStandalone = async (seg: OB11Segment) => {
    setAttachOpen(false);
    await doSendSegments([seg]);
  };

  const onSendPointerDown = () => {
    longPressFired.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressFired.current = true;
      setConfigOpen(true);
    }, 3000);
  };
  const clearLongPress = () => {
    if (longPressTimer.current) { clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  };
  const onSendClick = () => {
    if (longPressFired.current) { longPressFired.current = false; return; }
    void doSend();
  };

  const clearCache = async () => {
    if (!accountKey) return;
    try {
      await api.simulate.clear(accountKey);
      setEntries([]);
      toast.success('已清空');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '清空失败');
    } finally {
      setClearOpen(false);
    }
  };

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col">
      {/* 对话区：主体，铺满；底部留出输入栏折叠态高度 */}
      <div
        ref={scrollRef}
        className="kk-glass min-h-0 flex-1 overflow-y-auto rounded-2xl p-3 pb-[4.5rem] no-scrollbar"
      >
        {loadingHistory ? (
          <div className="flex h-full items-center justify-center text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center text-sm text-muted-foreground">
            {accountKey ? '发一条消息或事件，触发该账号已加载的插件' : '暂无可模拟的 OneBot 账号'}
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {entries.map((e) => <Row key={e.id} entry={e} official={isOfficial} />)}
          </div>
        )}
      </div>

      {/* 输入栏：绝对定位于底部，展开时向上覆盖聊天区而非挤占 */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 p-1 pt-0">
        <div className="pointer-events-auto flex items-end gap-2 rounded-2xl border border-white/40 bg-white/45 p-1.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)] backdrop-blur-xl focus-within:border-teal-400/50">
          <button
            type="button"
            onClick={() => { rememberCaret(); setAttachOpen(true); }}
            disabled={!accountKey}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-white/50 disabled:opacity-40"
            title="插入图片/@/视频/语音/卡片"
          >
            <Plus className="h-5 w-5" />
          </button>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onSelect={rememberCaret}
            onKeyUp={rememberCaret}
            onClick={rememberCaret}
            placeholder={accountKey ? '输入消息…（回车换行）' : '长按发送键设置账号'}
            rows={1}
            disabled={!accountKey}
            className="max-h-[10.5rem] min-h-[2.25rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-slate-800 outline-none no-scrollbar placeholder:text-slate-400"
          />
          <button
            type="button"
            data-tour="simulate-send"
            onClick={onSendClick}
            onPointerDown={onSendPointerDown}
            onPointerUp={clearLongPress}
            onPointerLeave={clearLongPress}
            onPointerCancel={clearLongPress}
            disabled={sending || !accountKey}
            title="点击发送 · 长按 3 秒打开设置"
            className="flex h-9 shrink-0 items-center justify-center rounded-xl bg-teal-500/90 px-3.5 text-sm font-medium text-white transition-colors hover:bg-teal-500 disabled:opacity-40"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <AttachDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        onInsertInline={(token) => { setAttachOpen(false); insertAtCaret(token); }}
        onSendStandalone={sendStandalone}
      />

      <ConfigSheet
        open={configOpen}
        onOpenChange={setConfigOpen}
        accounts={accounts}
        accountKey={accountKey}
        setAccountKey={setAccountKey}
        official={isOfficial}
        chatType={chatType}
        setChatType={setChatType}
        groupId={groupId} setGroupId={setGroupId}
        userId={userId} setUserId={setUserId}
        nickname={nickname} setNickname={setNickname}
        onClear={() => { setConfigOpen(false); setClearOpen(true); }}
      />

      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空模拟缓存</AlertDialogTitle>
            <AlertDialogDescription>
              将删除账号 {currentAccount?.name || accountKey} 的全部模拟对话历史，不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void clearCache()}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** 一行：用户气泡（右）/ 插件消息气泡（左）/ 事件与系统动作灰字（居中） */
function Row({ entry, official }: { entry: SimulateEntry; official?: boolean }) {
  if (entry.kind === 'event') {
    return <SystemLine text={entry.summary} />;
  }
  // 官方消息按发送接口判断；OneBot 按 action 名判断
  const pluginIsMessage = entry.kind === 'plugin'
    && (official ? isOfficialMessageAction(entry.action, entry.params) : isMessageAction(entry.action));
  if (entry.kind === 'plugin' && !pluginIsMessage) {
    return <SystemLine text={systemActionSummary(entry.action, entry.params)} />;
  }
  const isUser = entry.kind === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div className={cn('flex min-w-0 max-w-[78%] flex-col gap-1', isUser ? 'items-end' : 'items-start')}>
        <div className="px-1 text-[11px] text-muted-foreground">
          {entry.kind === 'user'
            ? `${entry.nickname || entry.userId}${entry.chatType === 'group' ? ` · 群${entry.groupId}` : ' · 私聊'}`
            : `插件 ${entry.pluginId}`}
        </div>
        <div
          className={cn(
            'min-w-0 max-w-full overflow-hidden rounded-2xl px-3 py-2 text-sm shadow-sm',
            isUser ? 'bg-teal-500/25 text-slate-800' : 'bg-white/55 text-slate-800',
          )}
        >
          {entry.kind === 'user'
            ? <MessageSegments message={entry.message} />
            : official
              ? <OfficialOutput action={entry.action} params={entry.params} />
              : <PluginOutput action={entry.action} params={entry.params} />}
        </div>
      </div>
    </div>
  );
}

function Field({
  label, value, onChange, className, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; className?: string; placeholder?: string }) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="h-9" />
    </div>
  );
}

/** 长按呼出的设置面板：账号 / 会话类型 / 身份 / 清空 / 事件上报 */
function ConfigSheet(props: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: SimulateAccount[];
  accountKey: string;
  setAccountKey: (v: string) => void;
  official?: boolean;
  chatType: 'group' | 'private';
  setChatType: (v: 'group' | 'private') => void;
  groupId: string; setGroupId: (v: string) => void;
  userId: string; setUserId: (v: string) => void;
  nickname: string; setNickname: (v: string) => void;
  onClear: () => void;
}) {
  const {
    open, onOpenChange, accounts, accountKey, setAccountKey, official,
    chatType, setChatType, groupId, setGroupId, userId, setUserId, nickname, setNickname, onClear,
  } = props;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 p-0">
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-white/40 px-5 py-4">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-500/15 text-teal-600">
            <Zap className="h-4 w-4" />
          </span>
          <DialogTitle className="text-base">模拟设置</DialogTitle>
        </div>

        <div className="flex flex-col gap-5 px-5 py-4">
          {/* 账号 */}
          <section data-tour="sim-config-account" className="flex flex-col gap-1.5">
            <Label className="text-xs font-medium text-slate-500">账号</Label>
            <Select value={accountKey} onValueChange={setAccountKey}>
              <SelectTrigger>
                <SelectValue placeholder={accounts.length ? '选择账号' : '暂无可模拟账号'} />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.accountKey} value={a.accountKey}>
                    {a.kind === 'official' ? '［官方］' : ''}{a.name}（{a.botUin || a.accountKey}）{a.connected ? '' : ' · 未连接'}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {official ? (
              <p className="text-[11px] text-sky-600">QQ 官方机器人：走 openid 语义，事件与消息按官方格式模拟</p>
            ) : null}
          </section>

          {/* 身份 */}
          <section data-tour="sim-config-identity" className="flex flex-col gap-2 rounded-2xl bg-white/30 p-3">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-slate-500">发送身份</Label>
              <div className="flex overflow-hidden rounded-lg border border-white/40 bg-white/30">
                <button type="button" onClick={() => setChatType('group')}
                  className={cn('px-3 py-1 text-xs', chatType === 'group' ? 'bg-teal-500/30 text-teal-800' : 'text-slate-600')}>群聊</button>
                <button type="button" onClick={() => setChatType('private')}
                  className={cn('px-3 py-1 text-xs', chatType === 'private' ? 'bg-teal-500/30 text-teal-800' : 'text-slate-600')}>私聊</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {chatType === 'group' && <Field label={official ? '群 openid' : '群号'} value={groupId} onChange={setGroupId} className="w-32" />}
              <Field label={official ? '用户 openid' : '发送者 QQ'} value={userId} onChange={setUserId} className="w-32" />
              {!official && <Field label="昵称" value={nickname} onChange={setNickname} className="min-w-[7rem] flex-1" />}
            </div>
          </section>

          {/* 事件上报 */}
          <div data-tour="sim-config-event">
            <EventPanel accountKey={accountKey} official={official} chatType={chatType} groupId={groupId} userId={userId} />
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-white/40 px-5 py-3">
          <Button variant="ghost" onClick={onClear} disabled={!accountKey} className="h-10 flex-1 basis-0 justify-center text-rose-500 hover:bg-rose-500/10">
            <Trash2 className="h-4 w-4" /> 清空缓存
          </Button>
          <Button onClick={() => onOpenChange(false)} className="h-10 flex-1 basis-0 justify-center">完成</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 事件上报面板：按当前会话类型（群/私聊）过滤可选事件；账号级事件始终可见 */
function EventPanel({
  accountKey, official, chatType, groupId, userId,
}: { accountKey: string; official?: boolean; chatType: 'group' | 'private'; groupId: string; userId: string }) {
  // 官方账号用官方事件集；OneBot 账号按会话类型过滤（群/私聊 + 账号级）
  const available = useMemo(
    () => (official ? OFFICIAL_EVENT_TYPES : EVENT_TYPES).filter((e) => e.scope === 'account' || e.scope === chatType),
    [official, chatType],
  );

  const [eventType, setEventType] = useState<SimulateEventType>(available[0]?.value ?? 'profile_like');
  const [evtGroup, setEvtGroup] = useState(groupId);
  const [evtUser, setEvtUser] = useState(userId);
  const [evtOperator, setEvtOperator] = useState('10000');
  const [duration, setDuration] = useState('600');
  const [subType, setSubType] = useState('');
  const [comment, setComment] = useState('');
  const [value, setValue] = useState('');
  const [firing, setFiring] = useState(false);

  useEffect(() => { setEvtGroup(groupId); }, [groupId]);
  useEffect(() => { setEvtUser(userId); }, [userId]);
  // 会话类型切换后，若当前事件已不在可选列表，重置为第一个
  useEffect(() => {
    if (!available.some((e) => e.value === eventType)) {
      setEventType(available[0]?.value ?? 'profile_like');
    }
  }, [available, eventType]);

  const meta = available.find((e) => e.value === eventType) ?? available[0];
  const needs = (k: EventNeed) => !!meta?.needs.includes(k);

  const fire = async () => {
    if (!accountKey) { toast.error('请先选择账号'); return; }
    setFiring(true);
    try {
      const input: SimulateEventInput = {
        eventType,
        groupId: needs('group') ? evtGroup.trim() : undefined,
        userId: needs('user') ? evtUser.trim() : undefined,
        operatorId: needs('operator') ? evtOperator.trim() : undefined,
        duration: needs('duration') ? Number(duration) || 0 : undefined,
        subType: needs('sub') ? (subType.trim() || undefined) : undefined,
        comment: needs('comment') ? (comment.trim() || undefined) : undefined,
        value: needs('value') ? (value.trim() || undefined) : undefined,
      };
      const r = await api.simulate.event(accountKey, input);
      if (r.code !== 0) { toast.error(r.message || '上报失败'); return; }
      if (r.data && r.data.dispatched === 0) toast('该账号没有已加载的插件', { icon: 'ℹ️' });
      else toast.success('事件已上报');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '上报失败');
    } finally {
      setFiring(false);
    }
  };

  return (
    <section className="flex flex-col gap-2 rounded-2xl bg-white/30 p-3">
      <Label className="flex items-center gap-1 text-xs font-medium text-slate-500">
        <Zap className="h-3 w-3" /> 事件上报 · {chatType === 'group' ? '群聊' : '私聊'}场景
      </Label>
      <Select value={eventType} onValueChange={(v) => setEventType(v as SimulateEventType)}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {available.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
        </SelectContent>
      </Select>

      <div className="flex flex-wrap gap-2">
        {needs('group') && <Field label="群号" value={evtGroup} onChange={setEvtGroup} className="w-24" />}
        {needs('user') && <Field label="目标 QQ" value={evtUser} onChange={setEvtUser} className="w-24" />}
        {needs('operator') && <Field label="操作者 QQ" value={evtOperator} onChange={setEvtOperator} className="w-24" />}
        {needs('duration') && <Field label="时长(秒,0=解禁)" value={duration} onChange={setDuration} className="w-28" />}
        {needs('sub') && <Field label="子类型" value={subType} onChange={setSubType} className="w-28" placeholder={subTypeHint(eventType)} />}
        {needs('value') && <Field label={meta?.valueLabel || '值'} value={value} onChange={setValue} className="min-w-[7rem] flex-1" placeholder={meta?.valuePlaceholder} />}
        {needs('comment') && <Field label="验证信息" value={comment} onChange={setComment} className="min-w-[7rem] flex-1" />}
      </div>

      <Button onClick={() => void fire()} disabled={firing || !accountKey} variant="secondary" className="w-full">
        {firing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Zap className="h-4 w-4" />} 触发事件
      </Button>
    </section>
  );
}

function subTypeHint(t: SimulateEventType): string {
  if (t === 'group_decrease') return 'leave / kick';
  if (t === 'group_admin') return 'set / unset';
  if (t === 'group_essence') return 'add / delete';
  return '';
}

type InsertKind = 'image' | 'at' | 'video' | 'record' | 'json';

function AttachDialog({
  open, onOpenChange, onInsertInline, onSendStandalone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onInsertInline: (token: string) => void;
  onSendStandalone: (seg: OB11Segment) => void;
}) {
  const [tab, setTab] = useState<InsertKind>('image');
  const [val, setVal] = useState('');

  const tabs: { k: InsertKind; label: string; icon: typeof ImageIcon; ph: string; inline: boolean }[] = [
    { k: 'image', label: '图片', icon: ImageIcon, ph: '图片 URL / 本地路径 / base64（插入光标处）', inline: true },
    { k: 'at', label: '@', icon: AtSign, ph: 'QQ 号，或 all（插入光标处）', inline: true },
    { k: 'video', label: '视频', icon: Video, ph: '视频 URL / 本地路径（独立发送）', inline: false },
    { k: 'record', label: '语音', icon: Mic, ph: '语音 URL / 本地路径（独立发送）', inline: false },
    { k: 'json', label: 'JSON卡片', icon: Braces, ph: 'JSON 卡片原文（独立发送）', inline: false },
  ];

  const meta = tabs.find((t) => t.k === tab)!;

  const submit = () => {
    const v = val.trim();
    if (!v) return;
    if (tab === 'image') onInsertInline(`[CQ:image,file=${cqEscape(v)}]`);
    else if (tab === 'at') onInsertInline(`[CQ:at,qq=${cqEscape(v)}]`);
    else if (tab === 'video') onSendStandalone({ type: 'video', data: { file: v } });
    else if (tab === 'record') onSendStandalone({ type: 'record', data: { file: v } });
    else if (tab === 'json') onSendStandalone({ type: 'json', data: { data: v } });
    setVal('');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>插入内容</DialogTitle></DialogHeader>

        {/* 一行三个、等大的按钮 */}
        <div className="grid grid-cols-3 gap-2">
          {tabs.map((t) => (
            <button
              key={t.k}
              type="button"
              onClick={() => setTab(t.k)}
              className={cn(
                'flex aspect-[5/3] flex-col items-center justify-center gap-1 rounded-xl border text-sm transition-colors',
                tab === t.k
                  ? 'border-teal-400/60 bg-teal-500/20 text-teal-800'
                  : 'border-white/40 bg-white/30 text-slate-600 hover:bg-white/45',
              )}
            >
              <t.icon className="h-5 w-5" />
              {t.label}
            </button>
          ))}
        </div>

        <div className="text-[11px] text-slate-500">
          {meta.inline ? '插入到输入框光标位置，可与文字混排' : '独立成一条消息发送，不与文字或其他内容混排'}
        </div>

        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          placeholder={meta.ph}
          rows={tab === 'json' ? 4 : 2}
          className="w-full resize-none rounded-xl border border-white/40 bg-white/25 px-3 py-2 text-sm outline-none no-scrollbar focus:border-teal-400/50 focus:bg-white/35"
        />

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={submit}>{meta.inline ? '插入' : '发送'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function cqEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;').replace(/,/g, '&#44;');
}
