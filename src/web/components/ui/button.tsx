import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'kk-btn-press inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'kk-gradient-primary text-primary-foreground kk-btn-elevate hover:brightness-105',
        destructive:
          'bg-destructive/90 text-destructive-foreground shadow-sm backdrop-blur-sm hover:bg-destructive',
        outline:
          'border border-white/55 bg-white/35 kk-top-sheen backdrop-blur-md hover:border-primary/35 hover:bg-white/55 hover:text-accent-foreground',
        secondary:
          'border border-white/40 bg-white/40 text-secondary-foreground backdrop-blur-md hover:bg-white/55',
        ghost: 'hover:bg-white/40 hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-xl px-3 text-xs',
        lg: 'h-10 rounded-xl px-8',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

/**
 * 把「裸文本」子节点包进 span。
 *
 * 为什么：全局「字体渐变」（background-clip: text）只能染**元素**，button 里的
 * 裸文本节点染不上，于是 outline / ghost / link 按钮的文字在渐变模式下永远是
 * 默认色（开发平台「添加账号」就是这么漏掉的）。包一层 span 后交给既有的
 * 全局渐变规则处理；实底按钮（default / destructive / secondary）的文字属于
 * 组件角色（白字 / 前景色），不能被渐变劫持，保持原样。
 */
function withLabelSpans(children: React.ReactNode): React.ReactNode {
  return React.Children.map(children, (child) =>
    typeof child === 'string' || typeof child === 'number' ? (
      <span className="kk-btn-label">{child}</span>
    ) : (
      child
    ),
  );
}

/** 文字会被染成字体渐变的「非实底」变体 */
const INK_FOLLOW_VARIANTS = new Set(['outline', 'ghost', 'link']);

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, children, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    const content =
      !asChild && INK_FOLLOW_VARIANTS.has(variant ?? '')
        ? withLabelSpans(children)
        : children;
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
        {content}
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
