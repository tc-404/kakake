import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { cn } from '@/lib/utils';

type QuietNavProps = {
  to: string;
  children: ReactNode;
  className?: string;
  replace?: boolean;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'>;

/**
 * 站内跳转：用 button + navigate，避免 <a href> 悬停时
 * 浏览器左下角状态栏泄露目标路径。
 */
export const QuietNav = forwardRef<HTMLButtonElement, QuietNavProps>(
  function QuietNav({ to, children, className, replace = false, ...props }, ref) {
    const navigate = useNavigate();

    return (
      <button
        ref={ref}
        type="button"
        className={cn('cursor-pointer text-left', className)}
        onClick={() => navigate(to, { replace })}
        {...props}
      >
        {children}
      </button>
    );
  },
);

type QuietExternalProps = {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
};

/** 外链：同样不挂 href，改为点击时 window.open */
export function QuietExternal({ href, children, className, title }: QuietExternalProps) {
  return (
    <button
      type="button"
      title={title}
      className={cn('cursor-pointer text-left', className)}
      onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
    >
      {children}
    </button>
  );
}
