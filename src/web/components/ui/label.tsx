import * as React from 'react';
import * as LabelPrimitive from '@radix-ui/react-label';
import { cn } from '@/lib/utils';

type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement> & {
  ref?: React.Ref<HTMLLabelElement>;
  children?: React.ReactNode;
};

const LabelRoot = LabelPrimitive.Root as unknown as React.FC<LabelProps>;

function Label({ className, ...props }: LabelProps) {
  return (
    <LabelRoot
      className={cn(
        'mb-0 text-sm font-medium leading-none text-slate-700 peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        className,
      )}
      {...props}
    />
  );
}

export { Label };
