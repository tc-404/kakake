import { useEffect } from 'react';
import { api } from '@/lib/api';
import {
  applyAppearance,
  cacheAppearance,
  mergeAppearance,
  readCachedAppearance,
} from '@/lib/appearance';

/**
 * 全站外观同步：先用本地缓存顶住首帧，再用公开只读接口校正。
 *
 * 登录页、设置密码页与控制台共用同一套参数和背景图，所以在路由根部调用一次即可，
 * 不需要等登录会话就绪。
 *
 * 校正时用 mergeAppearance 合并：渐变字段在服务端**没下发**（旧版后端不认识该字段，
 * 返回体里是 undefined）时沿用本地缓存，避免刚选好的渐变被当成未设置而"自动重置"；
 * 服务端显式带回的空串（用户确实清掉了渐变）则正常生效。
 */
export function useAppearanceSync(): void {
  useEffect(() => {
    let cancelled = false;
    const cached = readCachedAppearance();
    applyAppearance(cached);
    api.appearance
      .getPublic()
      .then((r) => {
        if (cancelled) return;
        const next = mergeAppearance(cached, r.appearance);
        applyAppearance(next);
        cacheAppearance(next);
      })
      .catch(() => { /* 取不到就沿用缓存 / 默认外观 */ });
    return () => {
      cancelled = true;
    };
  }, []);
}