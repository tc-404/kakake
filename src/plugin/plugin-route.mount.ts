import type { Application, Request, Response, Router } from 'express';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import type { PluginRouterRegistryImpl } from './router-registry.js';
import { legacyNapcatPluginId } from './plugin-id.js';

/**
 * 统一管理插件 HTTP 路由挂载，避免重复 mount
 */
export class PluginRouteMount {
  private mounted = false;
  private pluginApiLayer?: Router;
  private pluginMemHandler?: (req: Request, res: Response) => void;

  remount(app: Application, registries: Map<string, PluginRouterRegistryImpl>): void {
    if (this.mounted) {
      this.unmount(app);
    }
    this.mount(app, registries);
  }

  mount(app: Application, registries: Map<string, PluginRouterRegistryImpl>): void {
    const routeTargets = new Map<string, PluginRouterRegistryImpl>();
    for (const [pluginId, registry] of registries) {
      routeTargets.set(pluginId, registry);
      const legacyId = legacyNapcatPluginId(pluginId);
      if (legacyId) routeTargets.set(legacyId, registry);
    }

    // 无认证 API: /plugin/{id}/api/*
    for (const [pluginId, registry] of routeTargets) {
      if (registry.hasApiNoAuthRoutes()) {
        app.use(`/plugin/${pluginId}/api`, registry.buildApiNoAuthRouter());
      }
    }

    // 静态文件: /plugin/{id}/files/*
    for (const [pluginId, registry] of routeTargets) {
      for (const { urlPath, localPath } of registry.getStaticRoutes()) {
        if (fs.existsSync(localPath)) {
          app.use(`/plugin/${pluginId}/files${urlPath}`, express.static(localPath));
        }
      }
    }

    // 内存静态: /plugin/{id}/mem/*
    this.pluginMemHandler = async (req: Request, res: Response) => {
      const pluginId = String(req.params.pluginId ?? '');
      const registry = routeTargets.get(pluginId);
      if (!registry) {
        res.status(404).json({ code: -1, message: 'Plugin not found' });
        return;
      }

      for (const { urlPath, files } of registry.getMemoryStaticRoutes()) {
        const prefix = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
        if (!req.path.startsWith(prefix)) continue;

        const filePath = '/' + (req.path.substring(prefix.length).replace(/^\//, '') || '');
        const memFile = files.find(f => `/${f.path.replace(/^\//, '')}` === filePath);
        if (!memFile) continue;

        try {
          const content = typeof memFile.content === 'function'
            ? await memFile.content()
            : memFile.content;
          res.setHeader('Content-Type', memFile.contentType || 'application/octet-stream');
          res.send(content);
          return;
        } catch (err) {
          res.status(500).json({ code: -1, message: String(err) });
          return;
        }
      }

      res.status(404).json({ code: -1, message: 'Memory file not found' });
    };
    app.use('/plugin/:pluginId/mem', this.pluginMemHandler);

    // 插件页面: /plugin/{id}/page/*
    for (const [pluginId, registry] of routeTargets) {
      if (!registry.hasPages()) continue;
      app.get(`/plugin/${pluginId}/page/:pagePath`, (req, res) => {
        const pages = registry.getPages();
        const pagePath = req.params.pagePath!;
        const page = pages.find(p => p.path === pagePath || p.path === `/${pagePath}`);
        if (!page) {
          res.status(404).json({ code: -1, message: 'Page not found' });
          return;
        }
        const htmlFile = page.htmlFile;
        if (!htmlFile) {
          res.status(404).json({
            code: -1,
            message: 'Page has no HTML entry; open via console host route',
            hint: page.module
              ? `module=${page.module}; use /plugins/${pluginId}/pages/${pagePath}`
              : undefined,
          });
          return;
        }
        const htmlPath = path.join(registry.getPluginPath(), htmlFile);
        if (!fs.existsSync(htmlPath)) {
          res.status(404).json({ code: -1, message: 'HTML not found' });
          return;
        }
        res.sendFile(htmlPath);
      });
    }

    // 需认证 API: /api/plugin/ext/{id}/*
    this.pluginApiLayer = express.Router();
    for (const [pluginId, registry] of routeTargets) {
      if (registry.hasApiRoutes()) {
        this.pluginApiLayer.use(`/${pluginId}`, registry.buildApiRouter());
      }
    }
    app.use('/api/plugin/ext', this.pluginApiLayer);

    this.mounted = true;
  }

  private unmount(app: Application): void {
    if (!app._router?.stack) {
      this.mounted = false;
      return;
    }

    const filterLayer = (layer: { route?: unknown; regexp?: RegExp; handle?: Router | unknown }) => {
      const reg = layer.regexp?.toString() ?? '';
      if (reg.includes('\\/plugin\\/') || reg.includes('\\/api\\/plugin\\/ext')) return false;
      return true;
    };

    app._router.stack = app._router.stack.filter(filterLayer);
    this.mounted = false;
  }
}
