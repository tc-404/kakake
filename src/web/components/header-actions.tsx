import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';

/**
 * 顶部栏内容注入：当前界面向顶栏贡献「标题 + 操作按钮/菜单」。
 *
 * 顶栏在手机与电脑上是同一套（手机样式），所以这个机制也全端共用：
 * 页面挂载时把自己这一屏要用的操作写进来，卸载时清空，切界面后顶栏自动换成新的。
 *
 * 用法：
 *   usePageHeader(() => ({ title: '自定义标题', actions: <>…</> }), [deps]);
 * 只写 actions 也行，标题缺省时顶栏按路由推导。
 */

export interface PageHeaderPatch {
  /** 覆盖按路由推导出的界面标题（如「工具」下的具体工具名） */
  title?: string;
  /** 顶栏右侧的操作按钮 / 菜单 */
  actions?: ReactNode | null;
}

/** 稳定 setter，避免 actions 更新导致订阅方 effect 死循环 */
const SetHeaderContext = createContext<((patch: PageHeaderPatch | null) => void) | null>(null);

const HeaderContext = createContext<PageHeaderPatch>({});

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [patch, setPatchState] = useState<PageHeaderPatch>({});
  const setPatch = useCallback((next: PageHeaderPatch | null) => {
    setPatchState(next ?? {});
  }, []);

  return (
    <SetHeaderContext.Provider value={setPatch}>
      <HeaderContext.Provider value={patch}>
        {children}
      </HeaderContext.Provider>
    </SetHeaderContext.Provider>
  );
}

/**
 * 页面向顶栏写入标题与操作。deps 变化会重写，页面卸载时自动清空。
 * factory 每次求值都会拿到最新的闭包变量，无需把按钮 memo 化。
 */
export function usePageHeader(
  factory: () => PageHeaderPatch | null,
  deps: DependencyList,
) {
  const setPatch = useContext(SetHeaderContext);

  useEffect(() => {
    if (!setPatch) return;
    setPatch(factory());
    return () => setPatch(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式传入
  }, [setPatch, ...deps]);
}

/** 顶栏读取当前界面的标题覆盖值 */
export function usePageHeaderTitle(): string | undefined {
  return useContext(HeaderContext).title;
}

/** 顶栏右侧操作区；没有内容时不占位 */
export function PageHeaderActionsSlot() {
  const actions = useContext(HeaderContext).actions;
  if (!actions) return null;
  return <div className="mr-0.5 flex items-center gap-0.5">{actions}</div>;
}
