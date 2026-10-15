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
  return record;
}

export function getAgreementState() {
  const version = getFrameworkVersion();
  return {
    version,
    agreed: isAgreementAccepted(version),
  };
}
