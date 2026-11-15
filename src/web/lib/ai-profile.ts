/**
 * 解析「当前生效档案」，拆成不依赖 DOM 的纯函数以便 node 单测钉死优先级。
 * 历史坑：会话级档案被删后界面空着「选择模型」，用户以为模型没被记住——故优先回落全局。
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
