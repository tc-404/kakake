import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard, Cable, Puzzle, Store, Wrench, Rocket, Sparkles, ScrollText, Settings, LogOut, MessagesSquare, Github, Menu, X,
  Pencil, Check, RotateCcw, Lock,
} from 'lucide-react';
import { useEffect, useRef, useState, Suspense, lazy, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { useT } from '@/lib/i18n';
import { api, setStoredToken } from '@/lib/api';
import { getAppearanceSnapshot, subscribeAppearance } from '@/lib/appearance';
import { getDeviceTier, subscribeDeviceTier } from '@/lib/device-tier';
import { useSessionActivity } from '@/lib/session-activity';
import { setLanguageLocal } from '@/lib/language';
import { useEventSource } from '@/lib/sse';
import { pushContent } from '@/lib/content-push';
import { toast } from 'sonner';
import { useLiquidIndicator } from '@/hooks/use-liquid-indicator';
import { useLiquidNavDrag } from '@/hooks/use-liquid-nav-drag';
import { useNavReorder } from '@/hooks/use-nav-reorder';
import {
  applyNavLayout,
  getNavLayoutSnapshot,
  isNavHidable,
  isNavLayoutLoaded,
  loadNavLayout,
  orderNavBy,
  saveNavLayout,
  subscribeNavLayout,
  type NavLayout,
} from '@/lib/nav-layout';
import { Button } from '@/components/ui/button';
import { AmbientVideo } from '@/components/ambient-video';
import { BackgroundPresetLayer } from '@/components/background-preset-layer';
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
  { href: '/', navKey: 'nav.dashboard', shortKey: 'nav.short.dashboard', icon: LayoutDashboard },
  { href: '/connections', navKey: 'nav.connections', shortKey: 'nav.short.connections', icon: Cable },
  { href: '/plugins', navKey: 'nav.plugins', shortKey: 'nav.short.plugins', icon: Puzzle },
  { href: '/plugin-store', navKey: 'nav.pluginStore', shortKey: 'nav.short.pluginStore', icon: Store },
  { href: '/tools', navKey: 'nav.tools', shortKey: 'nav.short.tools', icon: Wrench },
  { href: '/open-platform', navKey: 'nav.openPlatform', shortKey: 'nav.short.openPlatform', icon: Rocket },
  { href: '/ai', navKey: 'nav.ai', shortKey: 'nav.short.ai', icon: Sparkles },
  { href: '/simulate', navKey: 'nav.simulate', shortKey: 'nav.short.simulate', icon: MessagesSquare },
  { href: '/logs', navKey: 'nav.logs', shortKey: 'nav.short.logs', icon: ScrollText },
  { href: '/settings', navKey: 'nav.settings', shortKey: 'nav.short.settings', icon: Settings },
];

/**
 * 电脑侧边栏「窄到只放得下两字」的阈值（px）。
 * 低于它时导航项改用两字短名（概览 / 连接 / 插件 …），
 * 否则四字全称（系统总览 / 连接管理 …）在窄栏里会被硬挤成省略号。
 */
const NAV_COMPACT_PX = 140;

/**
 * 电脑侧边栏「窄到放不下图标 + 文字」的阈值（px）。
 * 低于它时，带文字的按钮（导航项、退出登录）一律把图标收掉、只留文字：
 * 图标 16px + gap 10px 一共 26px，在 105px 以下的栏里占了近四分之一，
 * 挤掉它换来的宽度正好把两字短名完整放下。
 *
 * 纯图标按钮（底部的导航编辑、GitHub）不受这条影响——
 * 它们本来就没有文字可退，收掉图标就只剩一个空方块。
 */
const NAV_NO_ICON_PX = 105;

/**
 * 电脑侧边栏「连文字都放不下」的阈值（px），也是这一档的兜底：
 * 低于它时只留图标、文字收掉。
 * 侧栏除了左右内边距还要给图标留位置，50px 的下限里两个汉字必然被省略号截断，
 * 与其显示「系…」不如把图标居中摆着。
 * 手机端同档阈值见 NAV_NO_TEXT_VW（按屏宽百分比另算）。
 */
const NAV_NO_TEXT_PX = 80;

/**
 * 手机侧栏的两个阈值，单位是**屏宽百分比**（与「侧边栏宽度 · 手机」那根滑块同一单位）。
 * 手机上侧栏是覆盖式抽屉，宽度按屏宽走，不能复用电脑的 px 阈值——
 * 同一个百分比在不同屏宽的手机上对应的像素差别很大。
 *
 * 手机三档（下限 20%）：
 * - ≥ 40%：图标 + 全称
 * - 25% ~ 39%：只留文字（两字短名，居中），收掉图标
 * - < 25%：只留图标。这一档栏宽已经放不下两个汉字，留着也只有省略号，
 *   不如把图标居中摆着——这也是它与电脑端最大的差别（电脑端最窄档是只留文字）。
 */
const NAV_COMPACT_VW = 40;
const NAV_NO_TEXT_VW = 25;

/**
 * 侧栏一行的四种形态。
 * - full：图标 + 全称
 * - short：图标 + 两字短名
 * - text：只留文字（短名），图标收掉
 * - icon：只留图标，文字收掉
 */
type NavMode = 'full' | 'short' | 'text' | 'icon';

/** 电脑端（px）：≥ 140 全称、105 ~ 139 短名、80 ~ 104 只留文字、< 80 只留图标 */
function pcNavMode(widthPx: number): NavMode {
  if (widthPx >= NAV_COMPACT_PX) return 'full';
  if (widthPx >= NAV_NO_ICON_PX) return 'short';
  if (widthPx >= NAV_NO_TEXT_PX) return 'text';
  return 'icon';
}

/** 手机端（屏宽百分比）：≥ 40 全称、25 ~ 39 只留文字、< 25 只留图标 */
function mobileNavMode(widthVw: number): NavMode {
  if (widthVw >= NAV_COMPACT_VW) return 'full';
  if (widthVw >= NAV_NO_TEXT_VW) return 'text';
  return 'icon';
}

/**
 * 侧栏的自适应形态。
 *
 * 手机与电脑各按自己的宽度判定（手机是屏宽百分比、电脑是像素），
 * 同一个值在两端可能一个算窄、一个不算，所以每个结论都要给两份 display 类：
 * 不带前缀的那份管手机，md: 那份管电脑。下面几个 class 直接给 JSX 用。
 */
function useSidebarShape() {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const pc = pcNavMode(appearance.sidebarWidthPc);
  const mobile = mobileNavMode(appearance.sidebarWidthMobile);
  /** 只有文字、或只有图标时，那一个元素要居中摆——否则空出另一格，整排看着偏左 */
  const lone = (m: NavMode) => m === 'text' || m === 'icon';
  return {
    /** 退出登录的居中要用（它的对齐写在 CSS 里，走不了 Tailwind 工具类） */
    mobileCenter: lone(mobile),
    pcCenter: lone(pc),
    /** 全称：只在 full 档出现 */
    fullClass: cn(mobile === 'full' ? 'inline' : 'hidden', pc === 'full' ? 'md:inline' : 'md:hidden'),
    /** 两字短名：short 档（带图标）与 text 档（不带图标）都用它 */
    shortClass: cn(
      mobile === 'short' || mobile === 'text' ? 'inline' : 'hidden',
      pc === 'short' || pc === 'text' ? 'md:inline' : 'md:hidden',
    ),
    /**
     * 导航项 / 退出登录的图标：只有 text 档收掉（icon 档正是要留它）。
     */
    iconClass: cn('h-4 w-4 shrink-0', mobile === 'text' ? 'hidden' : 'block', pc === 'text' ? 'md:hidden' : 'md:block'),
    /**
     * 文字外层：icon 档整块 display:none。
     * 只把里面的两个 span 设成 hidden 不够——父 span 仍是 flex 子项，
     * 宽度为 0 却照样吃掉那 10px 的 gap，居中时图标会被顶偏 5px。
     */
    textWrapClass: cn(mobile === 'icon' ? 'hidden' : 'block', pc === 'icon' ? 'md:hidden' : 'md:block'),
    /** 只剩文字 / 只剩图标时居中；两端各判一次，与 iconClass 严格同步 */
    centerClass: cn(
      lone(mobile) ? 'justify-center' : 'justify-start',
      lone(pc) ? 'md:justify-center' : 'md:justify-start',
    ),
    /**
     * 底部两个纯图标按钮（导航编辑 / GitHub）的尺寸。
     * 收窄档收成 28px、icon 档再收到 24px：32 + 4 + 32 加上左右内边距会超出栏宽，
     * 右边那枚会被 aside 的 overflow-hidden 切掉一角；而 50px 的下限里
     * 并排两枚 28px 也一样放不下，所以那一档改为换行（见 iconRowClass）。
     */
    iconBtnClass: cn(
      mobile === 'icon' ? 'h-6 w-6' : lone(mobile) ? 'h-7 w-7' : 'h-8 w-8',
      pc === 'icon' ? 'md:h-6 md:w-6' : lone(pc) ? 'md:h-7 md:w-7' : 'md:h-8 md:w-8',
    ),
    /**
     * 放那两个纯图标按钮的行：icon 档（< 80px / < 25%）改成可换行 + 居中。
     * 栏宽压到 50px 时一排塞不下两枚，nowrap 会把右边那枚挤出 aside 的
     * overflow-hidden；换行后各占一行，居中摆着不显歪。
     */
    iconRowClass: cn(
      mobile === 'icon' ? 'flex-wrap justify-center' : 'flex-nowrap justify-between',
      pc === 'icon' ? 'md:flex-wrap md:justify-center' : 'md:flex-nowrap md:justify-between',
    ),
  };
}

/** 顶栏标题：按当前路由推导界面名，页面可用 usePageHeader({ title }) 覆盖 */
function titleFromPath(pathname: string, t: (key: string) => string): string {
  const hit = NAV.find((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return hit?.navKey ? t(hit.navKey) : '';
}

/** 在给定列表里找当前路由落在第几项；传 list 是因为顺序可被用户改过 */
function activeNavIndex(pathname: string, list: readonly { href: string }[] = NAV) {
  const i = list.findIndex((item) => (
    item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
  ));
  return i < 0 ? 0 : i;
}

/**
 * 侧栏导航。手机与电脑共用一份，不需要在点击时手动收起——
 * ConsoleShellInner 监听了 pathname，切界面会自动把侧栏收起来。
 *
 * 除了点击，还支持「长按整条侧栏上下拖」：按住不动约 0.33s，液态指示条被拎起来
 * 跟着指针滑，松手落在哪一项就切过去（手势细节见 use-liquid-nav-drag）。
 * 编辑模式下这个手势要让给排序拖拽，否则两个手势抢同一次按下。
 *
 * 编辑模式（点侧栏底部的铅笔进）：
 * - 每一项都按当前顺序排出来，隐藏的也留着（这样才有机会把它恢复回来）
 * - 右侧给一个叉号：点了该项变淡，退出编辑后不再显示；叉号随即变成恢复按钮
 * - 整条可拖着换位置；低配档只在落点画一条线，完整档实时重排 + FLIP 让位
 */
/**
 * 逐项 stagger 用的两个序号，写成行内 CSS 变量交给样式表算延迟。
 * --kk-i 是自己在列表里的位置，--kk-n 是总数——退出时按 (n - i) 反着排，
 * 收起来像从最后一项往回卷，而不是整排一起淡掉。
 */
function staggerVars(index: number, total: number): CSSProperties {
  return { '--kk-i': index, '--kk-n': total } as CSSProperties;
}

function SidebarNav({
  layout,
  editMode,
  onToggleHide,
  onReorder,
}: {
  layout: NavLayout;
  editMode: boolean;
  onToggleHide: (href: string) => void;
  onReorder: (order: string[]) => void;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const tier = useSyncExternalStore(subscribeDeviceTier, getDeviceTier, getDeviceTier);
  // 侧栏窄栏形态：短名 / 收图标，手机与电脑各按自己的阈值判定（见 useSidebarShape）
  const {
    fullClass: navFullClass,
    shortClass: navShortClass,
    iconClass: navIconClass,
    centerClass: navCenterClass,
    textWrapClass: navTextWrapClass,
  } = useSidebarShape();
  // 完整特效档才启用水的形态（gooey 融合 / 重力水滴 / 引力斜倾）；低配档回落到纯玻璃块
  const fullEffects = tier === 'normal';

  /*
   * 编辑模式的进出场。
   *
   * renderEdit 比 editMode 晚一拍变 false：退出动画要先把「隐藏项 + 叉号」收走，
   * 才能换成普通列表，否则两批 DOM 是硬切——就是那个「一闪而过」。
   * 三个阶段：in（进入）→ idle（停稳）→ out（退出）→ settle（普通列表落位）→ idle。
   * 低配档不排队：phase 立刻回 idle，CSS 也用 html:not(.kk-lowtier) 挡掉了动画，
   * 表现与从前一致（直接切换）。
   */
  /*
   * 三个时长必须 ≥「最后一项的 delay + 它自己的动画时长」，否则 class 会被提前摘掉，
   * 还在等待起始帧（backwards 填充成透明）的那几项会突然整排闪出来。
   * 算式：delay = 序号 × 18ms（最多 9 × 18 = 162ms），最长动画 0.42s。
   */
  const EDIT_IN_MS = 640;
  const EDIT_OUT_MS = 320;
  const EDIT_SETTLE_MS = 480;
  const [renderEdit, setRenderEdit] = useState(editMode);
  const [editPhase, setEditPhase] = useState<'in' | 'out' | 'settle' | 'idle'>(editMode ? 'in' : 'idle');
  const firstPhaseRun = useRef(true);
  useEffect(() => {
    // 首帧别跑「退出」：刚挂载时本来就是普通态，没必要先播一段收起
    if (firstPhaseRun.current) {
      firstPhaseRun.current = false;
      if (!editMode) return;
    }
    if (!fullEffects) {
      setRenderEdit(editMode);
      setEditPhase('idle');
      return;
    }
    if (editMode) {
      setRenderEdit(true);
      setEditPhase('in');
      const id = window.setTimeout(() => setEditPhase('idle'), EDIT_IN_MS);
      return () => window.clearTimeout(id);
    }
    setEditPhase('out');
    const id = window.setTimeout(() => {
      setRenderEdit(false);
      setEditPhase('settle');
    }, EDIT_OUT_MS);
    return () => window.clearTimeout(id);
  }, [editMode, fullEffects]);

  // 普通列表落位播完就收：留着 class 会让下一次 hover 的过渡被动画覆盖
  useEffect(() => {
    if (editPhase !== 'settle') return;
    const id = window.setTimeout(() => setEditPhase('idle'), EDIT_SETTLE_MS);
    return () => window.clearTimeout(id);
  }, [editPhase]);

  // 编辑模式要把隐藏项也列出来，否则它们永远没法被恢复
  const hiddenSet = new Set(layout.hidden);
  const visible = applyNavLayout(NAV, layout);
  const orderedAll = orderNavBy(NAV, layout.order);
  const list = renderEdit ? orderedAll : visible;

  const active = activeNavIndex(pathname, list);
  const { navRef, setItemRef, box } = useLiquidIndicator(active, list.length);
  const liquidRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const dripRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<HTMLSpanElement>(null);
  /**
   * 停止态位置的镜像：拖动手势结束后要按它把内联样式写回去。
   * React 只在属性值变化时才写 DOM，直接清空内联样式会让指示条失去
   * 定位与尺寸（表现为「拖动切换后玻璃不见了」），所以手势那边必须知道当前值。
   */
  const restBoxRef = useRef(box);
  restBoxRef.current = box;
  const { dragging, hoverIndex, fx, bindItem } = useLiquidNavDrag({
    navRef,
    liquidRef,
    tailRef,
    dripRef,
    flowRef,
    restBoxRef,
    itemCount: list.length,
    fullEffects,
    enabled: !renderEdit,
    onCommit: (index) => {
      markManualNav();
      navigate(list[index]!.href);
    },
  });
  const { dragHref, dropIndex, bindItem: bindReorder, startDrag } = useNavReorder({
    enabled: renderEdit,
    items: renderEdit ? list.map((i) => i.href) : [],
    fullEffects,
    onReorder,
  });

  return (
    <nav
      ref={navRef as RefObject<HTMLElement>}
      className={cn(
        'kk-nav relative px-3 py-2',
        dragging && 'kk-nav--dragging',
        // 编辑时不再选中文字：拖排序会把文字一起刷蓝
        renderEdit ? 'select-none' : undefined,
        // 进出场：完整档靠这两个 class 驱动逐项 stagger，低配档 CSS 里被挡掉
        editPhase === 'in' && 'kk-nav--edit-in',
        editPhase === 'out' && 'kk-nav--edit-out',
        editPhase === 'settle' && 'kk-nav--settle',
      )}
    >
      {/* 水的滤镜层：液体 / 拖尾 / 水滴 / 水花都在这层，拖动态经 gooey 滤镜融合成一坨水 */}
      {/*
        编辑期间不再卸载它，而是整层淡出：硬摘掉的话液态指示条会「啪」地消失，
        退出时又要从零重新量位置、先闪一下才归位。留着它、只把 opacity 收掉，
        退出时原位淡入即可。
      */}
      <div
        className={cn('kk-nav-water', renderEdit && 'kk-nav-water--away')}
        aria-hidden="true"
      >
        {/* 水花 / 湿痕：拖动时留在地上、会慢慢「干」掉的痕迹 */}
        {fx.map((f) => (
          <span
            key={f.id}
            aria-hidden
            className={f.kind === 'wet' ? 'kk-nav-wet' : 'kk-nav-ripple'}
            // dir 让痕迹朝行进方向偏一点，读起来像被带着甩出去
            style={{ top: f.y + f.dir * 7 }}
          />
        ))}
        {/* 拖尾水影：跟得比液体慢半拍，拖动时才有存在感 */}
        <div
          ref={tailRef}
          aria-hidden
          className={cn('kk-nav-liquid-tail', dragging && 'kk-nav-liquid-tail--on')}
        />
        {/* 重力水滴：受重力下坠、被弹簧拽回，经 gooey 与液体融成一颗将滴未滴的水珠 */}
        <div ref={dripRef} aria-hidden className="kk-nav-drip" />
        <div
          ref={liquidRef}
          aria-hidden
          className={cn(
            'kk-nav-liquid',
            box.ready && 'kk-nav-liquid-ready',
            dragging && 'kk-nav-liquid--drag',
          )}
          style={{
            transform: `translate3d(${box.left}px, ${box.top}px, 0)`,
            width: box.width,
            height: box.height,
          }}
        >
          {/* 条内的流动纹理：完整特效下常驻涌动，拖动时按速度滚动 */}
          <span ref={flowRef} className="kk-nav-liquid-flow" />
        </div>
      </div>
      {/* 文本层：单独拎出，不参与 gooey 滤镜，文字保持清晰 */}
      <div className="kk-nav-items">
        {renderEdit ? (
          <div className="kk-nav-edit-hint px-1 pb-1.5 text-[11px] leading-tight text-muted-foreground">
            {t('navEdit.hint')}
          </div>
        ) : null}
        {list.map((item, index) => {
          const isActive = !renderEdit && index === active;
          const Icon = item.icon;
          const hidden = hiddenSet.has(item.href);
          const hidable = isNavHidable(item.href);
          const label = (
            /*
              两份文案按端分别判定：手机看屏宽百分比、电脑看像素，各自的阈值不同，
              所以全称 / 短名是「哪一端窄了就只在那一端切」——手机抽屉很窄（< 40%）
              但电脑侧栏很宽时，手机上显示短名、电脑上仍是全称，反过来也一样。
              truncate 兜底：再窄下去（压到下限）短名也放不下时走省略号，
              而不是把药丸撑破、把图标挤出栏外。
              隐藏态只把名字压淡——图标与右侧按钮保持清楚，否则恢复按钮也跟着看不见了。
            */
            <span className={cn('min-w-0 truncate', navTextWrapClass, hidden && 'opacity-40')}>
              <span className={navFullClass}>{t(item.navKey)}</span>
              <span className={navShortClass}>{t(item.shortKey)}</span>
            </span>
          );

          if (renderEdit) {
            return (
              <div
                key={item.href}
                ref={(el) => {
                  bindReorder(item.href, el);
                }}
                data-nav-index={index}
                onPointerDown={(e) => startDrag(item.href, e)}
                title={hidden ? t('navEdit.hiddenNote') : t('navEdit.drag')}
                className={cn(
                  'kk-nav-item relative w-full cursor-grab touch-none',
                  'kk-nav-item-idle',
                  // 被拖起来的那枚：抬升 + 描边，读起来像被拎出列表
                  dragHref === item.href && 'z-30 shadow-lg shadow-black/10 ring-1 ring-sky-400/40',
                  // 被隐藏的项是「新长出来的」：进入时从压扁状态展开，而不是凭空出现
                  hidden && 'kk-nav-item--unfold',
                )}
                style={{ touchAction: 'none', ...staggerVars(index, list.length) }}
              >
                {/* 低配档的落点提示：就在目标位置上方画一条线 */}
                {dropIndex === index ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -top-px left-1 right-1 h-0.5 rounded-full bg-sky-500/80"
                  />
                ) : null}
                <Icon className={navIconClass} />
                {label}
                {/* 操作区：可隐藏的给叉号 / 恢复，不可隐藏的给一把小锁说明原因 */}
                <span className="kk-nav-tools ml-auto flex shrink-0 items-center">
                  {hidable ? (
                    <button
                      type="button"
                      // 按下不能冒泡给条目，否则一次点击会被当成拖拽起点
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleHide(item.href);
                      }}
                      title={hidden ? t('navEdit.restore') : t('navEdit.hide')}
                      aria-label={hidden ? t('navEdit.restore') : t('navEdit.hide')}
                      className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md transition-colors',
                        'hover:bg-white/45',
                        hidden ? 'text-sky-600' : 'text-muted-foreground hover:text-rose-600',
                      )}
                    >
                      {hidden ? <RotateCcw className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
                    </button>
                  ) : (
                    <span
                      title={t('navEdit.locked')}
                      aria-label={t('navEdit.locked')}
                      className="inline-flex h-6 w-6 items-center justify-center text-muted-foreground/50"
                    >
                      <Lock className="h-3 w-3" />
                    </span>
                  )}
                </span>
              </div>
            );
          }

          return (
            <QuietNav
              key={item.href}
              ref={(el) => {
                setItemRef(index, el);
                bindItem(index, el);
              }}
              to={item.href}
              data-tour={NAV_TOUR_ID[item.href]}
              data-nav-index={index}
              aria-current={isActive ? 'page' : undefined}
              onClick={markManualNav}
              className={cn(
                'kk-nav-item relative w-full',
                isActive ? 'kk-nav-item-active' : 'kk-nav-item-idle',
                dragging && hoverIndex === index && 'kk-nav-item--drop',
                // 图标被收掉时把文字居中（编辑态不参与：那一行右侧还有叉号 / 小锁占位）
                navCenterClass,
              )}
              style={staggerVars(index, list.length)}
            >
              <Icon className={navIconClass} />
              {label}
            </QuietNav>
          );
        })}
        {/* 拖到最后一项之下的落点线 */}
        {renderEdit && dropIndex === list.length ? (
          <span
            aria-hidden
            className="pointer-events-none relative -mt-1 block h-0.5 rounded-full bg-sky-500/80"
          />
        ) : null}
      </div>
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
  const t = useT();
  return (
    <a
      href={REPO_URL}
      target="_blank"
      rel="noreferrer"
      title={t('components.githubRepo')}
      aria-label={t('components.githubRepo')}
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

/**
 * 品牌字：优先用自定义标题名；没改过（默认）时跟随语言——
 * 中文「咔咔珂」、英文「Kakake」，而不是英文界面里还顶着一个中文名。
 */
function useBrandTitle(): string {
  const appearance = useSyncExternalStore(subscribeAppearance, getAppearanceSnapshot, getAppearanceSnapshot);
  const t = useT();
  return appearance.customTitle?.trim() || t('brand.kakake');
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

/** 响应式的桌面断点判断（跨断点时重渲染，供顶栏标题策略使用） */
function useIsDesktopViewport(): boolean {
  const [isDesktop, setIsDesktop] = useState(isDesktopViewport);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia(DESKTOP_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
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
 * 「排在第一位的就是首页」这次改道是否已经应用过（同一次页面加载只跑一次）。
 */
let navHomeApplied = false;

/**
 * 本次会话里用户是否**自己点过**侧栏导航。
 *
 * 存 sessionStorage（不是模块级变量）是关键：模块级变量刷新即失效，
 * 于是「手动点回系统总览 → 刷新」又会被弹到自定义首页——这就是那个 bug。
 * 放在 sessionStorage 里，刷新还在、关掉标签页才失效，正好是想要的粒度：
 * 会话内尊重用户最后一次的手动选择，下次重新进来才回到自定义首页。
 */
const NAV_MANUAL_KEY = 'kk.nav.manual';

/** 用户点了一次导航：记下来，本次会话内不再替他改道 */
function markManualNav(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(NAV_MANUAL_KEY, '1');
  } catch {
    /* 隐私模式写不进就算了，退化为「每次加载都改道」 */
  }
}

function hasManualNav(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return sessionStorage.getItem(NAV_MANUAL_KEY) === '1';
  } catch {
    return false;
  }
}

/** 改完首页后清掉：让新首页在下一次加载时生效，而不是被上次的手动记录一直压着 */
function clearManualNav(): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.removeItem(NAV_MANUAL_KEY);
  } catch {
    /* 同上 */
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
  const t = useT();
  // 侧栏窄栏形态（两字短名 / 收掉图标）：底部这一行的按钮与导航项共用同一套判定
  const {
    fullClass: navFullClass,
    shortClass: navShortClass,
    iconClass: navIconClass,
    centerClass: navCenterClass,
    textWrapClass: navTextWrapClass,
    iconBtnClass,
    iconRowClass,
    mobileCenter,
    pcCenter,
  } = useSidebarShape();
  /**
   * 侧栏开合。初始值见 initialSidebarOpen()：电脑端还原上次状态（刷新不关）、
   * 手机端收起。展开后只由用户自己关（电脑点顶栏按钮，手机点侧栏外的空白或按 Esc）。
   */
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const pageTitle = usePageHeaderTitle() || titleFromPath(pathname, t);
  const isDesktop = useIsDesktopViewport();
  /**
   * 顶栏是否还要显示品牌字。
   *
   * 电脑端侧栏展开时，品牌字已经明明白白挂在侧栏左上角，顶栏再重复一遍就是
   * 「咔咔珂 · 资源商店」这种同一屏出现两次品牌的情形；此时只留页面标题即可。
   * 侧栏收起后它被推到屏幕外，顶栏就得把品牌字补回来，否则用户看不到自己开的是哪个实例。
   * 手机端的侧栏是覆盖式抽屉、平时本来就不可见，所以不参与这套判断——照旧显示。
   */
  const showBrandInHeader = !(isDesktop && sidebarOpen);

  /* ─────────── 侧栏导航自定义（顺序 + 隐藏，存后端 data/nav-layout.json） ─────────── */
  const navLayout = useSyncExternalStore(subscribeNavLayout, getNavLayoutSnapshot, getNavLayoutSnapshot);
  /** 编辑中的草稿：改动先落在它身上，点「完成」才落库，中途放弃也不影响线上显示 */
  const [navEdit, setNavEdit] = useState(false);
  const [navDraft, setNavDraft] = useState<NavLayout>(navLayout);
  const [navSaving, setNavSaving] = useState(false);

  // 进来拉一次；此后 store 里一直有值
  useEffect(() => {
    void loadNavLayout();
  }, []);

  /*
   * 语言是实例级设置：别人在设置里切了，服务端经 /api/events 广播过来，
   * 这一页跟着切——否则同一个实例里各人各看一门语言，重启前都对不上。
   */
  useEventSource((msg) => {
    if (msg.type !== 'language') return;
    const lang = (msg.data as { lang?: unknown } | null)?.lang;
    if (lang === 'zh' || lang === 'en') setLanguageLocal(lang);
  });

  /**
   * 排在第一位的就是首页。
   *
   * 只在「落在根路径」时改道：用户主动点了别的界面就不该被弹走，
   * 而登录后 / 直接敲域名进来都停在 /，正好是改道的时机。
   *
   * 但如果用户是**自己点回**总览的（或点回后刷新的），这次就别改道了——
   * 他刚刚用点击表达过「我要看总览」，刷新不该把这个选择推翻。
   * 判断依据见 NAV_MANUAL_KEY：会话内点过导航就一律尊重手动选择。
   */
  useEffect(() => {
    if (navHomeApplied) return;
    if (!isNavLayoutLoaded()) return;
    navHomeApplied = true;
    if (hasManualNav()) return;
    const first = applyNavLayout(NAV, getNavLayoutSnapshot())[0]?.href;
    if (!first || first === '/' || pathname !== '/') return;
    navigate(first, { replace: true });
  }, [navLayout, pathname, navigate]);

  /** 进入编辑：以当前布局为草稿起点 */
  const enterNavEdit = () => {
    setNavDraft(getNavLayoutSnapshot());
    setNavEdit(true);
  };

  /** 隐藏 / 恢复：只有白名单内的四项会走到这里（其余连叉号都没有） */
  const toggleNavHide = (href: string) => {
    setNavDraft((d) => {
      const hidden = d.hidden.includes(href)
        ? d.hidden.filter((h) => h !== href)
        : [...d.hidden, href];
      return { ...d, hidden };
    });
  };

  /** 完成编辑：落库成功才退出，失败就留在编辑态让人重试 */
  const finishNavEdit = async () => {
    setNavSaving(true);
    const saved = await saveNavLayout(navDraft);
    setNavSaving(false);
    if (!saved) {
      toast.error(t('navEdit.saveFailed'));
      return;
    }
    // 顺序可能刚改过：清掉「用户手动点过」的记录，让新的第一位在下一次加载时生效
    clearManualNav();
    setNavEdit(false);
  };

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
      {/* 侧边栏「液态玻璃」形变滤镜：feTurbulence 生成缓慢流动的分形噪声，
          经 feDisplacementMap 揉动玻璃**内部的折射光斑**（只挂在 .kk-nav-liquid-flow 上）。
          不要把整条玻璃一起位移——那会把 1px 描边和 inset 高光撕成高低不一的碎线。
          <animate> 让 baseFrequency 循环变化，光斑得以「一直在涌」 */}
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
        <defs>
          <filter
            id="kk-nav-glass"
            x="-40%"
            y="-40%"
            width="180%"
            height="180%"
            colorInterpolationFilters="sRGB"
          >
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.018 0.022"
              numOctaves="2"
              seed="5"
              result="noise"
            >
              <animate
                attributeName="baseFrequency"
                dur="13s"
                values="0.018 0.022;0.023 0.028;0.018 0.022"
                repeatCount="indefinite"
              />
            </feTurbulence>
            <feDisplacementMap
              in="SourceGraphic"
              in2="noise"
              scale="6"
              xChannelSelector="R"
              yChannelSelector="G"
              result="warped"
            />
            {/* 位移之后再柔化一次：光斑永远是软的，不会被噪声揉出硬边 */}
            <feGaussianBlur in="warped" stdDeviation="1.2" />
          </filter>
        </defs>
      </svg>
      <div className="kk-ambient flex h-dvh max-h-dvh overflow-hidden">
        <AmbientVideo />
        <BackgroundPresetLayer />

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
            'fixed inset-0 z-40 bg-black/25 transition-opacity duration-300 motion-reduce:transition-none md:hidden',
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
              <SidebarNav
                layout={navEdit ? navDraft : navLayout}
                editMode={navEdit}
                onToggleHide={toggleNavHide}
                onReorder={(order) => setNavDraft((d) => ({ ...d, order }))}
              />
            </div>
            <div className="mx-3 my-1 h-px shrink-0 bg-gradient-to-r from-transparent via-white/40 to-transparent" />
            <div className="shrink-0 p-2 pt-1.5">
              {/* 导航编辑与 GitHub 同一行：编辑在左、仓库在右；最窄档换行堆叠（见 iconRowClass） */}
              <div className={cn('mb-1.5 flex items-center gap-1', iconRowClass)}>
                <button
                  type="button"
                  data-tour="nav-edit"
                  onClick={() => (navEdit ? void finishNavEdit() : enterNavEdit())}
                  disabled={navSaving}
                  title={navEdit ? t('navEdit.done') : t('navEdit.enter')}
                  aria-label={navEdit ? t('navEdit.done') : t('navEdit.enter')}
                  className={cn(
                    // 只留图标：侧栏底部这一行是「编辑 + GitHub」两个同尺寸的图标按钮，
                    // 多出「编辑导航」四个字会让左边这枚明显更宽、整行看着偏重
                    'inline-flex items-center justify-center rounded-lg transition-colors',
                    'hover:bg-white/35',
                    // 极窄档收成 28px：32 + 4 + 32 加上左右内边距会超出下限宽度，
                    // 右边那枚会被 aside 的 overflow-hidden 切掉一角。
                    // 手机（< 20%）与电脑（< 105px）各判一次，尺寸类同样分两份。
                    iconBtnClass,
                    navEdit
                      ? 'bg-white/45 text-slate-800'
                      : 'text-muted-foreground hover:text-slate-800',
                    navSaving && 'opacity-60',
                  )}
                >
                  {/*
                    铅笔 ↔ 对勾：换个 key 强制重新挂载，让新图标自己转进来，
                    否则两个图标是直接替换、没有交代。
                  */}
                  <span key={navEdit ? 'done' : 'edit'} className="kk-nav-edit-icon inline-flex">
                    {navEdit ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
                  </span>
                </button>
                <GitHubRepoLink className={iconBtnClass} />
              </div>
              {/*
                退出登录从顶栏移到侧栏：顶栏只留标题与当前界面的操作。
                窄栏下跟着导航项一起降级——否则「退出登录」四个字会把这一行撑破，
                而四字全称 + 16px 图标在窄栏里根本放不下。两端各按自己的阈值判定：
                - 电脑 < 140px → 两字短名（退出 / Exit）；< 105px → 收掉图标只留文字；
                  < 80px → 文字也放不下，只留图标
                - 手机 < 40%   → 两字短名；< 25% → 只留文字（收图标）；< 20% → 只留图标
              */}
              <Button
                variant="ghost"
                size="sm"
                // 图标被收掉时文字居中：这里的对齐写在 .kk-sidebar-logout 里，
                // 用不上 Tailwind 的 justify 工具类，得走专门的两条覆盖规则
                className={cn(
                  'kk-sidebar-logout',
                  mobileCenter && 'kk-sidebar-logout--center',
                  pcCenter && 'kk-sidebar-logout--center-md',
                )}
                onClick={logout}
                title={t('components.logout')}
              >
                <LogOut className={navIconClass} />
                <span className={cn('min-w-0 truncate', navTextWrapClass)}>
                  <span className={navFullClass}>{t('components.logout')}</span>
                  <span className={navShortClass}>{t('components.logoutShort')}</span>
                </span>
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
              title={sidebarOpen ? t('components.sidebarCollapse') : t('components.sidebarExpand')}
              aria-label={sidebarOpen ? t('components.sidebarCollapse') : t('components.sidebarExpand')}
              aria-expanded={sidebarOpen}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              {sidebarOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
            </Button>
            <PageHeaderLeadingSlot />
            <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
              {/* 与侧栏品牌字共用导览锚点：导览只会高亮当前可见的那个 */}
              {showBrandInHeader ? (
                <span data-tour="brand-title" className="kk-logo-text truncate font-semibold tracking-tight">{brandTitle}</span>
              ) : null}
              {pageTitle ? (
                <>
                  {showBrandInHeader ? (
                    <span aria-hidden className="shrink-0 text-slate-400">·</span>
                  ) : null}
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
