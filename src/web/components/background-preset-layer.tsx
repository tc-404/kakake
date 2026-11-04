import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  effectiveBackgroundPreset,
  getAppearanceSnapshot,
  subscribeAppearance,
} from '@/lib/appearance';
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';
import { Waves } from '@/components/waves';

/** CSS 变量里那组组件色通道（"R G B"）→ 画布认的 rgb() 串 */
function channelsToRgb(raw: string): string | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

/** 朝白色方向提亮。波浪在暗色主题下必须用亮线，原色直接画会闷在深底里 */
function lighten(rgb: string, amount: number): string {
  const matched = rgb.match(/^rgba?\(([^)]+)\)$/i);
  if (!matched) return rgb;
  const parts = matched[1]
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3) return rgb;
  const k = Math.max(0, Math.min(1, amount));
  const ch = (n: number) => Math.round(n + (255 - n) * k);
  return `rgb(${ch(parts[0])}, ${ch(parts[1])}, ${ch(parts[2])})`;
}

/** 波浪预设是否生效（同时负责把暗色主题开关写到 <html> 上，见下方 effect） */
function useWavesActive(state: ReturnType<typeof getAppearanceSnapshot>, tier: 'low' | 'normal'): boolean {
  return effectiveBackgroundPreset(state, tier) === 'waves';
}

/**
 * 背景预设层：目前只有「波浪」一个预设生效，其余情况什么都不渲染。
 *
 * 与视频背景层（AmbientVideo）同级挂在 .kk-ambient / .kk-login-ambient 里，
 * 由 globals.css 压到 z-index:0 —— **永远在最底部**，内容层（.kk-ambient > *，
 * z-index:1）压在它上面；鼠标事件穿透（pointer-events:none），拖拽走的是
 * window 级 pointermove，不受影响。以下任一情况直接不画：
 * - 用户选的是「默认」；
 * - 已经设置了自定义背景（图片或视频），按需求由自定义背景接管；
 * - 当前是性能模式档（WebGL 全屏绘制留给「完整特效」）。
 *
 * 波浪生效时全站切暗色主题（globals.css 的 html[data-kk-bg-preset='waves']）：
 * 原版 Waves 的画法就是「深底 + 亮线」，划过的区域还会被 accentColor 提亮成高光 ——
 * 只有暗底上才读得出这两个效果；浅色主题里整片亮线糊在玻璃上，看着就像画在 UI 之上。
 */
export function BackgroundPresetLayer() {
  const state = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const tier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  const waves = useWavesActive(state, tier);
  const [lineColor, setLineColor] = useState('#9be893');
  const [accentColor, setAccentColor] = useState('#ffffff');

  // 线色跟「组件及按钮」配色走（提亮到暗底可辨的亮度）；高光色用近白，划过即亮
  useEffect(() => {
    const read = () => {
      if (typeof window === 'undefined') return;
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--kk-comp-rgb');
      const rgb = channelsToRgb(raw);
      setLineColor(rgb ? lighten(rgb, 0.45) : '#9be893');
    };
    read();
    return subscribeAppearance(read);
  }, []);

  // 性能档运行时变化（device-tier 动态校准）不会走 applyAppearance，这里兜底补写暗色开关
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (waves) root.setAttribute('data-kk-bg-preset', 'waves');
    else root.removeAttribute('data-kk-bg-preset');
    return () => root.removeAttribute('data-kk-bg-preset');
  }, [waves]);

  if (!waves) return null;

  return (
    <Waves
      className="kk-bg-preset"
      // 暗色主题：亮线 + 划过高亮。lightMode=false 是原版默认（白线画深底），
      // 之前误开了 lightMode（把线色压成墨色给浅底用），高亮效果完全看不出来
      lineColor={lineColor}
      accentColor={accentColor}
      spacing={6}
      amplitude={60}
      twist={1}
      speed={0}
      lineWidth={1.2}
      mouseRadius={130}
      mouseStrength={1.35}
      bounce={0.4}
      returnDuration={3}
      clickRipple={false}
      fade={0.35}
      opacity={0.6}
      // 全屏 WebGL 在高分屏上按 2 倍像素画太重，1.5 倍足够细腻
      dpr={1.5}
    />
  );
}
