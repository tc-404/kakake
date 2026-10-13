import { Toaster } from 'sonner';

/**
 * 全局 toast 容器。
 *
 * 注意：globals.css 里把 [data-sonner-toaster] 整个设成了 pointer-events:none——
 * 顶部居中的气泡（含 sonner 常驻的约 20px 缓冲区）在手机上会盖住顶栏最左侧的
 * 「侧边栏呼出」按钮，之前点不到。现在整条 toast 都是可穿透的。
 *
 * 因此这里只能放纯展示内容：**不要往 toast 里塞需要点击的按钮 / 链接**。
 * 真有交互需求（比如「撤销」），把 toast 换成 Dialog，或给元素加
 * data-toast-interactive（globals.css 里的逃生舱会给它恢复 pointer-events:auto）。
 *
 * expand：多条 toast 时默认展开平铺、不堆叠。sonner 默认会把多于一条的通知叠成
 * 「两层」，靠 hover 才展开；而本项目全局 pointer-events:none，hover 永远触发不了，
 * 叠起来的那层就再也打不开。这里直接让它别叠。
 */
export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      richColors
      expand
      toastOptions={{
        className:
          'font-sans !rounded-2xl !border-white/50 !bg-white/70 !shadow-[0_8px_32px_rgba(15,40,60,0.12)] !backdrop-blur-xl',
      }}
    />
  );
}
