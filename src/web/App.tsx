import { Suspense, useEffect } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ConsoleShell } from '@/components/console-shell';
import { AuthGuard } from '@/components/auth-guard';
import { PageErrorBoundary } from '@/components/page-error-boundary';
import { useAppearanceSync } from '@/hooks/use-appearance';
import { useSessionActivity } from '@/lib/session-activity';
import { getDeviceTier } from '@/lib/device-tier';
// 首屏路径保持静态引入（登录页 / 登录后落地页），其余页面全部按需加载，
// 降低低端设备首屏 JS 解析体积（LogsPage 等单页超过 1000 行源码）。
import DashboardPage from '@/pages/DashboardPage';
import LoginPage from '@/pages/LoginPage';

/**
 * 各页面的动态 import。放在一张表里，预取与渲染共用同一份 ——
 * 预取过的模块会被缓存下来，切界面时可以直接同步渲染（见 Page）。
 */
const PAGE_LOADERS = {
  connections: () => import('@/pages/ConnectionsPage'),
  plugins: () => import('@/pages/PluginsPage'),
  pluginHost: () => import('@/pages/PluginHostPage'),
  pluginStore: () => import('@/pages/PluginStorePage'),
  tools: () => import('@/pages/ToolsPage'),
  openPlatform: () => import('@/pages/OpenPlatformPage'),
  ai: () => import('@/pages/AIPage'),
  simulate: () => import('@/pages/SimulatePage'),
  logs: () => import('@/pages/LogsPage'),
  settings: () => import('@/pages/SettingsPage'),
  announcement: () => import('@/pages/AnnouncementPage'),
  setupPassword: () => import('@/pages/SetupPasswordPage'),
} as const;

type LoaderKey = keyof typeof PAGE_LOADERS;
type LoadedModule = { default: React.ComponentType<Record<string, never>> };

/** 模块缓存：`mod` 有值就表示已经加载完，可以同步渲染 */
const pageCache = new Map<LoaderKey, { mod?: LoadedModule; promise?: Promise<unknown> }>();

function loadPage(key: LoaderKey): { mod?: LoadedModule; promise?: Promise<unknown> } {
  let entry = pageCache.get(key);
  if (!entry) {
    entry = {};
    pageCache.set(key, entry);
  }
  if (!entry.mod && !entry.promise) {
    entry.promise = (PAGE_LOADERS[key]() as unknown as Promise<LoadedModule>)
      .then((m) => {
        entry!.mod = m;
        return m;
      });
  }
  return entry;
}

/**
 * 自己实现的「可预热懒加载」，替代 React.lazy。
 *
 * React.lazy 首次渲染**必定先挂起一轮**（哪怕模块早已在缓存里），于是切界面时
 * 总会先闪一下兜底（转圈），内容再补进来 —— 观感就是「先显示再渲染」。
 * 这里直接读预取好的模块：`mod` 就绪时**同步渲染**，切界面即见完整页面；
 * 只有没预热到（冷启动直接打开某个二级页面）才 throw promise，交给外面 Suspense。
 *
 * 代码分割照旧：模块仍是动态 import，只是改成空闲时预取 + 命中即同步渲染。
 */
function Page({ pageKey }: { pageKey: LoaderKey }) {
  const entry = loadPage(pageKey);
  if (!entry.mod) throw entry.promise;
  const PageComponent = entry.mod.default;
  return <PageComponent />;
}

/** 路由级懒加载兜底：极简居中转轮，避免为每个页面写骨架屏 */
function PageFallback() {
  return (
    <div className="flex h-full min-h-[50vh] w-full items-center justify-center" role="status" aria-label="页面加载中">
      <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
    </div>
  );
}

/**
 * 页面统一包一层 Suspense + 错误边界 + 入场动画层。
 * 错误边界不可省：chunk 404（重建后旧文件名失效）或页面 render 抛错时，
 * 少了它 React 18 会卸载整个 root，表现为切界面全白。
 *
 * 入场动画（`.kk-page-in`）刻意挂在 **Suspense 之内**：
 * 挂在外面时，切界面会先淡入一个空壳，内容随后才补进来 —— 又是「先显示再渲染」。
 * 挂进来之后，只有真正的内容挂载了才开始淡入，即「渲染好再显示」。
 *
 * 内容层分两种布局模式（底部留白的处理不同，见 globals.css）：
 * - 流式（默认，`.kk-page-flow`）：`min-h-full + shrink-0`，跟着内容一起长高，
 *   末尾垫片（::after）落在内容真正的末尾 —— 「滚到最底部才露出」的预留；
 *   装不满一屏时垫片躺在空白里，不占位、不挤压。
 *   shrink-0 不可省：外层 .kk-page-enter 被 flex-1 + min-h-0 封顶在视口高度，
 *   缺了它内容层会被压缩回视口高、长内容又变成「漫出盒子」，垫片重新被埋掉。
 * - 固定（fixed，`.kk-page-fixed`）：页面是 h-full 固定骨架（模拟消息 / 智能助手 /
 *   日志 / 插件 / 工具 / 开放平台，以及不套控制台外壳的独立页），接续 flex 高度链
 *   （缺了它 h-full 会塌缩成 0）；底栏固定显示，不要滚到底式预留，只留 12px 投影余量。
 */
function LazyPage({ children, fixed = false }: { children: React.ReactNode; fixed?: boolean }) {
  return (
    <PageErrorBoundary>
      <Suspense fallback={<PageFallback />}>
        <div
          className={
            fixed
              ? 'kk-page-in kk-page-fixed flex min-h-0 flex-1 flex-col'
              : 'kk-page-in kk-page-flow flex min-h-full w-full shrink-0 flex-col'
          }
        >
          {children}
        </div>
      </Suspense>
    </PageErrorBoundary>
  );
}

/**
 * 空闲时把各页面模块预取好（性能模式跳过：低端设备省流量、省解析开销）。
 * 预取之后，切界面走的是 Page 的「同步渲染」分支 —— 不闪兜底、不等网络。
 */
function usePrefetchPages(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (getDeviceTier() === 'low') return;
    const load = () => {
      for (const key of Object.keys(PAGE_LOADERS) as LoaderKey[]) loadPage(key);
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };
    if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(load, { timeout: 3000 });
    else window.setTimeout(load, 1500);
  }, []);
}

function ConsoleLayout() {
  // pathname 作 key：切换界面时整层重挂，连带 Suspense 内的内容层一起重挂，
  // 由内容层（.kk-page-in，见 LazyPage）重放入场动画（淡入 + 上滑）；
  // 注意入场动画不在这一层 —— 挂外层会「先淡入空壳、内容再补进来」。
  const location = useLocation();
  return (
    <ConsoleShell>
      {/* 包装层必须接续 flex 高度链：页面根节点多为 h-full + min-h-0 + flex-col（内部自滚动），
          若此处是普通块级元素，h-full 会塌缩为 0，导致模拟消息 / 日志等页面内容挤到顶部。

          顶部留白（pt-*）刻意放在这一层、而不是滚动容器 [data-kk-page-scroll] 上：
          吸顶（position: sticky）的基准是滚动容器的**内容盒顶边**，卷容器自己带 padding-top
          会把基准一起下推，页面里 `sticky top-12` 的工具栏静止时就被顶下去 48px 压住列表。
          放在这里后滚动容器内容盒顶边与顶栏上沿齐平，吸顶位置才正确。
          留白值须与 console-shell 里 <main> 的 marginTop 口径一致（手机 3.75rem / 电脑 4.25rem）。 */}
      <div key={location.pathname} className="kk-page-enter flex min-h-0 flex-1 flex-col pt-[3.75rem] md:pt-[4.25rem]">
        <Outlet />
      </div>
    </ConsoleShell>
  );
}

/** 插件后台独立全屏页（不套控制台侧栏 / 顶栏） */
function PluginHostLayout() {
  useSessionActivity(true);
  return (
    <AuthGuard>
      <div className="flex h-dvh max-h-dvh flex-col overflow-hidden bg-transparent">
        <Outlet />
      </div>
    </AuthGuard>
  );
}

export function App() {
  // 登录页、设置密码页、控制台共用同一套外观：在路由根部同步一次即可
  useAppearanceSync();
  // 空闲时预取各页面模块（性能模式跳过），切界面直接同步渲染
  usePrefetchPages();

  return (
    // 根级兜底：静态引入的页面（首页 / 登录页）抛错时也不能整屏全白
    <PageErrorBoundary>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 独立页不套控制台外壳，保持固定布局（内容与原来一致） */}
        <Route path="/announcement" element={<LazyPage fixed><Page pageKey="announcement" /></LazyPage>} />
        <Route path="/setup-password" element={<LazyPage fixed><Page pageKey="setupPassword" /></LazyPage>} />

        {/* 插件宿主：与控制台平级的独立路由 */}
        <Route element={<PluginHostLayout />}>
          <Route path="/plugins/:pluginId/a/:accountKey/pages/*" element={<LazyPage fixed><Page pageKey="pluginHost" /></LazyPage>} />
          <Route path="/plugins/:pluginId/pages/*" element={<LazyPage fixed><Page pageKey="pluginHost" /></LazyPage>} />
        </Route>

        {/* 首页虽然静态引入，也套一层 LazyPage：好让它和控制台其它页面一样挂上入场动画层 */}
        <Route element={<ConsoleLayout />}>
          <Route path="/" element={<LazyPage><DashboardPage /></LazyPage>} />
          <Route path="/connections" element={<LazyPage><Page pageKey="connections" /></LazyPage>} />
          <Route path="/plugins" element={<LazyPage fixed><Page pageKey="plugins" /></LazyPage>} />
          <Route path="/plugin-store" element={<LazyPage><Page pageKey="pluginStore" /></LazyPage>} />
          <Route path="/tools" element={<LazyPage fixed><Page pageKey="tools" /></LazyPage>} />
          <Route path="/tools/:toolId" element={<LazyPage fixed><Page pageKey="tools" /></LazyPage>} />
          <Route path="/open-platform" element={<LazyPage fixed><Page pageKey="openPlatform" /></LazyPage>} />
          <Route path="/ai" element={<LazyPage fixed><Page pageKey="ai" /></LazyPage>} />
          <Route path="/simulate" element={<LazyPage fixed><Page pageKey="simulate" /></LazyPage>} />
          <Route path="/logs" element={<LazyPage fixed><Page pageKey="logs" /></LazyPage>} />
          <Route path="/settings" element={<LazyPage><Page pageKey="settings" /></LazyPage>} />
        </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </PageErrorBoundary>
  );
}
