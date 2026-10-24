import { Body, Controller, Get, Post, Put, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { isRequestAuthed } from './auth.middleware.js';
import { DEFAULT_LANG, languageService, type Lang } from './language.service.js';

/**
 * 控制台语言。
 *
 * 读取对未登录开放（`/api/language/public`）——登录页也要用同一门语言，
 * 否则「登录页中文、进去变英文」。写操作走 `/api/language`，需要登录会话：
 * 语言属于实例设置，不该被公网任何人改掉。
 */
@Controller('api/language')
export class LanguageController {
  @Get()
  getLanguage() {
    return { ok: true, lang: languageService.getState(), default: DEFAULT_LANG };
  }

  /** 免鉴权只读：供登录页与启动时的首次拉取 */
  @Get('public')
  getLanguagePublic() {
    return { ok: true, lang: languageService.getState(), default: DEFAULT_LANG };
  }

  @Put()
  saveLanguage(@Req() req: Request, @Body() body: { lang?: Lang } = {}) {
    // 路径虽在 admin 控制器里，仍显式挡一层：将来若有人把 /api/language 整段
    // 加进免鉴权白名单，这里不至于把写接口一起放出去。
    if (!isRequestAuthed(req)) throw new UnauthorizedException('Unauthorized');
    return { ok: true, lang: languageService.save(body ?? {}) };
  }

  /** 恢复出厂语言（中文） */
  @Post('reset')
  resetLanguage(@Req() req: Request) {
    if (!isRequestAuthed(req)) throw new UnauthorizedException('Unauthorized');
    return { ok: true, lang: languageService.reset() };
  }
}
