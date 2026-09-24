/**
 * 手动同步：token 续票 + 提交步数。移植自 TonyJiangWJ/mimotion（Apache-2.0）。
 */
import { randomUUID } from 'node:crypto';
import { beijingNowLabel, nowMsString } from './beijing.js';
import {
  checkAppToken,
  getUserDeviceId,
  grantAppToken,
  grantLoginTokens,
  loginAccessToken,
  normalizeUser,
  postFakeBandData,
} from './zepp-client.js';
import { loadZeppSteps, maskUser, saveZeppSteps, upsertAccount } from './store.js';
import type { ZeppAccount, ZeppLastRun, ZeppTokens } from './types.js';

const ACCOUNT_GAP_MS = 5000;

let running = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

async function resolveAppToken(
  account: ZeppAccount,
  logs: string[],
): Promise<{ appToken: string; tokens: ZeppTokens } | { error: string; tokens: ZeppTokens }> {
  const { user, isPhone } = normalizeUser(account.user);
  const tokens: ZeppTokens = { ...account.tokens };
  if (!tokens.deviceId) tokens.deviceId = randomUUID();

  const stamp = () => nowMsString();

  if (tokens.appToken) {
    const ok = await checkAppToken(tokens.appToken);
    if (ok) {
      logs.push('使用已保存的 app_token');
      return { appToken: tokens.appToken, tokens };
    }
    logs.push('app_token 失效，尝试续票');
  }

  if (tokens.loginToken) {
    const granted = await grantAppToken(tokens.loginToken);
    if ('appToken' in granted) {
      tokens.appToken = granted.appToken;
      tokens.appTokenTime = stamp();
      logs.push('用 login_token 重新获取 app_token 成功');
      return { appToken: granted.appToken, tokens };
    }
    logs.push(`login_token 失效：${granted.error}`);
  }

  if (tokens.accessToken) {
    const granted = await grantLoginTokens(tokens.accessToken, tokens.deviceId, isPhone);
    if ('loginToken' in granted) {
      tokens.loginToken = granted.loginToken;
      tokens.appToken = granted.appToken;
      tokens.userId = granted.userId;
      tokens.loginTokenTime = stamp();
      tokens.appTokenTime = stamp();
      logs.push('用 access_token 重新获取登录票据成功');
      return { appToken: granted.appToken, tokens };
    }
    logs.push(`access_token 失效：${granted.error}`);
  }

  if (!account.password) {
    return { error: '未保存密码，且登录票据已失效', tokens };
  }

  const login = await loginAccessToken(user, account.password);
  if ('error' in login) {
    logs.push(`登录获取 accessToken 失败：${login.error}`);
    return { error: `登陆失败！${login.error}`, tokens };
  }
  tokens.accessToken = login.accessToken;
  tokens.accessTokenTime = stamp();

  const granted = await grantLoginTokens(login.accessToken, tokens.deviceId, isPhone);
  if ('error' in granted) {
    logs.push(`登录提取的 access_token 无效：${granted.error}`);
    return { error: `登陆失败！${granted.error}`, tokens };
  }
  tokens.loginToken = granted.loginToken;
  tokens.appToken = granted.appToken;
  tokens.userId = granted.userId;
  tokens.loginTokenTime = stamp();
  tokens.appTokenTime = stamp();
  logs.push('账号密码登录成功');
  return { appToken: granted.appToken, tokens };
}

export async function runOneAccount(
  account: ZeppAccount,
  opts: { minStep: number; maxStep: number; fixedStep?: number },
): Promise<{ account: ZeppAccount; lastRun: ZeppLastRun }> {
  const logs: string[] = [];
  let step: number | null = null;
  try {
    if (!account.user || (!account.password && !account.tokens.appToken && !account.tokens.accessToken)) {
      const lastRun: ZeppLastRun = {
        at: beijingNowLabel(),
        ok: false,
        step: null,
        message: '账号或密码配置有误',
      };
      return { account: { ...account, lastRun }, lastRun };
    }

    const resolved = await resolveAppToken(account, logs);
    const tokens = resolved.tokens;
    if ('error' in resolved) {
      const lastRun: ZeppLastRun = {
        at: beijingNowLabel(),
        ok: false,
        step: null,
        message: `${logs.join('；')} ${resolved.error}`.trim(),
      };
      return { account: { ...account, tokens, lastRun }, lastRun };
    }

    if (typeof opts.fixedStep === 'number' && Number.isFinite(opts.fixedStep)) {
      step = Math.max(0, Math.min(100000, Math.floor(opts.fixedStep)));
    } else {
      step = randomInt(opts.minStep, opts.maxStep);
    }
    logs.push(`随机步数范围(${opts.minStep}~${opts.maxStep}) 本次：${step}`);

    let bound = tokens.boundDeviceId || null;
    if (!bound && tokens.userId) {
      bound = await getUserDeviceId(resolved.appToken, tokens.userId);
      if (bound) {
        tokens.boundDeviceId = bound;
        logs.push(`查找到已绑定设备ID: ${bound}`);
      }
    }

    const posted = await postFakeBandData(
      String(step),
      resolved.appToken,
      String(tokens.userId || ''),
      bound,
    );
    const lastRun: ZeppLastRun = {
      at: beijingNowLabel(),
      ok: posted.ok,
      step,
      message: `修改步数（${step}）[${posted.message}]${logs.length ? `；${logs.join('；')}` : ''}`,
    };
    return { account: { ...account, tokens, lastRun }, lastRun };
  } catch (e) {
    const lastRun: ZeppLastRun = {
      at: beijingNowLabel(),
      ok: false,
      step,
      message: e instanceof Error ? e.message : String(e),
    };
    return { account: { ...account, lastRun }, lastRun };
  }
}

export type ZeppRunResult = {
  ok: boolean;
  message: string;
  results: Array<{ id: string; userMasked: string; lastRun: ZeppLastRun }>;
};

export async function runZeppSteps(opts: {
  id?: string;
  step?: number;
}): Promise<ZeppRunResult> {
  if (running) {
    return { ok: false, message: '已有同步任务在执行，请稍后再试', results: [] };
  }
  running = true;
  try {
    let file = loadZeppSteps();
    const targets = opts.id
      ? file.accounts.filter((a) => a.id === opts.id)
      : file.accounts.filter((a) => a.enabled !== false);

    if (!targets.length) {
      return {
        ok: false,
        message: opts.id ? '找不到该账号' : '没有已启用的账号',
        results: [],
      };
    }

    const results: ZeppRunResult['results'] = [];
    const fixedStep = typeof opts.step === 'number' && Number.isFinite(opts.step)
      ? Math.floor(opts.step)
      : undefined;

    for (let i = 0; i < targets.length; i++) {
      const current = file.accounts.find((a) => a.id === targets[i].id);
      if (!current) continue;
      const { account, lastRun } = await runOneAccount(current, {
        minStep: file.minStep,
        maxStep: file.maxStep,
        fixedStep,
      });
      file = upsertAccount(file, account);
      saveZeppSteps(file);
      results.push({
        id: account.id,
        userMasked: maskUser(account.user),
        lastRun,
      });
      if (i < targets.length - 1) await sleep(ACCOUNT_GAP_MS);
    }

    const success = results.filter((r) => r.lastRun.ok).length;
    return {
      ok: success > 0,
      message: `执行 ${results.length} 个账号，成功 ${success}，失败 ${results.length - success}`,
      results,
    };
  } finally {
    running = false;
  }
}
