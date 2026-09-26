import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;

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
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: React.Ref<HTMLButtonElement>;
  children?: React.ReactNode;
};

const Overlay = DialogPrimitive.Overlay as unknown as React.FC<DivProps>;
const Content = DialogPrimitive.Content as unknown as React.FC<DivProps>;
const Title = DialogPrimitive.Title as unknown as React.FC<HeadingProps>;
const Description = DialogPrimitive.Description as unknown as React.FC<ParagraphProps>;
const Close = DialogPrimitive.Close as unknown as React.FC<ButtonProps>;

const DialogClose = Close;

function DialogOverlay({ className, ...props }: DivProps) {
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

function DialogContent({
  className,
  children,
  hideClose = false,
  ...props
}: DivProps & { hideClose?: boolean }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 grid max-h-[min(85dvh,100dvh-2rem)] w-[calc(100vw-1.5rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto no-scrollbar rounded-2xl p-5 duration-200 sm:p-6',
          'kk-glass-2 shadow-[0_8px_32px_rgba(0,0,0,0.08)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <Close
            className={cn(
              'absolute right-3 top-3 z-20 flex h-8 w-8 items-center justify-center rounded-full text-slate-500',
              'transition-colors hover:bg-white/30 hover:text-slate-800',
              'focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-500/40',
            )}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </Close>
        )}
      </Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col space-y-1.5 text-center sm:text-left', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
  );
}

function DialogTitle({ className, ...props }: HeadingProps) {
  return (
    <Title className={cn('text-lg font-bold leading-none tracking-tight text-slate-800', className)} {...props} />
  );
}

function DialogDescription({ className, ...props }: ParagraphProps) {
  return <Description className={cn('mt-0.5 text-xs text-slate-500', className)} {...props} />;
}

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogTrigger,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
