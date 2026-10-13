import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * 页面级错误边界。
 *
 * 没有它的时候，页面组件在 render 阶段抛错会让 React 18 直接卸载整个 root，
 * 表现就是「切个界面突然全白、啥也没有」。两个最常见的抛错来源：
 *
 * 1. 懒加载 chunk 拿不到。Vite 每次构建 chunk 文件名都换 hash（LogsPage-DCv0bEV4.js
 *    → LogsPage-Cc8Y70CN.js），旧文件随即被删。浏览器还开着旧页面时切界面，
 *    import 旧 chunk 直接 404，React.lazy 的 promise 就 reject 了。
 * 2. 页面组件自身的 render 异常（接口返回结构变了、取了 undefined 上的字段等）。
 *
 * 前者直接整页重载即可恢复（新 index.html 指向新 chunk），后者给一个「重试」入口，
 * 不再让整个界面消失。
 */

/** 动态 import 失败 / chunk 404 时的错误信息特征 */
function isChunkLoadError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? '');
  return /Failed to fetch dynamically imported module/i.test(msg)
    || /Importing a module script failed/i.test(msg)
    || /error loading dynamically imported module/i.test(msg)
    || /dynamically imported module/i.test(msg);
}

/** 一次会话内最多自动重载一次，避免 chunk 真缺失时无限刷新 */
const AUTO_RELOADED_KEY = 'kk:chunk-auto-reloaded';

function alreadyAutoReloaded(): boolean {
  try {
    return sessionStorage.getItem(AUTO_RELOADED_KEY) === '1';
  } catch {
    return false;
  }
}

function markAutoReloaded(): void {
  try {
    sessionStorage.setItem(AUTO_RELOADED_KEY, '1');
  } catch { /* 隐私模式写不进去，退化为不自动重载 */ }
}

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // eslint-disable-next-line no-console
    console.error('[页面异常]', error, info.componentStack);
    if (!isChunkLoadError(error)) return;
    if (alreadyAutoReloaded()) return;
    markAutoReloaded();
    window.location.reload();
  }

  private reset = () => {
    this.setState({ error: null });
  };

  private reload = () => {
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const chunk = isChunkLoadError(error);
    return (
      <div className="flex h-full min-h-[50vh] w-full items-center justify-center p-6">
        <div className="kk-glass max-w-md rounded-2xl border border-white/40 p-5 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-amber-500/15 text-amber-700">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <p className="text-sm font-medium text-slate-800">
            {chunk ? '界面资源已更新，需要重新加载' : '这个界面加载失败了'}
          </p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
            {chunk
              ? '咔咔珂刚更新过，你看到的还是上一版页面。重新加载后即可正常切换。'
              : '已拦下这次异常，界面不会白屏。可以先重试，不行再整页刷新。'}
          </p>
          <div className="mt-4 flex items-center justify-center gap-2">
            {!chunk ? (
              <Button variant="outline" size="sm" onClick={this.reset}>
                重试
              </Button>
            ) : null}
            <Button size="sm" onClick={this.reload}>
              <RefreshCw className="h-4 w-4" /> 重新加载
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
