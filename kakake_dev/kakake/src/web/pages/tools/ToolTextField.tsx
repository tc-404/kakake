import * as React from 'react';
import { cn } from '@/lib/utils';

type ToolTextFieldProps = Omit<React.ComponentProps<'textarea'>, 'className'> & {
  className?: string;
  /** 外层壳高度档：输入区 / 输出区可共用 */
  minRows?: number;
  /** 撑满父级高度（用于工具页自适应布局） */
  fill?: boolean;
};

/**
 * 工具页专用内容框：玻璃壳 + 透明内层，弱化原生 textarea 观感。
 */
export const ToolTextField = React.forwardRef<HTMLTextAreaElement, ToolTextFieldProps>(
  ({ className, minRows = 5, fill = false, disabled, readOnly, rows, ...props }, ref) => {
    const resolvedRows = fill ? undefined : (rows ?? minRows);
    return (
      <div
        className={cn(
          'kk-tool-field group relative',
          fill && 'kk-tool-field--fill',
          disabled && 'kk-tool-field--disabled',
          readOnly && 'kk-tool-field--readonly',
          className,
        )}
      >
        <span className="kk-tool-field__accent" aria-hidden />
        <textarea
          ref={ref}
          rows={resolvedRows}
          disabled={disabled}
          readOnly={readOnly}
          className="kk-tool-field__input"
          {...props}
        />
      </div>
    );
  },
);
ToolTextField.displayName = 'ToolTextField';
