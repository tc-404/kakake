/**
 * Telegram Bot —— Webhook 回调中间件
 *
 * 挂在框架主端口 `/tgbot/<连接id>`，外网用域名 + HTTPS 反代即可。
 * 官方要求：响应必须是 2xx（否则会重试并在若干次后放弃），并可用
 * `X-Telegram-Bot-Api-Secret-Token` 头配合 setWebhook 的 secret_token 校验来源。
 *
 * 额外支持官方技巧「在 webhook 响应里直接调用 Bot API 方法」：
 * 插件在本次 update 中产生的首个 send* 动作会被放进 2xx 响应体，
 * 省掉一次出站请求（代价是拿不到 result，因此做成可选开关）。
 */

import type { NextFunction, Request, Response } from 'express';
import { createTelegramFallbackLogger } from './telegram-api.js';
import {
  TELEGRAM_WEBHOOK_CALLBACK_PREFIX,
  telegramWebhookCallbackPath,
  type TelegramUpdate,
} from './telegram.types.js';

// kakake-app 用动态 import：静态引入会把整个后端模块图拉进来，
// 在插件/单测动态加载本模块时触发 logger ↔ atomic-file 的循环求值（TDZ）。
const logger = createTelegramFallbackLogger('[TelegramWebhook] ');

/** 每连接每分钟最多接受的回调数（防扫描 / 防 Bot-to-Bot 循环打爆） */
const WINDOW_MS = 60_000;
const WINDOW_MAX = 600;
const slots = new Map<string, { start: number; used: number }>();

function consumeSlot(connectionId: string): boolean {
  const now = Date.now();
  let slot = slots.get(connectionId);
  if (!slot || now - slot.start >= WINDOW_MS) {
    slot = { start: now, used: 0 };
    slots.set(connectionId, slot);
  }
  if (slot.used >= WINDOW_MAX) return false;
  slot.used += 1;
  if (slots.size > 512) {
    for (const [k, v] of slots) if (now - v.start >= WINDOW_MS) slots.delete(k);
  }
  return true;
}

function parseBody(req: Request): TelegramUpdate | null {
  const body = (req as Request & { body?: unknown }).body;
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) {
    return body as TelegramUpdate;
  }
  if (typeof body === 'string' && body.trim()) {
    try { return JSON.parse(body) as TelegramUpdate; } catch { return null; }
  }
  if (Buffer.isBuffer(body) && body.length) {
    try { return JSON.parse(body.toString('utf-8')) as TelegramUpdate; } catch { return null; }
  }
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw) && raw.length) {
    try { return JSON.parse(raw.toString('utf-8')) as TelegramUpdate; } catch { return null; }
  }
  return null;
}

/** 供界面展示/复制的完整回调 URL */
export function telegramWebhookCallbackUrl(connectionId: string, publicBase?: string): string {
  const base = String(publicBase || '').trim().replace(/\/+$/, '');
  return base ? `${base}${telegramWebhookCallbackPath(connectionId)}` : telegramWebhookCallbackPath(connectionId);
}

/**
 * 无参中间件：内部从 kakakeApp 取 ConnectionManager，装配顺序与
 * createQqOfficialHttpsWebhookMiddleware 一致（在 authMiddleware 之前）。
 */
export function createTelegramWebhookMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.path || '';
    if (!path.startsWith(TELEGRAM_WEBHOOK_CALLBACK_PREFIX)) { next(); return; }

    const connectionId = decodeURIComponent(path.slice(TELEGRAM_WEBHOOK_CALLBACK_PREFIX.length).replace(/\/+$/, ''));
    if (!connectionId || /[\\/]/.test(connectionId)) { res.status(404).end(); return; }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // 方便用户用浏览器 / curl 验证反向代理是否通到框架（不泄露任何配置）
      res.status(200).type('text/plain').send('kakake telegram webhook endpoint');
      return;
    }
    if (req.method !== 'POST') { res.status(405).end(); return; }
    if (!consumeSlot(connectionId)) {
      res.status(429).json({ ok: false, message: 'too many webhook requests' });
      return;
    }

    void (async () => {
      try {
        const { kakakeApp } = await import('../kakake-app.js');
        const manager = kakakeApp.connectionManager;
        const client = manager?.getTelegramClient?.(connectionId);
        if (!client) {
          // 返回 404（非 2xx）让 Telegram 明确知道这个回调不存在
          res.status(404).json({ ok: false, message: 'telegram connection not found or disabled' });
          return;
        }
        const update = parseBody(req);
        if (!update || typeof update.update_id !== 'number') {
          res.status(400).json({ ok: false, message: 'invalid Update payload' });
          return;
        }

        const secretHeader = req.headers['x-telegram-bot-api-secret-token'];
        const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
        const accepted = await client.acceptWebhookUpdate(update, secret);
        if (!accepted) {
          res.status(403).json({ ok: false, message: 'secret_token mismatch' });
          return;
        }
        const reply = client.takeResponseMethod?.(update.update_id);
        if (reply) {
          // 官方：在 webhook 响应体里带 method 即可直接调用 Bot API
          res.status(200).json(reply);
          return;
        }
        res.status(200).json({ ok: true });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`处理 Webhook 更新失败 (${connectionId}): ${msg}`);
        // 非 2xx 才会被 Telegram 重试：插件异常时让它重投，避免静默丢消息
        res.status(500).json({ ok: false, message: 'internal error' });
      }
    })();
  };
}
