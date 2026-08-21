import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { PATHS } from '../paths.js';

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
  const file = agreementFilePath(version);
  if (!fs.existsSync(file)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AgreementRecord>;
    return raw.agreed === true && String(raw.version || '') === version;
  } catch {
    return false;
  }
}

export function markAgreementAccepted(version = getFrameworkVersion()): AgreementRecord {
  const dir = agreementDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const record: AgreementRecord = {
    version,
    agreed: true,
    agreedAt: new Date().toISOString(),
  };
  fs.writeFileSync(agreementFilePath(version), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
}

export function getAgreementState() {
  const version = getFrameworkVersion();
  return {
    version,
    agreed: isAgreementAccepted(version),
  };
}
