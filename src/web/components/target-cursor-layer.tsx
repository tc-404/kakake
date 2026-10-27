import { Component, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  effectiveBackgroundPreset,
  getAppearanceSnapshot,
  subscribeAppearance,
} from '@/lib/appearance';
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';
import TargetCursor from '@/components/target-cursor';

/** CSS 变量里那组组件色通道（"R G B"）→ 光标认的 rgb() 串 */
function channelsToRgb(raw: string): string | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

/** 朝白色方向提亮，避免锁定态在深色底上被 difference 反成一团暗色 */
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

/**
 * 准星纯属装饰，绝不能因为它出问题把整个应用拖白屏：
 * 挂在 App 根级的组件一旦抛错会卸载整棵树，所以单独包一层哨兵边界。
 */
class CursorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * 全局准星光标的挂载层。
 *
 * 与设置页、背景渲染层共用 effectiveBackgroundPreset 一个判定：
 * 只有「背景预设 = 波浪 + 没有自定义背景 + 完整特效档」时才接管光标；
 * 其余情况整个组件不挂载（系统光标原样保留，隐藏光标的样式表也随之移除）。
 *
 * 挂在 App 根级（<Routes> 之外），因此登录页、设置密码页、插件独立页、
 * 控制台内所有界面都吃得到 —— 真正的全局。
 */
export function TargetCursorLayer() {
  const state = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const tier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  const [accent, setAccent] = useState<string | null>(null);

  // 锁定态的括号跟着「组件及按钮」配色走，改设置即刻换色
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue('--kk-comp-rgb');
      const rgb = channelsToRgb(raw);
      setAccent(rgb ? lighten(rgb, 0.45) : null);
    };
    read();
    return subscribeAppearance(read);
  }, []);

  if (effectiveBackgroundPreset(state, tier) !== 'waves') return null;

  return (
    <CursorBoundary>
      <TargetCursor
      // 铺开到所有语义化可交互元素（见 DEFAULT_TARGET_SELECTOR）：
      // button / a / summary / 表单控件 / Radix 的 role=tab|switch|checkbox|slider… 全算命中
      spinDuration={1.9}
      hoverDuration={0.22}
      parallaxOn
      hideDefaultCursor
      size={34}
      cornerSize={11}
      thickness={2.5}
      padding={5}
      dotSize={4}
      matchRadius
      blendMode="difference"
      showLabel
      clickEffect
      // 手机 / 平板：点按时锁一下再淡出，不自转、不隐藏系统光标
      touchMode="tap"
      touchHold={720}
      maxTargetArea={0.5}
      cursorColor="#ffffff"
      cursorColorOnTarget={accent ?? undefined}
      />
    </CursorBoundary>
  );
}
