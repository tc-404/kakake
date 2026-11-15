import { Controller, Get } from '@nestjs/common';
import { PROXY_ENTRIES } from '../proxy/registry/index.js';
import type { ProxyApiEntry } from '../proxy/proxy.types.js';

/**
 * 「接口代理」注册表清单：把 PROXY_ENTRIES 整份发给控制台前端展示。
 *
 * 访问边界：这是控制台内部接口，**刻意不放进 auth.middleware.ts 的 PUBLIC_PREFIXES**——
 * 默认走登录中间件，未登录一律 401。注册表里含各协议的原生 action / path 与参数结构，
 * 属于实现细节，不该对外放 API 那样免鉴权可见。
 *
 * 返回的是条目原文（含 examples / impl），不是 ProxyApiSummary 摘要：
 * 控制台要点开一条看请求参数与三种返回示例，摘要会把这些剥掉。整份注册表几百 KB，
 * 一次读够即可，前端自行筛选，不再做分页 / 分类接口。
 */
@Controller('api/proxy')
export class ProxyRegistryController {
  @Get('apis')
  apis(): { ok: true; count: number; items: ProxyApiEntry[] } {
    return { ok: true, count: PROXY_ENTRIES.length, items: PROXY_ENTRIES };
  }
}
