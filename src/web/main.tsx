import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppToaster } from '@/components/app-toaster';
import { App } from '@/App';
import { ensureKakakeSharedLibs } from '@/lib/plugin-ui-shared';
import { applyAppearanceTokens, readCachedAppearance } from '@/lib/appearance';
import '@/styles/globals.css';
// 设备能力判定要在首帧前生效：低端设备第一帧就是降级样式，不闪重特效
import '@/lib/device-tier';

ensureKakakeSharedLibs();
// 首帧就套上上次的动效 / 透明度 / 模糊，避免接口回来前外观跳变
applyAppearanceTokens(readCachedAppearance());

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
      <AppToaster />
    </BrowserRouter>
  </StrictMode>,
);
