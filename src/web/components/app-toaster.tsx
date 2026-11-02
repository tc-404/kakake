import { Toaster } from 'sonner';

/**
 * 全局 toast：整条可穿透（pointer-events:none），避免顶部气泡盖住手机顶栏按钮。
 * 因此只能放纯展示内容；需要点击时改用 Dialog，或给元素加 data-toast-interactive。
 * expand：全局不可 hover，必须平铺，不能叠成两层。
 */
export function AppToaster() {
  return (
    <Toaster
      position="top-center"
      richColors
      expand
      toastOptions={{
        /*
         * 只挂一个语义类：底色 / 描边 / 阴影 / 模糊全部由 globals.css 的 [data-sonner-toast].kk-toast
         * 从外观令牌派生。之前是 !bg-white/70 这类写死值——「卡片2 透明度 / 模糊度」
         * 与自定义配色都管不到它，暗色预设下还是一块白板。
         */
        className: 'font-sans kk-toast',
      }}
    />
  );
}
