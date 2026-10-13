import { Controller, Get, Post, Put, Delete, Body, Param, Req, Res, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  listProfiles,
  getProfile,
  getActiveProfile,
  upsertProfile,
  deleteProfile,
  activateProfile,
  toPublicProfile,
  fetchModels,
  testConnection,
  draftProfile,
  type AiProfile,
  type AiProtocol,
} from '../ai/ai-provider.js';
import {
  listSessions,
  getSession,
  saveSession,
  createSession,
  updateSessionMeta,
  deleteSession,
} from '../ai/ai-session.js';
import { isRunning, stopSession, runTurn, runningSessionIds, type PendingFile, type PendingImage } from '../ai/ai-agent.js';
import { clearVisionBlock } from '../ai/ai-provider.js';

/** 单条消息最多挂起的附件数，与 ai-agent 里的 ATTACH_MAX_FILES 对齐 */
const MAX_ATTACH_FILES = 5;
/** 单个附件接收上限（字符）：挡住超大 body，后续进上下文还有一道更严的截断 */
const MAX_ATTACH_CHARS = 200_000;

/**
 * 附件入参收口：这是外部输入，数量与体积都要先卡住。
 * 少这一道，一个请求就能把内存与会话 JSON 撑爆。
 */
function normalizeIncomingFiles(files: unknown): PendingFile[] {
  if (!Array.isArray(files)) return [];
  return files.slice(0, MAX_ATTACH_FILES).map((f) => {
    const o = (f || {}) as Partial<PendingFile>;
    return {
      name: String(o.name || '未命名').slice(0, 120),
      content: typeof o.content === 'string' ? o.content.slice(0, MAX_ATTACH_CHARS) : '',
    };
  });
}

/** 单条消息最多挂几张图 / 单张 base64 字符上限（与 ai-agent 的常量对齐，这里先挡一道） */
const MAX_ATTACH_IMAGES = 5;
const MAX_IMAGE_CHARS = 5_500_000;

/**
 * 图片入参收口：只放行上游真正接受的四种 MIME，体积与数量都卡住。
 * 这是外部输入，不设限一个请求就能把内存撑爆。
 */
function normalizeIncomingImages(images: unknown): PendingImage[] {
  if (!Array.isArray(images)) return [];
  const allowed = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
  return images
    .filter((i) => {
      const o = (i || {}) as Partial<PendingImage>;
      return typeof o.b64 === 'string' && o.b64.length > 0 && o.b64.length <= MAX_IMAGE_CHARS
        && allowed.has(String(o.mime || '').toLowerCase());
    })
    .slice(0, MAX_ATTACH_IMAGES)
    .map((i) => {
      const o = i as Partial<PendingImage>;
      return { name: String(o.name || '未命名').slice(0, 120), mime: String(o.mime).toLowerCase(), b64: o.b64 as string };
    });
}

@Controller('api/ai')
export class AiApiController {
  // ---------- 会话 ----------

  @Get('sessions')
  listSessionsApi() {
    const runningIds = runningSessionIds();
    const sessions = listSessions().map((s) => {
      // 自愈：落库状态为 running 但内存中没有对应的执行（进程重启/异常退出残留）→ 归位为已结束，
      // 否则列表会永远转圈
      if (s.status === 'running' && !runningIds.includes(s.id)) {
        updateSessionMeta(s.id, { status: 'idle' });
        return { ...s, status: 'idle' as const };
      }
      return s;
    });
    return { ok: true, sessions, runningIds };
  }

  @Post('sessions')
  createSessionApi(@Body() body: { title?: string; profileId?: string } = {}) {
    const profileId = body.profileId || getActiveProfile()?.id || '';
    const s = createSession(body.title || '新会话', profileId);
    const { messages: _m, ...meta } = s;
    return { ok: true, session: meta };
  }

  @Get('sessions/:id')
  getSessionApi(@Param('id') id: string) {
    const s = getSession(id);
    if (!s) throw new HttpException('会话不存在', 404);
    return { ok: true, session: s, running: isRunning(id) };
  }

  @Put('sessions/:id')
  updateSessionApi(@Param('id') id: string, @Body() body: { title?: string; profileId?: string } = {}) {
    const s = updateSessionMeta(id, body);
    if (!s) throw new HttpException('会话不存在', 404);
    const { messages: _m, ...meta } = s;
    return { ok: true, session: meta };
  }

  @Delete('sessions/:id')
  deleteSessionApi(@Param('id') id: string) {
    if (isRunning(id)) throw new HttpException('会话正在执行中，请先停止', 409);
    return { ok: deleteSession(id) };
  }

  /** 运行一轮任务（SSE 流式返回事件） */
  @Post('sessions/:id/run')
  async runTurnApi(
    @Param('id') id: string,
    @Body() body: { text?: string; files?: PendingFile[]; images?: PendingImage[] } = {},
    @Req() _req: Request,
    @Res() res: Response,
  ) {
    const text = String(body.text || '').trim();
    const files = normalizeIncomingFiles(body.files);
    const images = normalizeIncomingImages(body.images);
    // 只挂了文件/图片、没写说明也允许发送——附件本身就是本条消息的内容
    if (!text && !files.length && !images.length) throw new HttpException('消息不能为空', 400);
    if (isRunning(id)) throw new HttpException('该会话正在执行中', 409);
    await this.sseRun(res, id, text, files, images);
  }

  /** 重发/续跑：弹出尾部错误卡片；末条是用户消息则弹出重跑原文，否则按现有历史直接续跑 */
  @Post('sessions/:id/retry')
  async retryTurnApi(@Param('id') id: string, @Res() res: Response) {
    if (isRunning(id)) throw new HttpException('该会话正在执行中', 409);
    const s = getSession(id);
    if (!s) throw new HttpException('会话不存在', 404);
    while (s.messages.length && s.messages[s.messages.length - 1].role === 'assistant' && s.messages[s.messages.length - 1].isError) {
      s.messages.pop();
    }
    const last = s.messages[s.messages.length - 1];
    if (last?.role === 'user') {
      const text = last.content;
      // 重跑的是**原消息**，它挂的图片必须一起带走——否则重跑一次图就没了
      const images = last.images;
      s.messages.pop();
      saveSession(s);
      await this.sseRun(res, id, text, undefined, images);
      return;
    }
    // 断点在工具执行后（末条是 tool / assistant）：历史不动，直接续跑
    if (!s.messages.length) throw new HttpException('会话没有可重发的内容', 400);
    saveSession(s);
    await this.sseRun(res, id, '');
  }

  /** SSE 运行骨架（run / retry 共用） */
  private async sseRun(res: Response, id: string, text: string, files?: PendingFile[], images?: PendingImage[]): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const write = (event: unknown) => {
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch { /* 客户端断开 */ }
    };
    // 心跳注释行，防止中间层超时断流
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);

    try {
      await runTurn(id, text, write, files, images);
    } catch (err) {
      write({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      clearInterval(heartbeat);
      write({ type: '__end' });
      res.end();
    }
  }

  @Post('sessions/:id/stop')
  stopSessionApi(@Param('id') id: string) {
    return { ok: stopSession(id) };
  }

  // ---------- 上游档案 ----------

  @Get('providers')
  listProviders() {
    const profiles = listProfiles().map(toPublicProfile);
    const active = getActiveProfile();
    return { ok: true, activeId: active?.id || '', profiles };
  }

  @Post('providers')
  createProvider(@Body() body: Partial<AiProfile> & { name?: string; protocol?: AiProtocol }) {
    if (!body.name?.trim()) throw new HttpException('档案名称不能为空', 400);
    if (body.protocol !== 'openai' && body.protocol !== 'anthropic') {
      throw new HttpException('协议类型必须是 openai 或 anthropic', 400);
    }
    const p = upsertProfile({ ...body, name: body.name.trim(), protocol: body.protocol });
    return { ok: true, profile: toPublicProfile(p) };
  }

  @Put('providers/:id')
  updateProvider(@Param('id') id: string, @Body() body: Partial<AiProfile>) {
    const saved = getProfile(id);
    if (!saved) throw new HttpException('档案不存在', 404);
    try {
      const draft = { ...body };
      if (!draft.apiKey) delete draft.apiKey; // 空密钥 = 未修改，保留已存密钥
      const p = upsertProfile({
        ...draft,
        id,
        name: draft.name || saved.name,
        protocol: draft.protocol || saved.protocol,
      });
      // 用户重新勾上「图片识别」= 他想再试一次，清掉「该档案不支持图片」的运行时记忆。
      // 这条记忆本来就是因为真被上游拒过一次才置的，重新勾选算显式的人为复位。
      if (body.vision === true) clearVisionBlock(id);
      return { ok: true, profile: toPublicProfile(p) };
    } catch (err) {
      throw new HttpException(err instanceof Error ? err.message : '更新失败', 400);
    }
  }

  @Delete('providers/:id')
  deleteProvider(@Param('id') id: string) {
    return { ok: deleteProfile(id) };
  }

  @Post('providers/activate')
  activateProvider(@Body() body: { id?: string } = {}) {
    if (!activateProfile(String(body.id || ''))) throw new HttpException('档案不存在', 404);
    return { ok: true };
  }

  /** 复制档案（含密钥，前端拿不到密钥所以复制走后端） */
  @Post('providers/:id/copy')
  copyProvider(@Param('id') id: string) {
    const src = getProfile(id);
    if (!src) throw new HttpException('档案不存在', 404);
    const p = upsertProfile({ ...src, id: undefined, name: `${src.name} 副本` } as Partial<AiProfile> & { name: string; protocol: AiProtocol });
    return { ok: true, profile: toPublicProfile(p) };
  }

  /** 测试连接：body 可传已存档案 id，或整份草稿配置 */
  @Post('providers/test')
  async testProvider(@Body() body: Partial<AiProfile> & { id?: string }) {
    const r = this.resolveProfile(body, 'chat');
    if (!r.ok) throw new HttpException(r.message, 400);
    const out = await testConnection(r.profile);
    return { ...out, protocol: r.profile.protocol };
  }

  /** 拉取上游模型列表：body 可传已存档案 id，或整份草稿配置 */
  @Post('providers/models')
  async providerModels(@Body() body: Partial<AiProfile> & { id?: string }) {
    const r = this.resolveProfile(body, 'models');
    if (!r.ok) throw new HttpException(r.message, 400);
    return fetchModels(r.profile);
  }

  /**
   * 把请求体解析成一份可用于请求上游的档案。
   *
   * - 传 id：以已存档案为底，草稿字段覆盖（密钥留空 = 未修改，保留已存密钥）
   * - 不传 id：由草稿构造**临时档案，不落库**
   *
   * 按用途校验必填项，缺什么点名报什么。早期实现两种情况混在一起，
   * 缺任何一项都只回一句「找不到档案或配置不完整」，用户不知道该补哪一格；
   * 而且拉模型列表本来就不需要模型名——想拉列表得先填模型，等于先有鸡还是先有蛋。
   */
  private resolveProfile(
    body: Partial<AiProfile> & { id?: string },
    purpose: 'chat' | 'models',
  ): { ok: true; profile: AiProfile } | { ok: false; message: string } {
    let p: AiProfile | null = null;
    if (body.id) {
      const saved = getProfile(String(body.id));
      if (!saved) return { ok: false, message: '档案不存在，请先保存再试' };
      const draft = { ...body };
      if (!draft.apiKey) delete draft.apiKey; // 空密钥表示「未修改」，保留已存密钥
      p = {
        ...saved,
        ...draft,
        id: saved.id,
        name: body.name || saved.name,
        protocol: body.protocol || saved.protocol,
      } as AiProfile;
    } else {
      if (body.protocol !== 'openai' && body.protocol !== 'anthropic') {
        return { ok: false, message: '请先选择请求协议（OpenAI 兼容 / Anthropic）' };
      }
      p = draftProfile({ ...body, protocol: body.protocol });
    }

    if (!String(p.baseUrl || '').trim()) return { ok: false, message: '请先填写服务器地址' };
    if (!String(p.apiKey || '').trim()) return { ok: false, message: '请先填写 API Key' };
    if (purpose === 'chat' && !String(p.model || '').trim()) {
      return { ok: false, message: '请先填写模型名称（可点「获取模型」从上游拉取列表）' };
    }
    return { ok: true, profile: p };
  }
}
