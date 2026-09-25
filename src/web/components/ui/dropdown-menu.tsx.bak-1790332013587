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
          'kk-glass-2 kk-glass-2-strong z-50 min-w-[10rem] overflow-hidden rounded-2xl p-1.5 text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
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

const DropdownMenuItem = React.forwardRef<HTMLDivElement, DropdownMenuItemProps>(
  ({ className, inset, destructive, ...props }, ref) => (
    <MenuItem
      ref={ref}
      className={cn(
        'relative flex cursor-default select-none items-center gap-2 rounded-xl px-2.5 py-2 text-sm outline-none transition-colors focus:bg-white/50 data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4',
        destructive && 'text-destructive focus:bg-destructive/10 focus:text-destructive',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
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
