import { configService } from './config.service.js';
import { DEFAULT_API_TIMEOUT_MS, normalizeApiTimeoutMs } from './types.js';

export function apiTimeoutMs(): number {
  try {
    return normalizeApiTimeoutMs(configService.getConfig().apiTimeoutMs);
  } catch {
    return DEFAULT_API_TIMEOUT_MS;
  }
}
