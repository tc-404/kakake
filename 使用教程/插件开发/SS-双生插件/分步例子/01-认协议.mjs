// 分步 ①：认协议 —— 这是双生插件所有分支的起点
//
// 框架给了两个判别入口，挑一个用就行（别写两套互相打架的分支）：
//   · ctx.frameworkEnv.protocol  → 'onebot' | 'qq_official'（plugin_init 里也有值）
//   · 事件对象上的标记键          → event.onebot === true / event.qq_official === true
//
// 下面统一用两参签名 protocolOf(ctx, event)，跟其它分步例子和完整示例保持一致。

// 写法 A（推荐）：先读 frameworkEnv，拿不到再退到事件标记
function protocolOf(ctx, event) {
  const p = ctx.frameworkEnv?.protocol;
  if (p === 'onebot' || p === 'qq_official') return p;
  return event?.qq_official ? 'qq_official' : 'onebot';
}

// 写法 B：只读事件标记（适合把判断完全放在事件回调里的插件）
function protocolOfEvent(event) {
  return event?.qq_official ? 'qq_official' : 'onebot';
}

async function plugin_onmessage(ctx, event) {
  const p = protocolOf(ctx, event);
  if (p === 'qq_official') {
    ctx.logger.info('这条来自 QQ 官方机器人，事件名=' + event.t);
    return;
  }
  ctx.logger.info('这条来自 OneBot，post_type=' + event.post_type);
}

// —— 顺带：ob11Mode 是更细的一层 ——
// OneBot 恒为 'ws-server'；
// 官方按连接配置给 'qq-official-ws'（WebSocket）或 'qq-official-https'（Webhook）
function modeOf(ctx) {
  return ctx.frameworkEnv?.ob11Mode ?? 'ws-server';
}

// —— 补一句实现细节，免得被绕进去 ——
// 在事件回调里，frameworkEnv.protocol 是按**这条事件本身**重算的
// （src/plugin/sssx-plugin.manager.ts：事件带 t 字段就判官方，否则 OneBot），
// 不是去查连接表。日常两者结论一致，知道就行。

export { plugin_onmessage, protocolOf, protocolOfEvent, modeOf };
