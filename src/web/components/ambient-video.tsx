import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  backgroundUrl,
  getAppearanceSnapshot,
  resolveBackgroundSlot,
  subscribeAppearance,
  type BackgroundOrientation,
} from '@/lib/appearance';

/** 跟随屏幕方向（竖 / 横），旋转后换用对应方向的资源 */
function useScreenOrientation(): BackgroundOrientation {
  const [orientation, setOrientation] = useState<BackgroundOrientation>(() =>
    typeof window !== 'undefined' && window.matchMedia('(orientation: landscape)').matches
      ? 'landscape'
      : 'portrait',
  );
  useEffect(() => {
    const mq = window.matchMedia('(orientation: landscape)');
    const onChange = () => setOrientation(mq.matches ? 'landscape' : 'portrait');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return orientation;
}

/**
 * 视频背景层：mp4 与实况图视频轨在此静音自动循环播放。
 * 与图片层共用白幕（::after 始终在其上）、背景模糊度与竖横屏兜底规则；
 * 没有视频背景时什么都不渲染，原有 CSS 图片机制不受影响。
 */
export function AmbientVideo() {
  const state = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const screenOrientation = useScreenOrientation();
  const slot = resolveBackgroundSlot(state, screenOrientation, 'video');
  if (!slot) return null;
  return (
    <video
      key={`${slot.orientation}:${slot.meta.updatedAt}`}
      className="kk-ambient-video"
      src={backgroundUrl(slot.orientation, slot.meta)}
      autoPlay
      loop
      muted
      playsInline
      preload="auto"
      disablePictureInPicture
      // 个别浏览器里 React 设 muted 属性的时机赶不上自动播放策略检查，双保险
      ref={(el) => {
        if (el) el.muted = true;
      }}
      aria-hidden
      tabIndex={-1}
    />
  );
}
