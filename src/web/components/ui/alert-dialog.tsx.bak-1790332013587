import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { cn } from '@/lib/utils';
import { buttonVariants } from '@/components/ui/button';

const AlertDialog = AlertDialogPrimitive.Root;
const AlertDialogPortal = AlertDialogPrimitive.Portal;

type DivProps = React.HTMLAttributes<HTMLDivElement> & {
  ref?: React.Ref<HTMLDivElement>;
  children?: React.ReactNode;
};
type HeadingProps = React.HTMLAttributes<HTMLHeadingElement> & {
  ref?: React.Ref<HTMLHeadingElement>;
  children?: React.ReactNode;
};
type ParagraphProps = React.HTMLAttributes<HTMLParagraphElement> & {
  ref?: React.Ref<HTMLParagraphElement>;
  children?: React.ReactNode;
};
export type KakakeAlertDialogTriggerProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  children?: React.ReactNode;
  asChild?: boolean;
};
type ButtonProps = KakakeAlertDialogTriggerProps;

const AlertDialogTrigger = AlertDialogPrimitive.Trigger as unknown as React.FC<KakakeAlertDialogTriggerProps>;
const Overlay = AlertDialogPrimitive.Overlay as unknown as React.FC<DivProps>;
const Content = AlertDialogPrimitive.Content as unknown as React.FC<DivProps>;
const Title = AlertDialogPrimitive.Title as unknown as React.FC<HeadingProps>;
const Description = AlertDialogPrimitive.Description as unknown as React.FC<ParagraphProps>;
const Action = AlertDialogPrimitive.Action as unknown as React.FC<ButtonProps>;
const Cancel = AlertDialogPrimitive.Cancel as unknown as React.FC<ButtonProps>;

function AlertDialogOverlay({ className, ...props }: DivProps) {
  return (
    <Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/10 backdrop-blur-md data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function AlertDialogContent({ className, ...props }: DivProps) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid max-h-[min(85dvh,100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-2xl kk-glass-2 p-5 shadow-[0_8px_32px_rgba(0,0,0,0.08)] duration-200',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'sm:p-6',
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-2 text-center sm:text-left', className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
  );
}

function AlertDialogTitle({ className, ...props }: HeadingProps) {
  return <Title className={cn('text-lg font-semibold', className)} {...props} />;
}

function AlertDialogDescription({ className, ...props }: ParagraphProps) {
  return <Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function AlertDialogAction({ className, ...props }: ButtonProps) {
  return <Action className={cn(buttonVariants(), className)} {...props} />;
}

function AlertDialogCancel({ className, ...props }: ButtonProps) {
  return (
    <Cancel
      className={cn(buttonVariants({ variant: 'outline' }), 'mt-2 sm:mt-0', className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogPortal,
  AlertDialogOverlay,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
};
