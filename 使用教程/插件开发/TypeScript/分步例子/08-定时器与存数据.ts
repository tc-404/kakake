// ⚠️ 片段：不能单独运行。演示 plugin_cleanup 收尾 + ctx.dataPath 持久化。
// TS 版：比 JS 版多了两处类型标注（timer 与 counter），其余一致。
//
// ========== 定时器、收尾、数据落盘 ==========
//
// 铁律：plugin_init 里挂了定时器 / 开了连接 / 订阅了事件，
// plugin_cleanup 里就必须收掉。不收的后果：插件每重载一次就多一个定时器，
// 越积越多，最后连日志都刷不动 —— 这是新手最常踩的内存泄漏。
//
// ctx.dataPath = 这个插件专属的数据目录（按机器人账号分开）。
// 要存文件就存这里：覆盖插件目录、重载插件、更新框架都不会丢。

import fs from 'node:fs';
import path from 'node:path';

// 挂在模块作用域，供 plugin_init 和 plugin_cleanup 共用
let timer: ReturnType<typeof setInterval> | null = null;

export async function plugin_init(ctx: any) {
  // 读回上次落盘的数据（第一次运行还没有文件，用默认值兜住）
  const file = path.join(ctx.dataPath, 'counter.json');
  let counter: { count: number } = { count: 0 };
  try {
    counter = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* 文件不存在或坏了就用默认值，别让插件起不来 */ }

  ctx.logger.info(`插件已加载，上次计数：${counter.count}`);

  // 每 10 秒计数 +1 并落盘（示例而已，真实插件按需来）
  timer = setInterval(() => {
    counter.count += 1;
    try {
      fs.writeFileSync(file, JSON.stringify(counter, null, 2), 'utf8');
    } catch (err: any) {
      ctx.logger.warn(`落盘失败：${err && err.message ? err.message : err}`);
    }
  }, 10 * 1000);
}

export async function plugin_cleanup(ctx: any) {
  // 收尾清单：清定时器（必做）、落盘（建议）、断连接（如有）
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  ctx.logger.info('插件卸载 / 重载：定时器已清理');
}
