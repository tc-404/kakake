import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const outDir = path.resolve(__dirname, '../../packages/web/dist');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/plugin': 'http://127.0.0.1:8787',
      '/onebot': 'http://127.0.0.1:8787',
      '/gfbot': 'http://127.0.0.1:8787',
      '/gf_bot': 'http://127.0.0.1:8787',
    },
  },
});
