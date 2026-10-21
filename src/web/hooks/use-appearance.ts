import { useEffect } from 'react';
import { api } from '@/lib/api';
import {
  applyAppearance,
  cacheAppearance,
  normalizeAppearance,
  readCachedAppearance,
} from '@/lib/appearance';

/**
 * 全站外观同步：先用本地缓存顶住首帧，再用公开只读接口校正。
 *
 * 登录页、设置密码页与控制台共用同一套参数和背景图，所以在路由根部调用一次即可，
 * 不需要等登录会话就绪。
 */
export function useAppearanceSync(): void {
  useEffect(() => {
    let cancelled = false;
    applyAppearance(readCachedAppearance());
    api.appearance
      .getPublic()
      .then((r) => {
        if (cancelled) return;
        const next = normalizeAppearance(r.appearance);
        applyAppearance(next);
        cacheAppearance(next);
      })
      .catch(() => { /* 取不到就沿用缓存 / 默认外观 */ });
    return () => {
      cancelled = true;
    };
  }, []);
}