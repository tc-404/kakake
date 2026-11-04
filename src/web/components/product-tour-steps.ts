/**
 * 产品导览的步骤定义表（纯数据 + enter/skipIf 回调）。
 */
import { getNavLayoutSnapshot } from '@/lib/nav-layout';
import {
  closeAiProfile,
  closeColorDialog,
  closeConnAdd,
  closeConnDialog,
  closeOpDetail,
  closeSimConfig,
  closeStoreDetail,
  closeUpdateCenter,
  clearStoreCategory,
  hasAiSessions,
  hasConnCards,
  hasOpCards,
  hasPluginCards,
  hasStoreCards,
  openAiProfile,
  openAiProfileEdit,
  openAiSession,
  openColorDialog,
  openConnDialog,
  openConnForm,
  openConnTypeModal,
  openOpDetail,
  openSimConfig,
  openStoreCategoryMenu,
  openStoreDetail,
  openUpdateCenter,
  pickStoreCategory,
} from './product-tour-dom';

export type Callout = { tone: 'warn' | 'tip'; text: string };

export type TourStep = {
  id: string;
  /** 进入该步骤前先跳转到此路由（已在该路由则不跳） */
  route?: string;
  /** 高亮目标的 CSS 选择器；省略或找不到则居中浮层展示 */
  target?: string;
  /** 强制居中浮层（不高亮） */
  center?: boolean;
  title: string;
  /** 正文，支持 **文字** 高亮 */
  body: string[];
  /** 醒目提示框 */
  callout?: Callout;
  /** 返回 true 时跳过该步骤（按当前页面实时判断） */
  skipIf?: () => boolean;
  /** 进入该步骤时的副作用（如打开/关闭连接管理弹窗），需幂等 */
  enter?: () => void;
  /**
   * 该步骤需要侧边栏处于什么状态。
   * 侧栏默认收起，而导航项 / 版本号徽标都在侧栏里——不展开就会高亮到被裁掉的位置。
   * 省略 = 收起（手机端侧栏是带遮罩的抽屉，展开会盖住内容区与顶栏）。
   */
  sidebar?: 'open' | 'close';
  /** 高亮描边的内边距（px） */
  padding?: number;
  /**
   * 高亮框的高度上限（px）。
   * 用于「容器铺满剩余空间、但内容只有一点点」的目标——比如日志区是 flex-1，
   * 高亮框会跟着撑到几百像素高、框住一大片空白。设了它，框就只从顶部往下量这么多。
   */
  maxHeight?: number;
};

/** 导航项被用户自己隐藏了：对应的导览步骤无从高亮，跳过（编号不变） */
const NAV_TOUR_HREF: Record<string, string> = {
  'nav-dashboard': '/',
  'nav-connections': '/connections',
  'nav-plugins': '/plugins',
  'nav-plugin-store': '/plugin-store',
  'nav-tools': '/tools',
  'nav-open-platform': '/open-platform',
  'nav-ai': '/ai',
  'nav-simulate': '/simulate',
  'nav-logs': '/logs',
  'nav-settings': '/settings',
};

function navEntryHidden(tourId: string): boolean {
  const href = NAV_TOUR_HREF[tourId];
  if (!href) return false;
  return getNavLayoutSnapshot().hidden.includes(href);
}

export const STEPS: TourStep[] = [
  {
    id: 'dashboard',
    route: '/',
    target: '[data-tour="nav-dashboard"]',
    sidebar: 'open',
    title: 'tour.dashboardTitle',
    body: [
      'tour.dashboardBody1',
      'tour.dashboardBody2',
      'tour.dashboardBody3',
    ],
  },
  {
    id: 'nav-toggle',
    route: '/',
    target: '[data-tour="nav-toggle"]',
    sidebar: 'open',
    title: 'tour.navToggleTitle',
    body: [
      'tour.navToggleBody1',
      'tour.navToggleBody2',
      'tour.navToggleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.navToggleCallout' },
  },
  {
    id: 'nav-edit',
    route: '/',
    target: '[data-tour="nav-edit"]',
    sidebar: 'open',
    padding: 6,
    title: 'tour.navEditTitle',
    body: [
      'tour.navEditBody1',
      'tour.navEditBody2',
      'tour.navEditBody3',
    ],
    callout: { tone: 'tip', text: 'tour.navEditCallout' },
  },
  {
    id: 'dashboard-stats',
    route: '/',
    target: '[data-tour="dashboard-stats"]',
    title: 'tour.dashboardStatsTitle',
    body: [
      'tour.dashboardStatsBody1',
      'tour.dashboardStatsBody2',
    ],
    callout: { tone: 'tip', text: 'tour.dashboardStatsCallout' },
  },
  {
    id: 'dash-stat-listen',
    route: '/',
    target: '[data-tour="dash-stat-listen"]',
    title: 'tour.dashStatListenTitle',
    body: [
      'tour.dashStatListenBody1',
      'tour.dashStatListenBody2',
    ],
  },
  {
    id: 'dash-stat-connected',
    route: '/',
    target: '[data-tour="dash-stat-connected"]',
    title: 'tour.dashStatConnectedTitle',
    body: [
      'tour.dashStatConnectedBody1',
      'tour.dashStatConnectedBody2',
    ],
  },
  {
    id: 'dash-stat-plugins',
    route: '/',
    target: '[data-tour="dash-stat-plugins"]',
    title: 'tour.dashStatPluginsTitle',
    body: [
      'tour.dashStatPluginsBody1',
      'tour.dashStatPluginsBody2',
    ],
  },
  {
    id: 'dash-stat-loaded',
    route: '/',
    target: '[data-tour="dash-stat-loaded"]',
    title: 'tour.dashStatLoadedTitle',
    body: [
      'tour.dashStatLoadedBody1',
      'tour.dashStatLoadedBody2',
    ],
  },
  {
    id: 'nav-connections',
    route: '/',
    target: '[data-tour="nav-connections"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-connections'),
    title: 'tour.navConnectionsTitle',
    body: [
      'tour.navConnectionsBody1',
      'tour.navConnectionsBody2',
    ],
  },
  {
    id: 'connections-add',
    route: '/connections',
    target: '[data-tour="connections-add"]',
    title: 'tour.connectionsAddTitle',
    body: [
      'tour.connectionsAddBody1',
      'tour.connectionsAddBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connectionsAddCallout' },
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'conn-type-modal',
    route: '/connections',
    target: '[data-tour="conn-type-list"]',
    title: 'tour.connTypeModalTitle',
    body: [
      'tour.connTypeModalBody1',
      'tour.connTypeModalBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connTypeModalCallout' },
    enter: openConnTypeModal,
  },
  {
    id: 'conn-form',
    route: '/connections',
    target: '[data-tour="conn-form"]',
    title: 'tour.connFormTitle',
    body: [
      'tour.connFormBody1',
      'tour.connFormBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-name',
    route: '/connections',
    target: '[data-tour="conn-form-name"]',
    title: 'tour.connFormNameTitle',
    body: [
      'tour.connFormNameBody1',
      'tour.connFormNameBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-host',
    route: '/connections',
    target: '[data-tour="conn-form-host"]',
    title: 'tour.connFormHostTitle',
    body: [
      'tour.connFormHostBody1',
      'tour.connFormHostBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-port',
    route: '/connections',
    target: '[data-tour="conn-form-port"]',
    title: 'tour.connFormPortTitle',
    body: [
      'tour.connFormPortBody1',
      'tour.connFormPortBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connFormPortCallout' },
    enter: openConnForm,
  },
  {
    id: 'conn-form-token',
    route: '/connections',
    target: '[data-tour="conn-form-token"]',
    title: 'tour.connFormTokenTitle',
    body: [
      'tour.connFormTokenBody1',
      'tour.connFormTokenBody2',
    ],
    enter: openConnForm,
  },
  {
    id: 'conn-form-submit',
    route: '/connections',
    target: '[data-tour="conn-form-submit"]',
    title: 'tour.connFormSubmitTitle',
    body: [
      'tour.connFormSubmitBody1',
      'tour.connFormSubmitBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connFormSubmitCallout' },
    enter: openConnForm,
  },
  {
    // 有连接时：讲点开卡片能干嘛
    id: 'connections-card',
    route: '/connections',
    target: '.kk-conn-card',
    title: 'tour.connectionsCardTitle',
    body: [
      'tour.connectionsCardBody1',
      'tour.connectionsCardBody2',
    ],
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'conn-dialog-enable',
    route: '/connections',
    target: '[data-tour="conn-dialog-enable"]',
    title: 'tour.connDialogEnableTitle',
    body: [
      'tour.connDialogEnableBody1',
      'tour.connDialogEnableBody2',
    ],
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'conn-dialog-plugins',
    route: '/connections',
    target: '[data-tour="conn-dialog-plugins"]',
    title: 'tour.connDialogPluginsTitle',
    body: [
      'tour.connDialogPluginsBody1',
      'tour.connDialogPluginsBody2',
    ],
    callout: { tone: 'warn', text: 'tour.connDialogPluginsCallout' },
    enter: openConnDialog,
    skipIf: () => !hasConnCards(),
  },
  {
    id: 'connections-export',
    route: '/connections',
    target: '[data-tour="connections-export"]',
    title: 'tour.connectionsExportTitle',
    body: [
      'tour.connectionsExportBody1',
      'tour.connectionsExportBody2',
    ],
    callout: { tone: 'tip', text: 'tour.connectionsExportCallout' },
    // 上一步把「连接管理」弹窗打开了，不先关掉就会高亮到弹窗背后的区域
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'connections-import',
    route: '/connections',
    target: '[data-tour="connections-import"]',
    title: 'tour.connectionsImportTitle',
    body: [
      'tour.connectionsImportBody1',
      'tour.connectionsImportBody2',
      'tour.connectionsImportBody3',
      'tour.connectionsImportBody4',
    ],
    callout: { tone: 'tip', text: 'tour.connectionsImportCallout' },
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'nav-plugins',
    route: '/connections',
    target: '[data-tour="nav-plugins"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-plugins'),
    title: 'tour.navPluginsTitle',
    body: [
      'tour.navPluginsBody1',
      'tour.navPluginsBody2',
    ],
    enter: () => {
      closeConnAdd();
      closeConnDialog();
    },
  },
  {
    id: 'plugins-stats',
    route: '/plugins',
    target: '[data-tour="plugins-stats"]',
    title: 'tour.pluginsStatsTitle',
    body: [
      'tour.pluginsStatsBody1',
      'tour.pluginsStatsBody2',
    ],
    callout: { tone: 'warn', text: 'tour.pluginsStatsCallout' },
  },
  {
    id: 'plugins-filter',
    route: '/plugins',
    target: '[data-tour="plugins-filter"]',
    title: 'tour.pluginsFilterTitle',
    body: [
      'tour.pluginsFilterBody1',
      'tour.pluginsFilterBody2',
      'tour.pluginsFilterBody3',
    ],
  },
  {
    id: 'plugins-toolbar',
    route: '/plugins',
    target: '[data-tour="plugins-toolbar"]',
    title: 'tour.pluginsToolbarTitle',
    body: [
      'tour.pluginsToolbarBody1',
      'tour.pluginsToolbarBody2',
      'tour.pluginsToolbarBody3',
    ],
  },
  {
    id: 'plugins-upload',
    route: '/plugins',
    target: '[data-tour="plugins-upload"]',
    title: 'tour.pluginsUploadTitle',
    body: [
      'tour.pluginsUploadBody1',
      'tour.pluginsUploadBody2',
    ],
  },
  {
    id: 'plugins-refresh',
    route: '/plugins',
    target: '[data-tour="plugins-refresh"]',
    title: 'tour.pluginsRefreshTitle',
    body: [
      'tour.pluginsRefreshBody1',
      'tour.pluginsRefreshBody2',
    ],
  },
  {
    id: 'plugins-card',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: 'tour.pluginsCardTitle',
    body: [
      'tour.pluginsCardBody1',
      'tour.pluginsCardBody2',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugin-master-switch',
    route: '/plugins',
    target: '[data-tour="plugin-master-switch"]',
    title: 'tour.pluginMasterSwitchTitle',
    body: [
      'tour.pluginMasterSwitchBody1',
      'tour.pluginMasterSwitchBody2',
    ],
    callout: { tone: 'warn', text: 'tour.pluginMasterSwitchCallout' },
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'plugins-card-actions',
    route: '/plugins',
    target: '.kk-plugin-card',
    title: 'tour.pluginsCardActionsTitle',
    body: [
      'tour.pluginsCardActionsBody1',
      'tour.pluginsCardActionsBody2',
    ],
    skipIf: () => !hasPluginCards(),
  },
  {
    id: 'nav-plugin-store',
    route: '/plugins',
    target: '[data-tour="nav-plugin-store"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-plugin-store'),
    title: 'tour.navPluginStoreTitle',
    body: [
      'tour.navPluginStoreBody1',
      'tour.navPluginStoreBody2',
    ],
  },
  {
    id: 'store-toolbar',
    route: '/plugin-store',
    target: '[data-tour="store-toolbar"]',
    title: 'tour.storeToolbarTitle',
    body: [
      'tour.storeToolbarBody1',
      'tour.storeToolbarBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-search',
    route: '/plugin-store',
    target: '[data-tour="store-search"]',
    title: 'tour.storeSearchTitle',
    body: [
      'tour.storeSearchBody1',
      'tour.storeSearchBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-origin',
    route: '/plugin-store',
    target: '[data-tour="store-origin"]',
    title: 'tour.storeOriginTitle',
    body: [
      'tour.storeOriginBody1',
      'tour.storeOriginBody2',
      'tour.storeOriginBody3',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-category',
    route: '/plugin-store',
    target: '[data-tour="store-category"]',
    title: 'tour.storeCategoryTitle',
    body: [
      'tour.storeCategoryBody1',
      'tour.storeCategoryBody2',
      'tour.storeCategoryBody3',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-category-menu',
    route: '/plugin-store',
    target: '[data-tour="store-category-menu"]',
    title: 'tour.storeCategoryMenuTitle',
    body: [
      'tour.storeCategoryMenuBody1',
      'tour.storeCategoryMenuBody2',
      'tour.storeCategoryMenuBody3',
      'tour.storeCategoryMenuBody4',
    ],
    callout: { tone: 'tip', text: 'tour.storeCategoryMenuCallout' },
    enter: () => {
      closeStoreDetail();
      openStoreCategoryMenu();
    },
    skipIf: () => !document.querySelector('[data-tour="store-category"]'),
  },
  {
    id: 'store-category-picked',
    route: '/plugin-store',
    target: '[data-tour="store-category"]',
    title: 'tour.storeCategoryPickedTitle',
    body: [
      'tour.storeCategoryPickedBody1',
      'tour.storeCategoryPickedBody2',
      'tour.storeCategoryPickedBody3',
    ],
    enter: () => {
      closeStoreDetail();
      pickStoreCategory('official');
    },
  },
  {
    id: 'store-grid',
    route: '/plugin-store',
    target: '[data-tour="store-grid"]',
    title: 'tour.storeGridTitle',
    body: [
      'tour.storeGridBody1',
      'tour.storeGridBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-card',
    route: '/plugin-store',
    target: '[data-tour="store-card"]',
    title: 'tour.storeCardTitle',
    body: [
      'tour.storeCardBody1',
      'tour.storeCardBody2',
    ],
    skipIf: () => !hasStoreCards(),
    /*
     * 也负责关详情弹窗：往回走（从「资源详情」那几步点上一步）时，
     * 必须有一个步骤把弹窗收掉，否则它就一直盖在卡片列表上，
     * 后面的步骤全都高亮不到——以前只有往前的路径上写了 closeStoreDetail，
     * 于是「上一步」永远关不掉它。
     */
    enter: closeStoreDetail,
  },
  {
    id: 'store-install',
    route: '/plugin-store',
    target: '[data-tour="store-install"]',
    title: 'tour.storeInstallTitle',
    body: [
      'tour.storeInstallBody1',
      'tour.storeInstallBody2',
      'tour.storeInstallBody3',
    ],
    callout: { tone: 'warn', text: 'tour.storeInstallCallout' },
    skipIf: () => !hasStoreCards(),
    // 同 store-card：这一步在详情弹窗之前，往回走时由它把弹窗收掉
    enter: closeStoreDetail,
  },
  {
    id: 'store-detail',
    route: '/plugin-store',
    target: '[data-tour="store-detail-head"]',
    title: 'tour.storeDetailTitle',
    body: [
      'tour.storeDetailBody1',
      'tour.storeDetailBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-intro',
    route: '/plugin-store',
    target: '[data-tour="store-detail-intro"]',
    title: 'tour.storeDetailIntroTitle',
    body: [
      'tour.storeDetailIntroBody1',
      'tour.storeDetailIntroBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-info',
    route: '/plugin-store',
    target: '[data-tour="store-detail"]',
    title: 'tour.storeDetailInfoTitle',
    body: [
      'tour.storeDetailInfoBody1',
      'tour.storeDetailInfoBody2',
    ],
    callout: { tone: 'warn', text: 'tour.storeDetailInfoCallout' },
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-detail-install',
    route: '/plugin-store',
    target: '[data-tour="store-detail-install"]',
    title: 'tour.storeDetailInstallTitle',
    body: [
      'tour.storeDetailInstallBody1',
      'tour.storeDetailInstallBody2',
    ],
    enter: openStoreDetail,
    skipIf: () => !hasStoreCards(),
  },
  {
    id: 'store-pagination',
    route: '/plugin-store',
    target: '[data-tour="store-pagination"]',
    title: 'tour.storePaginationTitle',
    body: [
      'tour.storePaginationBody1',
      'tour.storePaginationBody2',
    ],
    callout: { tone: 'tip', text: 'tour.storePaginationCallout' },
    skipIf: () => !document.querySelector('[data-tour="store-pagination"]'),
    enter: closeStoreDetail,
  },
  {
    id: 'store-sort',
    route: '/plugin-store',
    target: '[data-tour="store-sort"]',
    title: 'tour.storeSortTitle',
    body: [
      'tour.storeSortBody1',
      'tour.storeSortBody2',
      'tour.storeSortBody3',
    ],
    callout: { tone: 'tip', text: 'tour.storeSortCallout' },
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'store-refresh',
    route: '/plugin-store',
    target: '[data-tour="store-refresh"]',
    title: 'tour.storeRefreshTitle',
    body: [
      'tour.storeRefreshBody1',
      'tour.storeRefreshBody2',
    ],
    callout: { tone: 'tip', text: 'tour.storeRefreshCallout' },
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'nav-tools',
    route: '/plugin-store',
    target: '[data-tour="nav-tools"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-tools'),
    title: 'tour.navToolsTitle',
    body: [
      'tour.navToolsBody1',
      'tour.navToolsBody2',
    ],
    enter: () => {
      closeStoreDetail();
      clearStoreCategory();
    },
  },
  {
    id: 'tools',
    route: '/tools',
    target: '[data-tour="tools-grid"]',
    title: 'tour.toolsTitle',
    body: [
      'tour.toolsBody1',
      'tour.toolsBody2',
    ],
  },
  {
    id: 'tool-encode',
    route: '/tools',
    target: '[data-tour="tool-encode"]',
    title: 'tour.toolEncodeTitle',
    body: [
      'tour.toolEncodeBody1',
      'tour.toolEncodeBody2',
    ],
  },
  {
    id: 'tool-media',
    route: '/tools',
    target: '[data-tour="tool-media"]',
    title: 'tour.toolMediaTitle',
    body: [
      'tour.toolMediaBody1',
      'tour.toolMediaBody2',
    ],
  },
  {
    id: 'tool-plugin-dev',
    route: '/tools',
    target: '[data-tour="tool-plugin-dev"]',
    title: 'tour.toolPluginDevTitle',
    body: [
      'tour.toolPluginDevBody1',
      'tour.toolPluginDevBody2',
    ],
  },
  {
    id: 'tool-image-obf',
    route: '/tools',
    target: '[data-tour="tool-image-obf"]',
    title: 'tour.toolImageObfTitle',
    body: [
      'tour.toolImageObfBody1',
      'tour.toolImageObfBody2',
    ],
    callout: { tone: 'warn', text: 'tour.toolImageObfCallout' },
  },
  {
    id: 'tool-image-edit',
    route: '/tools',
    target: '[data-tour="tool-image-edit"]',
    title: 'tour.toolImageEditTitle',
    body: [
      'tour.toolImageEditBody1',
      'tour.toolImageEditBody2',
    ],
  },
  {
    id: 'nav-open-platform',
    route: '/tools',
    target: '[data-tour="nav-open-platform"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-open-platform'),
    title: 'tour.navOpenPlatformTitle',
    body: [
      'tour.navOpenPlatformBody1',
      'tour.navOpenPlatformBody2',
      'tour.navOpenPlatformBody3',
    ],
  },
  {
    id: 'op-login',
    route: '/open-platform',
    target: '[data-tour="op-login"]',
    title: 'tour.opLoginTitle',
    body: [
      'tour.opLoginBody1',
      'tour.opLoginBody2',
      'tour.opLoginBody3',
      'tour.opLoginBody4',
    ],
    callout: { tone: 'warn', text: 'tour.opLoginCallout' },
  },
  {
    id: 'op-stats',
    route: '/open-platform',
    target: '[data-tour="op-stats"]',
    title: 'tour.opStatsTitle',
    body: [
      'tour.opStatsBody1',
      'tour.opStatsBody2',
    ],
  },
  {
    id: 'op-add',
    route: '/open-platform',
    target: '[data-tour="op-add"]',
    title: 'tour.opAddTitle',
    body: [
      'tour.opAddBody1',
      'tour.opAddBody2',
      'tour.opAddBody3',
    ],
  },
  {
    id: 'op-card',
    route: '/open-platform',
    target: '[data-tour="op-card"]',
    title: 'tour.opCardTitle',
    body: [
      'tour.opCardBody1',
      'tour.opCardBody2',
      'tour.opCardBody3',
    ],
    skipIf: () => !hasOpCards(),
    enter: closeOpDetail,
  },
  {
    id: 'op-detail',
    route: '/open-platform',
    target: '[data-tour="op-detail"]',
    title: 'tour.opDetailTitle',
    body: [
      'tour.opDetailBody1',
      'tour.opDetailBody2',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-dau',
    route: '/open-platform',
    target: '[data-tour="op-detail-dau"]',
    title: 'tour.opDetailDauTitle',
    body: [
      'tour.opDetailDauBody1',
      'tour.opDetailDauBody2',
    ],
    skipIf: () => !document.querySelector('[data-tour="op-detail-dau"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-insight',
    route: '/open-platform',
    title: 'tour.opDetailInsightTitle',
    center: true,
    body: [
      'tour.opDetailInsightBody1',
      'tour.opDetailInsightBody2',
    ],
    callout: { tone: 'tip', text: 'tour.opDetailInsightCallout' },
    skipIf: () => !document.querySelector('[data-tour="op-detail-insight"]'),
    enter: openOpDetail,
  },
  {
    id: 'op-detail-actions',
    route: '/open-platform',
    target: '[data-tour="op-detail-actions"]',
    title: 'tour.opDetailActionsTitle',
    body: [
      'tour.opDetailActionsBody1',
      'tour.opDetailActionsBody2',
    ],
    skipIf: () => !hasOpCards(),
    enter: openOpDetail,
  },
  {
    id: 'nav-ai',
    route: '/open-platform',
    target: '[data-tour="nav-ai"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-ai'),
    title: 'tour.navAiTitle',
    body: [
      'tour.navAiBody1',
      'tour.navAiBody2',
      'tour.navAiBody3',
    ],
    enter: closeOpDetail,
  },
  {
    id: 'ai-new',
    route: '/ai',
    target: '[data-tour="ai-new"]',
    title: 'tour.aiNewTitle',
    body: [
      'tour.aiNewBody1',
      'tour.aiNewBody2',
    ],
    enter: () => {
      closeAiProfile();
    },
  },
  {
    id: 'ai-list',
    route: '/ai',
    target: '[data-tour="ai-list"]',
    title: 'tour.aiListTitle',
    body: [
      'tour.aiListBody1',
      'tour.aiListBody2',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-config',
    route: '/ai',
    target: '[data-tour="ai-config"]',
    title: 'tour.aiConfigTitle',
    body: [
      'tour.aiConfigBody1',
      'tour.aiConfigBody2',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'ai-profile',
    route: '/ai',
    target: '[data-tour="ai-profile"]',
    title: 'tour.aiProfileTitle',
    body: [
      'tour.aiProfileBody1',
      'tour.aiProfileBody2',
    ],
    callout: { tone: 'warn', text: 'tour.aiProfileCallout' },
    enter: openAiProfile,
  },
  {
    id: 'ai-profile-edit',
    route: '/ai',
    target: '[data-tour="ai-profile-edit"]',
    title: 'tour.aiProfileEditTitle',
    body: [
      'tour.aiProfileEditBody1',
      'tour.aiProfileEditBody2',
      'tour.aiProfileEditBody3',
      'tour.aiProfileEditBody4',
    ],
    callout: { tone: 'warn', text: 'tour.aiProfileEditCallout' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-profile-vision',
    route: '/ai',
    target: '[data-tour="ai-profile-vision"]',
    title: 'tour.aiProfileVisionTitle',
    body: [
      'tour.aiProfileVisionBody1',
      'tour.aiProfileVisionBody2',
    ],
    callout: { tone: 'tip', text: 'tour.aiProfileVisionCallout' },
    enter: openAiProfileEdit,
  },
  {
    id: 'ai-composer',
    route: '/ai',
    target: '[data-tour="ai-composer"]',
    title: 'tour.aiComposerTitle',
    body: [
      'tour.aiComposerBody1',
      'tour.aiComposerBody2',
      'tour.aiComposerBody3',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-model',
    route: '/ai',
    target: '[data-tour="ai-model"]',
    title: 'tour.aiModelTitle',
    body: [
      'tour.aiModelBody1',
      'tour.aiModelBody2',
      'tour.aiModelBody3',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-file',
    route: '/ai',
    target: '[data-tour="ai-file"]',
    title: 'tour.aiFileTitle',
    body: [
      'tour.aiFileBody1',
      'tour.aiFileBody2',
    ],
    callout: { tone: 'warn', text: 'tour.aiFileCallout' },
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'ai-send',
    route: '/ai',
    target: '[data-tour="ai-send"]',
    title: 'tour.aiSendTitle',
    body: [
      'tour.aiSendBody1',
      'tour.aiSendBody2',
    ],
    skipIf: () => !hasAiSessions(),
    enter: () => {
      closeAiProfile();
      openAiSession();
    },
  },
  {
    id: 'nav-simulate',
    route: '/ai',
    target: '[data-tour="nav-simulate"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-simulate'),
    title: 'tour.navSimulateTitle',
    body: [
      'tour.navSimulateBody1',
      'tour.navSimulateBody2',
      'tour.navSimulateBody3',
    ],
    enter: closeAiProfile,
  },
  {
    id: 'simulate',
    route: '/simulate',
    target: '[data-tour="simulate-send"]',
    title: 'tour.simulateTitle',
    body: [
      'tour.simulateBody1',
      'tour.simulateBody2',
    ],
    callout: { tone: 'tip', text: 'tour.simulateCallout' },
    enter: closeSimConfig,
  },
  {
    id: 'sim-config-account',
    route: '/simulate',
    target: '[data-tour="sim-config-account"]',
    title: 'tour.simConfigAccountTitle',
    body: [
      'tour.simConfigAccountBody1',
      'tour.simConfigAccountBody2',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-identity',
    route: '/simulate',
    target: '[data-tour="sim-config-identity"]',
    title: 'tour.simConfigIdentityTitle',
    body: [
      'tour.simConfigIdentityBody1',
      'tour.simConfigIdentityBody2',
    ],
    enter: openSimConfig,
  },
  {
    id: 'sim-config-event',
    route: '/simulate',
    target: '[data-tour="sim-config-event"]',
    title: 'tour.simConfigEventTitle',
    body: [
      'tour.simConfigEventBody1',
      'tour.simConfigEventBody2',
    ],
    callout: { tone: 'tip', text: 'tour.simConfigEventCallout' },
    enter: openSimConfig,
  },
  {
    id: 'nav-logs',
    route: '/simulate',
    target: '[data-tour="nav-logs"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-logs'),
    title: 'tour.navLogsTitle',
    body: [
      'tour.navLogsBody1',
      'tour.navLogsBody2',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-filters',
    route: '/logs',
    target: '[data-tour="logs-filters"]',
    title: 'tour.logsFiltersTitle',
    body: [
      'tour.logsFiltersBody1',
      'tour.logsFiltersBody2',
    ],
    enter: closeSimConfig,
  },
  {
    id: 'logs-search',
    route: '/logs',
    target: '[data-tour="logs-search"]',
    title: 'tour.logsSearchTitle',
    body: [
      'tour.logsSearchBody1',
    ],
  },
  {
    id: 'logs-cat',
    route: '/logs',
    target: '[data-tour="logs-cat"]',
    title: 'tour.logsCatTitle',
    body: [
      'tour.logsCatBody1',
      'tour.logsCatBody2',
      'tour.logsCatBody3',
    ],
  },
  {
    id: 'logs-level',
    route: '/logs',
    target: '[data-tour="logs-level"]',
    title: 'tour.logsLevelTitle',
    body: [
      'tour.logsLevelBody1',
      'tour.logsLevelBody2',
    ],
    callout: { tone: 'tip', text: 'tour.logsLevelCallout' },
  },
  {
    id: 'logs-file',
    route: '/logs',
    target: '[data-tour="logs-file"]',
    title: 'tour.logsFileTitle',
    body: [
      'tour.logsFileBody1',
      'tour.logsFileBody2',
      'tour.logsFileBody3',
    ],
  },
  {
    id: 'logs-stream',
    route: '/logs',
    target: '[data-tour="logs-stream"]',
    // 日志区是 flex-1，会一路撑到屏幕底部；不设上限的话高亮框比里面的日志行高出一大截，
    // 看着像框错了地方。这里只从日志区顶部往下框一段，正好盖住最前面几行。
    maxHeight: 240,
    title: 'tour.logsStreamTitle',
    body: [
      'tour.logsStreamBody1',
      'tour.logsStreamBody2',
      'tour.logsStreamBody3',
      'tour.logsStreamBody4',
      'tour.logsStreamBody5',
    ],
    callout: { tone: 'tip', text: 'tour.logsStreamCallout' },
  },
  {
    id: 'logs-toolbar',
    route: '/logs',
    target: '[data-tour="logs-toolbar"]',
    title: 'tour.logsToolbarTitle',
    body: [
      'tour.logsToolbarBody1',
      'tour.logsToolbarBody2',
    ],
  },
  {
    id: 'logs-refresh',
    route: '/logs',
    target: '[data-tour="logs-refresh"]',
    title: 'tour.logsRefreshTitle',
    body: [
      'tour.logsRefreshBody1',
      'tour.logsRefreshBody2',
    ],
  },
  {
    id: 'logs-copy',
    route: '/logs',
    target: '[data-tour="logs-copy"]',
    title: 'tour.logsCopyTitle',
    body: [
      'tour.logsCopyBody1',
      'tour.logsCopyBody2',
    ],
  },
  {
    id: 'logs-download',
    route: '/logs',
    target: '[data-tour="logs-download"]',
    title: 'tour.logsDownloadTitle',
    body: [
      'tour.logsDownloadBody1',
      'tour.logsDownloadBody2',
      'tour.logsDownloadBody3',
    ],
  },
  {
    id: 'logs-clear',
    route: '/logs',
    target: '[data-tour="logs-clear"]',
    title: 'tour.logsClearTitle',
    body: [
      'tour.logsClearBody1',
      'tour.logsClearBody2',
    ],
    callout: { tone: 'warn', text: 'tour.logsClearCallout' },
  },
  {
    id: 'logs-autoscroll',
    route: '/logs',
    target: '[data-tour="logs-autoscroll"]',
    title: 'tour.logsAutoscrollTitle',
    body: [
      'tour.logsAutoscrollBody1',
      'tour.logsAutoscrollBody2',
    ],
  },
  {
    id: 'nav-settings',
    route: '/logs',
    target: '[data-tour="nav-settings"]',
    sidebar: 'open',
    // 用户在侧边栏里把它隐藏了：没有可高亮的入口，这一步整步跳过（编号不变）
    skipIf: () => navEntryHidden('nav-settings'),
    title: 'tour.navSettingsTitle',
    body: [
      'tour.navSettingsBody1',
      'tour.navSettingsBody2',
    ],
  },
  {
    id: 'settings-listen',
    route: '/settings',
    target: '[data-tour="settings-listen"]',
    title: 'tour.settingsListenTitle',
    body: [
      'tour.settingsListenBody1',
      'tour.settingsListenBody2',
    ],
  },
  {
    id: 'row-host',
    route: '/settings',
    target: '[data-tour="row-host"]',
    title: 'tour.rowHostTitle',
    body: [
      'tour.rowHostBody1',
      'tour.rowHostBody2',
    ],
    callout: { tone: 'warn', text: 'tour.rowHostCallout' },
  },
  {
    id: 'row-port',
    route: '/settings',
    target: '[data-tour="row-port"]',
    title: 'tour.rowPortTitle',
    body: [
      'tour.rowPortBody1',
      'tour.rowPortBody2',
    ],
    callout: { tone: 'warn', text: 'tour.rowPortCallout' },
  },
  {
    id: 'settings-runtime',
    route: '/settings',
    target: '[data-tour="settings-runtime"]',
    title: 'tour.settingsRuntimeTitle',
    body: [
      'tour.settingsRuntimeBody1',
    ],
  },
  {
    id: 'row-loglevel',
    route: '/settings',
    target: '[data-tour="row-loglevel"]',
    title: 'tour.rowLoglevelTitle',
    body: [
      'tour.rowLoglevelBody1',
      'tour.rowLoglevelBody2',
    ],
  },
  {
    id: 'row-timeout',
    route: '/settings',
    target: '[data-tour="row-timeout"]',
    title: 'tour.rowTimeoutTitle',
    body: [
      'tour.rowTimeoutBody1',
      'tour.rowTimeoutBody2',
    ],
  },
  {
    id: 'settings-title',
    route: '/settings',
    target: '[data-tour="settings-title"]',
    title: 'tour.settingsTitleTitle',
    body: [
      'tour.settingsTitleBody1',
      'tour.settingsTitleBody2',
    ],
  },
  {
    id: 'row-title',
    route: '/settings',
    target: '[data-tour="row-title"]',
    title: 'tour.rowTitleTitle',
    body: [
      'tour.rowTitleBody1',
      'tour.rowTitleBody2',
    ],
  },
  {
    id: 'brand-title',
    route: '/settings',
    target: '[data-tour="brand-title"]',
    title: 'tour.brandTitleTitle',
    body: [
      'tour.brandTitleBody1',
      'tour.brandTitleBody2',
      'tour.brandTitleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.brandTitleCallout' },
  },
  {
    id: 'settings-appearance',
    route: '/settings',
    target: '[data-tour="settings-appearance"]',
    title: 'tour.settingsAppearanceTitle',
    body: [
      'tour.settingsAppearanceBody1',
      'tour.settingsAppearanceBody2',
    ],
  },
  {
    id: 'ap-bg',
    route: '/settings',
    target: '[data-tour="ap-bg"]',
    title: 'tour.apBgTitle',
    body: [
      'tour.apBgBody1',
      'tour.apBgBody2',
    ],
  },
  {
    id: 'ap-uiSpeed',
    route: '/settings',
    target: '[data-tour="ap-row-uiSpeed"]',
    title: 'tour.apUiSpeedTitle',
    body: [
      'tour.apUiSpeedBody1',
    ],
  },
  {
    id: 'ap-cardOpacity',
    route: '/settings',
    target: '[data-tour="ap-row-cardOpacity"]',
    title: 'tour.apCardOpacityTitle',
    body: [
      'tour.apCardOpacityBody1',
    ],
  },
  {
    id: 'ap-cardBlur',
    route: '/settings',
    target: '[data-tour="ap-row-cardBlur"]',
    title: 'tour.apCardBlurTitle',
    body: [
      'tour.apCardBlurBody1',
    ],
  },
  {
    id: 'ap-card2Opacity',
    route: '/settings',
    target: '[data-tour="ap-row-card2Opacity"]',
    title: 'tour.apCard2OpacityTitle',
    body: [
      'tour.apCard2OpacityBody1',
      'tour.apCard2OpacityBody2',
    ],
  },
  {
    id: 'ap-card2Blur',
    route: '/settings',
    target: '[data-tour="ap-row-card2Blur"]',
    title: 'tour.apCard2BlurTitle',
    body: [
      'tour.apCard2BlurBody1',
    ],
  },
  {
    id: 'ap-backgroundBlur',
    route: '/settings',
    target: '[data-tour="ap-row-backgroundBlur"]',
    title: 'tour.apBackgroundBlurTitle',
    body: [
      'tour.apBackgroundBlurBody1',
      'tour.apBackgroundBlurBody2',
    ],
  },
  {
    id: 'ap-sidebarWidthPc',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthPc"]',
    title: 'tour.apSidebarWidthPcTitle',
    body: [
      'tour.apSidebarWidthPcBody1',
      'tour.apSidebarWidthPcBody2',
    ],
  },
  {
    id: 'ap-sidebarWidthMobile',
    route: '/settings',
    target: '[data-tour="ap-row-sidebarWidthMobile"]',
    title: 'tour.apSidebarWidthMobileTitle',
    body: [
      'tour.apSidebarWidthMobileBody1',
      'tour.apSidebarWidthMobileBody2',
    ],
  },
  {
    id: 'settings-color',
    route: '/settings',
    target: '[data-tour="settings-color"]',
    title: 'tour.settingsColorTitle',
    body: [
      'tour.settingsColorBody1',
      'tour.settingsColorBody2',
    ],
  },
  {
    id: 'color-panel',
    route: '/settings',
    target: '[data-tour="color-panel"]',
    title: 'tour.colorPanelTitle',
    body: [
      'tour.colorPanelBody1',
      'tour.colorPanelBody2',
    ],
    enter: openColorDialog,
  },
  {
    id: 'color-gradient',
    route: '/settings',
    target: '[data-tour="color-panel"]',
    title: 'tour.colorGradientTitle',
    body: [
      'tour.colorGradientBody1',
      'tour.colorGradientBody2',
    ],
    enter: openColorDialog,
  },
  {
    id: 'settings-watermark',
    route: '/settings',
    target: '[data-tour="settings-watermark"]',
    title: 'tour.settingsWatermarkTitle',
    body: [
      'tour.settingsWatermarkBody1',
      'tour.settingsWatermarkBody2',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'settings-performance',
    route: '/settings',
    target: '[data-tour="settings-performance"]',
    title: 'tour.settingsPerformanceTitle',
    body: [
      'tour.settingsPerformanceBody1',
      'tour.settingsPerformanceBody2',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'perf-mode-toggle',
    route: '/settings',
    target: '[data-tour="perf-mode-toggle"]',
    title: 'tour.perfModeToggleTitle',
    body: [
      'tour.perfModeToggleBody1',
      'tour.perfModeToggleBody2',
      'tour.perfModeToggleBody3',
    ],
    callout: { tone: 'tip', text: 'tour.perfModeToggleCallout' },
  },
  {
    id: 'settings-bg-preset',
    route: '/settings',
    target: '[data-tour="settings-bg-preset"]',
    title: 'tour.settingsBgPresetTitle',
    body: [
      'tour.settingsBgPresetBody1',
      'tour.settingsBgPresetBody2',
    ],
  },
  {
    id: 'settings-store-origin',
    route: '/settings',
    target: '[data-tour="settings-store-origin"]',
    title: 'tour.settingsStoreOriginTitle',
    body: [
      'tour.settingsStoreOriginBody1',
      'tour.settingsStoreOriginBody2',
    ],
    callout: { tone: 'warn', text: 'tour.settingsStoreOriginCallout' },
    enter: closeColorDialog,
  },
  {
    id: 'settings-resource',
    route: '/settings',
    target: '[data-tour="settings-resource"]',
    title: 'tour.settingsResourceTitle',
    body: [
      'tour.settingsResourceBody1',
    ],
  },
  {
    id: 'settings-github',
    route: '/settings',
    target: '[data-tour="settings-github"]',
    title: 'tour.settingsGithubTitle',
    body: [
      'tour.settingsGithubBody1',
    ],
  },
  {
    id: 'settings-language',
    route: '/settings',
    target: '[data-tour="settings-language"]',
    title: 'tour.settingsLanguageTitle',
    body: [
      'tour.settingsLanguageBody1',
    ],
  },
  {
    id: 'settings-login-guard',
    route: '/settings',
    target: '[data-tour="settings-login-guard"]',
    title: 'tour.settingsLoginGuardTitle',
    body: [
      'tour.settingsLoginGuardBody1',
    ],
  },
  {
    id: 'settings-sharp',
    route: '/settings',
    target: '[data-tour="settings-sharp"]',
    title: 'tour.settingsSharpTitle',
    body: [
      'tour.settingsSharpBody1',
    ],
  },
  {
    id: 'update-center',
    route: '/settings',
    target: '[data-tour="update-center"]',
    sidebar: 'open',
    title: 'tour.updateCenterTitle',
    body: [
      'tour.updateCenterBody1',
      'tour.updateCenterBody2',
    ],
    enter: closeColorDialog,
  },
  {
    id: 'uc-header',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-header"]',
    title: 'tour.ucHeaderTitle',
    body: [
      'tour.ucHeaderBody1',
      'tour.ucHeaderBody2',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-actions',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-actions"]',
    title: 'tour.ucActionsTitle',
    body: [
      'tour.ucActionsBody1',
      'tour.ucActionsBody2',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-version',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-version"]',
    title: 'tour.ucVersionTitle',
    body: [
      'tour.ucVersionBody1',
    ],
    enter: openUpdateCenter,
  },
  {
    id: 'uc-mirror',
    route: '/settings',
    sidebar: 'open',
    target: '[data-tour="uc-mirror"]',
    title: 'tour.ucMirrorTitle',
    body: [
      'tour.ucMirrorBody1',
      'tour.ucMirrorBody2',
    ],
    callout: { tone: 'tip', text: 'tour.ucMirrorCallout' },
    enter: openUpdateCenter,
  },
  {
    id: 'settings-tour',
    route: '/settings',
    target: '[data-tour="settings-tour"]',
    title: 'tour.settingsTourTitle',
    body: [
      'tour.settingsTourBody1',
    ],
    enter: closeUpdateCenter,
  },
  {
    id: 'done',
    center: true,
    title: 'tour.doneTitle',
    body: [
      'tour.doneBody1',
      'tour.doneBody2',
      'tour.doneBody3',
    ],
  },
];
