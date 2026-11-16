import path from 'node:path';
import { createRequire } from 'node:module';
import { PATHS } from '../paths.js';
import { readJsonSafe, writeJsonAtomic } from '../storage/atomic-file.js';

const require = createRequire(import.meta.url);

export function getFrameworkVersion(): string {
  try {
    const pkg = require(path.join(PATHS.root, 'package.json')) as { version?: string };
    const v = String(pkg.version || '').trim();
    return v || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export type AgreementRecord = {
  version: string;
  agreed: true;
  agreedAt: string;
};

function agreementDir(): string {
  return path.join(PATHS.data, 'agreement');
}

export function agreementFilePath(version = getFrameworkVersion()): string {
  const safe = version.replace(/[^\w.\-]+/g, '_');
  return path.join(agreementDir(), `${safe}.json`);
}

export function isAgreementAccepted(version = getFrameworkVersion()): boolean {
  const raw = readJsonSafe<Partial<AgreementRecord> | null>(agreementFilePath(version), null, {
    label: `agreement/${version}.json`,
  });
  if (!raw) return false;
  return raw.agreed === true && String(raw.version || '') === version;
}

export function markAgreementAccepted(version = getFrameworkVersion()): AgreementRecord {
  const record: AgreementRecord = {
    version,
    agreed: true,
    agreedAt: new Date().toISOString(),
  };
  writeJsonAtomic(agreementFilePath(version), record, { trailingNewline: true });
  stateCache = { at: Date.now(), version, agreed: true };
  return record;
}

const STATE_TTL_MS = 2000;
let stateCache: { at: number; version: string; agreed: boolean } | null = null;

export function getAgreementState() {
  const now = Date.now();
  if (stateCache && now - stateCache.at < STATE_TTL_MS) {
    return { version: stateCache.version, agreed: stateCache.agreed };
  }
  const version = getFrameworkVersion();
  const agreed = isAgreementAccepted(version);
  stateCache = { at: now, version, agreed };
  return { version, agreed };
}
