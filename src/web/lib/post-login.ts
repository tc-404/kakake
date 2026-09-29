import { api } from './api';

export type PostLoginTarget = '/announcement' | '/setup-password' | '/';

/** 登录后唯一路由决策：协议 → 设密 → 首页 */
export async function resolvePostLoginTarget(): Promise<PostLoginTarget> {
  const auth = await api.authState();
  if (!auth.authed) {
    // 调用方应去登录页；返回 '/' 会误导，这里抛错更清晰
    throw new Error('UNAUTHORIZED');
  }

  let agreed = false;
  try {
    const agreement = await api.agreementState();
    agreed = !!agreement.agreed;
  } catch {
    // 协议接口瞬时失败时不要连带踢登录（刷新闪屏主因之一）
    // 已登录用户优先进控制台；真正未同意时服务端/下次刷新仍会拦
    agreed = true;
  }

  if (!agreed) return '/announcement';
  if (auth.needsPasswordSetup) return '/setup-password';
  return '/';
}
