import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Plus, Check, ArrowUpDown } from 'lucide-react';
import { api } from '@/lib/api';
import { applyAppearanceTokens, DEFAULT_APPEARANCE_STATE } from '@/lib/appearance';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import DashboardPage from '@/pages/DashboardPage';
// 样式走 packages/web/dist 已构建好的 CSS（探针不重复跑 Tailwind，见 index.html 的 app.css）
import '@/lib/i18n';
import '@/lib/i18n-dict/register';

/* 启用「全局字体」渐变：浅紫 → 粉，最容易看出哪些字没跟上 */
applyAppearanceTokens({
  ...DEFAULT_APPEARANCE_STATE,
  inkGradient: 'linear-gradient(90deg, #8b5cf6 0%, #ec4899 100%)',
});

// —— 假数据：让总览页有内容可看 ——
const conns = [
  {
    id: 'c1', name: '主连接 · 正向 WS', type: 'onebot', mode: 'forward',
    enable: true, connected: true, listenUrl: 'ws://127.0.0.1:6700',
    modeLabel: '正向 WebSocket', typeLabel: 'OneBot', reconnectAttempts: 0,
  },
  {
    id: 'c2', name: '备用 · 反向 WS', type: 'onebot', mode: 'reverse',
    enable: true, connected: false, listenUrl: 'ws://127.0.0.1:6701',
    modeLabel: '反向 WebSocket', typeLabel: 'OneBot', reconnectAttempts: 3,
    lastError: '连接失败',
  },
];

const metrics = {
  time: Date.now(),
  uptimeSec: 3600,
  systemUptimeSec: 72000,
  frameworkVersion: '0.6.8',
  host: {
    hostname: 'KAKAKE-PC', platform: 'win32', platformLabel: 'Windows', runtime: 'windows',
    release: '10.0.26100', arch: 'x64', type: 'Windows_NT', nodeVersion: 'v22.22.2',
  },
  cpu: {
    processPercent: 3.2, systemPercent: 27.5, perCore: [30, 22, 41, 18, 26, 33, 20, 25],
    cores: 8, coresOnline: 8, model: 'Intel Core i7', speedMHz: 3200,
  },
  memory: {
    processPercent: 4.1, processRssBytes: 200 * 1024 * 1024, processHeapUsedBytes: 90 * 1024 * 1024,
    nodeRssBytes: 210 * 1024 * 1024, nodePercent: 4.3, nodeHeapUsedBytes: 95 * 1024 * 1024,
    systemUsedBytes: 12 * 1024 ** 3, systemTotalBytes: 32 * 1024 ** 3, systemPercent: 37.5,
  },
  disk: {
    usedPercent: 62, usedBytes: 620 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3,
    freeBytes: 404 * 1024 ** 3, path: 'C:\\',
  },
  disks: [
    { usedPercent: 62, usedBytes: 620 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3, freeBytes: 404 * 1024 ** 3, path: 'C:\\' },
    { usedPercent: 41, usedBytes: 410 * 1024 ** 3, totalBytes: 1024 * 1024 ** 3, freeBytes: 614 * 1024 ** 3, path: 'D:\\' },
  ],
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const a = api as any;
a.status = async () => ({
  framework: 'kakake', version: '0.6.8',
  connections: conns,
  plugins: [{ id: 'p1', loaded: true, enable: true }, { id: 'p2', loaded: false, enable: true }],
});
a.systemMetrics = async () => metrics;
a.systemMetricsLive = async () => ({
  time: Date.now(),
  cpu: { systemPercent: 27.5, processPercent: 3.2 },
  memory: { systemPercent: 37.5, systemUsedBytes: metrics.memory.systemUsedBytes, systemTotalBytes: metrics.memory.systemTotalBytes, nodePercent: 4.3, nodeRssBytes: metrics.memory.nodeRssBytes, nodeHeapUsedBytes: metrics.memory.nodeHeapUsedBytes },
});

const SORTS = [
  { id: 'default', label: '默认排序' },
  { id: 'updated', label: '最近更新' },
  { id: 'downloads', label: '下载次数' },
  { id: 'views', label: '浏览最多' },
];

function Probe() {
  return (
    <div className="kk-ambient" style={{ minHeight: '100vh', padding: 24 }}>
      <MemoryRouter>
        {/* ① 总览界面 */}
        <section data-probe="overview">
          <DashboardPage />
        </section>

        {/* ② 插件市场的排序下拉 */}
        <section data-probe="store-sort" style={{ marginTop: 32 }}>
          <p className="mb-2 text-xs font-semibold">② 插件市场 · 排序方式</p>
          <DropdownMenu open>
            <DropdownMenuTrigger asChild>
              <button type="button" className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-600">
                <ArrowUpDown className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[11rem]">
              {SORTS.map((opt, i) => (
                <DropdownMenuItem key={opt.id} className={i === 1 ? 'bg-white/45 font-medium text-teal-800' : ''}>
                  <Check className={i === 1 ? 'h-4 w-4 opacity-100' : 'h-4 w-4 opacity-0'} />
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </section>

        {/* ③ 开发平台「添加账号」按钮 */}
        <section data-probe="op-add" style={{ marginTop: 220 }}>
          <p className="mb-2 text-xs font-semibold">③ 开发平台 · 添加账号</p>
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm">
              <Plus className="h-4 w-4" /> 添加账号
            </Button>
            <Button size="sm">
              <Plus className="h-4 w-4" /> 登记 / 接入账号
            </Button>
          </div>
        </section>
      </MemoryRouter>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Probe />);
