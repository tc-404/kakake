import { configService } from '../core/config.service.js';

export function inboundGuardEnabled(): boolean {
  return configService.getConfig().inboundGuard !== false;
}
