/**
 * 插件远程后台组件契约（方案 B）。
 * 插件 ESM 默认导出符合此签名的 React 组件；
 * 构建时 external：react / react-dom / react/jsx-runtime / react-router-dom。
 */

import type { ComponentType } from 'react';

export interface PluginRemoteProps {
  pluginId: string;
  accountKey: string;
  /** 页面 path，如 admin */
  pagePath: string;
  /** `/api/Plugin/ext/<id>/a/<account>` */
  apiBase: string;
  /** 模块资源根：`/plugin/<id>/a/<account>/module/` */
  moduleBase: string;
  /** 在控制台内跳转（相对宿主） */
  navigate: (to: string) => void;
  /** 带鉴权的 fetch（credentials + Bearer） */
  fetch: typeof globalThis.fetch;
}

export type PluginRemoteComponent = ComponentType<PluginRemoteProps>;

export interface PluginRemoteModule {
  default: PluginRemoteComponent;
}
