/** 接口代理注册表总入口：按分类分文件的 entry 在此汇总，新分类要接进 PROXY_ENTRIES。 */
import type { ProxyApiEntry } from '../proxy.types.js';
import { messageEntries } from './entries/message.js';
import { mediaEntries } from './entries/media.js';
import { groupEntries } from './entries/group.js';
import { memberEntries } from './entries/member.js';
import { friendEntries } from './entries/friend.js';
import { accountEntries } from './entries/account.js';
import { systemEntries } from './entries/system.js';
import { guildEntries } from './entries/guild.js';
import { officialEntries } from './entries/official.js';
import { wildEntries } from './entries/wild.js';
import { nativeEntries } from './entries/native.js';

export const PROXY_ENTRIES: ProxyApiEntry[] = [
  ...messageEntries,
  ...mediaEntries,
  ...groupEntries,
  ...memberEntries,
  ...friendEntries,
  ...accountEntries,
  ...systemEntries,
  ...guildEntries,
  ...officialEntries,
  ...wildEntries,
  ...nativeEntries,
];

/** 短名索引，调用时的热路径 */
const BY_NAME = new Map<string, ProxyApiEntry>();

export function buildRegistryIndex(): Map<string, ProxyApiEntry> {
  if (BY_NAME.size === 0) {
    for (const entry of PROXY_ENTRIES) {
      BY_NAME.set(entry.name, entry);
      for (const alias of entry.alias ?? []) {
        // 别名不覆盖正式短名，也不互相覆盖（先到先得）
        if (!BY_NAME.has(alias)) BY_NAME.set(alias, entry);
      }
    }
  }
  return BY_NAME;
}

export function findEntry(name: string): ProxyApiEntry | undefined {
  return buildRegistryIndex().get(name);
}
