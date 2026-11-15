// 扩展插件（kz-plugin-*）示例：本地便签板
//
// 与机器人插件最大的不同：
//   1. 不绑任何连接 → 没有 plugin_onmessage / plugin_onevent，ctx.actions.call 也不可用；
//   2. 数据目录直接是 data/<插件ID>，没有账号层；
//   3. 只有「总开关」，打开即执行 plugin_init，关闭即执行 plugin_cleanup。
//
// 它做的三件事：声明配置项、挂三个本机接口、注册一个网页后台。

import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = { title: '便签板', maxNotes: 50, allowPublicRead: false };

// ── 配置项：控制台「插件配置」弹窗里的表单（卡片右下角齿轮按钮打开） ──
// 只有 string / multi-select 会把 description 显示出来，其余类型只显示 label。
export const plugin_config_schema = [
  {
    key: 'title',
    type: 'string',
    label: '面板标题',
    default: DEFAULTS.title,
    description: '显示在网页后台顶部，保存后立即生效。',
  },
  {
    key: 'maxNotes',
    type: 'number',
    label: '最多保留条数',
    default: DEFAULTS.maxNotes,
  },
  {
    key: 'allowPublicRead',
    type: 'boolean',
    label: '允许免登录只读',
    default: DEFAULTS.allowPublicRead,
  },
];

let config = { ...DEFAULTS };
let notes = [];
// ctx 存一份，给下面的小工具用（扩展插件只有一个实例，不存在串号问题）
let ctxRef = null;

const notesFile = (ctx) => path.join(ctx.dataPath, 'notes.json');

function readConfig(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(ctx.configPath, 'utf-8'));
    return { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...DEFAULTS };
  }
}

function readNotes(ctx) {
  try {
    const raw = JSON.parse(fs.readFileSync(notesFile(ctx), 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeNotes() {
  if (!ctxRef) return;
  fs.writeFileSync(notesFile(ctxRef), JSON.stringify(notes, null, 2), 'utf-8');
}

// ── 加载：读数据、挂接口、注册页面 ──
export async function plugin_init(ctx) {
  ctxRef = ctx;
  config = readConfig(ctx);
  notes = readNotes(ctx);

  // ① 需要登录的接口：页面里调 /api/Plugin/ext/<插件ID>/notes
  ctx.router.get('/notes', (req, res) => {
    res.json({ code: 0, data: { title: config.title, notes } });
  });

  ctx.router.post('/notes', (req, res) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) {
      res.status(400).json({ code: -1, message: 'text 不能为空' });
      return;
    }
    const max = Math.max(1, Number(config.maxNotes) || DEFAULTS.maxNotes);
    notes.unshift({ id: Date.now(), text, at: new Date().toISOString() });
    notes = notes.slice(0, max);      // 超出上限就丢最旧的
    writeNotes();
    res.json({ code: 0, data: { max } });
  });

  ctx.router.delete('/notes/:id', (req, res) => {
    const id = String(req.params.id);
    notes = notes.filter((n) => String(n.id) !== id);
    writeNotes();
    res.json({ code: 0 });
  });

  // ② 免登录接口：公网可达，只放无敏感信息的健康检查。
  //    这里演示「配置项能影响运行时行为」：allowPublicRead 关着就拒绝。
  ctx.router.getNoAuth('/health', (req, res) => {
    if (!config.allowPublicRead) {
      res.status(403).json({ code: -1, message: '未开放' });
      return;
    }
    res.json({ ok: true, count: notes.length, at: new Date().toISOString() });
  });

  // ③ 网页后台：控制台卡片上的「打开控制台」会打开它
  ctx.router.page({
    path: 'admin',
    title: '本地便签板',
    description: '添加 / 删除便签，数据存在 data/<插件ID>',
    htmlFile: 'webui/admin.html',
  });

  ctx.logger.info(`便签板已加载，数据目录：${ctx.dataPath}，现有 ${notes.length} 条`);
}

// ── 配置读写：实现了这两个钩子，保存配置不会重载插件，即时生效 ──
export function plugin_get_config() {
  return config;
}

export async function plugin_set_config(ctx, next) {
  // 合并式保存：只覆盖传进来的字段，避免把手写的其它键冲掉
  config = { ...config, ...(next && typeof next === 'object' ? next : {}) };
  // 注意：实现了 plugin_set_config，宿主就不再替你写 config.json —— 必须自己落盘
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2), 'utf-8');
  ctx.logger.info('配置已更新：', JSON.stringify(config));
}

// ── 卸载 / 重载：收尾（本例没有定时器，只提示一句） ──
export async function plugin_cleanup(ctx) {
  ctxRef = null;
  ctx.logger.info('便签板已卸载');
}
