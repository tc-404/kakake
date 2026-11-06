import { Component, useEffect, useState, type ReactNode } from 'react';
import { getAppearanceSnapshot, subscribeAppearance, type AppearanceState } from '@/lib/appearance';
import { useTestFeatureEnabled } from '@/hooks/use-test-feature';
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

/** 设置页「前端鼠标调整」卡调的那组参数（外观状态 → TargetCursor props） */
interface CursorTuning {
  spin: number;
  hover: number;
  size: number;
  corner: number;
  thickness: number;
  dot: number;
  /** 自定义颜色（#hex），空串 = 跟随品牌 Logo */
  color: string;
  /** 选中时（悬停到目标上）的颜色（#hex），空串 = 跟随品牌 Logo 渐变端色 */
  targetColor: string;
}

function tuningOf(state: AppearanceState): CursorTuning {
  return {
    spin: state.cursorSpin,
    hover: state.cursorHover,
    size: state.cursorSize,
    corner: state.cursorCorner,
    thickness: state.cursorThickness,
    dot: state.cursorDot,
    color: state.cursorColor,
    targetColor: state.cursorTargetColor,
  };
}

/**
 * 全局准星光标：挂在 App 根级（<Routes> 之外），所有预设与页面都生效。
 * 属于「更高级的鼠标效果」装饰件：只有「设置 → 测试功能」开关打开时才启用，
 * 未开启（含读取失败）一律不渲染，系统光标原样保留。
 * 颜色与动态参数来自设置页「前端鼠标调整」卡（外观状态订阅，拖动即生效）；
 * 未设置自定义颜色时跟随「品牌 Logo」配色。
 */
export function TargetCursorLayer() {
  const testOn = useTestFeatureEnabled();
  const [accent, setAccent] = useState<string | null>(null);
  const [accentAlt, setAccentAlt] = useState<string | null>(null);
  const [gradient, setGradient] = useState<string | null>(null);
  const [tuning, setTuning] = useState<CursorTuning>(() => tuningOf(getAppearanceSnapshot()));

  // 配色订阅：品牌色通道已按亮/暗主题调好明度，渐变开启时圆点直接吃渐变；
  // 同一条订阅顺带拿准星调参（设置页拖动滑条 → applyAppearance → 这里实时跟上）
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setAccent(channelsToRgb(cs.getPropertyValue('--kk-logo-rgb')));
      setAccentAlt(channelsToRgb(cs.getPropertyValue('--kk-logo-alt-rgb')));
      setGradient(cs.getPropertyValue('--kk-logo-gradient').trim() || null);
      setTuning(tuningOf(getAppearanceSnapshot()));
    };
    read();
    return subscribeAppearance(read);
  }, []);

  // 未开启测试功能：整层不渲染，系统光标原样保留
  if (!testOn) return null;

  return (
    <CursorBoundary>
      <TargetCursor
        spinDuration={tuning.spin}
        hoverDuration={tuning.hover}
        parallaxOn
        hideDefaultCursor
        size={tuning.size}
        cornerSize={tuning.corner}
        thickness={tuning.thickness}
        padding={5}
        dotSize={tuning.dot}
        matchRadius
        // 主题色直出（不用 difference 反色），CSS 侧带投影兜可见性
        blendMode="normal"
        showLabel
        clickEffect
        // 手机 / 平板：点按时锁一下再淡出，不自转、不隐藏系统光标
        touchMode="tap"
        touchHold={720}
        maxTargetArea={0.5}
        // 自定义色优先；没设（空串）跟随品牌 Logo 通道
        cursorColor={tuning.color || (accent ?? undefined)}
        cursorBg={gradient ?? undefined}
        // 选中态同理：自定义优先，没设跟随 Logo 渐变端色通道
        cursorColorOnTarget={tuning.targetColor || (accentAlt ?? undefined)}
      />
    </CursorBoundary>
  );
}
