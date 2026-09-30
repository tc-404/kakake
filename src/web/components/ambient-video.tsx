import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
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
 * 主动释放一个视频元素持有的解码会话：暂停 → 摘掉 src → load() 触发资源回收。
 * 不这么做的话，被摘除的 <video> 要等 GC 才放掉硬件解码器；反复登录/退出堆积后
 * 会拖满 GPU 进程，出现「刷新无效、只能重启设备」的持续高负荷。
 */
function releaseVideo(el: HTMLVideoElement): void {
  try {
    el.pause();
    el.removeAttribute('src');
    // 清掉缓冲并让浏览器立即释放解码器，而不是等垃圾回收
    el.load();
  } catch {
    /* 元素已被销毁等边界情况，忽略 */
  }
}

/**
 * 视频背景层：mp4 与实况图视频轨在此静音自动循环播放。
 * 与图片层共用白幕（::after 始终在其上）、背景模糊度与竖横屏兜底规则；
 * 没有视频背景时什么都不渲染，原有 CSS 图片机制不受影响。
 */
export function AmbientVideo() {
  const state = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const screenOrientation = useScreenOrientation();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // 回调 ref：同一实例里换资源（key 变）会先以 null 卸旧节点、再挂新节点；
  // 整个组件卸载时也会收到 null。两种情况都在此显式放掉旧解码会话。
  const setVideoRef = useCallback((el: HTMLVideoElement | null) => {
    if (el === null) {
      const prev = videoRef.current;
      if (prev) releaseVideo(prev);
      videoRef.current = null;
      return;
    }
    videoRef.current = el;
    // 个别浏览器里 React 设 muted 属性的时机赶不上自动播放策略检查，双保险
    el.muted = true;
  }, []);

  // 页面隐藏（切后台 / 最小化 / 前进后退缓存）时暂停解码，可见时恢复，避免后台空转
  useEffect(() => {
    const sync = () => {
      const el = videoRef.current;
      if (!el) return;
      if (document.hidden) el.pause();
      else void el.play().catch(() => { /* 自动播放被拦等情况，忽略 */ });
    };
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', sync);
    window.addEventListener('pageshow', sync);
    return () => {
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('pagehide', sync);
      window.removeEventListener('pageshow', sync);
    };
  }, []);

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
      ref={setVideoRef}
      aria-hidden
      tabIndex={-1}
    />
  );
}
