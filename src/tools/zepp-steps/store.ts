import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from '../../paths.js';
import type {
  ZeppAccount,
  ZeppAccountPublic,
  ZeppStepsFile,
  ZeppStepsPublic,
} from './types.js';

const DEFAULT_MIN = 18000;
const DEFAULT_MAX = 25000;

function emptyFile(): ZeppStepsFile {
  return { minStep: DEFAULT_MIN, maxStep: DEFAULT_MAX, accounts: [] };
}

export function maskUser(user: string): string {
  const u = String(user || '');
  if (u.length <= 8) {
    const ln = Math.max(Math.floor(u.length / 3), 1);
    return `${u.slice(0, ln)}***${u.slice(-ln)}`;
  }
  return `${u.slice(0, 3)}****${u.slice(-4)}`;
}

function clampStep(n: unknown, fallback: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(0, Math.min(100000, Math.floor(v)));
}

export function toPublic(file: ZeppStepsFile): ZeppStepsPublic {
  return {
    minStep: file.minStep,
    maxStep: file.maxStep,
    accounts: file.accounts.map((a): ZeppAccountPublic => ({
      id: a.id,
      user: a.user,
      userMasked: maskUser(a.user),
      enabled: a.enabled !== false,
      hasPassword: Boolean(a.password),
      lastRun: a.lastRun,
    })),
  };
}

export function loadZeppSteps(): ZeppStepsFile {
  const abs = PATHS.zeppSteps;
  if (!fs.existsSync(abs)) return emptyFile();
  try {
    const raw = JSON.parse(fs.readFileSync(abs, 'utf-8')) as Partial<ZeppStepsFile>;
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    return {
      minStep: clampStep(raw.minStep, DEFAULT_MIN),
      maxStep: clampStep(raw.maxStep, DEFAULT_MAX),
      accounts: accounts
        .filter((a) => a && typeof a.id === 'string' && a.user)
        .map((a) => ({
          ...a,
          enabled: a.enabled !== false,
          password: String(a.password || ''),
          tokens: a.tokens && typeof a.tokens === 'object' ? a.tokens : {},
          lastRun: a.lastRun ?? null,
        })),
    };
  } catch {
    return emptyFile();
  }
}

export function saveZeppSteps(file: ZeppStepsFile): void {
  const abs = PATHS.zeppSteps;
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const minStep = clampStep(file.minStep, DEFAULT_MIN);
  const maxStep = clampStep(file.maxStep, DEFAULT_MAX);
  const data: ZeppStepsFile = {
    minStep,
    maxStep: Math.max(minStep, maxStep),
    accounts: file.accounts,
  };
  fs.writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

export function findAccount(file: ZeppStepsFile, id: string): ZeppAccount | undefined {
  return file.accounts.find((a) => a.id === id);
}

export function upsertAccount(file: ZeppStepsFile, account: ZeppAccount): ZeppStepsFile {
  const idx = file.accounts.findIndex((a) => a.id === account.id);
  const next = { ...file, accounts: [...file.accounts] };
  if (idx >= 0) next.accounts[idx] = account;
  else next.accounts.push(account);
  return next;
}

export function createAccount(input: {
  user: string;
  password: string;
  enabled?: boolean;
}): ZeppAccount {
  return {
    id: randomUUID(),
    user: String(input.user || '').trim(),
    password: String(input.password || ''),
    enabled: input.enabled !== false,
    tokens: {},
    lastRun: null,
  };
}
