import type { Request, Response, NextFunction, Router } from 'express';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type {
  PluginRouterRegistry,
  PluginRequestHandler,
  PluginPageDefinition,
  PluginHttpRequest,
  PluginHttpResponse,
  HttpMethod,
  MemoryStaticFile,
} from './plugin.types.js';

interface PluginApiRouteDefinition {
  method: HttpMethod;
  path: string;
  handler: PluginRequestHandler;
}

function wrapRequest(req: Request): PluginHttpRequest {
  return {
    path: req.path,
    method: req.method,
    query: req.query as Record<string, unknown>,
    body: req.body,
    headers: req.headers as Record<string, string | string[] | undefined>,
    params: req.params as Record<string, string>,
    raw: req,
  };
}

function wrapResponse(res: Response): PluginHttpResponse {
  const wrapped: PluginHttpResponse = {
    status(code: number) { res.status(code); return wrapped; },
    type(contentType: string) { res.type(contentType); return wrapped; },
    json(data: unknown) { res.json(data); },
    send(data: string | Buffer) { res.send(data); },
    setHeader(name: string, value: string) { res.setHeader(name, value); return wrapped; },
    sendFile(filePath: string) { res.sendFile(filePath); },
    redirect(url: string) { res.redirect(url); },
    raw: res,
  };
  return wrapped;
}

interface MemoryStaticRoute {
  urlPath: string;
  files: MemoryStaticFile[];
}

/** 插件路由注册器 */
export class PluginRouterRegistryImpl implements PluginRouterRegistry {
  private apiRoutes: PluginApiRouteDefinition[] = [];
  private apiNoAuthRoutes: PluginApiRouteDefinition[] = [];
  private pageDefinitions: PluginPageDefinition[] = [];
  private staticRoutes: Array<{ urlPath: string; localPath: string }> = [];
  private memoryStaticRoutes: MemoryStaticRoute[] = [];

  constructor(
    private readonly pluginId: string,
    private readonly pluginPath: string,
  ) {}

  api(method: HttpMethod, routePath: string, handler: PluginRequestHandler): void {
    this.apiRoutes.push({ method, path: routePath, handler });
  }

  get(routePath: string, handler: PluginRequestHandler): void { this.api('get', routePath, handler); }
  post(routePath: string, handler: PluginRequestHandler): void { this.api('post', routePath, handler); }
  put(routePath: string, handler: PluginRequestHandler): void { this.api('put', routePath, handler); }
  delete(routePath: string, handler: PluginRequestHandler): void { this.api('delete', routePath, handler); }

  apiNoAuth(method: HttpMethod, routePath: string, handler: PluginRequestHandler): void {
    this.apiNoAuthRoutes.push({ method, path: routePath, handler });
  }

  getNoAuth(routePath: string, handler: PluginRequestHandler): void { this.apiNoAuth('get', routePath, handler); }
  postNoAuth(routePath: string, handler: PluginRequestHandler): void { this.apiNoAuth('post', routePath, handler); }
  putNoAuth(routePath: string, handler: PluginRequestHandler): void { this.apiNoAuth('put', routePath, handler); }
  deleteNoAuth(routePath: string, handler: PluginRequestHandler): void { this.apiNoAuth('delete', routePath, handler); }

  page(pageDef: PluginPageDefinition): void { this.pageDefinitions.push(pageDef); }
  pages(pageDefs: PluginPageDefinition[]): void { this.pageDefinitions.push(...pageDefs); }

  static(urlPath: string, localPath: string): void {
    const absolutePath = path.isAbsolute(localPath) ? localPath : path.join(this.pluginPath, localPath);
    this.staticRoutes.push({ urlPath, localPath: absolutePath });
  }

  staticOnMem(urlPath: string, files: MemoryStaticFile[]): void {
    this.memoryStaticRoutes.push({ urlPath, files });
  }

  buildApiRouter(): Router {
    const router = express.Router();
    for (const route of this.apiRoutes) {
      this.mountRoute(router, route);
    }
    return router;
  }

  buildApiNoAuthRouter(): Router {
    const router = express.Router();
    for (const route of this.apiNoAuthRoutes) {
      this.mountRoute(router, route);
    }
    return router;
  }

  private mountRoute(router: Router, route: PluginApiRouteDefinition): void {
    const handler = this.wrapHandler(route.handler);
    switch (route.method) {
      case 'get': router.get(route.path, handler); break;
      case 'post': router.post(route.path, handler); break;
      case 'put': router.put(route.path, handler); break;
      case 'delete': router.delete(route.path, handler); break;
      case 'patch': router.patch(route.path, handler); break;
      case 'all': router.all(route.path, handler); break;
    }
  }

  private wrapHandler(handler: PluginRequestHandler) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        await handler(wrapRequest(req), wrapResponse(res), next);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        if (!res.headersSent) {
          res.status(500).json({ code: -1, message: `Plugin error: ${msg}` });
        }
      }
    };
  }

  hasApiRoutes(): boolean { return this.apiRoutes.length > 0; }
  hasApiNoAuthRoutes(): boolean { return this.apiNoAuthRoutes.length > 0; }
  hasStaticRoutes(): boolean { return this.staticRoutes.length > 0 || this.memoryStaticRoutes.length > 0; }
  hasPages(): boolean { return this.pageDefinitions.length > 0; }
  getPages(): PluginPageDefinition[] { return [...this.pageDefinitions]; }
  getPluginId(): string { return this.pluginId; }
  getPluginPath(): string { return this.pluginPath; }
  getStaticRoutes() { return [...this.staticRoutes]; }
  getMemoryStaticRoutes() { return [...this.memoryStaticRoutes]; }

  clear(): void {
    this.apiRoutes = [];
    this.apiNoAuthRoutes = [];
    this.pageDefinitions = [];
    this.staticRoutes = [];
    this.memoryStaticRoutes = [];
  }
}
