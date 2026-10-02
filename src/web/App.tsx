import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { ConsoleShell } from '@/components/console-shell';
import { AuthGuard } from '@/components/auth-guard';
import { useAppearanceSync } from '@/hooks/use-appearance';
import { useSessionActivity } from '@/lib/session-activity';
// 首屏路径保持静态引入（登录页 / 登录后落地页），其余页面全部按需加载，
// 降低低端设备首屏 JS 解析体积（LogsPage 等单页超过 1000 行源码）。
import DashboardPage from '@/pages/DashboardPage';
import LoginPage from '@/pages/LoginPage';

const ConnectionsPage = lazy(() => import('@/pages/ConnectionsPage'));
const PluginsPage = lazy(() => import('@/pages/PluginsPage'));
const PluginHostPage = lazy(() => import('@/pages/PluginHostPage'));
const PluginStorePage = lazy(() => import('@/pages/PluginStorePage'));
const ToolsPage = lazy(() => import('@/pages/ToolsPage'));
const SimulatePage = lazy(() => import('@/pages/SimulatePage'));
const LogsPage = lazy(() => import('@/pages/LogsPage'));
const SettingsPage = lazy(() => import('@/pages/SettingsPage'));
const AnnouncementPage = lazy(() => import('@/pages/AnnouncementPage'));
const SetupPasswordPage = lazy(() => import('@/pages/SetupPasswordPage'));

/** 路由级懒加载兜底：极简居中转轮，避免为每个页面写骨架屏 */
function PageFallback() {
  return (
    <div className="flex h-full min-h-[50vh] w-full items-center justify-center" role="status" aria-label="页面加载中">
      <Loader2 className="h-6 w-6 animate-spin text-slate-400" aria-hidden="true" />
    </div>
  );
}

/** 懒加载页面统一包一层 Suspense */
function LazyPage({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

function ConsoleLayout() {
  // pathname 作 key：切换界面时整层重挂，重放 kk-page-enter 入场动画（淡入 + 上滑），
  // 结束后与页内卡片原有的 kk-stagger 交错动画自然衔接
  const location = useLocation();
  return (
    <ConsoleShell>
      {/* 包装层必须接续 flex 高度链：页面根节点多为 h-full + min-h-0 + flex-col（内部自滚动），
          若此处是普通块级元素，h-full 会塌缩为 0，导致模拟消息 / 日志等页面内容挤到顶部 */}
      <div key={location.pathname} className="kk-page-enter flex min-h-0 flex-1 flex-col">
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

  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/announcement" element={<LazyPage><AnnouncementPage /></LazyPage>} />
      <Route path="/setup-password" element={<LazyPage><SetupPasswordPage /></LazyPage>} />

      {/* 插件宿主：与控制台平级的独立路由 */}
      <Route element={<PluginHostLayout />}>
        <Route path="/plugins/:pluginId/a/:accountKey/pages/*" element={<LazyPage><PluginHostPage /></LazyPage>} />
        <Route path="/plugins/:pluginId/pages/*" element={<LazyPage><PluginHostPage /></LazyPage>} />
      </Route>

      <Route element={<ConsoleLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/connections" element={<LazyPage><ConnectionsPage /></LazyPage>} />
        <Route path="/plugins" element={<LazyPage><PluginsPage /></LazyPage>} />
        <Route path="/plugin-store" element={<LazyPage><PluginStorePage /></LazyPage>} />
        <Route path="/tools" element={<LazyPage><ToolsPage /></LazyPage>} />
        <Route path="/tools/:toolId" element={<LazyPage><ToolsPage /></LazyPage>} />
        <Route path="/simulate" element={<LazyPage><SimulatePage /></LazyPage>} />
        <Route path="/logs" element={<LazyPage><LogsPage /></LazyPage>} />
        <Route path="/settings" element={<LazyPage><SettingsPage /></LazyPage>} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
