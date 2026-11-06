import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** 测试功能开关变化时广播的事件名（设置页切换后实时同步，无需整页刷新） */
export const TEST_FEATURE_EVENT = 'kk-test-feature-changed';

/**
 * 订阅「设置 → 测试功能」开关：
 * 挂载时拉一次真实状态（接口免鉴权，登录页也能拿到），
 * 之后靠设置页广播的自定义事件实时同步。
 * 拿不到状态（接口失败等）一律视为未启用。
 */
export function useTestFeatureEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.testFeature
      .get()
      .then((r) => {
        if (!cancelled) setEnabled(!!(r && r.ok && r.enabled));
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    const onToggle = (e: Event) => {
      if (!cancelled) setEnabled(!!(e as CustomEvent<boolean>).detail);
    };
    window.addEventListener(TEST_FEATURE_EVENT, onToggle);
    return () => {
      cancelled = true;
      window.removeEventListener(TEST_FEATURE_EVENT, onToggle);
    };
  }, []);

  return enabled;
}
