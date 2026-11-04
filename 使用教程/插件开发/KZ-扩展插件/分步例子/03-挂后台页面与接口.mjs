// 分步 ③：网页后台 + 两类 HTTP 接口
//
// 地址规则（<ID> = 插件目录名）：
//   ctx.router.page(...)                 → /plugin/<ID>/page/admin
//   ctx.router.get('/data', fn)          → /api/Plugin/ext/<ID>/data      （需登录）
//   ctx.router.getNoAuth('/ping', fn)    → /plugin/<ID>/api/ping         （免登录，公网可达）
//   ctx.router.static('/static', 'webui')→ /plugin/<ID>/files/static/...

export async function plugin_init(ctx) {
  // ---- ① 页面：控制台卡片「打开控制台」打开的就是它 ----
  ctx.router.page({
    path: 'admin',                  // 页面路径段
    title: '我的扩展后台',
    description: '一句话说明',
    htmlFile: 'webui/admin.html',   // 相对插件根目录；也可以只给 module（ESM 远程组件）
  });

  // ---- ② 需登录接口：页面里用绝对路径调 ----
  ctx.router.get('/data', (req, res) => {
    res.json({ code: 0, data: { hello: 'world' } });
  });

  ctx.router.post('/data', (req, res) => {
    // req.body 由宿主解析好（JSON），req.query / req.params / req.headers 也都在
    res.json({ code: 0, data: { received: req.body ?? null } });
  });

  // ---- ③ 免登录接口：只放健康检查这类无敏感信息的 ----
  ctx.router.getNoAuth('/ping', (req, res) => {
    res.json({ ok: true });
  });

  // ---- ④ 静态资源与内存文件 ----
  ctx.router.static('/static', 'webui');   // plugins/<ID>/webui/** → /plugin/<ID>/files/static/**
  ctx.router.staticOnMem('/live', [
    {
      path: 'status.json',
      contentType: 'application/json; charset=utf-8',
      content: () => JSON.stringify({ at: Date.now() }),   // 支持函数：每次请求现算
    },
  ]);
}

// 后台页面里这样调（ID 由宿主注入）：
//
//   const ID = window.__KAKAKE_PLUGIN_ID__;
//   const API = `/api/Plugin/ext/${ID}`;
//   fetch(`${API}/data`).then(r => r.json()).then(r => console.log(r.data));
