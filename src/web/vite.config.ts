import path from 'node:path';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const outDir = path.resolve(__dirname, '../../packages/web/dist');

const gzipAsync = promisify(zlib.gzip) as (data: Buffer, opts?: zlib.ZlibOptions) => Promise<Buffer>;
const brotliAsync = promisify(zlib.brotliCompress) as (
  data: Buffer,
  opts?: zlib.BrotliCompressOptions,
) => Promise<Buffer>;

/** 需要预压缩的文本类静态资源后缀 */
const PRECOMPRESS_EXTS = new Set(['.js', '.css', '.html', '.svg', '.json', '.txt']);

/**
 * 构建完成后为文本资源生成 .gz/.br 旁文件（main.ts 的 precompressedStatic 会按
 * Accept-Encoding 优先发变体）。用 node:zlib 内联实现，零新增依赖；
 * brotli quality 5 在体积与构建耗时之间取平衡。
 */
function precompressPlugin(): Plugin {
  return {
    name: 'kakake-precompress',
    apply: 'build',
    closeBundle: async () => {
      const files: string[] = [];
      const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const ent of entries) {
          const p = path.join(dir, ent.name);
          if (ent.isDirectory()) walk(p);
          else if (PRECOMPRESS_EXTS.has(path.extname(ent.name).toLowerCase())) files.push(p);
        }
      };
      walk(outDir);

      let count = 0;
      await Promise.all(files.map(async (file) => {
        const data = await fs.promises.readFile(file);
        if (data.length < 1024) return; // 小文件不值得压
        await Promise.all([
          fs.promises.writeFile(`${file}.gz`, await gzipAsync(data, { level: 6 })),
          fs.promises.writeFile(`${file}.br`, await brotliAsync(data, {
            params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
          })),
        ]);
        count += 1;
      }));
      console.log(`[precompress] ${count} files → .gz/.br`);
    },
  };
}

export default defineConfig({
  plugins: [react(), precompressPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // node_modules 统一进 vendor 块：业务改动后浏览器只需重新下载小的 app 块，vendor 长期缓存
        manualChunks(id: string) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
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
