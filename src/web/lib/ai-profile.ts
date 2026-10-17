/**
 * AI 会话「当前生效档案」的解析规则。
 *
 * 单独放一个不依赖 DOM 的纯函数文件，是为了能用 node 单测把优先级规则钉死——
 * 这块出过一次静默错误：会话级档案被删掉后，界面会一直空着「选择模型」，
 * 而用户以为自己选好的模型「没被记住」。
 */

/**
 * 解析当前生效的档案 id。
 *
 * 规则（按优先级）：
 * 1. 会话自己指定了档案，且该档案确实存在 → 用它（**会话级优先**，一个会话可以有自己的模型）
 * 2. 档案列表还没加载出来（空数组）→ 不否决会话级值，直接采用，避免首帧闪成「未选择」
 * 3. 会话指定的档案已不存在，或会话没指定 → 回落到全局「当前使用」的档案
 *
 * @param sessionProfileId 会话上记录的档案 id（可能为空串或 undefined）
 * @param activeProfileId  全局「当前使用」的档案 id
 * @param knownProfileIds  当前已知的档案 id 列表；为空表示尚未加载
 */
export function resolveCurrentProfileId(
  sessionProfileId: string | undefined,
  activeProfileId: string,
  knownProfileIds: readonly string[],
): string {
  const own = (sessionProfileId || '').trim();
  if (own && (!knownProfileIds.length || knownProfileIds.includes(own))) return own;
  return (activeProfileId || '').trim();
}
