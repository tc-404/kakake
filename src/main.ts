import 'reflect-metadata';
import path from 'node:path';
import fs from 'node:fs';
import dns from 'node:dns';
import process from 'node:process';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { rootLogger } from './core/logger.js';
import { setLogMinLevel } from './core/log-store.js';
import {
  bold,
  brightCyan,
  brightGreen,
  brightYellow,
  dim,
  displayWidth,
  padDisplay,
  rule,
  underline,
} from './core/console-style.js';
import { flushDau } from './core/dau.js';
import { closeLogStream } from './core/log-file-writer.js';
import {
  buildQuickLoginUrl,
  describeNicKind,
  detectCloudPublicIpv4,
  isWildcardHost,
  listLanIpv4Detailed,
  resolvePublicHostSync,
} from './core/public-address.js';
import {
  IS_TERMUX,
  TERMUX_PREFIX,
  describeRuntime,
  isPrivilegedPort,
  isSharedStoragePath,
} from './core/runtime-env.js';
import { configService } from './core/config.service.js';
import { initDataDirs } from './core/init-data.js';
import { ConnectionManager } from './connection/connection.manager.js';
import { PluginManager } from './plugin/plugin.manager.js';
import { GfPluginManager } from './plugin/gf-plugin.manager.js';
import { WxPluginManager } from './plugin/wx-plugin.manager.js';
import { SsPluginManager } from './plugin/ss-plugin.manager.js';
import { SssxPluginManager } from './plugin/sssx-plugin.manager.js';
import { PluginConfigService } from './plugin/plugin-config.service.js';
import { PluginImporter } from './plugin/plugin.importer.js';
import { createPluginHttpMiddleware } from './plugin/plugin-http.handler.js';
import { createOnebotHttpClientWebhookMiddleware } from './connection/onebot-http.client.js';
import { createQqOfficialHttpsWebhookMiddleware } from './connection/qq-official-https.server.js';
import { kakakeApp } from './kakake-app.js';
import { PATHS } from './paths.js';
import { authMiddleware, clearAllSessions } from './admin/auth.middleware.js';
import { ensureAuthKey } from './admin/auth-key.js';
import { attachPublicWs } from './admin/public-ws.js';
import { getFrameworkVersion } from './admin/agreement.service.js';
import { NODE_SAFE_BASELINE, printNodeSecurityNotice } from './core/node-version-guard.js';

function isFrameworkPassthroughPath(p: string): boolean {
  return (
    p.startsWith('/api')
    || /^\/plugin(?:\/|$)/.test(p)
    || p.startsWith('/onebot/')
    || p.startsWith('/gfbot/')
    || p.startsWith('/gf_bot/')
  );
}

/**
 * 预压缩静态服务：vite 构建时已为文本资源生成 .br/.gz 旁文件（见 vite.config.ts 的内联插件），
 * 浏览器 Accept-Encoding 支持时直接发变体——省去每请求现场压缩的 CPU 开销，传输体积也小得多。
 */
function precompressedStatic(rootDir: string) {
  const rootAbs = path.resolve(rootDir);
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    const rawPath = (req.path || '/').split('?')[0] ?? '/';
    if (/\.(?:br|gz)$/i.test(rawPath)) { next(); return; } // 变体文件本身不直接暴露
    const accept = String(req.headers['accept-encoding'] || '');
    const variants: [string, string][] = [];
    if (accept.includes('br')) variants.push(['br', '.br']);
    if (accept.includes('gzip')) variants.push(['gzip', '.gz']);
    if (variants.length === 0) { next(); return; }

    let filePath: string;
    try {
      filePath = path.resolve(rootAbs, decodeURIComponent(rawPath));
    } catch {
      next();
      return;
    }
    // 防目录穿越：必须仍落在 dist 内
    if (filePath !== rootAbs && !filePath.startsWith(rootAbs + path.sep)) { next(); return; }

    for (const [encoding, ext] of variants) {
      const variant = filePath + ext;
      try {
        if (!fs.existsSync(variant)) continue;
      } catch {
        continue;
      }
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');
      res.sendFile(variant, (err) => {
        if (err && !res.headersSent) next();
      });
      return;
    }
    next();
  };
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

  rootLogger.debug(`Web SPA: ${dist}`);
  expressApp.use(precompressedStatic(dist));
  expressApp.use(express.static(dist, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        // 带 hash 的构建产物：内容永不变化，可永久缓存
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        // 入口 html 等：每次协商，保证发版后浏览器立即拿到新入口
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  }));
  expressApp.use((req: Request, res: Response, next: NextFunction) => {
    if (isFrameworkPassthroughPath(req.path || '')) {
      next();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}

/**
 * 可选的 DNS 结果顺序覆盖。
 * 云服务器上偶发的 `fetch failed`（连接阶段超时）常见于：同时存在 IPv4 与不通的 IPv6，
 * 或 DNS 返回的首个地址在本机网络不可达。Node 默认按 DNS 返回顺序（verbatim）尝试，
 * 设 KAKAKE_DNS_RESULT_ORDER=ipv4first 可强制优先 IPv4，用于快速验证是否属于该情况。
 */
function applyDnsResultOrder(): void {
  const raw = (process.env.KAKAKE_DNS_RESULT_ORDER ?? '').trim();
  if (!raw) return;
  const allowed = ['ipv4first', 'ipv6first', 'verbatim'];
  if (!allowed.includes(raw)) {
    rootLogger.warn(`KAKAKE_DNS_RESULT_ORDER=${raw} 无效，可选：${allowed.join(' / ')}`);
    return;
  }
  try {
    dns.setDefaultResultOrder(raw as 'ipv4first' | 'ipv6first' | 'verbatim');
    rootLogger.info(`DNS 解析顺序已设为 ${raw}`);
  } catch (err: unknown) {
    rootLogger.warn(`设置 DNS 解析顺序失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Termux（安卓手机）专属的启动前自检。
 * 这些问题在手机上非常常见，报错信息又很难看懂，所以提前用中文讲清楚。
 */
function checkTermuxEnvironment(port: number): void {
  if (!IS_TERMUX) return;

  rootLogger.info(`Termux 环境已识别${TERMUX_PREFIX ? ` · PREFIX=${TERMUX_PREFIX}` : ''}`);

  if (isSharedStoragePath(PATHS.root)) {
    rootLogger.warn(`项目位于安卓共享存储: ${PATHS.root}`);
    rootLogger.warn('共享存储没有可执行位、不支持符号链接，npm 安装与前端构建会失败');
    rootLogger.warn('请把项目移到 Termux 家目录，例如: mv 当前目录 ~/kakake && cd ~/kakake');
  }

  if (isPrivilegedPort(port)) {
    rootLogger.warn(`后台端口 ${port} 小于 1024，安卓非 root 无法监听，建议改成 8787 之类的高位端口`);
  }

  rootLogger.info('建议先执行 termux-wake-lock，否则息屏后安卓可能杀掉后台进程');
}

/**
 * 完整快捷登录链接（含明文密钥）只打印到屏幕，不进日志文件；
 * rootLogger 写打码版，避免 log/*.log 留存可直接登录的明文密钥。
 *
 * 密钥会按 URL 规则编码后拼进 query（服务端解析时会自动还原）。
 * 新生成的初始密钥只含 URL 安全字符，链接原样呈现；用户自定义密钥
 * 若含特殊字符，输出会在链接后附一句转义说明，避免误以为链接失效。
 */
/**
 * 屏幕专用行：label 按显示宽度对齐，value 高亮。
 * 只写 stdout —— 带明文密钥的内容绝不能进日志文件（后台「日志」页也读得到）。
 */
interface ScreenRow {
  label: string;
  value: string;
  paint?: (s: string) => string;
}

/**
 * 收成一块对齐的横幅再一次性输出。
 * 分开 println 会被启动过程中的插件日志插断，用户翻屏时找不到地址。
 */
function printScreenBanner(title: string, rows: ScreenRow[]): void {
  const line = dim(rule());
  // 按最长标签定宽：写死宽度的话「登录密钥（自定义）」这类长标签会顶到值上
  const width = rows.reduce((w, r) => Math.max(w, displayWidth(r.label)), 0) + 2;
  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`  ${bold(brightGreen(title))}\n`);
  for (const r of rows) {
    const paint = r.paint ?? brightCyan;
    process.stdout.write(`  ${dim(padDisplay(r.label, width))}${paint(r.value)}\n`);
  }
  process.stdout.write(`${line}\n\n`);
}

function printQuickLogin(
  label: string,
  host: string,
  port: number,
  key: string,
  rows?: ScreenRow[],
): void {
  // buildQuickLoginUrl 内部会做 encodeURIComponent；这里再算一次只为判断
  // 「密钥是否含需要转义的字符」，决定要不要附转义说明
  const needsEscape = encodeURIComponent(key) !== key;
  const url = buildQuickLoginUrl(host, port, key);
  const note = needsEscape ? '（密钥含特殊字符，链接里已按 URL 规则转义，点开即可正常登录）' : '';
  const row: ScreenRow = {
    label,
    value: url + note,
    paint: (s) => underline(brightGreen(s)),
  };
  // 有 rows 就先攒着（等横幅一起打），没有就直接输出（如异步补到的公网地址）
  if (rows) rows.push(row);
  else printScreenBanner('快捷登录', [row]);
  rootLogger.info(`${label}: ${url.replace(/([?&]key=)[^&]+/, '$1***')}${note}`);
}

async function bootstrap() {
  initDataDirs();

  const legacyToken = configService.getConfig().token?.trim();
  const auth = ensureAuthKey(legacyToken || undefined);
  clearAllSessions();

  const config = configService.getConfig();
  rootLogger.setLevel(config.logLevel);
  // 落盘/内存/SSE 的最小级别与控制台级别保持一致（仅启动时设置一次）
  setLogMinLevel(config.logLevel);
  applyDnsResultOrder();

  process.stdout.write(`${dim(rule())}\n`);
  process.stdout.write(`  ${bold(brightCyan('咔咔珂 Kakake'))}  ${dim(`v${getFrameworkVersion()}`)}\n`);
  process.stdout.write(`${dim(rule())}\n`);
  rootLogger.info(`咔咔珂 Kakake v${getFrameworkVersion()} 启动中...`);
  rootLogger.info(`运行环境: ${describeRuntime()}`);
  checkTermuxEnvironment(config.port);
  if (auth.created) {
    rootLogger.info(`已创建登录密钥文件: ${PATHS.authKey}`);
  }

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
  const ssPluginManager = new SsPluginManager(
    rootLogger.child('[其他插件] '),
    connectionManager,
    config.host,
    config.port,
    true,
  );
  const sssxPluginManager = new SssxPluginManager(
    rootLogger.child('[双生插件] '),
    connectionManager,
    config.host,
    config.port,
    true,
  );

  kakakeApp.connectionManager = connectionManager;
  kakakeApp.pluginManager = pluginManager;
  kakakeApp.gfPluginManager = gfPluginManager;
  kakakeApp.wxPluginManager = wxPluginManager;
  kakakeApp.ssPluginManager = ssPluginManager;
  kakakeApp.sssxPluginManager = sssxPluginManager;
  kakakeApp.pluginConfigService = new PluginConfigService(
    pluginManager,
    gfPluginManager,
    wxPluginManager,
    ssPluginManager,
    sssxPluginManager,
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
  ssPluginManager.bindEvents();
  sssxPluginManager.bindEvents();
  await pluginManager.open();
  await gfPluginManager.open();
  await wxPluginManager.open();
  await ssPluginManager.open();
  await sssxPluginManager.open();

  connectionManager.reload();

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    rootLogger.error('[进程] 未捕获的 Promise 拒绝（框架继续运行）:', msg);
  });

  process.on('uncaughtException', (error: Error) => {
    rootLogger.error('[进程] 未捕获的异常（框架继续运行）:', error);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info(`收到 ${signal}，正在优雅退出（最长等待 8 秒）...`);
    // 硬超时兜底：清理卡死也强制退出
    const hardExit = setTimeout(() => process.exit(0), 8000);
    try { hardExit.unref?.(); } catch { /* ignore */ }
    try {
      connectionManager.stopAll();
      // 各类插件管理器统一收尾（内部调用各插件 plugin_cleanup 并自行捕获异常）
      Promise.allSettled([
        pluginManager.close(),
        gfPluginManager.close(),
        wxPluginManager.close(),
        ssPluginManager.close(),
        sssxPluginManager.close(),
      ]).finally(() => {
        try { flushDau(); } catch { /* ignore */ }
        try { closeLogStream(); } catch { /* ignore */ }
        process.exit(0);
      });
    } catch {
      try { flushDau(); } catch { /* ignore */ }
      try { closeLogStream(); } catch { /* ignore */ }
      process.exit(0);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.init();
  try {
    await app.listen(config.port, config.host);
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'EADDRINUSE') {
      rootLogger.error(`端口 ${config.port} 已被占用：先停掉占用它的进程，或改 data/config.json 里的 port`);
    } else if (code === 'EACCES') {
      rootLogger.error(
        `没有权限监听端口 ${config.port}`
        + (isPrivilegedPort(config.port) ? '：1024 以下端口在安卓和普通用户下都不可用，请改成 8787 之类的高位端口' : ''),
      );
    } else if (code === 'EADDRNOTAVAIL') {
      rootLogger.error(`监听地址 ${config.host} 在本机不存在：改回 0.0.0.0 即可`);
    }
    throw err;
  }

  // 外放 API 的 WebSocket 推送：与主服务共用同一 IP+端口（路径 /api/public/ws）
  attachPublicWs(app.getHttpServer());

  // 关键信息集中在最后几行输出，避免被启动过程的日志顶走
  const finalAuth = ensureAuthKey();
  const wildcard = isWildcardHost(config.host);
  const localHost = wildcard ? '127.0.0.1' : config.host;
  const publicHost = wildcard ? resolvePublicHostSync() : null;
  const lanCandidates = wildcard ? listLanIpv4Detailed() : [];
  const lanPrimary = lanCandidates[0] ?? null;
  const lanHost = lanPrimary?.address ?? null;
  const panelUrl = (() => {
    if (!wildcard) return `http://${config.host}:${config.port}`;
    const parts = [`http://127.0.0.1:${config.port}（本机）`];
    if (lanHost) parts.push(`http://${lanHost}:${config.port}（局域网）`);
    // 手机上没有公网 IP，就不提示“外网”，免得照着填一个不存在的地址
    if (!IS_TERMUX) parts.push(`http://${publicHost ?? '<服务器IP>'}:${config.port}（外网）`);
    return parts.join(' / ');
  })();

  rootLogger.info(`启动完成 · 后台控制台: ${panelUrl}`);
  if (finalAuth.kind === 'initial') {
    rootLogger.info('当前为初始密钥：首次登录并同意协议后需设置自定义密码');
  }
  // 原话「会话：无互动 30 分钟退出」被不少新手读成「框架会自动退出」——
  // 这里把主语说清楚：退出的是登录状态，进程一直在跑
  rootLogger.info(
    '登录有效期：30 分钟无操作自动退出登录（仅退出登录，框架不会关闭）· 单次登录最长 3 小时 · 重启框架需重新登录',
  );

  // ===== 屏幕横幅：地址 / 明文密钥 / 快捷登录，不进日志文件 =====
  const rows: ScreenRow[] = [];
  if (wildcard) {
    rows.push({ label: '本机地址', value: `http://127.0.0.1:${config.port}` });
    if (lanHost) rows.push({ label: '局域网', value: `http://${lanHost}:${config.port}` });
    if (!IS_TERMUX) {
      rows.push({
        label: '外网',
        value: publicHost
          ? `http://${publicHost}:${config.port}`
          : `http://<服务器IP>:${config.port}`,
      });
    }
  } else {
    rows.push({ label: '控制台', value: `http://${config.host}:${config.port}` });
  }

  const keyLabel = `登录密钥${finalAuth.kind === 'custom' ? '（自定义）' : '（初始）'}`;
  rows.push({
    label: keyLabel,
    value: `${finalAuth.key}   ${dim('（仅屏幕显示，已存 data/auth-key.json）')}`,
    paint: (s) => bold(brightYellow(s)),
  });
  rootLogger.info(`${keyLabel}: ***（完整密钥仅屏幕显示，文件存于 data/auth-key.json）`);

  printQuickLogin(`快捷登录${wildcard ? '（本机）' : ''}`, localHost, config.port, finalAuth.key, rows);
  if (lanHost && lanPrimary) {
    printQuickLogin(
      `快捷登录（局域网 · ${describeNicKind(lanPrimary.kind)}）`,
      lanHost,
      config.port,
      finalAuth.key,
      rows,
    );
    if (lanCandidates.length > 1) {
      const others = lanCandidates
        .slice(1)
        .map((c) => `${c.address}（${c.iface}/${describeNicKind(c.kind)}）`)
        .join('、');
      rootLogger.info(`本机还有其它内网地址，上面那个连不上就换着试: ${others}`);
    }
    if (IS_TERMUX && lanPrimary.kind !== 'wifi' && lanPrimary.kind !== 'ethernet') {
      rootLogger.warn(
        `上面这个地址来自${describeNicKind(lanPrimary.kind)}，同一 Wi-Fi 的设备很可能访问不到`,
      );
      rootLogger.warn('手机请确认已连上 Wi-Fi；若同时开着蜂窝数据或 VPN，可先关掉再重启咔咔');
    }
  }
  if (publicHost) {
    printQuickLogin('快捷登录（公网）', publicHost, config.port, finalAuth.key, rows);
  }
  rows.push({
    label: '会话说明',
    value: '30 分钟无操作只会退出登录，框架一直在运行；刷新页面重新登录即可',
    paint: dim,
  });

  printScreenBanner(`咔咔珂 Kakake v${getFrameworkVersion()} 已启动`, rows);

  // 运行时安全提示单独划一块，放在启动横幅之后：
  // 混进横幅里会被地址/密钥那几行盖过去，而它是「不升级就可能被动崩溃」的事
  const nodeNotice = printNodeSecurityNotice();
  if (nodeNotice) {
    // 屏幕提示只在启动那一刻可见，这里再留一条日志，后台「日志」页也能查到
    rootLogger.warn(
      `当前 Node.js v${nodeNotice.current} 未达到安全基线（${nodeNotice.reason}）；`
      + `建议升级到 ${NODE_SAFE_BASELINE.map((b) => `v${b.version}`).join(' / ')} 之一并重启本框架`,
    );
  }

  // NAT / 弹性公网 IP 机型的网卡上看不到公网地址，向云厂商元数据接口补问一次（失败就安静跳过）
  if (wildcard && !publicHost) {
    void detectCloudPublicIpv4()
      .then((ip) => {
        if (!ip) return;
        printQuickLogin('快捷登录（公网）', ip, config.port, finalAuth.key);
      })
      .catch(() => undefined);
  }
}

bootstrap().catch((err) => {
  rootLogger.error('启动失败:', err);
  process.exit(1);
});
