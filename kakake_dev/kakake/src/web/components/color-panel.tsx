import { ColorDial } from '@/components/color-dial';
import type { AppearanceSettings } from '@/lib/appearance';

/**
 * 调色卡容器。手机屏窄只放两张：组件与 Logo 合成一张、全局字体一张；
 * 桌面拆得更细，字体 / 组件及按钮 / Logo 各一张。
 * 两种排布都强制同行，靠 grid 列数与 order 切换，不需要 JS 判断视口。
 */
export function ColorPanel({
  settings,
  disabled,
  onChange,
}: {
  settings: AppearanceSettings;
  disabled?: boolean;
  onChange: (patch: Partial<AppearanceSettings>) => void;
}) {
  const shared = { settings, disabled, onChange };
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4">
      <ColorDial {...shared} target="brand" className="order-1 sm:hidden" />
      <ColorDial {...shared} target="ink" className="order-2 sm:order-1" />
      <ColorDial {...shared} target="comp" className="order-3 hidden sm:order-2 sm:flex" />
      <ColorDial {...shared} target="logo" className="order-4 hidden sm:order-3 sm:flex" />
    </div>
  );
}