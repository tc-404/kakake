import type { NextFunction, Request, Response } from 'express';
import { isRequestAuthed } from './auth.middleware.js';
import { TEST_PAGE_ASSETS, TEST_PAGE_HTML } from './test-feature.page.js';
import { testFeatureService } from './test-feature.service.js';

const ASSET_SUFFIXES = Object.keys(TEST_PAGE_ASSETS);
const PAGE_ROUTE = '/__page';

function acceptsHtml(req: Request): boolean {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.toLowerCase().includes('text/html');
}

function pageAssetFor(pathname: string): { contentType: string; body: Buffer } | undefined {
  for (const suffix of ASSET_SUFFIXES) {
    if (pathname.endsWith(suffix)) return TEST_PAGE_ASSETS[suffix];
  }
  return undefined;
}

export function testFeatureAssets() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (!testFeatureService.isEnabled()) {
      next();
      return;
    }
    const pathname = req.path || '';
    const isPage = pathname === PAGE_ROUTE || pathname === `${PAGE_ROUTE}/`;
    const asset = isPage
      ? { contentType: 'text/html; charset=utf-8', body: TEST_PAGE_HTML }
      : pageAssetFor(pathname);
    if (!asset || !isRequestAuthed(req)) {
      next();
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Length', String(asset.body.length));
    res.setHeader('Cache-Control', 'no-store');
    res.end(req.method === 'HEAD' ? undefined : asset.body);
  };
}

export function testFeaturePage() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (!testFeatureService.isEnabled()) {
      next();
      return;
    }
    const pathname = req.path || '';
    if (pathname.startsWith('/api/') && !pathname.startsWith('/api/Plugin/page/')) {
      next();
      return;
    }
    if (!acceptsHtml(req) || pageAssetFor(pathname) || !isRequestAuthed(req)) {
      next();
      return;
    }

    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);
    let swapped = false;

    const swap = (): boolean => {
      if (swapped || res.headersSent) return false;
      const code = res.statusCode;
      if (code !== 403 && code !== 404) return false;
      swapped = true;
      res.status(code);
      res.removeHeader('Content-Encoding');
      res.removeHeader('ETag');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Length', String(TEST_PAGE_HTML.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(req.method === 'HEAD' ? undefined : TEST_PAGE_HTML);
      return true;
    };

    res.send = ((body?: unknown) => (swap() ? res : originalSend(body))) as Response['send'];
    res.json = ((body?: unknown) => (swap() ? res : originalJson(body))) as Response['json'];
    next();
  };
}
