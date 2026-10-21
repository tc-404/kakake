import { FormEvent, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, setStoredToken } from '@/lib/api';
import { resolvePostLoginTarget } from '@/lib/post-login';
import { clearAuthGateCache } from '@/components/auth-guard';
import { AmbientVideo } from '@/components/ambient-video';
import { BackgroundPresetLayer } from '@/components/background-preset-layer';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { errText, resText, svcText } from '@/lib/server-error';

type Phase = 'checking' | 'form' | 'submitting' | 'entering';

function targetToast(target: string, t: (k: string) => string): { title: string; description: string } {
  if (target === '/announcement') {
    return { title: t('login.loginSuccess'), description: t('login.agreeTerms') };
  }
  if (target === '/setup-password') {
    return { title: t('login.loginSuccess'), description: t('login.setupPasswordHint') };
  }
  return { title: t('login.loginSuccess'), description: t('login.enteringConsole') };
}

export default function LoginPageInner() {
  const navigate = useNavigate();
  const t = useT();
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [phase, setPhase] = useState<Phase>('checking');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const triggerError = (message: string) => {
    setError(message);
    setShake(true);
    window.setTimeout(() => setShake(false), 450);
    inputRef.current?.focus();
  };

  const enterAfterLogin = async (message = '登录成功') => {
    setStoredToken('');
    setError('');
    setPhase('entering');
    clearAuthGateCache();
    try {
      const target = await resolvePostLoginTarget();
      const tip = targetToast(target, t);
      // message 是后端原文（多为「登录成功」），默认态用引导文案，其余先翻成当前语言
      toast.success(message === '登录成功' ? tip.title : svcText(message), {
        description: tip.description,
        duration: 1800,
      });
      window.setTimeout(() => {
        navigate(target, { replace: true });
      }, 420);
    } catch (e) {
      setPhase('form');
      toast.error(errText(e));
    }
  };

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const urlKey = searchParams.get('key')?.trim() || '';
      if (urlKey) {
        setPhase('submitting');
        try {
          const r = await api.login(urlKey);
          if (cancelled) return;
          if (r.ok) {
            await enterAfterLogin(t('login.keyVerified'));
            return;
          }
          toast.error(resText(r) || t('login.loginKeyError'));
          navigate('/login', { replace: true });
          setPhase('form');
          triggerError(resText(r) || t('login.keyErrorRetry'));
        } catch (e) {
          if (!cancelled) {
            toast.error(errText(e));
            navigate('/login', { replace: true });
            setPhase('form');
            triggerError(String(e));
          }
        }
        return;
      }

      try {
        const s = await api.authState();
        if (cancelled) return;
        if (s.authed) {
          setPhase('entering');
          try {
            const target = await resolvePostLoginTarget();
            if (cancelled) return;
            navigate(target, { replace: true });
          } catch {
            if (!cancelled) {
              setPhase('form');
            }
          }
          return;
        }
        setPhase('form');
        window.setTimeout(() => inputRef.current?.focus(), 80);
      } catch {
        if (!cancelled) setPhase('form');
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!token.trim() || phase === 'submitting' || phase === 'entering') return;
    setError('');
    setPhase('submitting');
    try {
      const r = await api.login(token.trim());
      if (!r.ok) {
        setPhase('form');
        triggerError(resText(r) || t('login.keyErrorRetry'));
        toast.error(resText(r) || t('login.loginKeyError'));
        return;
      }
      await enterAfterLogin(t('login.loginSuccess'));
    } catch (err) {
      setPhase('form');
      const msg = String(err).replace(/^Error:\s*/i, '') || t('login.keyErrorRetry');
      triggerError(msg);
      toast.error(msg);
    }
  };

  const busy = phase === 'checking' || phase === 'submitting' || phase === 'entering';

  if (phase === 'checking') {
    return (
      <div className="kk-login-ambient flex h-full min-h-[100dvh] flex-col items-center justify-center gap-3">
        <AmbientVideo />
        <BackgroundPresetLayer />
        <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
        <p className="text-sm text-slate-500/80">{t('login.checkingStatus')}</p>
      </div>
    );
  }

  return (
    <div className="kk-login-ambient relative flex h-full min-h-[100dvh] items-center justify-center px-4 py-8">
      <AmbientVideo />
      <BackgroundPresetLayer />
      {(phase === 'submitting' || phase === 'entering') && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-white/15 backdrop-blur-md">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <p className="text-sm text-slate-600">
            {phase === 'entering' ? t('login.entering') : t('login.verifyingKey')}
          </p>
        </div>
      )}

      <div
        className={cn(
          'kk-auth-card flex w-full max-w-sm flex-col gap-6 overflow-hidden rounded-3xl p-8',
          shake && 'animate-kk-shake',
        )}
      >
        {/* 顶部玻璃高光 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-12 rounded-t-3xl bg-gradient-to-b from-white/40 to-transparent"
        />
        {/* 边缘微光 */}
        <div
          aria-hidden
          className="kk-edge-sheen pointer-events-none absolute inset-0 rounded-3xl"
        />

        <div className="relative z-10 mt-1 text-center">
          <h1 className="kk-logo-text text-3xl font-bold tracking-tight">{t('brand.kakake')}</h1>
          <p className="mt-1.5 text-sm text-slate-500/80">{t('login.enterKeyPrompt')}</p>
        </div>

        <form onSubmit={onSubmit} className="relative z-10 flex flex-col gap-4" noValidate>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="login-token" className="text-sm font-medium text-slate-700">
              {t('login.loginKey')}
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="login-token"
                type={showToken ? 'text' : 'password'}
                autoComplete="current-password"
                value={token}
                disabled={busy}
                onChange={(e) => {
                  setToken(e.target.value);
                  if (error) setError('');
                }}
                placeholder={t('login.pleaseEnterKey')}
                className={cn(
                  'w-full rounded-xl border border-white/50 bg-white/30 px-4 py-2.5 pr-11 text-sm text-slate-800',
                  'backdrop-blur-sm placeholder:text-slate-400/70 outline-none transition-all',
                  'focus:bg-white/40 focus:ring-2 focus:ring-teal-500/50',
                  'disabled:opacity-60',
                  error && 'border-rose-400/70 focus:ring-rose-400/40',
                )}
              />
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-500 transition-colors hover:bg-white/30 hover:text-slate-700 disabled:opacity-50"
                onClick={() => setShowToken((v) => !v)}
                aria-label={showToken ? t('login.hideKey') : t('login.showKey')}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error ? <p className="text-xs font-medium text-rose-500">{error}</p> : null}
          </div>

          <button
            type="submit"
            disabled={busy || !token.trim()}
            className={cn(
              'mt-1 flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-all duration-300',
              token.trim()
                ? 'border border-white/30 bg-gradient-to-r from-teal-500 to-teal-600 text-white shadow-lg kk-glow hover:-translate-y-0.5 hover:shadow-xl active:translate-y-0'
                : 'cursor-not-allowed border border-white/30 bg-white/35 text-slate-400',
            )}
          >
            {phase === 'submitting' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {phase === 'submitting' ? t('login.verifying') : t('login.login')}
          </button>
        </form>
      </div>
    </div>
  );
}
