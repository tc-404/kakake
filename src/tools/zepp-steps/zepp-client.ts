/**
 * Zepp Life / 华米接口客户端。
 * 流程移植自 TonyJiangWJ/mimotion（Apache-2.0）。
 */
import { randomUUID } from 'node:crypto';
import { encryptHuami } from './aes.js';
import { BAND_DATA_TEMPLATE } from './band-data-template.js';
import { beijingParts, nowMsString } from './beijing.js';

const ANDROID_UA = 'MiFit6.14.0 (M2007J1SC; Android 12; Density/2.75)';
const APP_NAME = 'com.xiaomi.hm.health';
const FALLBACK_DID = 'DA932FFFFE8816E7';

const LOGIN_TIMEOUT_MS = 8000;
const DEFAULT_TIMEOUT_MS = 12000;

export function normalizeUser(raw: string): { user: string; isPhone: boolean } {
  const user = String(raw || '').trim();
  if (!user) return { user: '', isPhone: false };
  if (user.startsWith('+86') || user.includes('@')) {
    return { user, isPhone: user.startsWith('+86') };
  }
  return { user: `+86${user}`, isPhone: true };
}

async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; json: Record<string, unknown>; location: string }> {
  const timeoutMs = init.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json: Record<string, unknown> = {};
  const text = await res.text();
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { raw: text };
    }
  }
  return {
    status: res.status,
    json,
    location: res.headers.get('location') || '',
  };
}

export async function loginAccessToken(
  user: string,
  password: string,
): Promise<{ accessToken: string } | { error: string }> {
  const qs = new URLSearchParams({
    emailOrPhone: user,
    password,
    state: 'REDIRECTION',
    client_id: 'HuaMi',
    country_code: 'CN',
    token: 'access',
    redirect_uri: 'https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html',
  }).toString();
  const body = encryptHuami(Buffer.from(qs, 'utf8'));
  const res = await fetch('https://api-user.zepp.com/v2/registrations/tokens', {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(LOGIN_TIMEOUT_MS),
    headers: {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'user-agent': ANDROID_UA,
      app_name: APP_NAME,
      appname: APP_NAME,
      appplatform: 'android_phone',
      'x-hm-ekv': '1',
      'hm-privacy-ceip': 'false',
    },
    body: new Uint8Array(body),
  });
  if (res.status !== 303) {
    return { error: `登录异常，status: ${res.status}` };
  }
  const location = res.headers.get('location') || '';
  const access = location.match(/access=([^&]*)/)?.[1];
  if (!access) {
    const err = location.match(/error=([^&]*)/)?.[1] || 'unknown';
    return { error: `获取accessToken失败 ${err}` };
  }
  return { accessToken: decodeURIComponent(access) };
}

export async function grantLoginTokens(
  accessToken: string,
  deviceId: string,
  isPhone: boolean,
): Promise<
  | { loginToken: string; appToken: string; userId: string }
  | { error: string }
> {
  const body = new URLSearchParams(
    isPhone
      ? [
          ['app_name', APP_NAME],
          ['app_version', '6.14.0'],
          ['code', accessToken],
          ['country_code', 'CN'],
          ['device_id', deviceId],
          ['device_model', 'phone'],
          ['grant_type', 'access_token'],
          ['third_name', 'huami_phone'],
        ]
      : [
          ['allow_registration=', 'false'],
          ['app_name', APP_NAME],
          ['app_version', '6.14.0'],
          ['code', accessToken],
          ['country_code', 'CN'],
          ['device_id', deviceId],
          ['device_model', 'android_phone'],
          ['dn', 'account.zepp.com,api-user.zepp.com,api-mifit.zepp.com,api-watch.zepp.com,app-analytics.zepp.com,api-analytics.huami.com,auth.zepp.com'],
          ['grant_type', 'access_token'],
          ['lang', 'zh_CN'],
          ['os_version', '1.5.0'],
          ['source', 'com.xiaomi.hm.health:6.14.0:50818'],
          ['third_name', 'email'],
        ],
  );
  const { json } = await fetchJson('https://account.huami.com/v2/client/login', {
    method: 'POST',
    headers: {
      app_name: APP_NAME,
      'x-request-id': randomUUID(),
      'accept-language': 'zh-CN',
      appname: APP_NAME,
      cv: '50818_6.14.0',
      v: '2.0',
      appplatform: 'android_phone',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    },
    body: body.toString(),
  });
  if (json.result !== 'ok') {
    return { error: `客户端登录失败：${String(json.result ?? 'unknown')}` };
  }
  const info = json.token_info as Record<string, unknown> | undefined;
  const loginToken = String(info?.login_token || '');
  const appToken = String(info?.app_token || '');
  const userId = String(info?.user_id || '');
  if (!loginToken || !appToken || !userId) {
    return { error: '提取login_token失败' };
  }
  return { loginToken, appToken, userId };
}

export async function grantAppToken(
  loginToken: string,
): Promise<{ appToken: string } | { error: string }> {
  const url =
    'https://account-cn.huami.com/v1/client/app_tokens'
    + `?app_name=${APP_NAME}`
    + '&dn=api-user.huami.com%2Capi-mifit.huami.com%2Capp-analytics.huami.com'
    + `&login_token=${encodeURIComponent(loginToken)}`;
  const { status, json } = await fetchJson(url, {
    headers: {
      'User-Agent': 'MiFit/5.3.0 (iPhone; iOS 14.7.1; Scale/3.00)',
    },
  });
  if (status !== 200) return { error: `请求异常：${status}` };
  if (json.result !== 'ok') {
    return { error: `请求失败：${String(json.error_code ?? json.result ?? 'unknown')}` };
  }
  const info = json.token_info as Record<string, unknown> | undefined;
  const appToken = String(info?.app_token || '');
  if (!appToken) return { error: '未返回 app_token' };
  return { appToken };
}

export async function checkAppToken(appToken: string): Promise<boolean> {
  const params = new URLSearchParams({
    r: '00b7912b-790a-4552-81b1-3742f9dd1e76',
    userid: '1188760659',
    appid: '428135909242707968',
    channel: 'Normal',
    country: 'CN',
    cv: '50818_6.14.0',
    device: 'android_31',
    device_type: 'android_phone',
    lang: 'zh_CN',
    timezone: 'Asia/Shanghai',
    v: '2.0',
  });
  const { status, json } = await fetchJson(
    `https://api-mifit-cn3.zepp.com/huami.health.getUserInfo.json?${params}`,
    {
      headers: {
        'User-Agent': ANDROID_UA,
        'hm-privacy-diagnostics': 'false',
        country: 'CN',
        appplatform: 'android_phone',
        'hm-privacy-ceip': 'true',
        'x-request-id': randomUUID(),
        timezone: 'Asia/Shanghai',
        channel: 'Normal',
        cv: '50818_6.14.0',
        appname: APP_NAME,
        v: '2.0',
        apptoken: appToken,
        lang: 'zh_CN',
        clientid: '428135909242707968',
      },
    },
  );
  return status === 200 && json.message === 'success';
}

export async function getUserDeviceId(
  appToken: string,
  userId: string,
): Promise<string | null> {
  try {
    const { json } = await fetchJson(
      `https://api-mifit-cn.huami.com/v1/device/binds.json?userid=${encodeURIComponent(userId)}`,
      {
        timeoutMs: LOGIN_TIMEOUT_MS,
        headers: {
          apptoken: appToken,
          'User-Agent': ANDROID_UA,
        },
      },
    );
    const items = Array.isArray(json.items) ? json.items as Record<string, unknown>[] : [];
    const pick = (item: Record<string, unknown>): string | null => {
      const raw = String(item.deviceId || item.mac || '').replace(/:/g, '').toUpperCase();
      return raw || null;
    };
    for (const item of items) {
      if (item.deviceType === 0) {
        const id = pick(item);
        if (id) return id;
      }
    }
    for (const item of items) {
      const name = String(item.productName || '').toLowerCase();
      if (['band', 'watch', '手环', '手表'].some((k) => name.includes(k))) {
        const id = pick(item);
        if (id) return id;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

export async function postFakeBandData(
  step: string,
  appToken: string,
  userId: string,
  deviceId?: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (!userId) {
    return { ok: false, message: '缺少 user_id，无法提交步数' };
  }
  const today = beijingParts().dateStr;
  const targetDevId = deviceId || FALLBACK_DID;
  let dataJson = BAND_DATA_TEMPLATE.replaceAll('2021-08-07', today);
  dataJson = dataJson.replace('ttl%5C%22%3A18272', `ttl%5C%22%3A${step}`);
  dataJson = dataJson.replaceAll(FALLBACK_DID, targetDevId);

  const t = nowMsString();
  const url = `https://api-mifit-cn.huami.com/v1/data/band_data.json?&t=${t}&r=${randomUUID()}`;
  const body =
    `userid=${encodeURIComponent(userId)}`
    + `&last_sync_data_time=1597306380`
    + `&device_type=0`
    + `&last_deviceid=${encodeURIComponent(targetDevId)}`
    + `&data_json=${dataJson}`;

  const { status, json } = await fetchJson(url, {
    method: 'POST',
    headers: {
      apptoken: appToken,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (status !== 200) {
    return { ok: false, message: `请求修改步数异常：${status}` };
  }
  const message = String(json.message ?? 'unknown');
  return { ok: message === 'success', message };
}
