import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, setStoredToken } from '@/lib/api';
import { clearAuthGateCache } from '@/components/auth-guard';

/** 最短续期间隔 */
const TOUCH_THROTTLE_MS = 20_000;
/** 进入控制台后再续期，避开与 AuthGuard 抢跑 */
const INITIAL_TOUCH_DELAY_MS = 800;

/**
 * 控制台互动时续期会话：重置 30 分钟空闲计时。
 * 仅会话真正失效（401）时踢回登录；网络抖动不闪屏。
 */
export function useSessionActivity(enabled: boolean): void {
  const navigate = useNavigate();
  const lastTouch = useRef(0);
  const touching = useRef(false);

  useEffect(() => {
    if (!enabled) return;

    const forceLogout = () => {
      setStoredToken('');
      clearAuthGateCache();
      navigate('/login', { replace: true });
    };

    const touch = () => {
      const now = Date.now();
      if (touching.current || now - lastTouch.current < TOUCH_THROTTLE_MS) return;
      touching.current = true;
      lastTouch.current = now;
      void api.touchSession()
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.status === 401) {
            forceLogout();
          }
          // 其它错误忽略，避免刷新/弱网闪登录页
        })
        .finally(() => {
          touching.current = false;
        });
    };

    const onActivity = () => {
      touch();
    };

    const opts: AddEventListenerOptions = { capture: true, passive: true };
    window.addEventListener('pointerdown', onActivity, opts);
    window.addEventListener('keydown', onActivity, opts);
    window.addEventListener('scroll', onActivity, opts);
    window.addEventListener('touchstart', onActivity, opts);

    const boot = window.setTimeout(() => {
      touch();
    }, INITIAL_TOUCH_DELAY_MS);

    return () => {
      window.clearTimeout(boot);
      window.removeEventListener('pointerdown', onActivity, opts);
      window.removeEventListener('keydown', onActivity, opts);
      window.removeEventListener('scroll', onActivity, opts);
      window.removeEventListener('touchstart', onActivity, opts);
    };
  }, [enabled, navigate]);
}
