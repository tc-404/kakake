import { Component, useEffect, useState, type ReactNode } from 'react';
import { subscribeAppearance } from '@/lib/appearance';
import TargetCursor from '@/components/target-cursor';

/** CSS 变量里那组组件色通道（"R G B"）→ 光标认的 rgb() 串 */
function channelsToRgb(raw: string): string | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`;
}

/** 准星是装饰件：抛错时静默卸载自己，不拖垮 App 根级的整棵树 */
class CursorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** 全局准星光标：挂在 App 根级（<Routes> 之外），所有预设与页面都生效 */
export function TargetCursorLayer() {
  const [accent, setAccent] = useState<string | null>(null);
  const [accentAlt, setAccentAlt] = useState<string | null>(null);
  const [gradient, setGradient] = useState<string | null>(null);

  // 准星配色跟随「品牌 Logo」角色：rgb 通道已按亮/暗主题调好明度，渐变开启时圆点直接吃渐变
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setAccent(channelsToRgb(cs.getPropertyValue('--kk-logo-rgb')));
      setAccentAlt(channelsToRgb(cs.getPropertyValue('--kk-logo-alt-rgb')));
      setGradient(cs.getPropertyValue('--kk-logo-gradient').trim() || null);
    };
    read();
    return subscribeAppearance(read);
  }, []);

  return (
    <CursorBoundary>
      <TargetCursor
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
        // 主题色直出（不用 difference 反色），CSS 侧带投影兜可见性
        blendMode="normal"
        showLabel
        clickEffect
        // 手机 / 平板：点按时锁一下再淡出，不自转、不隐藏系统光标
        touchMode="tap"
        touchHold={720}
        maxTargetArea={0.5}
        cursorColor={accent ?? undefined}
        cursorBg={gradient ?? undefined}
        cursorColorOnTarget={accentAlt ?? undefined}
      />
    </CursorBoundary>
  );
}
