import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Cable, Puzzle, Store, Wrench, ScrollText, Settings, LogOut,
} from 'lucide-react';
import type { RefObject } from 'react';
import { cn } from '@/lib/utils';
import { api, setStoredToken } from '@/lib/api';
import { useSessionActivity } from '@/lib/session-activity';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { AuthGuard, clearAuthGateCache } from '@/components/auth-guard';
import { QuietNav } from '@/components/quiet-link';
import {
  MobileHeaderActionsProvider,
  MobileHeaderActionsSlot,
} from '@/components/mobile-header-actions';

const NAV = [
  { href: '/', label: '概览', icon: LayoutDashboard },
  { href: '/connections', label: '连接', icon: Cable },
  { href: '/plugins', label: '插件', icon: Puzzle },
  { href: '/plugin-store', label: '资源', icon: Store },
  { href: '/tools', label: '工具', icon: Wrench },
  { href: '/logs', label: '日志', icon: ScrollText },
  { href: '/settings', label: '设置', icon: Settings },
];

function activeNavIndex(pathname: string) {
  const i = NAV.findIndex((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return i < 0 ? 0 : i;
}

function SidebarNav() {
  const { pathname } = useLocation();
  const active = activeNavIndex(pathname);
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

function Brand() {
  return (
    <div className="leading-tight">
      <div className="text-base font-semibold tracking-tight">咔咔珂</div>
      <div className="text-[11px] text-muted-foreground">管理后台</div>
    </div>
  );
}

export function ConsoleShell({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  useSessionActivity(true);

  const logout = async () => {
    try {
      await api.logout();
    } catch { /* ignore */ }
    setStoredToken('');
    clearAuthGateCache();
    navigate('/login', { replace: true });
  };

  return (
    <AuthGuard>
      <MobileHeaderActionsProvider>
        <div className="kk-ambient flex h-dvh max-h-dvh overflow-hidden">
          <aside
            className={cn(
              'kk-sidebar relative ml-3 mr-2 my-3 hidden h-[calc(100%-1.5rem)] w-[15.5rem] shrink-0',
              'flex-col overflow-hidden rounded-[1.35rem] md:flex',
            )}
          >
            <div className="flex h-16 shrink-0 items-center px-5">
              <Brand />
            </div>
            <div className="mx-4 h-px shrink-0 bg-gradient-to-r from-transparent via-white/55 to-transparent" />
            <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar py-3">
              <SidebarNav />
            </div>
            <div className="mx-4 my-1 h-px shrink-0 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            <div className="shrink-0 p-3 pt-2">
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
              <span className="font-semibold tracking-tight">咔咔珂</span>
              <div className="flex items-center gap-0.5">
                <MobileHeaderActionsSlot />
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
