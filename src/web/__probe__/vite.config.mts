import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [react()],
  // Tailwind / PostCSS 配置在 src/web 下，探针只是换了 root，这里指过去
  css: { postcss: path.resolve(__dirname, '..') },
  resolve: { alias: { '@': path.resolve(__dirname, '..') } },
  build: { outDir: path.resolve(__dirname, '../../../packages/web/.probe'), emptyOutDir: true },
});
