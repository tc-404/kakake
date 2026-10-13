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

/**
 * 外链：同样不挂 href，改为点击时 window.open。
 *
 * ⚠️ props 必须透传：导览（product-tour）靠 `data-tour` 定位按钮，而这类包装组件
 * 如果只声明自己用到的那几个 prop，写在它身上的 data-tour / aria-label 会被 React
 * 直接丢掉、不进 DOM——导览就永远找不到目标，还不会报任何错（src/web 不参与 tsc，
 * vite build 也不做类型检查）。
 */
type QuietExternalProps = {
  href: string;
  children: ReactNode;
  className?: string;
  title?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'>;

export function QuietExternal({ href, children, className, title, ...props }: QuietExternalProps) {
  return (
    <button
      type="button"
      title={title}
      className={cn('cursor-pointer text-left', className)}
      onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}
      {...props}
    >
      {children}
    </button>
  );
}
