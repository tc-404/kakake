import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Cable, Puzzle, Store, Wrench, Rocket, Sparkles, ScrollText, Settings, LogOut, MessagesSquare, Github, Menu, X,
} from 'lucide-react';
import { useEffect, useRef, useState, Suspense, lazy, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { api, setStoredToken } from '@/lib/api';
import { getAppearanceSnapshot, subscribeAppearance } from '@/lib/appearance';
import { useSessionActivity } from '@/lib/session-activity';
import { pushContent } from '@/lib/content-push';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { Button } from '@/components/ui/button';
import { AmbientVideo } from '@/components/ambient-video';
import { AuthGuard, clearAuthGateCache } from '@/components/auth-guard';
import { AnnouncementUpdateDialog, resetAnnouncementUpdateCheck } from '@/components/announcement-update-dialog';
import { QuietNav } from '@/components/quiet-link';
import { UpdateCenter } from '@/components/update-center';
import { UpdateInstallOverlay } from '@/components/update-install-overlay';
import {
  PageHeaderProvider,
  PageHeaderActionsSlot,
  PageHeaderLeadingSlot,
  usePageHeaderTitle,
} from '@/components/header-actions';
// 1676 行的导览组件按需加载：不阻塞控制台首屏渲染，挂载后异步补齐
const ProductTour = lazy(() => import('@/components/product-tour').then((m) => ({ default: m.ProductTour })));

/** 导览锚点：href → data-tour（手机与电脑导航共用，导览按可见元素择一高亮） */
const NAV_TOUR_ID: Record<string, string> = {
  '/': 'nav-dashboard',
  '/connections': 'nav-connections',
  '/plugins': 'nav-plugins',
  '/plugin-store': 'nav-plugin-store',
  '/tools': 'nav-tools',
  '/open-platform': 'nav-open-platform',
  '/ai': 'nav-ai',
  '/simulate': 'nav-simulate',
  '/logs': 'nav-logs',
  '/settings': 'nav-settings',
};

/**
 * 导航项：手机与电脑共用同一份（底部导航栏已移除，两端都走侧边栏）。
 * 「模拟消息」也在这份里，不再按端拆分。
 */
const NAV = [
  { href: '/', label: '数据概览', icon: LayoutDashboard },
  { href: '/connections', label: '连接管理', icon: Cable },
  { href: '/plugins', label: '插件管理', icon: Puzzle },
  { href: '/plugin-store', label: '资源商店', icon: Store },
  { href: '/tools', label: '实用工具', icon: Wrench },
  { href: '/open-platform', label: '开放平台', icon: Rocket },
  { href: '/ai', label: '智能助手', icon: Sparkles },
  { href: '/simulate', label: '模拟消息', icon: MessagesSquare },
  { href: '/logs', label: '运行日志', icon: ScrollText },
  { href: '/settings', label: '系统设置', icon: Settings },
];

/** 顶栏标题：按当前路由推导界面名，页面可用 usePageHeader({ title }) 覆盖 */
function titleFromPath(pathname: string): string {
  const hit = NAV.find((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return hit?.label ?? '';
}

function activeNavIndex(pathname: string) {
  const i = NAV.findIndex((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return i < 0 ? 0 : i;
}

/**
 * 侧栏导航。手机与电脑共用一份，不需要在点击时手动收起——
 * ConsoleShellInner 监听了 pathname，切界面会自动把侧栏收起来。
 */
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
  // 侧栏按四字宽度收窄了，品牌字相应降一档；版本徽标放不下时换行，不硬挤
  return (
    <div className="min-w-0 leading-tight">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span data-tour="brand-title" className="kk-logo-text truncate text-lg font-semibold tracking-tight">{title}</span>
        {version ? <UpdateCenter version={version} large /> : null}
      </div>
    </div>
  );
}

/**
 * 侧边栏宽度：手机按屏宽百分比、电脑按像素，两条线各管一端，
 * 取值来自「设置 → 界面外观」里那两根「侧边栏宽度」调节条。
 * applyAppearanceTokens 写出 --kk-sidebar-w-mobile / --kk-sidebar-w-pc，
 * globals.css 再按 768px 断点把它们收敛成这一个派生量，
 * 于是侧栏只挂一个不带断点的宽度类——折叠用的 md 宽度类才是唯一的，
 * 不会被另一个同优先级的 md 宽度类按样式表源码顺序反压掉。
 * 折叠时外层宽度收到 0，内容靠这同一个宽度类保持原宽，不会跟着被压扁重排。
 */
const SIDEBAR_W = 'w-[var(--kk-sidebar-w)]';

/** 开合过渡：与全站液态指示同一条缓动曲线，尊重「减少动效」设置 */
const SIDEBAR_MOTION = 'transition-[transform,width,margin] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none';

/** 桌面断点：与 globals.css 的 @media (min-width: 768px) 及 content-push.ts 保持同一根线 */
const DESKTOP_QUERY = '(min-width: 768px)';

/** 侧栏开合记忆的存储键（沿用全站 kk- 前缀，同 kk-appearance / kk-perf-mode） */
const SIDEBAR_OPEN_KEY = 'kk-sidebar-open';

/** 当前是否落在桌面断点（宽屏）一侧 */
function isDesktopViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(DESKTOP_QUERY).matches;
}

/** 读回桌面端上次记下的开合状态；读不到（首次进入 / 隐私模式）按收起处理 */
function readStoredSidebarOpen(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 侧栏的初始开合状态。
 *
 * - 电脑端：还原上次记下的状态。刷新页面只是「组件重新挂载」，不该被当成
 *   一次用户操作把侧栏收掉——此前这里硬编码 false，于是宽屏下每次刷新侧栏
 *   都会自己关掉，与用户预期不符。
 * - 手机端：一律收起。窄屏侧栏是覆盖式抽屉，默认展开会盖住主内容，
 *   进去先得关一下；每次都从收起开始才是合理的。
 */
function initialSidebarOpen(): boolean {
  return isDesktopViewport() ? readStoredSidebarOpen() : false;
}

function ConsoleShellInner({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useSessionActivity(true);
  const version = useFrameworkVersion();
  const brandTitle = useBrandTitle();
  /**
   * 侧栏开合。初始值见 initialSidebarOpen()：电脑端还原上次状态（刷新不关）、
   * 手机端收起。展开后只由用户自己关（电脑点顶栏按钮，手机点侧栏外的空白或按 Esc）。
   */
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const pageTitle = usePageHeaderTitle() || titleFromPath(pathname);

  /*
   * 电脑端把开合状态记到本地，刷新后据此还原。
   * 手机端刻意不记：窄屏每次进入都应从收起开始，若把手机上的临时开合写进去，
   * 同一台设备来回旋转屏幕 / 缩放窗口时两边会互相覆盖，反而丢掉电脑端的偏好。
   */
  useEffect(() => {
    if (!isDesktopViewport()) return;
    try {
      localStorage.setItem(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0');
    } catch { /* 隐私模式等写不进去，忽略，只影响本次会话 */ }
  }, [sidebarOpen]);

  /*
   * 视口跨断点时对齐一次，避免状态与布局错配：
   * 缩到手机宽度 → 收起（抽屉不能默认遮着主内容）；
   * 放大回电脑宽度 → 还原电脑端上次的状态。
   */
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => {
      setSidebarOpen(e.matches ? readStoredSidebarOpen() : false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 注意：这里刻意不监听 pathname。导航切换不自动收起侧栏，否则在侧栏里连点几个
  // 界面会被打断；要关就由用户自己关。
  // Esc 仍然收起——它同样算「用户手动关闭」，且给键盘用户留一条退路。
  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sidebarOpen]);

  /*
   * 侧栏开合时给主内容区一次水平冲量，做出「被推挤 / 被撞到」的手感。
   * 只喂 sidebarOpen 一个信号，方向由它决定（展开被推向右、收起被拉向左）；
   * 窄屏 / 减少动效的判断都在 content-push 内部。
   * 首次挂载跳过——刚进界面不该无缘无故动一下。
   */
  const pushPrimed = useRef(false);
  const mainRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pushPrimed.current) {
      pushPrimed.current = true;
      return;
    }
    pushContent(mainRef.current, sidebarOpen);
  }, [sidebarOpen]);

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
    <>
      <AnnouncementUpdateDialog />
      <UpdateInstallOverlay />
      <Suspense fallback={null}><ProductTour /></Suspense>
      <div className="kk-ambient flex h-dvh max-h-dvh overflow-hidden">
        <AmbientVideo />

        {/*
         * 侧栏：手机与电脑共用一份，宽度由「设置 → 界面外观」的两根调节条决定
         * （手机按屏宽百分比，默认约三分之二；电脑按像素，默认比原来宽 60px）。
         * - 手机：左侧抽屉滑入，侧栏之外是遮罩层，点空白收起
         * - 电脑：占位侧栏，靠宽度过渡收放（挤开主内容，不盖在上面）
         */}
        <div
          aria-hidden={!sidebarOpen}
          onClick={() => setSidebarOpen(false)}
          className={cn(
            'fixed inset-0 z-40 bg-slate-900/25 transition-opacity duration-300 motion-reduce:transition-none md:hidden',
            sidebarOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
        <aside
          className={cn(
            'kk-sidebar overflow-hidden',
            SIDEBAR_W,
            SIDEBAR_MOTION,
            'fixed inset-y-0 left-0 z-50 rounded-r-[1.35rem]',
            sidebarOpen ? 'translate-x-0' : '-translate-x-full',
            /*
             * 电脑端必须是 relative + 显式 z-index，不能是 static + z-auto：
             * static 元素的 z-index 不生效，会掉到 CSS 绘制顺序的「块级非定位后代」层，
             * 而自定义背景层 .kk-ambient::after 是 absolute + z-index:0，绘制在其上——
             * 于是侧栏被背景图整块盖住。又因 ::after 带 pointer-events:none，点击能穿透，
             * 表现为「看不见但盲点还能点到」。
             * relative 同样在文档流里占位，挤压主内容的效果不变；z-1 与 .kk-ambient > *
             * 给其余子元素的层级一致，正好压住 z-index:0 的背景层。
             * inset-auto 清掉手机端 fixed 定位用的 inset-y-0/left-0，避免相对位移。
             */
            'md:relative md:inset-auto md:z-[1] md:my-3 md:translate-x-0 md:h-[calc(100%-1.5rem)] md:rounded-[1.35rem]',
            // 折叠态：宽度收到 0，同时去掉玻璃边框与投影，否则会留一条竖线
            sidebarOpen ? 'md:ml-3 md:mr-2' : 'md:ml-0 md:mr-0 md:w-0 md:border-0 md:shadow-none',
          )}
        >
          {/* 内容保持固定宽度：外层收放到 0 时文字不会被压得重排 */}
          <div className={cn('flex h-full flex-col', SIDEBAR_W)}>
            <div className="flex min-h-[4rem] shrink-0 flex-col justify-center gap-1 px-3 py-3">
              <Brand version={version} title={brandTitle} />
            </div>
            <div className="mx-3 h-px shrink-0 bg-gradient-to-r from-transparent via-white/55 to-transparent" />
            <div className="min-h-0 flex-1 overflow-y-auto no-scrollbar py-3">
              <SidebarNav />
            </div>
            <div className="mx-3 my-1 h-px shrink-0 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            <div className="shrink-0 p-2 pt-1.5">
              <div className="mb-1.5 flex justify-end">
                <GitHubRepoLink className="h-8 w-8" />
              </div>
              {/* 退出登录从顶栏移到侧栏：顶栏只留标题与当前界面的操作 */}
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
          </div>
        </aside>

        <div ref={mainRef} className="kk-ambient-main relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {/*
           * 顶栏：手机与电脑同一套（手机样式），只显示「应用标题 · 当前界面标题」
           * 与当前界面的操作；最左侧按钮开合侧栏。
           *
           * 用 absolute 悬浮（而不是 flex 里 shrink-0 占位）是刻意的：占位写法下
           * 顶栏会实打实吃掉顶部 60px，主内容永远滚不到它后面，滚动时顶栏里透出来的
           * 一直只是氛围背景——看着就像「顶栏自带一层背景、内容从它下面被切断」。
           * 悬浮之后主内容能一路滚到顶栏背后，透过毛玻璃继续可见。
           * 代价是主内容得自己留出等高的 padding-top，否则首屏会被压住（见下方注释）。
           */}
          <header
            className="kk-glass-nav absolute inset-x-3 z-20 flex h-12 items-center gap-1 rounded-[1.15rem] px-2"
            style={{ top: 'max(0.75rem, var(--safe-top))' }}
          >
            <Button
              variant="ghost"
              size="icon"
              data-tour="nav-toggle"
              className="h-8 w-8 shrink-0 text-slate-600 hover:bg-white/35"
              title={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
            <PageHeaderLeadingSlot />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {/* 与侧栏品牌字共用导览锚点：导览只会高亮当前可见的那个 */}
              <span data-tour="brand-title" className="kk-logo-text truncate font-semibold tracking-tight">{brandTitle}</span>
              {pageTitle ? (
                <>
                  <span aria-hidden className="shrink-0 text-slate-400">·</span>
                  <span className="truncate text-sm text-slate-600">{pageTitle}</span>
                </>
              ) : null}
            </div>
            <PageHeaderActionsSlot />
            <GitHubRepoLink className="h-8 w-8 shrink-0" />
          </header>

          {/*
           * 内边距必须挂在滚动容器自己身上，不能挂在外层 <main>。
           * overflow 裁的是「padding box」，挂在外面时滚动容器的 padding box
           * 正好和卡片边缘重合，卡片四边的投影被齐根切掉（左右尤其彻底，
           * 一眼看上去就是阴影被吞了、只剩上下两道）。挂进来之后，
           * 这圈 padding 就是阴影的作画余量，四边都能完整画出来。
           *
           * <main> 用 marginTop 顶到与顶栏同一条 top 上。
           *
           * ⚠️ 顶部留白（原「顶栏 h-12 + 手机 .75rem / 电脑 1.25rem」）**不能**留在这个
           * 滚动容器上，必须挪到页面外层的 .kk-page-enter（见 App.tsx）。原因：
           * position: sticky 的吸顶基准不是滚动容器的 padding box 顶边，而是**内容盒顶边**；
           * 这里挂 padding-top 会把基准整体下推同样多。于是页面里 `sticky top-12` 的工具栏
           * 静止时就被顶下去 48px、正好压在列表上——资源商城搜索栏与卡片重叠就是这么来的
           * （实测：容器 pt=4.25rem 时工具栏静止在 y=128，列表头顶在 y=154）。
           * 挪到内层后滚动容器内容盒顶边回到顶栏上沿，工具栏静止落在首屏留白处、
           * 吸顶时正好停在顶栏下沿（y=60）。留白仍是滚动内容的一部分，往上滚依旧穿过顶栏区间。
           *
           * 底部留白由内容层的 `.kk-page-flow::after`（见 globals.css）撑出，这里不要再挂
           * padding-bottom：本容器是 flex + overflow-y:auto，内容溢出时 padding-bottom
           * 会被浏览器忽略（留白恒为 0）；透明下边框虽然能撑高度，却把空间留在裁剪边界之外，
           * 最后一张卡片的投影会被切断；挂在 .kk-page-enter 末尾的垫片也不行——它和本容器
           * 一样被 flex-1 + min-h-0 封顶在视口高度，长内容是从盒子上「漫出去」的，
           * 垫片会被埋在内容中间。垫片必须挂在跟着内容长高的那一层（.kk-page-flow）的末尾，
           * 才既在裁剪区内、又在所有内容之后，滚到底才让出位置，静止的短页面不受影响。
           */}
          <main
            // 主区四角加圆角：滚动到中间态时，内容卡片的圆角已滚出视口，
            // 会露出 main 自身的直角四角——加 rounded 后视口顶/底左右角永远是圆的，
            // 与侧栏 aside 的 rounded-[1.35rem] 呼应，整体卡片化。
            // main 是 overflow-hidden，border-radius 对内部滚动内容做圆角裁剪。
            // 代价：内容卡片贴近视口顶/底时会被圆角咬 1.25rem 一角——但 .kk-page-enter
            // 的 pt-3.75rem 顶部留白意味着滚到顶时内容距视口顶 3.75rem 不被咬；
            // 滚到中间时若页面有 sticky 工具栏（top-12 = 48px）会挡住咬角，
            // 仅"无 sticky 的长内容页面滚到中间"会有可见咬角，是可接受的妥协。
            className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[1.25rem]"
            // 与顶栏同一个 top：滚动内容的裁切边缘正好落在顶栏上沿，
            // 否则顶栏上方那 12px 会露出半截内容再被硬生生切掉
            style={{ marginTop: 'max(0.75rem, var(--safe-top))' }}
          >
            <div
              data-kk-page-scroll
              className="flex min-h-0 flex-1 flex-col overflow-y-auto overflow-x-hidden overscroll-contain no-scrollbar px-4 [-webkit-overflow-scrolling:touch] md:px-6"
            >
              {children}
            </div>
          </main>
        </div>
      </div>
    </>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <AuthGuard>
      <PageHeaderProvider>
        <ConsoleShellInner>{children}</ConsoleShellInner>
      </PageHeaderProvider>
    </AuthGuard>
  );
}
