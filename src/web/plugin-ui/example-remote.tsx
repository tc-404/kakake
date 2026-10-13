/**
 * 插件远程后台示例（构建产物应为 webui/remote.js）。
 *
 * package.json:
 *   "webui": "webui/admin.html",
 *   "webuiModule": "webui/remote.js"
 *
 * 或代码注册:
 *   ctx.router.page({
 *     path: 'admin',
 *     title: '后台',
 *     module: 'webui/remote.js',
 *     htmlFile: 'webui/admin.html', // 可选 iframe 回退
 *   });
 *
 * Vite lib 构建建议:
 *   build.lib.entry = 'src/webui-remote.tsx'
 *   build.lib.formats = ['es']
 *   rollupOptions.external = ['react','react-dom','react/jsx-runtime','react-router-dom']
 */

import { useEffect, useState } from 'react';
import type { PluginRemoteProps } from '../lib/plugin-remote';

export default function ExamplePluginRemote({ pluginId, accountKey, apiBase, fetch: hostFetch }: PluginRemoteProps) {
  const [hint, setHint] = useState('…');

  useEffect(() => {
    setHint(`${pluginId} @ ${accountKey} → ${apiBase}`);
  }, [pluginId, accountKey, apiBase]);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 8 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>插件远程模块已挂载</h2>
      <p style={{ margin: 0, color: '#475569', fontSize: 13 }}>{hint}</p>
      <p style={{ margin: '12px 0 0', fontSize: 12, color: '#94a3b8' }}>
        使用 props.fetch 调用 apiBase 下的接口；react 由宿主 importmap 注入。
      </p>
      <button
        type="button"
        style={{ marginTop: 12, padding: '6px 12px' }}
        onClick={() => {
          void hostFetch(`${apiBase}/`).catch(() => undefined);
        }}
      >
        探测 API
      </button>
    </div>
  );
}
