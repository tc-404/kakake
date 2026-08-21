import 'reflect-metadata';
import path from 'node:path';
import fs from 'node:fs';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { rootLogger } from './core/logger.js';
import { configService } from './core/config.service.js';
import { initDataDirs } from './core/init-data.js';
import { ConnectionManager } from './connection/connection.manager.js';
import { PluginManager } from './plugin/plugin.manager.js';
import { GfPluginManager } from './plugin/gf-plugin.manager.js';
import { WxPluginManager } from './plugin/wx-plugin.manager.js';
import { PluginConfigService } from './plugin/plugin-config.service.js';
import { PluginImporter } from './plugin/plugin.importer.js';
import { createPluginHttpMiddleware } from './plugin/plugin-http.handler.js';
import { createOnebotHttpClientWebhookMiddleware } from './connection/onebot-http.client.js';
import { createQqOfficialHttpsWebhookMiddleware } from './connection/qq-official-https.server.js';
import { kakakeApp } from './kakake-app.js';
import { PATHS } from './paths.js';
import { authMiddleware, clearAllSessions } from './admin/auth.middleware.js';
import { ensureAuthKey } from './admin/auth-key.js';
import { getFrameworkVersion } from './admin/agreement.service.js';

function isFrameworkPassthroughPath(p: string): boolean {
  return (
    p.startsWith('/api')
    || /^\/plugin(?:\/|$)/.test(p)
    || p.startsWith('/onebot/')
    || p.startsWith('/gfbot/')
    || p.startsWith('/gf_bot/')
  );
}

function mountSpa(expressApp: express.Application): void {
  if (process.env.KAKAKE_NO_WEB === '1') {
    rootLogger.info('KAKAKE_NO_WEB=1：不托管 Web 控制台');
    expressApp.use((req: Request, res: Response, next: NextFunction) => {
      if (isFrameworkPassthroughPath(req.path || '')) {
        next();
        return;
      }
      res.status(503).type('text').send('Web UI disabled (KAKAKE_NO_WEB=1)');
    });
    return;
  }

  const dist = PATHS.webSpaDist;
  const indexHtml = path.join(dist, 'index.html');
  if (!fs.existsSync(indexHtml)) {
    rootLogger.warn('Web UI 未构建，请运行 pnpm build:web');
    expressApp.use((req: Request, res: Response, next: NextFunction) => {
      if (isFrameworkPassthroughPath(req.path || '')) {
        next();
        return;
      }
      res.status(503).type('html').send(
        '<h1>Web UI 未构建</h1><p>请运行: <code>pnpm install && pnpm build:web</code></p>',
      );
    });
    return;
  }

  rootLogger.info(`Web SPA: ${dist}`);
  expressApp.use(express.static(dist, { index: false, maxAge: '1h' }));
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    if (isFrameworkPassthroughPath(req.path || '')) {
      next();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.sendFile(indexHtml);
  });
}

async function bootstrap() {
  initDataDirs();

  const legacyToken = configService.getConfig().token?.trim();
  const auth = ensureAuthKey(legacyToken || undefined);
  clearAllSessions();

  const config = configService.getConfig();
  rootLogger.setLevel(config.logLevel);

  rootLogger.info(`咔咔珂 Kakake v${getFrameworkVersion()} 启动中...`);
  if (auth.created) {
    rootLogger.info(`已创建登录密钥文件: ${PATHS.authKey}`);
  }
  rootLogger.info(`登录密钥 (${auth.kind === 'custom' ? '自定义' : '初始'}): ${auth.key}`);
  rootLogger.info(`访问示例: http://127.0.0.1:${config.port}/?key=上述密钥 （登录后会自动去掉 URL 中的 key）`);
  if (auth.kind === 'initial') {
    rootLogger.info('当前为初始密钥：首次登录并同意协议后需设置自定义密码');
  }
  rootLogger.info('会话：无互动 30 分钟退出；自登录起最长 3 小时；重启框架需重新登录');

  const connectionManager = new ConnectionManager(rootLogger.child('[连接] '));
  const pluginManager = new PluginManager(
    rootLogger.child('[插件] '),
    connectionManager,
    config.host,
    config.port,
    true,
  );
  const gfPluginManager = new GfPluginManager(
    rootLogger.child('[GF插件] '),
    connectionManager,
    config.host,
    config.port,
    true,
  );
  const wxPluginManager = new WxPluginManager(
    rootLogger.child('[微信插件] '),
    connectionManager,
    config.host,
    config.port,
    true,
  );

  kakakeApp.connectionManager = connectionManager;
  kakakeApp.pluginManager = pluginManager;
  kakakeApp.gfPluginManager = gfPluginManager;
  kakakeApp.wxPluginManager = wxPluginManager;
  kakakeApp.pluginConfigService = new PluginConfigService(
    pluginManager,
    gfPluginManager,
    wxPluginManager,
  );
  kakakeApp.pluginImporter = new PluginImporter(rootLogger.child('[导入] '));

  const app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  }) as NestExpressApplication;
  const expressApp = app.getHttpAdapter().getInstance() as express.Application;
  kakakeApp.expressApp = expressApp;

  app.use(express.json({
    limit: '10mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true }));

  app.use(createPluginHttpMiddleware());
  app.use(createOnebotHttpClientWebhookMiddleware());
  app.use(createQqOfficialHttpsWebhookMiddleware());

  app.use(authMiddleware());

  // SPA 必须在 Nest init 之前挂上：否则 /login 等会被 Nest 直接 404，
  // 后续 static / index.html 回退永远走不到。
  mountSpa(expressApp);

  const tmpDir = path.join(PATHS.data, 'tmp');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  pluginManager.bindEvents();
  gfPluginManager.bindEvents();
  wxPluginManager.bindEvents();
  await pluginManager.open();
  await gfPluginManager.open();
  await wxPluginManager.open();

  connectionManager.reload();

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    rootLogger.error('[进程] 未捕获的 Promise 拒绝（框架继续运行）:', msg);
  });

  process.on('uncaughtException', (error: Error) => {
    rootLogger.error('[进程] 未捕获的异常（框架继续运行）:', error);
  });

  process.on('SIGINT', () => {
    connectionManager.stopAll();
    process.exit(0);
  });

  await app.init();
  await app.listen(config.port, config.host);

  if (config.host === '0.0.0.0' || config.host === '::') {
    rootLogger.info(`后台控制台: http://127.0.0.1:${config.port}（本机） / http://<服务器IP>:${config.port}（外网）`);
  } else {
    rootLogger.info(`后台控制台: http://${config.host}:${config.port}`);
  }
  rootLogger.info(`登录密钥: ${ensureAuthKey().key}`);
  rootLogger.info('启动完成');
}

bootstrap().catch((err) => {
  rootLogger.error('启动失败:', err);
  process.exit(1);
});
