import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import {
  DEFAULT_NAV_LAYOUT,
  NAV_HIDABLE,
  NAV_HREFS,
  navLayoutService,
  type NavLayout,
} from './nav-layout.service.js';

/**
 * 侧边栏导航自定义（顺序 + 隐藏）。
 *
 * 需要登录会话：这份配置属于实例本身，不该被未登录者读到或改掉。
 */
@Controller('api/nav-layout')
export class NavLayoutController {
  /** 当前布局 + 可隐藏白名单（前端据此决定哪一项显示叉号） */
  @Get()
  getNavLayout() {
    return {
      ok: true,
      layout: navLayoutService.getState(),
      hidable: [...NAV_HIDABLE],
      defaults: DEFAULT_NAV_LAYOUT,
      all: [...NAV_HREFS],
    };
  }

  @Put()
  saveNavLayout(@Body() body: Partial<NavLayout> = {}) {
    return { ok: true, layout: navLayoutService.save(body ?? {}) };
  }

  /** 恢复出厂：默认顺序 + 全部显示 */
  @Post('reset')
  resetNavLayout() {
    return { ok: true, layout: navLayoutService.reset() };
  }
}
