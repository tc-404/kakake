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
          'kk-gradient-primary text-primary-foreground shadow-[0_6px_18px_rgba(20,140,130,0.28),inset_0_1px_0_rgba(255,255,255,0.35)] hover:brightness-105',
        destructive:
          'bg-destructive/90 text-destructive-foreground shadow-sm backdrop-blur-sm hover:bg-destructive',
        outline:
          'border border-white/55 bg-white/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.5)] backdrop-blur-md hover:border-primary/35 hover:bg-white/55 hover:text-accent-foreground',
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

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
