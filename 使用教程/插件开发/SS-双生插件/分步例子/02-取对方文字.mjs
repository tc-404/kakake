// 分步 ②：取出对方文字（两条协议两套字段，别混用）
//
// OneBot  : event.raw_message（纯文本）或 event.message[]（消息段数组）
// 官方     : event.content（纯文本），里面混着 @ 标记，要自己剥

function protocolOf(ctx, event) {
  const p = ctx.frameworkEnv?.protocol;
  if (p === 'onebot' || p === 'qq_official') return p;
  return event?.qq_official ? 'qq_official' : 'onebot';
}

function getText(ctx, event) {
  // —— 官方：content 是纯文本，@ 标记要剥掉 ——
  if (protocolOf(ctx, event) === 'qq_official') {
    return String(event?.content ?? '')
      // 实测（log/2026-10-13.log 的真实群消息）：平台给的是**旧格式** `<@32位openid>`，
      // 而且位置不固定：
      //   "<@4D8F...> 你好呀"                 ← 开头（多数情况）
      //   " <@4D8F...> 肥鱼能咬吗"            ← 开头，还带一个前导空格
      //   "那你看看这个是什么<@4D8F...> "     ← 句尾！只剥开头的正则会漏掉这条
      //
      // 所以必须**全局剥**（注意 /g）。项目里既有的两处实现也都是全局的：
      //   GF-plugin-mkai          → RE_AT = /<@!?[A-Za-z0-9_]+>/g
      //   src/core/log-format.ts:346 → /<@([^>]*)>/g
      .replace(/<@[^>]*>/g, '')
      // 新格式 `<qqbot-at-user id="openid" />`：实测目前只在**发送侧**见到（框架自己拼的，
      // 见 src/core/log-format.ts:342），接收侧还没出现过；一并兼容以防平台切换。
      .replace(/<qqbot-at-user[^>]*>/gi, '')
      // 平台偶尔给 `@昵称` 这种纯文本形态。只剥开头的 —— 全局剥会误伤正常文本。
      .replace(/^(?:@\S+\s*)+/, '')
      .trim();
  }

  // —— OneBot：优先 raw_message，没有就从消息段里拼 text ——
  if (typeof event?.raw_message === 'string' && event.raw_message.trim()) {
    return event.raw_message.trim();
  }
  const segs = Array.isArray(event?.message) ? event.message : [];
  return segs
    .filter((s) => s && s.type === 'text')
    .map((s) => String(s?.data?.text ?? ''))
    .join('')
    .trim();
}

export { getText };
