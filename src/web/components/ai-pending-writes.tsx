import { useCallback, useEffect, useRef, useState } from 'react';
import { FilePlus2, FilePenLine, RotateCcw, Undo2, X } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { aiApi, type AiAppliedWrite, type AiPendingWrite } from '@/lib/ai';
import { toast } from 'sonner';

/**
 * AI 写入确认闸门面板：展示暂存区里的改动，提供 应用 / 放弃 / 回滚。
 *
 * 自包含轮询（4s）+ 暴露 window 事件刷新：AI 会话里模型每次暂存都会产出
 * staged 的 FileChange，但面板不该和消息流耦合，轮询是最省心的同步方式
 * （与页面里 1s/3s 的既有轮询节奏一致，4s 对「点应用后消失」足够跟手，
 * 主动操作后本地立即 setState，无需等下一轮）。
 *
 * 挂载点：AI 页输入区上方。无待应用改动时折叠成一行入口，不占空间。
 */

const POLL_MS = 4000;
/** 主动操作后广播，其他挂载实例（如果将来有多处）立即刷新 */
const REFRESH_EVENT = 'ai-pending-writes:refresh';

export function notifyPendingWritesChanged(): void {
  window.dispatchEvent(new CustomEvent(REFRESH_EVENT));
}

export function AiPendingWritesPanel() {
  const t = useT();
  const [pending, setPending] = useState<AiPendingWrite[]>([]);
  const [applied, setApplied] = useState<AiAppliedWrite[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await aiApi.listPendingWrites();
      if (!mountedRef.current) return;
      setPending(r.pending || []);
      setApplied(r.applied || []);
    } catch {
      /* 轮询失败静默：下一轮再试 */
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    const onRefresh = () => void refresh();
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [refresh]);

  const act = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await refresh();
      notifyPendingWritesChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh]);

  // 无任何可展示内容时不渲染（含已应用记录都看完的稳定态）
  const hasPending = pending.length > 0;
  const revertable = applied.filter((a) => !a.reverted);
  if (!hasPending && !expanded && revertable.length === 0) return null;

  return (
    <div
      className="flex shrink-0 flex-col gap-1.5 rounded-2xl border border-teal-200/70 bg-teal-50/80 px-3 py-2 text-xs text-slate-600"
      data-testid="ai-pending-writes"
    >
      <button
        type="button"
        className="flex items-center gap-2 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium text-teal-700">{t('ai.pwTitle')}</span>
        {hasPending && (
          <span className="rounded-full bg-teal-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-teal-700">
            {pending.length}
          </span>
        )}
        {!hasPending && <span className="text-[11px] text-slate-400">{t('ai.pwGateOff')}</span>}
        <span className="ml-auto truncate text-[11px] text-slate-400">{t('ai.pwHint')}</span>
      </button>

      {expanded && hasPending && (
        <div className="flex flex-col gap-1">
          {pending.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded-xl bg-white/60 px-2 py-1.5">
              {p.kind === 'create'
                ? <FilePlus2 className="h-3.5 w-3.5 shrink-0 text-teal-500" />
                : <FilePenLine className="h-3.5 w-3.5 shrink-0 text-teal-500" />}
              <span className="max-w-[18rem] truncate font-mono md:max-w-[28rem]" title={p.relPath}>{p.relPath}</span>
              <span className="shrink-0 rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[10px] text-teal-600">
                {p.kind === 'create' ? t('ai.pwCreate') : t('ai.pwModify')}
              </span>
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-lg px-2 py-0.5 text-[11px] font-medium text-teal-700 hover:bg-teal-500/10 disabled:opacity-50"
                  onClick={() => void act(() => aiApi.applyPendingWrites([p.id]))}
                >
                  {t('ai.pwApply')}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  aria-label={t('ai.pwDiscard')}
                  className="rounded-lg p-1 text-slate-400 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
                  onClick={() => void act(() => aiApi.discardPendingWrites([p.id]))}
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              disabled={busy}
              className="rounded-lg bg-teal-500/90 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-teal-600 disabled:opacity-50"
              onClick={() => void act(() => aiApi.applyPendingWrites(undefined, true))}
            >
              {t('ai.pwApplyAll')}
            </button>
            <button
              type="button"
              disabled={busy}
              className="rounded-lg px-2.5 py-1 text-[11px] text-slate-500 hover:bg-rose-500/10 hover:text-rose-500 disabled:opacity-50"
              onClick={() => void act(() => aiApi.discardPendingWrites(undefined, true))}
            >
              {t('ai.pwDiscardAll')}
            </button>
            {revertable.length > 0 && (
              <button
                type="button"
                className="ml-auto text-[11px] text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline"
                onClick={() => setShowHistory((v) => !v)}
              >
                {t('ai.pwHistory')}（{revertable.length}）
              </button>
            )}
          </div>
        </div>
      )}

      {expanded && showHistory && (
        <div className="flex flex-col gap-1 border-t border-teal-200/60 pt-1.5">
          {applied.slice(0, 20).map((a) => (
            <div key={a.id} className="flex items-center gap-2 rounded-xl bg-white/40 px-2 py-1">
              <RotateCcw className="h-3 w-3 shrink-0 text-slate-400" />
              <span className="max-w-[18rem] truncate font-mono md:max-w-[28rem]" title={a.relPath}>{a.relPath}</span>
              {a.reverted ? (
                <span className="shrink-0 rounded-full bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-500">{t('ai.pwReverted')}</span>
              ) : (
                <span className="shrink-0 rounded-full bg-teal-500/10 px-1.5 py-0.5 text-[10px] text-teal-600">{t('ai.pwApplied')}</span>
              )}
              {!a.reverted && (
                <button
                  type="button"
                  disabled={busy}
                  className="ml-auto flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-500/10 hover:text-slate-700 disabled:opacity-50"
                  onClick={() => void act(() => aiApi.revertAppliedWrite(a.id))}
                >
                  <Undo2 className="h-3 w-3" />
                  {t('ai.pwRevert')}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
