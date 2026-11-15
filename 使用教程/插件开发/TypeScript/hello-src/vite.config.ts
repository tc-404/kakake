import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// 当前文件所在目录 = 源码工程根目录
const __dirname = dirname(fileURLToPath(import.meta.url));

// 构建产物文件夹名（装进 plugins/ 的就是这一夹）
const OUT_DIR = 'kakake-plugin-hello';

// Node 内置模块不要打进包里
const nodeModules = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

/** 构建结束后：把 package.json / plugin.json 拷进产物夹 */
function copyJsonIntoOutDir() {
  return {
    name: 'copy-plugin-jsons',
    writeBundle() {
      const outAbs = resolve(__dirname, OUT_DIR);

      // —— 发布用 package.json（只留运行需要的字段）——
      const pkgPath = resolve(__dirname, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
      const distPkg = {
        name: pkg.name,
        plugin: pkg.plugin,
        version: pkg.version,
        type: pkg.type,
        main: pkg.main,
        description: pkg.description,
        author: pkg.author,
      };
      fs.writeFileSync(resolve(outAbs, 'package.json'), `${JSON.stringify(distPkg, null, 2)}\n`);

      // —— plugin.json 原样写入产物夹 ——
      const pluginJsonPath = resolve(__dirname, 'plugin.json');
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      fs.writeFileSync(resolve(outAbs, 'plugin.json'), `${JSON.stringify(pluginJson, null, 2)}\n`);

      // —— 插件文档.md（可选）：拷进产物夹，控制台插件列表会显示「查看说明」——
      const docsPath = resolve(__dirname, '插件文档.md');
      if (fs.existsSync(docsPath)) {
        fs.copyFileSync(docsPath, resolve(outAbs, '插件文档.md'));
      }

      console.log(`[hello] 产物夹已生成: ${outAbs}`);
      console.log('[hello] 内含: package.json + plugin.json + index.mjs（+ 插件文档.md）');
    },
  };
}

export default defineConfig({
  resolve: {
    conditions: ['node', 'default'],
  },
  build: {
    sourcemap: false,
    target: 'esnext',
    // 教程产物保持可读，不压缩
    minify: false,
    lib: {
      // 业务入口：源码
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      // 输出文件名固定为 index.mjs
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      external: [...nodeModules],
      output: {
        inlineDynamicImports: true,
      },
    },
    // 产物目录 = kakake-plugin-hello/
    outDir: OUT_DIR,
    emptyOutDir: true,
  },
  plugins: [copyJsonIntoOutDir()],
});
