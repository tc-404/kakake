// 分步 ②：配置项（控制台卡片右下角齿轮 → 配置弹窗）
//
// 两种写法选一种即可：
//   A. 静态导出 plugin_config_schema（简单，不依赖 ctx）
//   B. plugin_init 里用 ctx.NapCatConfig 构建，塞进同一个导出数组（推荐）
// 本例用 B，并实现 get/set 两个钩子，让保存即时生效、不重载插件。

import fs from 'node:fs';

const DEFAULTS = { title: '我的扩展', maxItems: 20 };

// 导出的引用保持不变：init 里只替换数组内容
const plugin_config_ui = [];
let config = { ...DEFAULTS };

export async function plugin_init(ctx) {
  // 先把已保存的配置读进来，再按它构建表单默认值
  try {
    const saved = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
    config = { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    config = { ...DEFAULTS };
  }

  const C = ctx.NapCatConfig;
  plugin_config_ui.length = 0;
  plugin_config_ui.push(...C.combine(
    C.text('title', '面板标题', config.title, '只有文本框类型会显示这段说明'),
    C.number('maxItems', '最多条数', config.maxItems),
    C.select('mode', '运行模式', [
      { label: '只读', value: 'readonly' },
      { label: '可写', value: 'write' },
    ], 'readonly'),
  ));
}

// 控制台打开配置弹窗时读它
export function plugin_get_config() {
  return config;
}

// 点「保存」时调它；不实现这个钩子的话，宿主会写 config.json 并重载一次插件
export async function plugin_set_config(ctx, next) {
  config = { ...config, ...(next && typeof next === 'object' ? next : {}) };
  // 实现了这个钩子，写文件就得自己做（宿主不再代写），否则重启就丢
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
  ctx.logger.info('配置已更新：', JSON.stringify(config));
}

export { plugin_config_ui };
