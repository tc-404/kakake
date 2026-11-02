import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { AppToaster } from '@/components/app-toaster';
import { getPortalRoot } from '@/lib/portal-root';
import { App } from '@/App';
import { ensureKakakeSharedLibs } from '@/lib/plugin-ui-shared';
import { applyAppearanceTokens, readCachedAppearance } from '@/lib/appearance';
import { loadLanguage } from '@/lib/language';
import '@/styles/globals.css';
// 设备能力判定要在首帧前生效：低端设备第一帧就是降级样式，不闪重特效
import '@/lib/device-tier';
// 语言切换：首帧前注册字典并设好 <html lang>，避免语言闪烁
import '@/lib/i18n';
// 统一触发各业务字典的 registerMessages（必须在 t() 调用前完成；见 register.ts 注释）
import '@/lib/i18n-dict/register';

ensureKakakeSharedLibs();
// 首帧就套上上次的动效 / 透明度 / 模糊，避免接口回来前外观跳变
applyAppearanceTokens(readCachedAppearance());
/*
 * 语言是实例级设置（data/language.json）：所有人共用一门语言。
 * 首帧先按中文渲染，这份取回来后再切过去——读的是免鉴权端点，登录页也能对齐。
 */
void loadLanguage();

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      {/* 必须 portal 到 #root 之外：#root 有 isolation:isolate（globals.css），
          会形成独立 stacking context，把 toast 层级「囚禁」在内部，导致所有经 body 层
          Portal 弹出的 Dialog 遮罩（z-50）整体压在 toast 之上（即「气泡在模糊层之下」）。
          挂到 document.body 后，toast 才能和 Dialog 在同一层比层级；z-index 见 globals.css。 */}
      {createPortal(<AppToaster />, getPortalRoot())}
    </BrowserRouter>
  </StrictMode>,
);
