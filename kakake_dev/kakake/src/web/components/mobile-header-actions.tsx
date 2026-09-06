import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type DependencyList,
  type ReactNode,
} from 'react';

/** 稳定 setter，避免 actions 更新导致订阅方 effect 死循环 */
const SetMobileHeaderActionsContext = createContext<
  ((node: ReactNode | null) => void) | null
>(null);

const MobileHeaderActionsNodeContext = createContext<ReactNode | null>(null);

export function MobileHeaderActionsProvider({ children }: { children: ReactNode }) {
  const [actions, setActionsState] = useState<ReactNode | null>(null);
  const setActions = useCallback((node: ReactNode | null) => {
    setActionsState(node);
  }, []);

  return (
    <SetMobileHeaderActionsContext.Provider value={setActions}>
      <MobileHeaderActionsNodeContext.Provider value={actions}>
        {children}
      </MobileHeaderActionsNodeContext.Provider>
    </SetMobileHeaderActionsContext.Provider>
  );
}

/** 仅在手机顶栏展示；页面卸载时自动清空 */
export function useMobileHeaderActions(
  factory: () => ReactNode | null,
  deps: DependencyList,
) {
  const setActions = useContext(SetMobileHeaderActionsContext);

  useEffect(() => {
    if (!setActions) return;
    setActions(factory());
    return () => setActions(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps 由调用方显式传入
  }, [setActions, ...deps]);
}

export function MobileHeaderActionsSlot() {
  const actions = useContext(MobileHeaderActionsNodeContext);
  if (!actions) return null;
  return <div className="mr-1 flex items-center gap-0.5">{actions}</div>;
}
