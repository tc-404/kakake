import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api, setStoredToken, setUnauthorizedHandler } from '@/lib/api';
import { resolvePostLoginTarget } from '@/lib/post-login';
import { useT } from '@/lib/i18n';
import { AmbientVideo } from '@/components/ambient-video';

type Gate = 'loading' | 'ok' | 'denied' | 'redirect';

/** 本 SPA 生命周期内：已确认可进控制台（刷新会清空） */
let gateCache: { ok: true } | null = null;

export function clearAuthGateCache(): void {
  gateCache = null;
}

async function checkConsoleAccess(): Promise<'ok' | 'denied' | PostLoginRedirect> {
  const s = await api.authState();
  if (!s.authed) return 'denied';
  try {
    const target = await resolvePostLoginTarget();
    if (target !== '/') return target;
    return 'ok';
  } catch (e) {
    if (e instanceof Error && e.message === 'UNAUTHORIZED') return 'denied';
    // 瞬时错误：若本页已确认过，保持 ok，避免踢去登录闪屏
    if (gateCache?.ok) return 'ok';
    throw e;
  }
}

type PostLoginRedirect = '/announcement' | '/setup-password';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Gate>(gateCache?.ok ? 'ok' : 'loading');
  const navigate = useNavigate();
  const redirected = useRef(false);
  const running = useRef(false);
  const t = useT();

  /*
   * 全局 401 兜底：request() 收到 401（登录/设密端点除外）时统一走这里，
   * 与 useSessionActivity 的 forceLogout 同一条路径；卸载时注销，登录页不受影响。
   */
  useEffect(() => {
    setUnauthorizedHandler(() => {
      setStoredToken('');
      gateCache = null;
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      if (running.current) return;
      running.current = true;
      // 有缓存时先展示控制台，后台再校验，减少刷新白屏/闪登录
      if (!gateCache?.ok) setState('loading');

      try {
        let result: 'ok' | 'denied' | PostLoginRedirect;
        try {
          result = await checkConsoleAccess();
        } catch {
          // 重试一次，避免偶发网络抖动直接 deny
          await new Promise((r) => setTimeout(r, 200));
          if (cancelled) return;
          try {
            result = await checkConsoleAccess();
          } catch {
            // 仍失败：有缓存则保持；无缓存再 deny
            if (cancelled) return;
            if (gateCache?.ok) {
              setState('ok');
              return;
            }
            setState('denied');
            return;
          }
        }

        if (cancelled) return;

        if (result === 'denied') {
          gateCache = null;
          setState('denied');
          return;
        }

        if (result !== 'ok') {
          setState('redirect');
          if (!redirected.current) {
            redirected.current = true;
            navigate(result, { replace: true });
          }
          return;
        }

        gateCache = { ok: true };
        setState('ok');
      } finally {
        running.current = false;
      }
    };

    void run();
    return () => {
      cancelled = true;
      running.current = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (state === 'denied') {
      navigate('/login', { replace: true });
    }
  }, [state, navigate]);

  if (state === 'loading' || state === 'redirect') {
    return (
      <div className="kk-ambient flex h-screen flex-col items-center justify-center gap-3">
        <AmbientVideo />
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('components.enteringConsole')}</p>
      </div>
    );
  }

  if (state === 'denied') return null;

  return <>{children}</>;
}
