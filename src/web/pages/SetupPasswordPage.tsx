import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { resolvePostLoginTarget } from '@/lib/post-login';
import { clearAuthGateCache } from '@/components/auth-guard';
import { AmbientVideo } from '@/components/ambient-video';
import { BackgroundPresetLayer } from '@/components/background-preset-layer';
import {
  evaluatePasswordRules,
  hasChineseInPassword,
  isPasswordFullyValid,
} from '@/lib/password-rules';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { errText } from '@/lib/server-error';

type Phase = 'boot' | 'form' | 'submitting' | 'done';

export default function SetupPasswordPage() {
  const navigate = useNavigate();
  const t = useT();
  const [phase, setPhase] = useState<Phase>('boot');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [readyAnimKey, setReadyAnimKey] = useState(0);

  const rules = useMemo(() => evaluatePasswordRules(password), [password]);
  const hasChinese = useMemo(() => hasChineseInPassword(password), [password]);
  const allRulesOk = useMemo(() => isPasswordFullyValid(password), [password]);
  const confirmTouched = confirm.length > 0;
  const confirmOk = confirmTouched && password === confirm;
  const confirmMismatch = confirmTouched && password !== confirm;
  const canSubmit = allRulesOk && confirmOk;

  useEffect(() => {
    if (canSubmit) setReadyAnimKey((k) => k + 1);
  }, [canSubmit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.authState();
        if (cancelled) return;
        if (!s.authed) {
          navigate('/login', { replace: true });
          return;
        }
        const target = await resolvePostLoginTarget();
        if (cancelled) return;
        if (target === '/announcement') {
          navigate('/announcement', { replace: true });
          return;
        }
        if (target === '/') {
          navigate('/', { replace: true });
          return;
        }
        setPhase('form');
      } catch {
        if (!cancelled) navigate('/login', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (phase === 'submitting' || phase === 'done' || !canSubmit) return;
    setError('');

    setPhase('submitting');
    try {
      await api.setupPassword(password, confirm);
      clearAuthGateCache();
      setPhase('done');
      toast.success(t('login.passwordSet'), { description: t('login.enteringConsole') });
      navigate('/', { replace: true });
    } catch (err) {
      setPhase('form');
      setError(String(err).replace(/^Error:\s*/i, '') || t('login.setupFailed'));
      toast.error(errText(err));
    }
  };

  if (phase === 'boot' || phase === 'done') {
    return (
      <div className="kk-login-ambient flex h-dvh max-h-dvh w-full items-center justify-center overflow-hidden">
        <AmbientVideo />
        <BackgroundPresetLayer />
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <p className="text-sm text-slate-500/80">
            {phase === 'done' ? t('login.enteringConsole') : t('login.preparing')}
          </p>
        </div>
      </div>
    );
  }

  const busy = phase === 'submitting';

  return (
    <div className="kk-login-ambient flex h-dvh max-h-dvh w-full items-center justify-center overflow-hidden px-4 py-4">
      <AmbientVideo />
      <BackgroundPresetLayer />
      <div
        className={cn(
          'kk-auth-card max-h-full w-full max-w-md overflow-x-hidden overflow-y-auto no-scrollbar rounded-3xl',
          'p-6 sm:max-w-lg sm:p-8',
        )}
      >
        {/* 顶部玻璃高光 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-12 rounded-t-3xl bg-gradient-to-b from-white/40 to-transparent"
        />
        <div
          aria-hidden
          className="kk-edge-sheen pointer-events-none absolute inset-0 rounded-3xl"
        />

        <div className="relative z-10 mb-7 flex flex-col items-center text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">{t('login.setupPasswordTitle')}</h1>
          <div className="mt-3 flex w-full items-start gap-2 rounded-xl border border-yellow-400/40 bg-yellow-400/20 px-4 py-3 text-left text-sm text-yellow-700 backdrop-blur-sm sm:items-center sm:justify-center sm:text-center">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 sm:mt-0" />
            <span className="font-medium leading-snug">
              {t('login.cannotModifyWarning')}
            </span>
          </div>
          <p className="mt-3 text-sm text-slate-500/80">{t('login.enterCustomPassword')}</p>
        </div>

        <form onSubmit={onSubmit} className="relative z-10 space-y-5" noValidate>
          <div>
            <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-slate-700">
              {t('login.newPassword')}
            </label>
            <div className="relative">
              <input
                id="new-password"
                type={showPwd ? 'text' : 'password'}
                autoComplete="new-password"
                value={password}
                disabled={busy}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError('');
                }}
                placeholder={t('login.pwdPlaceholder')}
                className={cn(
                  'w-full rounded-xl border border-white/40 bg-white/30 px-4 py-2.5 pr-11 text-sm text-slate-700',
                  'backdrop-blur-sm placeholder:text-slate-400 outline-none transition-all',
                  'focus:border-teal-400/60 focus:bg-white/40 focus:ring-2 focus:ring-teal-500/30',
                  'disabled:opacity-60',
                  hasChinese && 'border-rose-400/70 focus:border-rose-400/80 focus:ring-rose-400/30',
                  !hasChinese && error && 'border-rose-400/70 focus:ring-rose-400/30',
                )}
              />
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-500 transition-colors hover:bg-white/20 hover:text-slate-700 disabled:opacity-50"
                onClick={() => setShowPwd((v) => !v)}
                aria-label={showPwd ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {hasChinese ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-rose-500">
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                {t('login.noChinese')}
              </p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-1.5">
              {rules.map((rule) => {
                const isFail = Boolean(rule.fail);
                const isOk = rule.ok;
                return (
                  <span
                    key={rule.id}
                    data-valid={isOk ? 'true' : 'false'}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-all duration-200',
                      isFail
                        ? 'border-rose-400/40 bg-rose-400/15 text-rose-600'
                        : isOk
                          ? 'border-teal-400/40 bg-teal-400/20 text-teal-700'
                          : 'border-white/30 bg-white/20 text-slate-500',
                    )}
                  >
                    {isFail ? (
                      <X className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                    ) : isOk ? (
                      <Check className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                    ) : null}
                    {rule.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div>
            <label htmlFor="confirm-password" className="mb-2 block text-sm font-medium text-slate-700">
              {t('login.confirmInput')}
            </label>
            <div className="relative">
              <input
                id="confirm-password"
                type={showConfirm ? 'text' : 'password'}
                autoComplete="new-password"
                value={confirm}
                disabled={busy}
                onChange={(e) => {
                  setConfirm(e.target.value);
                  if (error) setError('');
                }}
                placeholder={t('login.confirmPlaceholder')}
                className={cn(
                  'w-full rounded-xl border border-white/40 bg-white/30 px-4 py-2.5 pr-11 text-sm text-slate-700',
                  'backdrop-blur-sm placeholder:text-slate-400 outline-none transition-all',
                  'focus:border-teal-400/60 focus:bg-white/40 focus:ring-2 focus:ring-teal-500/30',
                  'disabled:opacity-60',
                  confirmMismatch && 'border-rose-400/70 focus:border-rose-400/80 focus:ring-rose-400/30',
                  confirmOk && 'border-teal-400/50 focus:border-teal-400/60 focus:ring-teal-500/30',
                )}
              />
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-slate-500 transition-colors hover:bg-white/20 hover:text-slate-700 disabled:opacity-50"
                onClick={() => setShowConfirm((v) => !v)}
                aria-label={showConfirm ? t('login.hidePassword') : t('login.showPassword')}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error ? (
              <p className="mt-2 text-xs font-medium text-rose-500">{error}</p>
            ) : confirmMismatch ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-rose-500">
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                {t('login.mismatch')}
              </p>
            ) : confirmOk ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-teal-700">
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                {t('login.match')}
              </p>
            ) : null}
          </div>

          <button
            key={readyAnimKey}
            type="submit"
            disabled={busy || !canSubmit}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-medium transition-all duration-300',
              canSubmit
                ? 'kk-btn-ready border border-white/30 bg-teal-500/80 text-white shadow-lg kk-glow hover:-translate-y-0.5 hover:bg-teal-500/90 hover:shadow-xl active:translate-y-0'
                : 'cursor-not-allowed border border-slate-400/30 bg-transparent text-slate-400/50 backdrop-blur-sm',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? t('login.setting') : t('login.confirmSetup')}
          </button>
        </form>
      </div>
    </div>
  );
}
