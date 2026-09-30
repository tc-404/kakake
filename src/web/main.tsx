import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppToaster } from '@/components/app-toaster';
import { App } from '@/App';
import { ensureKakakeSharedLibs } from '@/lib/plugin-ui-shared';
import { applyAppearanceTokens, readCachedAppearance } from '@/lib/appearance';
import '@/styles/globals.css';

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
