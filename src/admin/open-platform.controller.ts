import { Controller, Get, Post, Put, Delete, Body, Query, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { randomUUID } from 'node:crypto';
import { configService } from '../core/config.service.js';
import { isQqOfficialConnection } from '../core/types.js';
import { kakakeApp } from '../kakake-app.js';
import { getDauStats } from '../core/dau.js';
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';
import { remoteAddressOf, describeRemoteAddress } from '../core/net-address.js';
import { rootLogger } from '../core/logger.js';
import { ConnectionsApiController } from './connections-api.controller.js';
import {
  fetchQqOfficialAccessToken,
  qqOfficialApiRequest,
  mapQqOfficialMeToProfile,
  pickQqOfficialCredentials,
  type QqOfficialBotProfile,
} from '../connection/qq-official-api.js';
import { createBindTask, bindQrUrl, pollBindResult, decryptBotSecret } from '../connection/qq-bind.js';

/**
 * 「开放平台」统一管理页：QQ 官方机器人的账号聚合 + 日活 + 扫码接入。
 *
 * 扫码接入走腾讯官方 SDK `@tencent-connect/qqbot-connector`（即 OpenClaw / Qwen Code
 * 用的那条通道）：`startQrConnect()` 吐出 `https://q.qq.com/qqbot/openclaw/connect.html`
 * 的二维码链接，用户用手机 QQ 扫码后 SDK 直接带回 `{ appId, appSecret }`，
 * 后端据此自动建连接——不用申请开发者账号、不用手填任何凭证。
 *
 * 账号数据两路来源：
 * 1. data/connections.json 里的 qq_official 连接（已接入的机器人），叠加运行时的
 *    连接状态 / 机器人资料（getStatusList），再补本地统计的日活；
 * 2. data/open-platform.json 里的 pending 列表。SDK 目前一次扫码只带回一个机器人，
 *    其余已有机器人可以手工登记 AppID 后再补密钥接入。
 */

interface PendingAccount {
  appId: string;
  name?: string;
  addedAt?: number;
}

interface OpenPlatformState {
  bind?: {
    openid?: string;
    appId?: string;
    boundAt?: number;
    bindIp?: string;
  };
  pending?: PendingAccount[];
}

/** 自定义菜单：switch 开关、send_message 发消息、link 跳链接、menu 折叠子菜单 */
export type MenuItemType = 'switch' | 'send_message' | 'link' | 'menu';
export type SubMenuItemType = 'send_message' | 'link';

export interface MenuSwitch {
  switch_id?: string;
  default?: boolean;
}

export interface MenuSubItem {
  name?: string;
  type?: SubMenuItemType;
  send_message?: string;
  link?: string;
}

export interface MenuItem {
  name?: string;
  type?: MenuItemType;
  sub_menu_items?: MenuSubItem[];
  send_message?: string;
  link?: string;
  switch?: MenuSwitch;
}

export interface MenuConfig {
  items?: MenuItem[];
}

/** 指令面板：command 指令、link 跳链接 */
export type PanelItemType = 'command' | 'link';
export type PanelScope = 'c2c' | 'group' | 'channel' | 'dm';

export interface PanelItem {
  name?: string;
  desc?: string;
  type?: PanelItemType;
  only_admin?: boolean;
  link?: string;
}

export interface PanelConfig {
  items?: PanelItem[];
  remark?: string;
  version?: number;
}

export interface PanelRecord {
  panel_id?: string;
  scope?: string;
  target_type?: string;
  panel?: PanelConfig;
  created_at?: string;
  updated_at?: string;
  version?: number;
}

const PANEL_SCOPES = new Set<string>(['c2c', 'group', 'channel', 'dm']);
const RETRY_LOGGER = (m: string) => rootLogger.warn(`[开放平台] ${m}`);

/** 一次扫码接入的过程态，只存内存（重启即失效，重新扫即可） */
interface BindSession {
  id: string;
  taskId: string;
  /** 解密 AppSecret 用的 AES 密钥，只活在这段内存里 */
  key: string;
  message: string;
  createdAt: number;
  ip: string;
  /** 二维码链接；SDK 过期自动换新时会递增 version 并重新出图 */
  url: string;
  version: number;
  qrDataUrl: string;
}

async function renderQr(session: BindSession): Promise<void> {
  const QRCode = (await import('qrcode')).default;
  session.qrDataUrl = await QRCode.toDataURL(session.url, {
    width: 280,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#111111', light: '#ffffff' },
  });
}

const bindSessions = new Map<string, BindSession>();
/** 复用「连接管理」那套建连接逻辑，避免两处各写一份 */
const connectionsApi = new ConnectionsApiController();
/** 过程态最长保留 10 分钟 */
const BIND_TTL_MS = 10 * 60 * 1000;

function readState(): OpenPlatformState {
  return readJsonSafe<OpenPlatformState>(PATHS.openPlatform, {}, { label: 'open-platform.json' });
}

function writeState(s: OpenPlatformState): void {
  try {
    writeJsonAtomic(PATHS.openPlatform, s, { trailingNewline: true });
  } catch { /* 落盘失败不影响内存态 */ }
}

/** 清掉过期的过程态 */
function sweepBind(): void {
  const now = Date.now();
  for (const [k, v] of bindSessions) {
    if (now - v.createdAt > BIND_TTL_MS) bindSessions.delete(k);
  }
}

/** GET /users/@me 的响应形状，够 mapQqOfficialMeToProfile 用即可 */
interface QqMeResponse {
  id?: string;
  username?: string;
  avatar?: string;
  union_openid?: string;
  desc?: string;
  bio?: string;
  share_url?: string;
}

interface GuildInfo {
  id?: string;
  name?: string;
  icon?: string;
  member_count?: number;
  max_members?: number;
  description?: string;
}

interface ChannelInfo {
  id?: string;
  name?: string;
  type?: number;
}

@Controller('api/open-platform')
export class OpenPlatformController {
  @Get('state')
  state() {
    const s = readState();
    const bind = s.bind;
    return {
      ok: true,
      login: {
        bound: !!bind?.appId,
        openid: bind?.openid ?? '',
        appId: bind?.appId ?? '',
        boundAt: bind?.boundAt ?? 0,
        bindIp: bind?.bindIp ?? '',
      },
      accounts: this.buildAccounts(),
    };
  }

  private buildAccounts() {
    const statusMap = new Map(kakakeApp.connectionManager.getStatusList().map((x) => [x.id, x]));
    const configuredAppIds = new Set<string>();
    const accounts: Array<Record<string, unknown>> = [];

    for (const c of configService.getConnections().connections) {
      if (!isQqOfficialConnection(c)) continue;
      const st = statusMap.get(c.id);
      const appId = String(c.appId ?? '').trim();
      if (appId) configuredAppIds.add(appId);
      accounts.push({
        id: c.id,
        appId,
        name: st?.name || c.name,
        username: st?.botProfile?.username || '',
        avatar: st?.botProfile?.avatar || '',
        desc: st?.botProfile?.desc || '',
        unionOpenid: st?.botProfile?.unionOpenid,
        sandbox: c.sandbox ?? true,
        intents: c.intents,
        enable: c.enable,
        connected: st?.connected ?? false,
        shareUrl: st?.botProfile?.shareUrl,
        listenUrl: st?.listenUrl ?? '',
        mode: st?.mode ?? (c.mode === 'https' ? 'https' : 'forward'),
        webhookVerified: st?.webhookVerified,
        createdAt: c.createdAt,
        hasSecret: !!c.appSecret,
        pending: false,
        dau: appId ? getDauStats(appId) : null,
      });
    }

    for (const p of readState().pending ?? []) {
      const appId = String(p.appId ?? '').trim();
      if (!appId || configuredAppIds.has(appId)) continue;
      accounts.push({
        id: `pending:${appId}`,
        appId,
        name: p.name || '',
        username: '',
        avatar: '',
        desc: '',
        sandbox: true,
        enable: false,
        connected: false,
        listenUrl: '',
        mode: 'forward',
        hasSecret: false,
        pending: true,
        addedAt: p.addedAt ?? 0,
        dau: null,
      });
    }

    return accounts;
  }

  /** 起一次扫码接入：向 q.qq.com 开绑定任务，把二维码链接转成 dataURL 给前端展示 */
  @Post('qr')
  async qr(@Req() req: Request) {
    sweepBind();
    const id = randomUUID().slice(0, 12);
    const session: BindSession = {
      id,
      taskId: '',
      key: '',
      message: '等待扫码',
      createdAt: Date.now(),
      ip: remoteAddressOf(req),
      url: '',
      version: 0,
      qrDataUrl: '',
    };

    try {
      const { taskId, key } = await createBindTask();
      session.taskId = taskId;
      session.key = key;
      session.url = bindQrUrl(taskId);
      session.version = 1;
      await renderQr(session);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '获取二维码失败' };
    }

    bindSessions.set(id, session);
    return { ok: true, id, url: session.url, qrDataUrl: session.qrDataUrl, version: session.version };
  }

  /** 轮询扫码结果；成功后后端自动建连接，账号直接出现在列表里 */
  @Post('poll')
  async poll(@Body() body: { id?: string } = {}) {
    const id = String(body.id ?? '').trim();
    const session = bindSessions.get(id);
    if (!session) return { ok: false, stage: 'error', message: '扫码已结束，请重新生成二维码' };

    // 官方 task 过期后自动开一个新的，二维码跟着换
    let result: { status: string; bots: Array<{ appId: string; encryptedSecret: string; userOpenid?: string }> };
    try {
      result = await pollBindResult(session.taskId);
    } catch (e) {
      session.message = e instanceof Error ? e.message : '查询失败';
      return { ok: true, stage: 'pending', message: session.message, version: session.version };
    }

    if (result.status === 'expired') {
      try {
        const fresh = await createBindTask();
        session.taskId = fresh.taskId;
        session.key = fresh.key;
        session.url = bindQrUrl(fresh.taskId);
        session.version += 1;
        await renderQr(session);
      } catch { /* 换新失败就沿用旧图，下次轮询再试 */ }
      bindSessions.set(id, session);
      return {
        ok: true,
        stage: 'pending',
        message: '二维码已过期，已换新',
        version: session.version,
        qrDataUrl: session.qrDataUrl || undefined,
      };
    }

    if (result.status !== 'completed') {
      session.message = result.status === 'pending' ? '已扫码，请在手机上确认' : '等待扫码';
      return { ok: true, stage: 'pending', message: session.message, version: session.version };
    }

    bindSessions.delete(id);

    const added: string[] = [];
    let lastMessage = '';
    let openid = '';
    for (const bot of result.bots) {
      const appId = String(bot.appId ?? '').trim();
      if (!appId) continue;
      if (bot.userOpenid) openid = bot.userOpenid;
      let appSecret = '';
      try {
        appSecret = decryptBotSecret(session.key, bot.encryptedSecret).trim();
      } catch (e) {
        lastMessage = e instanceof Error ? e.message : 'AppSecret 解密失败';
        continue;
      }
      if (!appSecret) continue;

      const exists = configService.getConnections().connections
        .some((c) => isQqOfficialConnection(c) && String(c.appId ?? '').trim() === appId);
      if (exists) {
        added.push(appId);
        continue;
      }
      const res = await connectionsApi.addConnection({
        type: 'qq_official',
        appId,
        appSecret,
        sandbox: true,
        enable: true,
      });
      if (res && res.ok === false) {
        lastMessage = res.message || '创建连接失败';
        continue;
      }
      added.push(appId);
    }

    if (added.length === 0) {
      return { ok: false, stage: 'error', message: lastMessage || '未能接入任何机器人' };
    }

    const s = readState();
    s.bind = {
      openid: openid || undefined,
      appId: added[0],
      boundAt: Date.now(),
      bindIp: session.ip,
    };
    writeState(s);
    rootLogger.info(
      `[鉴权] 开放平台扫码接入成功（AppID ${added.join('、')}，来源 ${describeRemoteAddress(session.ip)}）`,
    );

    return { ok: true, stage: 'done', appIds: added, openid };
  }

  /** 取消当前扫码 */
  @Post('qr/cancel')
  cancelQr(@Body() body: { id?: string } = {}) {
    const id = String(body.id ?? '').trim();
    bindSessions.delete(id);
    return { ok: true };
  }

  /**
   * 按 AppID 探测机器人资料（GET /users/@me）。
   * 给了密钥就真实拉取；没给密钥只回传 AppID——腾讯没有「无密钥查机器人」的接口。
   */
  @Post('probe')
  async probe(@Body() body: { appId?: string; appSecret?: string; sandbox?: boolean } = {}) {
    const appId = String(body.appId ?? '').trim();
    if (!appId) return { ok: false, message: '请填写 AppID' };
    const secret = String(body.appSecret ?? '').trim();
    if (!secret) return { ok: true, appId, profile: null };

    const onRetry = (m: string) => rootLogger.warn(`[开放平台] ${m}`);
    try {
      const token = await fetchQqOfficialAccessToken(appId, secret, onRetry);
      const me = await qqOfficialApiRequest<QqMeResponse>({
        method: 'GET',
        path: '/users/@me',
        appId,
        accessToken: token.access_token,
        sandbox: body.sandbox ?? true,
        onRetry,
      });
      return { ok: true, appId, profile: mapQqOfficialMeToProfile(me) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '拉取机器人资料失败' };
    }
  }

  /** 登记一个尚未接入的机器人（只记 AppID，等补密钥） */
  @Post('pending')
  addPending(@Body() body: { appId?: string; name?: string } = {}) {
    const appId = String(body.appId ?? '').trim();
    if (!appId) return { ok: false, message: '请填写 AppID' };
    const s = readState();
    const list = s.pending ?? [];
    if (list.some((x) => x.appId === appId)) return { ok: true, duplicated: true };
    list.push({ appId, name: String(body.name ?? '').trim() || undefined, addedAt: Date.now() });
    s.pending = list;
    writeState(s);
    return { ok: true };
  }

  /** 移除登记的未接入账号 */
  @Post('pending/remove')
  removePending(@Body() body: { appId?: string } = {}) {
    const appId = String(body.appId ?? '').trim();
    const s = readState();
    s.pending = (s.pending ?? []).filter((x) => x.appId !== appId);
    writeState(s);
    return { ok: true };
  }

  /**
   * 已接入账号的全量官方数据：机器人资料 + 频道列表 + 网关接入点。
   * 频道列表只有私域机器人能拉到（公域会 403），这里吞掉当 0 处理。
   */
  @Get('insight')
  async insight(@Query('id') id: string) {
    const conn = configService.getConnections().connections.find((c) => c.id === id);
    if (!conn) return { ok: false, message: '账号不存在' };
    const cred = pickQqOfficialCredentials(conn);
    if (!cred) return { ok: false, message: '该账号未配置 AppID / AppSecret' };

    const onRetry = (m: string) => rootLogger.warn(`[开放平台] ${m}`);
    try {
      const token = await fetchQqOfficialAccessToken(cred.appId, cred.appSecret, onRetry);
      const me = await qqOfficialApiRequest<QqMeResponse>({
        method: 'GET',
        path: '/users/@me',
        appId: cred.appId,
        accessToken: token.access_token,
        sandbox: cred.sandbox,
        onRetry,
      });
      const profile: QqOfficialBotProfile = mapQqOfficialMeToProfile(me);

      let guilds: GuildInfo[] = [];
      try {
        const g = await qqOfficialApiRequest<{ guilds?: GuildInfo[] }>({
          method: 'GET',
          path: '/users/@me/guilds?limit=100',
          appId: cred.appId,
          accessToken: token.access_token,
          sandbox: cred.sandbox,
          onRetry,
        });
        guilds = g.guilds ?? [];
      } catch { /* 公域机器人无权拉取，忽略 */ }

      let gatewayUrl = '';
      try {
        const gw = await qqOfficialApiRequest<{ url?: string }>({
          method: 'GET',
          path: '/gateway',
          appId: cred.appId,
          accessToken: token.access_token,
          sandbox: cred.sandbox,
          onRetry,
        });
        gatewayUrl = String(gw.url ?? '');
      } catch { /* 网关地址非必需 */ }

      return {
        ok: true,
        profile,
        guilds: guilds.map((g) => ({
          id: String(g.id ?? ''),
          name: String(g.name ?? ''),
          icon: String(g.icon ?? ''),
          memberCount: Number(g.member_count ?? 0),
          maxMembers: Number(g.max_members ?? 0),
          description: String(g.description ?? ''),
        })),
        gatewayUrl,
        tokenExpiresIn: token.expires_in,
        fetchedAt: Date.now(),
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '拉取账号数据失败' };
    }
  }

  /** 频道下的子频道列表（GET /guilds/{guild_id}/channels） */
  @Get('channels')
  async channels(@Query('id') id: string, @Query('guildId') guildId: string) {
    const conn = configService.getConnections().connections.find((c) => c.id === id);
    if (!conn) return { ok: false, message: '账号不存在' };
    const cred = pickQqOfficialCredentials(conn);
    if (!cred) return { ok: false, message: '该账号未配置 AppID / AppSecret' };
    if (!guildId) return { ok: false, message: '缺少频道 ID' };

    const onRetry = (m: string) => rootLogger.warn(`[开放平台] ${m}`);
    try {
      const token = await fetchQqOfficialAccessToken(cred.appId, cred.appSecret, onRetry);
      const list = await qqOfficialApiRequest<ChannelInfo[]>({
        method: 'GET',
        path: `/guilds/${encodeURIComponent(guildId)}/channels`,
        appId: cred.appId,
        accessToken: token.access_token,
        sandbox: cred.sandbox,
        onRetry,
      });
      return {
        ok: true,
        channels: (Array.isArray(list) ? list : []).map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          type: Number(c.type ?? 0),
        })),
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '拉取子频道失败' };
    }
  }

  /* ---------- 自定义菜单与指令面板（bot.q.qq.com/wiki/develop/api-v2/server-inter/menu-panel） ---------- */

  /** 取账号凭据 + access token，失败统一成 { ok:false } 的形状返回给前端 */
  private async withToken(id: string): Promise<
    | { ok: true; cred: { appId: string; appSecret: string; sandbox: boolean }; token: string }
    | { ok: false; res: { ok: false; message: string } }
  > {
    const conn = configService.getConnections().connections.find((c) => c.id === id);
    if (!conn) return { ok: false, res: { ok: false, message: '账号不存在' } };
    const cred = pickQqOfficialCredentials(conn);
    if (!cred) return { ok: false, res: { ok: false, message: '该账号未配置 AppID / AppSecret' } };
    try {
      const t = await fetchQqOfficialAccessToken(cred.appId, cred.appSecret, RETRY_LOGGER);
      return { ok: true, cred, token: t.access_token };
    } catch (e) {
      return { ok: false, res: { ok: false, message: e instanceof Error ? e.message : '获取凭据失败' } };
    }
  }

  /** GET /v2/menu — 查询全局自定义菜单（仅单聊场景生效） */
  @Get('menu')
  async getMenu(@Query('id') id: string) {
    const auth = await this.withToken(id);
    if (!auth.ok) return auth.res;
    try {
      const data = await qqOfficialApiRequest<{ version?: number; menu?: MenuConfig }>({
        method: 'GET',
        path: '/v2/menu',
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        onRetry: RETRY_LOGGER,
      });
      return { ok: true, version: Number(data?.version ?? 0), items: data?.menu?.items ?? [] };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '查询自定义菜单失败' };
    }
  }

  /** PUT /v2/menu — 覆盖式修改全局自定义菜单 */
  @Put('menu')
  async putMenu(@Body() body: { id?: string; items?: MenuItem[] } = {}) {
    const auth = await this.withToken(String(body.id ?? ''));
    if (!auth.ok) return auth.res;
    try {
      const data = await qqOfficialApiRequest<{ version?: number }>({
        method: 'PUT',
        path: '/v2/menu',
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        body: { menu: { items: Array.isArray(body.items) ? body.items : [] } },
        onRetry: RETRY_LOGGER,
      });
      return { ok: true, version: Number(data?.version ?? 0) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '保存自定义菜单失败' };
    }
  }

  /** GET /v2/panels — 查询某场景下的指令面板列表 */
  @Get('panels')
  async getPanels(@Query('id') id: string, @Query('scope') scope: string) {
    const sc = PANEL_SCOPES.has(scope) ? scope : 'c2c';
    const auth = await this.withToken(id);
    if (!auth.ok) return auth.res;
    try {
      const data = await qqOfficialApiRequest<{
        records?: PanelRecord[];
        next_cursor?: string;
        is_end?: boolean;
      }>({
        method: 'GET',
        path: `/v2/panels?scope=${sc}&limit=50`,
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        onRetry: RETRY_LOGGER,
      });
      return {
        ok: true,
        scope: sc,
        records: Array.isArray(data?.records) ? data.records : [],
        isEnd: data?.is_end !== false,
      };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '查询指令面板失败' };
    }
  }

  /** POST /v2/panels — 创建指令面板 */
  @Post('panels')
  async createPanel(@Body() body: {
    id?: string;
    scope?: string;
    targetType?: string;
    userOpenids?: string[];
    groupOpenids?: string[];
    items?: PanelItem[];
    remark?: string;
  } = {}) {
    const auth = await this.withToken(String(body.id ?? ''));
    if (!auth.ok) return auth.res;
    const scope = PANEL_SCOPES.has(String(body.scope ?? '')) ? String(body.scope) : 'c2c';
    const specific = body.targetType === 'specific' && (scope === 'c2c' || scope === 'group');
    try {
      const data = await qqOfficialApiRequest<{ panel_id?: string }>({
        method: 'POST',
        path: '/v2/panels',
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        body: {
          scope,
          target_type: specific ? 'specific' : 'all',
          ...(specific && scope === 'c2c' ? { user_openids: body.userOpenids ?? [] } : {}),
          ...(specific && scope === 'group' ? { group_openids: body.groupOpenids ?? [] } : {}),
          panel: { items: Array.isArray(body.items) ? body.items : [], ...(body.remark ? { remark: body.remark } : {}) },
        },
        onRetry: RETRY_LOGGER,
      });
      return { ok: true, panelId: String(data?.panel_id ?? '') };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '创建指令面板失败' };
    }
  }

  /** PUT /v2/panels/{panel_id} — 修改指令面板内容 */
  @Put('panels/:panelId')
  async updatePanel(
    @Param('panelId') panelId: string,
    @Body() body: { id?: string; items?: PanelItem[]; remark?: string } = {},
  ) {
    const auth = await this.withToken(String(body.id ?? ''));
    if (!auth.ok) return auth.res;
    try {
      await qqOfficialApiRequest({
        method: 'PUT',
        path: `/v2/panels/${encodeURIComponent(panelId)}`,
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        body: { panel: { items: Array.isArray(body.items) ? body.items : [], ...(body.remark ? { remark: body.remark } : {}) } },
        onRetry: RETRY_LOGGER,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '修改指令面板失败' };
    }
  }

  /** DELETE /v2/panels/{panel_id} — 删除指令面板 */
  @Delete('panels/:panelId')
  async deletePanel(@Param('panelId') panelId: string, @Query('id') id: string) {
    const auth = await this.withToken(id);
    if (!auth.ok) return auth.res;
    try {
      await qqOfficialApiRequest({
        method: 'DELETE',
        path: `/v2/panels/${encodeURIComponent(panelId)}`,
        appId: auth.cred.appId,
        accessToken: auth.token,
        sandbox: auth.cred.sandbox,
        onRetry: RETRY_LOGGER,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '删除指令面板失败' };
    }
  }
}
