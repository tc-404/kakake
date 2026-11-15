import { Body, Controller, Get, Put, Req, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { isRequestAuthed } from './auth.middleware.js';
import { testFeatureService } from './test-feature.service.js';

@Controller('api/test-feature')
export class TestFeatureController {
  @Get()
  getState() {
    return { ok: true, ...testFeatureService.getState() };
  }

  @Put()
  saveState(@Req() req: Request, @Body() body: { enabled?: unknown } = {}) {
    if (!isRequestAuthed(req)) throw new UnauthorizedException('Unauthorized');
    return { ok: true, ...testFeatureService.setEnabled(body?.enabled) };
  }
}
