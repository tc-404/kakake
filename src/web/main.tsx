import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AppToaster } from '@/components/app-toaster';
import { App } from '@/App';
import { ensureKakakeSharedLibs } from '@/lib/plugin-ui-shared';
import '@/styles/globals.css';

ensureKakakeSharedLibs();

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
