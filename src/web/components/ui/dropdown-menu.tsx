import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;

/** Radix + React 19 下 ComponentProps 偶发丢 className，用显式 DOM 属性兜底 */
type ItemPrimitiveProps = React.HTMLAttributes<HTMLDivElement> &
  React.RefAttributes<HTMLDivElement> & {
    disabled?: boolean;
    onSelect?: (event: Event) => void;
    textValue?: string;
  };

type ContentPrimitiveProps = React.HTMLAttributes<HTMLDivElement> &
  React.RefAttributes<HTMLDivElement> & {
    sideOffset?: number;
    align?: 'start' | 'center' | 'end';
    side?: 'top' | 'right' | 'bottom' | 'left';
  };

type SeparatorPrimitiveProps = React.HTMLAttributes<HTMLDivElement> &
  React.RefAttributes<HTMLDivElement>;

const MenuContent = DropdownMenuPrimitive.Content as unknown as React.ForwardRefExoticComponent<ContentPrimitiveProps>;
const MenuItem = DropdownMenuPrimitive.Item as unknown as React.ForwardRefExoticComponent<ItemPrimitiveProps>;
const MenuSeparator = DropdownMenuPrimitive.Separator as unknown as React.ForwardRefExoticComponent<SeparatorPrimitiveProps>;

const DropdownMenuContent = React.forwardRef<HTMLDivElement, ContentPrimitiveProps>(
  ({ className, sideOffset = 6, ...props }, ref) => (
    <DropdownMenuPrimitive.Portal>
      <MenuContent
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'kk-glass-2 kk-glass-2-strong kk-pop z-50 min-w-[10rem] overflow-hidden rounded-2xl p-1.5 text-card-foreground',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  ),
);
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

type DropdownMenuItemProps = ItemPrimitiveProps & {
  inset?: boolean;
  destructive?: boolean;
};

/**
 * 把「裸文本」子节点包进 span。
 *
 * 为什么：全局「字体渐变」（background-clip: text）只能染**元素**，而菜单项
 * 大多带勾选图标（含 svg 的元素被整体排除），文字又是裸文本节点——于是
 * 插件市场排序 / 分类这类菜单在渐变模式下永远是默认色。包一层 span 后，
 * span 本身是纯文字叶子元素，既有全局渐变规则就能正常接管。
 */
function withLabelSpans(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <span className="kk-menu-label">{child}</span>
    ) : (
      child
    ),
  );
}

const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, inset, destructive, children, ...props }, ref) => (
    <MenuItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-xl px-2.5 py-2 text-sm outline-none transition-colors focus:bg-white/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4',
        destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive kk-ink-plain',
        inset && 'pl-8',
        className,
      )}
      {...props}
    >
      {withLabelSpans(children)}
    </MenuItem>
  ),
);
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuSeparator = React.forwardRef<HTMLDivElement, SeparatorPrimitiveProps>(
  ({ className, ...props }, ref) => (
    <MenuSeparator
      ref={ref}
      className={cn('-mx-1 my-1 h-px bg-white/40', className)}
      {...props}
    />
  ),
);
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
};
