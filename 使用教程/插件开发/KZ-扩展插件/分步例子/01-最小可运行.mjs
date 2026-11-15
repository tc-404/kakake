// 分步 ①：最小可运行的扩展插件
//
// 三个要点：
//   1. 目录名必须是 kz-plugin-*（本例 kz-plugin-minimal）；
//   2. 入口必须导出 plugin_init（框架靠它认插件）；
//   3. 扩展插件不收消息，所以不需要 plugin_onmessage。

export async function plugin_init(ctx) {
  // logger.info → 控制台「日志」页 + log/ 文件
  ctx.logger.info('扩展插件已加载');

  // dataPath 直接是 data/<插件ID>，没有账号层；目录框架已建好
  ctx.logger.info('我的数据目录：', ctx.dataPath);
  ctx.logger.info('我的配置路径：', ctx.configPath);

  // 扩展插件不绑连接，这三项能直接看出差异：
  ctx.logger.info('ob11Mode =', ctx.frameworkEnv?.ob11Mode);   // 'none'
  ctx.logger.info('connectionId =', ctx.connectionId);          // undefined
  ctx.logger.info('kakake_api =', typeof ctx.kakake_api);       // 'undefined'

  // 下面这行会抛错——扩展插件发不了消息，别写这种代码
  // await ctx.actions.call('send_group_msg', { group_id: 1, message: [] });
}

export async function plugin_cleanup(ctx) {
  // 总开关关闭 / 重载 / 进程退出时执行：清定时器、断连接、落盘
  ctx.logger.info('扩展插件已卸载');
}
