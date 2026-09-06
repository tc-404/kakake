import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { ConsoleShell } from '@/components/console-shell';
import { AuthGuard } from '@/components/auth-guard';
import { useAppearanceSync } from '@/hooks/use-appearance';
import { useSessionActivity } from '@/lib/session-activity';
import DashboardPage from '@/pages/DashboardPage';
import ConnectionsPage from '@/pages/ConnectionsPage';
import PluginsPage from '@/pages/PluginsPage';
import PluginHostPage from '@/pages/PluginHostPage';
import PluginStorePage from '@/pages/PluginStorePage';
import ToolsPage from '@/pages/ToolsPage';
import LogsPage from '@/pages/LogsPage';
import SettingsPage from '@/pages/SettingsPage';
import LoginPage from '@/pages/LoginPage';
import AnnouncementPage from '@/pages/AnnouncementPage';
import SetupPasswordPage from '@/pages/SetupPasswordPage';

function ConsoleLayout() {
  return (
    <ConsoleShell>
      <Outlet />
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
      <Route path="/announcement" element={<AnnouncementPage />} />
      <Route path="/setup-password" element={<SetupPasswordPage />} />

      {/* 插件宿主：与控制台平级的独立路由 */}
      <Route element={<PluginHostLayout />}>
        <Route path="/plugins/:pluginId/a/:accountKey/pages/*" element={<PluginHostPage />} />
        <Route path="/plugins/:pluginId/pages/*" element={<PluginHostPage />} />
      </Route>

      <Route element={<ConsoleLayout />}>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/connections" element={<ConnectionsPage />} />
        <Route path="/plugins" element={<PluginsPage />} />
        <Route path="/plugin-store" element={<PluginStorePage />} />
        <Route path="/tools" element={<ToolsPage />} />
        <Route path="/tools/:toolId" element={<ToolsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
