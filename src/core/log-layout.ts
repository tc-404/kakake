import type { ConnectionLogLayout } from './types.js';

export type LogAccountResolver = (prefix: string) => string | null;
export type LogLayoutResolver = (accountKey: string) => ConnectionLogLayout;

let accountResolver: LogAccountResolver = () => null;
let layoutResolver: LogLayoutResolver = () => 'legacy';

export function setLogAccountResolver(fn: LogAccountResolver): void {
  accountResolver = fn;
}

export function setLogLayoutResolver(fn: LogLayoutResolver): void {
  layoutResolver = fn;
}

export function resolveLogAccount(prefix: string): string | null {
  try {
    return accountResolver(prefix);
  } catch {
    return null;
  }
}

export function resolveLogLayout(accountKey: string): ConnectionLogLayout {
  try {
    return layoutResolver(accountKey);
  } catch {
    return 'legacy';
  }
}
