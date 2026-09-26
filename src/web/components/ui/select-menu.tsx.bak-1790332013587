import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;

export type KakakeSelectTriggerProps = {
  className?: string;
  children?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  ref?: React.Ref<HTMLButtonElement>;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>;

export type KakakeSelectContentProps = {
  className?: string;
  children?: React.ReactNode;
  position?: 'item-aligned' | 'popper';
  ref?: React.Ref<HTMLDivElement>;
};

export type KakakeSelectItemProps = {
  className?: string;
  children?: React.ReactNode;
  value: string;
  disabled?: boolean;
  textValue?: string;
  ref?: React.Ref<HTMLDivElement>;
};

type ValueProps = {
  placeholder?: string;
  children?: React.ReactNode;
  className?: string;
};

const Trigger = SelectPrimitive.Trigger as unknown as React.FC<KakakeSelectTriggerProps>;
const Value = SelectPrimitive.Value as unknown as React.FC<ValueProps>;
const Icon = SelectPrimitive.Icon as unknown as React.FC<{ asChild?: boolean; children?: React.ReactNode }>;
const Content = SelectPrimitive.Content as unknown as React.FC<KakakeSelectContentProps>;
const Viewport = SelectPrimitive.Viewport as unknown as React.FC<{ className?: string; children?: React.ReactNode }>;
const Item = SelectPrimitive.Item as unknown as React.FC<KakakeSelectItemProps>;
const ItemText = SelectPrimitive.ItemText as unknown as React.FC<{ children?: React.ReactNode }>;
const ItemIndicator = SelectPrimitive.ItemIndicator as unknown as React.FC<{ children?: React.ReactNode }>;
const ScrollUpButton = SelectPrimitive.ScrollUpButton as unknown as React.FC<{ className?: string; children?: React.ReactNode }>;
const ScrollDownButton = SelectPrimitive.ScrollDownButton as unknown as React.FC<{ className?: string; children?: React.ReactNode }>;

const SelectValue = Value;

export function SelectTrigger({ className, children, ...props }: KakakeSelectTriggerProps) {
  return (
    <Trigger
      className={cn(
        'flex h-10 w-full items-center justify-between gap-2 whitespace-nowrap rounded-xl border border-white/30 bg-white/20 px-3.5 py-2 text-sm text-slate-800 outline-none transition-all duration-200 backdrop-blur-sm',
        'hover:bg-white/25',
        'focus:border-teal-400/50 focus:bg-white/30 focus:ring-2 focus:ring-teal-500/50',
        'disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=open]:border-teal-400/50 data-[state=open]:bg-white/30 data-[state=open]:ring-2 data-[state=open]:ring-teal-500/50',
        '[&>span]:line-clamp-1',
        className,
      )}
      {...props}
    >
      {children}
      <Icon asChild>
        <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
      </Icon>
    </Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: KakakeSelectContentProps) {
  return (
    <SelectPrimitive.Portal>
      <Content
        className={cn(
          'kk-glass-2 kk-glass-2-strong relative z-50 max-h-96 min-w-[8rem] overflow-hidden rounded-2xl text-slate-800',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          position === 'popper' && 'data-[side=bottom]:translate-y-1.5 data-[side=top]:-translate-y-1.5',
          className,
        )}
        position={position}
        {...props}
      >
        <ScrollUpButton className="flex cursor-default items-center justify-center py-1">
          <ChevronUp className="h-4 w-4" />
        </ScrollUpButton>
        <Viewport
          className={cn(
            'p-1.5',
            position === 'popper' &&
              'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]',
          )}
        >
          {children}
        </Viewport>
        <ScrollDownButton className="flex cursor-default items-center justify-center py-1">
          <ChevronDown className="h-4 w-4" />
        </ScrollDownButton>
      </Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({ className, children, ...props }: KakakeSelectItemProps) {
  return (
    <Item
      className={cn(
        'relative flex w-full cursor-pointer select-none items-center rounded-xl py-2.5 pl-3 pr-8 text-sm outline-none transition-colors',
        'focus:bg-white/50 focus:text-slate-900',
        'data-[highlighted]:bg-teal-500/12 data-[highlighted]:text-teal-900',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute right-2.5 flex h-3.5 w-3.5 items-center justify-center text-teal-600">
        <ItemIndicator>
          <Check className="h-4 w-4" />
        </ItemIndicator>
      </span>
      <ItemText>{children}</ItemText>
    </Item>
  );
}

export { Select, SelectGroup, SelectValue };
