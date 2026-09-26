import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Cable, Puzzle, Store, Wrench, ScrollText, Settings, LogOut, MessagesSquare, Github,
} from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { api, setStoredToken } from '@/lib/api';
import { getAppearanceSnapshot, subscribeAppearance } from '@/lib/appearance';
import { useSessionActivity } from '@/lib/session-activity';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { AmbientVideo } from '@/components/ambient-video';
import { AuthGuard, clearAuthGateCache } from '@/components/auth-guard';
import { AnnouncementUpdateDialog, resetAnnouncementUpdateCheck } from '@/components/announcement-update-dialog';
import { QuietNav } from '@/components/quiet-link';
import { UpdateCenter } from '@/components/update-center';
import { UpdateInstallOverlay } from '@/components/update-install-overlay';
import {
  MobileHeaderActionsProvider,
  MobileHeaderActionsSlot,
} from '@/components/mobile-header-actions';
import { ProductTour } from '@/components/product-tour';

/** 导览锚点：href → data-tour（手机与电脑导航共用，导览按可见元素择一高亮） */
const NAV_TOUR_ID: Record<string, string> = {
  '/': 'nav-dashboard',
  '/connections': 'nav-connections',
  '/plugins': 'nav-plugins',
  '/plugin-store': 'nav-plugin-store',
  '/tools': 'nav-tools',
  '/simulate': 'nav-simulate',
  '/logs': 'nav-logs',
  '/settings': 'nav-settings',
};

// 手机底部导航（模拟消息不在这里，改从「工具」进入）
const NAV = [
  { href: '/', label: '概览', icon: LayoutDashboard },
  { href: '/connections', label: '连接', icon: Cable },
  { href: '/plugins', label: '插件', icon: Puzzle },
  { href: '/plugin-store', label: '资源', icon: Store },
  { href: '/tools', label: '工具', icon: Wrench },
  { href: '/logs', label: '日志', icon: ScrollText },
  { href: '/settings', label: '设置', icon: Settings },
];

// 桌面侧栏：在「工具」后追加「模拟消息」
const DESKTOP_NAV = [
  ...NAV.slice(0, 5),
  { href: '/simulate', label: '模拟', icon: MessagesSquare },
  ...NAV.slice(5),
];

function activeNavIndexIn(list: typeof NAV, pathname: string) {
  const i = list.findIndex((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return i < 0 ? 0 : i;
}

function activeNavIndex(pathname: string) {
  return activeNavIndexIn(NAV, pathname);
}

function SidebarNav() {
  const { pathname } = useLocation();
  const NAV = DESKTOP_NAV;
  const active = activeNavIndexIn(NAV, pathname);
  const { navRef, setItemRef, box } = useLiquidIndicator(active, NAV.length);

  return (
    <nav
      ref={navRef as RefObject<HTMLElement>}
      className="relative flex flex-col gap-1 px-3 py-2"
    >
      <div
        aria-hidden
        className={cn('kk-nav-liquid', box.ready && 'kk-nav-liquid-ready')}
        style={{
          transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
          width: box.width,
          height: box.height,
        }}
      />
      {NAV.map((item, index) => {
        const isActive = index === active;
        const Icon = item.icon;
        return (
          <QuietNav
            key={item.href}
            ref={(el) => setItemRef(index, el)}
            to={item.href}
            data-tour={NAV_TOUR_ID[item.href]}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'kk-nav-item relative z-[1] w-full',
              isActive ? 'kk-nav-item-active' : 'kk-nav-item-idle',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {item.label}
          </QuietNav>
        );
      })}
    </nav>
  );
}

function MobileTabBar() {
  const { pathname } = useLocation();
  const active = activeNavIndex(pathname);
  const { navRef, setItemRef, box } = useLiquidIndicator(active, NAV.length);

  return (
            <nav
      ref={navRef as RefObject<HTMLElement>}
      className="kk-mobile-tabbar kk-glass-nav md:hidden"
      aria-label="主导航"
    >
      <div
        aria-hidden
        className={cn('kk-mobile-liquid', box.ready && 'kk-mobile-liquid-ready')}
        style={{
          transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
          width: box.width,
          height: box.height,
        }}
      />
      {NAV.map((item, index) => {
        const isActive = index === active;
        const Icon = item.icon;
        return (
          <QuietNav
            key={item.href}
            ref={(el) => setItemRef(index, el)}
            to={item.href}
            data-tour={NAV_TOUR_ID[item.href]}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'kk-mobile-tab relative z-[1]',
              isActive ? 'kk-mobile-tab-active' : 'kk-mobile-tab-idle',
            )}
          >
            <Icon
              className={cn('h-[1.15rem] w-[1.15rem]', isActive && 'scale-105')}
              strokeWidth={isActive ? 2.25 : 1.85}
            />
            <span className="truncate">{item.label}</span>
          </QuietNav>
        );
      })}
    </nav>
  );
}

/** 取咔咔珂版本号（协议门禁接口顺带返回，轻量） */
function useFrameworkVersion(): string {
  const [version, setVersion] = useState('');
  useEffect(() => {
    let cancelled = false;
    api.agreementState()
      .then((r) => { if (!cancelled) setVersion(String(r.version || '').trim()); })
      .catch(() => { /* 拿不到就不显示 */ });
    return () => { cancelled = true; };
  }, []);
  return version;
}

/** kakake 的 GitHub 仓库地址 */
const REPO_URL = 'https://github.com/tc-404/kakake';

/** GitHub 仓库图标按钮 */
function GitHubRepoLink({ className }: { className?: string }) {
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      title="GitHub 仓库"
      aria-label="GitHub 仓库"
      className={cn(
        'inline-flex items-center justify-center rounded-lg text-muted-foreground transition-colors',
        'hover:bg-white/35 hover:text-slate-800',
        className,
      )}
    >
      <Github className="h-4 w-4" />
    </a>
  );
}

/** 品牌字：优先用自定义标题名，未设置则回落到「咔咔珂」 */
function useBrandTitle(): string {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  return appearance.customTitle?.trim() || '咔咔珂';
}

function Brand({ version, title }: { version: string; title: string }) {
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex items-baseline gap-2">
        <span data-tour="brand-title" className="kk-logo-text truncate text-xl font-semibold tracking-tight">{title}</span>
        {version ? <UpdateCenter version={version} large /> : null}
      </div>
    </div>
  );
}

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  useSessionActivity(true);
  const version = useFrameworkVersion();
  const brandTitle = useBrandTitle();

  const logout = async () => {
    try {
      await api.logout();
    } catch { /* ignore */ }
    setStoredToken('');
    clearAuthGateCache();
    resetAnnouncementUpdateCheck();
    // 背景图与外观参数走公开只读接口，登录页沿用同一套，退出时不清
    navigate('/login', { replace: true });
  };

  return (
    <AuthGuard>
      <MobileHeaderActionsProvider>
        <AnnouncementUpdateDialog />
        <UpdateInstallOverlay />
        <ProductTour />
        <div className="kk-ambient flex h-dvh max-h-dvh overflow-hidden">
          <AmbientVideo />
          <aside
            className={cn(
              'kk-sidebar relative ml-3 mr-2 my-3 hidden h-[calc(100%-1.5rem)] w-[15.5rem] shrink-0',
              'flex-col overflow-hidden rounded-[1.35rem] md:flex',
            )}
          >
            <div className="flex h-16 shrink-0 items-center px-5">
              <Brand version={version} title={brandTitle} />
            </div>
            <div className="mx-4 h-px shrink-0 bg-gradient-to-r from-transparent via-white/55 to-transparent" />
            <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar py-3">
              <SidebarNav />
            </div>
            <div className="mx-4 my-1 h-px shrink-0 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            <div className="shrink-0 p-3 pt-2">
              <div className="mb-1.5 flex justify-end">
                <GitHubRepoLink className="h-8 w-8" />
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="kk-sidebar-logout"
                onClick={logout}
              >
                <LogOut className="h-4 w-4" />
                退出登录
              </Button>
            </div>
          </aside>

          <div className="kk-ambient-main flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header
              className="kk-glass-nav relative mx-3 mt-3 flex h-12 shrink-0 items-center justify-between rounded-[1.15rem] px-3 md:hidden"
              style={{ marginTop: 'max(0.75rem, var(--safe-top))' }}
            >
              <div className="flex min-w-0 items-baseline gap-1.5">
                <span data-tour="brand-title" className="kk-logo-text truncate font-semibold tracking-tight">{brandTitle}</span>
                {version ? <UpdateCenter version={version} /> : null}
              </div>
              <div className="flex items-center gap-0.5">
                <MobileHeaderActionsSlot />
                <GitHubRepoLink className="h-8 w-8" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-muted-foreground hover:bg-white/35"
                  onClick={logout}
                >
                  <LogOut className="h-3.5 w-3.5" />
                  退出
                </Button>
              </div>
            </header>

            <main className="flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-[calc(0.75rem+var(--mobile-nav-h)+var(--safe-bottom))] pt-3 md:px-6 md:pb-6 md:pt-5">
              <div
                data-kk-page-scroll
                className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar [-webkit-overflow-scrolling:touch]"
              >
                {children}
              </div>
            </main>

            <MobileTabBar />
          </div>
        </div>
      </MobileHeaderActionsProvider>
    </AuthGuard>
  );
}
