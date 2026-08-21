import { FormEvent, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, Check, Eye, EyeOff, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { resolvePostLoginTarget } from '@/lib/post-login';
import { clearAuthGateCache } from '@/components/auth-guard';
import {
  evaluatePasswordRules,
  hasChineseInPassword,
  isPasswordFullyValid,
} from '@/lib/password-rules';
import { cn } from '@/lib/utils';

type Phase = 'boot' | 'form' | 'submitting' | 'done';

export default function SetupPasswordPage() {
  const navigate = useNavigate();
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
      toast.success('密码已设置', { description: '正在进入控制台…' });
      navigate('/', { replace: true });
    } catch (err) {
      setPhase('form');
      setError(String(err).replace(/^Error:\s*/i, '') || '设置失败');
      toast.error(String(err));
    }
  };

  if (phase === 'boot' || phase === 'done') {
    return (
      <div className="kk-login-ambient flex h-dvh max-h-dvh w-full items-center justify-center overflow-hidden">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
          <p className="text-sm text-slate-500/80">
            {phase === 'done' ? '正在进入控制台…' : '正在准备…'}
          </p>
        </div>
      </div>
    );
  }

  const busy = phase === 'submitting';

  return (
    <div className="kk-login-ambient flex h-dvh max-h-dvh w-full items-center justify-center overflow-hidden px-4 py-4">
      <div
        className={cn(
          'relative max-h-full w-full max-w-md overflow-x-hidden overflow-y-auto no-scrollbar rounded-3xl',
          'border border-white/50 bg-white/20 p-6 shadow-[0_8px_32px_rgba(0,0,0,0.06)]',
          'backdrop-blur-xl sm:max-w-lg sm:p-8',
        )}
      >
        {/* 顶部玻璃高光 */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-12 rounded-t-3xl bg-gradient-to-b from-white/40 to-transparent"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-3xl shadow-[inset_0_1px_0_rgba(255,255,255,0.65),inset_0_-1px_0_rgba(255,255,255,0.12)]"
        />

        <div className="relative z-10 mb-7 flex flex-col items-center text-center">
          <h1 className="text-2xl font-bold tracking-tight text-slate-800">设置登录密码</h1>
          <div className="mt-3 flex w-full items-start gap-2 rounded-xl border border-yellow-400/40 bg-yellow-400/20 px-4 py-3 text-left text-sm text-yellow-700 backdrop-blur-sm sm:items-center sm:justify-center sm:text-center">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-600 sm:mt-0" />
            <span className="font-medium leading-snug">
              请注意：此密码一旦设置完成，系统内将无法修改！
            </span>
          </div>
          <p className="mt-3 text-sm text-slate-500/80">请输入符合下方所有规则的自定义密码</p>
        </div>

        <form onSubmit={onSubmit} className="relative z-10 space-y-5" noValidate>
          <div>
            <label htmlFor="new-password" className="mb-2 block text-sm font-medium text-slate-700">
              新密码
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
                placeholder="超过 10 位，含大小写、数字与特殊符号"
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
                aria-label={showPwd ? '隐藏密码' : '显示密码'}
              >
                {showPwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {hasChinese ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-rose-500">
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                禁止输入中文
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
              再次输入
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
                placeholder="请再输入一次"
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
                aria-label={showConfirm ? '隐藏密码' : '显示密码'}
              >
                {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            {error ? (
              <p className="mt-2 text-xs font-medium text-rose-500">{error}</p>
            ) : confirmMismatch ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-rose-500">
                <X className="h-3.5 w-3.5" strokeWidth={2.5} />
                两次输入的密码不一致
              </p>
            ) : confirmOk ? (
              <p className="mt-2 flex items-center gap-1 text-xs font-medium text-teal-700">
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
                两次密码匹配
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
                ? 'kk-btn-ready border border-white/30 bg-teal-500/80 text-white shadow-lg shadow-teal-500/30 hover:-translate-y-0.5 hover:bg-teal-500/90 hover:shadow-xl hover:shadow-teal-500/40 active:translate-y-0'
                : 'cursor-not-allowed border border-slate-400/30 bg-transparent text-slate-400/50 backdrop-blur-sm',
            )}
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {busy ? '设置中…' : '确认设置'}
          </button>
        </form>
      </div>
    </div>
  );
}
