import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * 把内容渲染到 document.body，脱离任何带 transform / backdrop-filter 的祖先，
 * 保证 fixed 定位相对「视口」而非当前界面容器。
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const [el] = useState(() => document.createElement('div'));
  useEffect(() => {
    document.body.appendChild(el);
    return () => { document.body.removeChild(el); };
  }, [el]);
  return createPortal(children, el);
}
