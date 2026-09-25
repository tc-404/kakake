/**
 * 将宿主 React / Router 挂到 globalThis，供 /plugin-ui/shims/* 再导出，
 * 保证动态 import 的插件模块与控制台共用同一 React 实例。
 */
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JsxRuntime from 'react/jsx-runtime';
import * as ReactRouterDOM from 'react-router-dom';
import { getStoredToken } from '@/lib/api';

export type KakakeSharedLibs = {
  react: typeof React;
  reactDom: typeof ReactDOM;
  reactDomClient: typeof ReactDOMClient;
  jsxRuntime: typeof JsxRuntime;
  reactRouterDom: typeof ReactRouterDOM;
};

declare global {
  // eslint-disable-next-line no-var
  var __KAKAKE_SHARED__: KakakeSharedLibs | undefined;
}

export function ensureKakakeSharedLibs(): KakakeSharedLibs {
  if (!globalThis.__KAKAKE_SHARED__) {
    globalThis.__KAKAKE_SHARED__ = {
      react: React,
      reactDom: ReactDOM,
      reactDomClient: ReactDOMClient,
      jsxRuntime: JsxRuntime,
      reactRouterDom: ReactRouterDOM,
    };
  }
  return globalThis.__KAKAKE_SHARED__;
}

/** 控制台内打开插件 API 用的 fetch（带登录态） */
export function createPluginHostFetch(): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers || {});
    const token = getStoredToken();
    if (token && !headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, {
      ...init,
      headers,
      credentials: init?.credentials ?? 'include',
    });
  };
}
