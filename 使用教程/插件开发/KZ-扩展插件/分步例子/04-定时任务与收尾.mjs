// 分步 ④：定时任务与收尾
//
// 扩展插件最常见的用法就是「每隔一段时间做点什么」。
// 两条铁律：
//   1. 定时器 / 监听器 / 连接一律在 plugin_cleanup 里清掉，否则关了总开关它还在跑；
//   2. 回调里的异常自己 catch，别让一次报错把整个进程带崩（宿主虽有兜底，但日志会很难看）。

import fs from 'node:fs';
import path from 'node:path';

let timer = null;
let tick = 0;

export async function plugin_init(ctx) {
  // 30 秒一次，把计数写到 data/<插件ID>/heartbeat.json
  timer = setInterval(async () => {
    try {
      tick += 1;
      const file = path.join(ctx.dataPath, 'heartbeat.json');
      fs.writeFileSync(file, JSON.stringify({ tick, at: new Date().toISOString() }, null, 2), 'utf-8');
      ctx.logger.debug(`第 ${tick} 次心跳`);
    } catch (e) {
      ctx.logger.error('心跳失败：', e);
    }
  }, 30_000);

  // 不让定时器吊住进程退出（宿主关闭时仍会调 plugin_cleanup）
  timer.unref?.();

  ctx.logger.info('定时任务已启动（30s/次）');
}

export async function plugin_cleanup(ctx) {
  if (timer) clearInterval(timer);
  timer = null;

  // 需要落盘的收尾放这里：缓冲写文件、关闭数据库连接、清临时文件
  try {
    fs.writeFileSync(
      path.join(ctx.dataPath, 'last-exit.json'),
      JSON.stringify({ tick, at: new Date().toISOString() }, null, 2),
      'utf-8',
    );
  } catch { /* 收尾失败不要再抛，避免影响其它插件卸载 */ }

  ctx.logger.info('定时任务已停止');
}
