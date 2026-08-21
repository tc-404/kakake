import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, ChevronsDown, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, setStoredToken } from '@/lib/api';
import { loadAnnouncementMarkdown } from '@/lib/load-announcement';
import { resolvePostLoginTarget } from '@/lib/post-login';
import { clearAuthGateCache } from '@/components/auth-guard';
import { cn } from '@/lib/utils';

type Phase = 'boot' | 'ready' | 'leaving';

/** 底部药丸 + 安全区预留，供正文滚动留白 */
const FOOTER_H = 96;

export default function AnnouncementPage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('boot');
  const [markdown, setMarkdown] = useState('');
  const [source, setSource] = useState<'remote' | 'fallback'>('remote');
  const [progress, setProgress] = useState(0);
  const [canAgree, setCanAgree] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      try {
        const s = await api.authState();
        if (cancelled) return;
        if (!s.authed) {
          navigate('/login', { replace: true });
          return;
        }

        const agreement = await api.agreementState();
        if (cancelled) return;
        if (agreement.agreed) {
          const target = await resolvePostLoginTarget();
          if (cancelled) return;
          navigate(target === '/announcement' ? '/' : target, { replace: true });
          return;
        }

        const payload = await loadAnnouncementMarkdown();
        if (cancelled) return;
        setMarkdown(payload.markdown);
        setSource(payload.source);
        setPhase('ready');
      } catch {
        if (!cancelled) navigate('/login', { replace: true });
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const recomputeScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const { scrollTop, clientHeight, scrollHeight } = el;
    const max = scrollHeight - clientHeight;
    if (max <= 8) {
      setProgress(100);
      setCanAgree(true);
      return;
    }
    const atBottom = scrollTop + clientHeight >= scrollHeight - 4;
    const ratio = Math.min(1, Math.max(0, scrollTop / max));
    const pct = atBottom ? 100 : Math.min(99, Math.round(ratio * 100));
    // 阅读进度只增不减：回滑不回退百分比
    setProgress((prev) => Math.max(prev, pct));
    if (atBottom || pct >= 100) setCanAgree(true);
  }, []);

  useEffect(() => {
    if (phase !== 'ready') return;
    const id = window.requestAnimationFrame(() => recomputeScroll());
    const onResize = () => recomputeScroll();
    window.addEventListener('resize', onResize);
    return () => {
      window.cancelAnimationFrame(id);
      window.removeEventListener('resize', onResize);
    };
  }, [phase, markdown, recomputeScroll]);

  const jumpToBottom = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const onAgree = async () => {
    if (!canAgree || busy) return;
    setBusy(true);
    try {
      await api.agreementAgree();
      clearAuthGateCache();
      setPhase('leaving');
      const target = await resolvePostLoginTarget();
      const next = target === '/announcement' ? '/' : target;
      if (next === '/setup-password') {
        toast.success('已同意协议', { description: '请设置登录密码…', duration: 1800 });
      } else {
        toast.success('已同意协议', { description: '正在进入控制台…', duration: 1800 });
      }
      navigate(next, { replace: true });
    } catch (e) {
      toast.error(String(e));
      setBusy(false);
    }
  };

  const onRefuse = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await api.logout();
    } catch {
      /* ignore */
    }
    setStoredToken('');
    toast.message('已拒绝协议', { description: '已返回登录页' });
    navigate('/login', { replace: true });
  };

  if (phase === 'boot' || phase === 'leaving') {
    return (
      <div className="kk-ambient flex h-[100dvh] flex-col items-center justify-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <p className="text-sm text-slate-400">
          {phase === 'leaving' ? '正在进入控制台…' : '正在加载协议…'}
        </p>
      </div>
    );
  }

  const progressLabel =
    progress >= 100
      ? '100% 阅读完毕，请点击确认'
      : `已阅读 ${progress}%`;

  return (
    <div className="kk-ambient relative flex h-[100dvh] flex-col">
      {/* 顶部固定栏：紧凑标题 + 进度 */}
      <header className="kk-glass-nav sticky top-0 z-30 mx-3 mt-2 shrink-0 rounded-2xl sm:mx-4">
        <div className="mx-auto w-full max-w-3xl px-3.5 py-2.5 sm:px-4 sm:py-3">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-base font-bold tracking-tight text-slate-800 sm:text-lg">
              用户协议与公告
            </h1>
            <p
              className={cn(
                'shrink-0 text-[11px] tabular-nums',
                progress >= 100 ? 'font-medium text-teal-700' : 'text-slate-400',
              )}
            >
              {progressLabel}
            </p>
          </div>
          <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
            请阅读至底部后再确认
            {source === 'fallback' ? ' · 本地备用文案' : ''}
          </p>
          <div className="mt-2 flex items-center gap-2.5">
            <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/20">
              <div
                className="h-full rounded-full bg-gradient-to-r from-teal-400 to-teal-500 transition-[width] duration-150 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="w-8 shrink-0 tabular-nums text-right text-[11px] font-medium text-teal-700">
              {progress}%
            </span>
          </div>
        </div>
      </header>

      {/* 仅正文卡片可滚动（隐藏滚动条，保留滑动） */}
      <div
        ref={scrollRef}
        onScroll={recomputeScroll}
        className="no-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-3 sm:px-6 sm:pt-4"
        style={{ paddingBottom: FOOTER_H + 28 }}
      >
        <div className="mx-auto w-full max-w-3xl">
          <article
            className={cn(
              'kk-md-prose relative overflow-hidden rounded-3xl p-6 text-slate-800 sm:p-8 md:p-10',
              'border border-white/50 bg-white/20 shadow-[0_8px_32px_rgba(0,0,0,0.06)]',
              'backdrop-blur-xl',
            )}
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-16 rounded-t-3xl bg-gradient-to-b from-white/40 to-transparent"
            />
            <div className="relative">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  a: ({ href, children }) => {
                    const url = typeof href === 'string' ? href : '';
                    if (!url) return <span>{children}</span>;
                    return (
                      <button
                        type="button"
                        className="cursor-pointer text-teal-700 underline underline-offset-2 hover:text-teal-800"
                        onClick={(e) => {
                          e.preventDefault();
                          if (/^https?:\/\//i.test(url)) {
                            window.open(url, '_blank', 'noopener,noreferrer');
                          } else if (url.startsWith('mailto:') || url.startsWith('tel:')) {
                            window.location.href = url;
                          }
                        }}
                      >
                        {children}
                      </button>
                    );
                  },
                }}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          </article>
        </div>
      </div>

      {!canAgree ? (
        <button
          type="button"
          onClick={jumpToBottom}
          className={cn(
            'absolute z-20 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-slate-700',
            'border border-white/40 bg-white/20 shadow-md backdrop-blur-sm',
            'transition-all hover:-translate-y-1 hover:bg-white/40 active:scale-95',
          )}
          style={{ right: 16, bottom: FOOTER_H + 12 }}
        >
          {progress < 40 ? (
            <>
              <ArrowDown className="h-3.5 w-3.5 animate-bounce" />
              向下阅读
            </>
          ) : (
            <>
              <ChevronsDown className="h-3.5 w-3.5" />
              跳至底部
            </>
          )}
        </button>
      ) : null}

      {/* 底部居中玻璃药丸 */}
      <div
        className={cn(
          'fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 p-3 sm:bottom-8 sm:gap-4',
          'rounded-2xl border border-white/40 bg-white/20 shadow-2xl shadow-slate-200/30 backdrop-blur-xl',
          'transition-opacity duration-300',
          !canAgree && 'opacity-90',
        )}
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom, 0px))' }}
      >
        <button
          type="button"
          disabled={busy}
          onClick={() => void onRefuse()}
          className={cn(
            'rounded-xl border border-white/30 bg-transparent px-6 py-2.5 text-sm font-medium text-slate-700',
            'transition-all hover:bg-white/30 active:scale-[0.98] disabled:opacity-50',
          )}
        >
          我拒绝
        </button>
        <button
          type="button"
          disabled={!canAgree || busy}
          onClick={() => void onAgree()}
          title={canAgree ? '同意并进入控制台' : '请先滚动阅读至底部'}
          className={cn(
            'inline-flex items-center justify-center gap-2 rounded-xl px-8 py-2.5 text-sm font-semibold transition-all duration-300',
            canAgree
              ? cn(
                  'kk-agree-unlock border border-white/30 text-white',
                  'bg-gradient-to-r from-teal-500 to-teal-600',
                  'shadow-lg shadow-teal-500/30 hover:-translate-y-0.5 hover:shadow-xl active:scale-[0.96]',
                )
              : 'pointer-events-none cursor-not-allowed border border-white/20 bg-white/15 text-slate-500 opacity-50',
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          我同意
        </button>
      </div>
    </div>
  );
}
