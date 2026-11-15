import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { loadPluginDevTutorial } from '../tutorials/plugin-dev.tutorial.js';

@Controller('api/tutorials')
export class TutorialsController {
  @Get('plugin-dev')
  pluginDev(@Res() res: Response) {
    try {
      const data = loadPluginDevTutorial();
      return res.json({ code: 0, message: 'ok', data });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '读取教程失败';
      return res.status(404).json({ code: -1, message: msg });
    }
  }
}
