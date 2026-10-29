# 接口代理（src/proxy/）

把 **OneBot11/NapCat（180 接口）**、**SnowLuma（200 接口）**、**QQ 官方 API v2（65 接口）**
三套协议收敛为一层统一入口。插件只写 `kakake_api(短名, GET/POST, 参数)`，由 kakake 决定
这次实际分发到哪个协议。

原始接口合计 **445 个**，合并为约 **250~300 个统一短名**。

---

## 目录

| 路径 | 职责 |
|---|---|
| `proxy.types.ts` | 全部类型定义。改任何东西前先读这里的三条铁律注释 |
| `registry/_sources/*.json` | 三份上游源快照，**覆盖率门禁的唯一依据** |
| `registry/entries/*.ts` | 注册表条目（数据资产，按分类拆文件） |
| `registry/index.ts` | 装载、索引、自检 |
| `transport/errors.ts` | 失败信封合成（`failWith` / `asSuccess` / `asFailure`） |
| `transport/onebot.ts` | 传输层落地：OneBot 走 `callActionRaw`，官方走 `callRaw` |
| `resolve/target.ts` | 连接寻址规则（conn 参数 + 默认连接兜底），只认端口、可单测 |
| `resolve/impl-detect.ts` | NapCat / SnowLuma 识别（连接页下拉 + `get_version_info` 探测） |
| `resolve/target.kakake.ts` | 上面两块与 ConnectionManager / configService 的接线 |
| `translate/params.ts` | 统一参数 → 协议参数（map / const / transform / path 填充 / 路径键剥离） |
| `runtime/dispatcher.ts` | 分发主链路（10 步，每步都返回信封） |
| `runtime/hooks.ts` | before / after / error 三钩子，按作用域隔离 |
| `runtime/facade.ts` | 进程级单例 + 构造挂在插件 ctx 上的 `kakake_api` |

---

## 三条铁律

1. **返回值透传。** 上游给什么就返回什么，一个字段都不改。元信息挂在并列的 `_proxy`
   字段上，绝不污染原始字段。
2. **永不空返回。** 超时、报错、协议不支持、参数缺失，一律合成失败信封 resolve 回来。
   绝不 reject、绝不返回 `undefined` / `null`。
3. **协议不支持就是报错。** 野生机器人调官方专属能力（或反向），即便协议端可能「通」，
   也返回失败信封——除非显式传 `force: true` 探索。

---

## 常用命令

```bash
# 重新抓取三份上游源并生成快照（需要 _sources/_napcat 与 _botdocs 解压副本，见下）
npm run build:proxy-sources

# 覆盖率 + 一致性门禁。未覆盖的接口会被逐条列出
npm run check:proxy
```

`build:proxy-sources` 依赖 `_sources/_napcat/`（NapCatQQ 仓库的 action 目录）与
`_sources/_botdocs/`（bot-docs 的 api-v2 目录）。这两个目录不入库（见 .gitignore），
需要时用 `_sources/extract-subtree.py` 从仓库压缩包里解出来：

```bash
python _sources/extract-subtree.py napcat-repo.zip \
  "NapCatQQ-main/packages/napcat-onebot/action/" _napcat
python _sources/extract-subtree.py bot-docs.zip \
  "bot-docs-main/docs/develop/api-v2/" _botdocs
```

---

## 插件里怎么用

`ctx.kakake_api` 就是统一入口，形态是「接口名 + GET/POST + 统一参数」：

```ts
// 发一条群文本消息：kakake 决定落到 NapCat / SnowLuma / 官方哪一套
const res = await ctx.kakake_api('send_text', 'POST', {
  scene: 'group',                 // group / private / channel / dms，决定落到哪个原生接口
  group_id: 123456,               // 野生用 QQ 号
  group_openid: '9A0B...',        // 官方用 openid（二选一，按连接类型）
  message: '大家好',
});
if (res.status === 'ok') console.log(res.data.message_id);
else console.warn(res.message, res._proxy.failure);   // 失败也一定有值，绝不空返回
```

挂在同一个对象上的还有：

| 成员 | 用途 |
|---|---|
| `kakake_api(name, method, params, opts)` | 主调用。`opts.conn` 指定连接，`opts.throwOnError` 改回抛异常 |
| `kakake_api.before(fn)` | 发请求前。返回 `false` 拦截，返回对象则用该对象替换参数 |
| `kakake_api.after(fn)` | 拿到结果后（只读） |
| `kakake_api.error(fn)` | 失败时被通知，参数里带 `failure` / `message` / `meta` |
| `kakake_api.on.before/after/error` | 上面三个的另一种写法 |
| `kakake_api.list(filter?)` / `.get(name)` | 查注册表，插件自检能力用 |
| `kakake_api.native(action, params, opts)` | 逃生舱：跳过变体选择与参数翻译直连原生接口 |

三件事值得知道：

- **`_proxy` 是并列的元信息字段**，不会污染原始字段。里面有协议、连接、实际发出的
  原生接口名、耗时、`source`（哪个插件调的）等，排查问题时看它。
- **每次真实发往协议端的请求都会记运行日志**（前缀 `[代理输出:<作用域>]`，官方侧走
  「官方输出」分类）：请求记 info、成功结果记 debug、失败记 error，与旧调用通道
  （`[输出:xxx]` / `[官方输出:xxx]`）同一套习惯。前置上传与 call_native 也各记一行。
- **钩子按插件作用域隔离**，插件卸载时自动摘干净，不会泄漏到已销毁的上下文。
- **`conn` 不传时用事件来源的连接**；连事件上下文都没有（定时任务等）才回落到默认连接。

## 外放给外部调用

设置页打开「接口代理外放 API」开关后：

```bash
# 参数走 query
curl -H "Authorization: Bearer <控制台密钥>"   "http://<地址>:<端口>/api/v1/get_group_info?group_id=123456"

# 参数走 body
curl -X POST -H "Authorization: Bearer <控制台密钥>"   -H "Content-Type: application/json"   -d '{"scene":"group","group_id":123456,"message":"大家好"}'   "http://<地址>:<端口>/api/v1/send_text"
```

- 鉴权沿用控制台 Bearer 密钥，不另造一套凭证。
- 按「来源 IP + 接口短名」分桶限流（每分钟 60 次），**与登录限速是两套独立状态**——
  外放接口被打爆不会把登录入口一起锁死。
- 开关默认关闭。它是独立于「外放 API」（只读概览）的另一个开关，因为「能以机器人
  身份发消息」和「给外部看一眼运行状态」风险量级完全不同。
- HTTP 状态码的分工：代理层**受理**了请求就回 200，真实成败在 body 的信封里
  （那才是按原文档透传的产物）；401 密钥错 / 403 开关没开 / 404 没有这个短名 /
  429 限流，这些是 kakake 自己的边界，才用真实状态码。

## 连接页的「协议端实现」

NapCat 与 SnowLuma 都自称 OneBot v11，但部分接口的 action 名与参数键名不一致，
代理层必须知道对面坐的是谁。双保险：

1. **连接页下拉**（`连接管理 → 协议端实现`）显式指定 napcat / snowluma，指定了就不探测。
2. **自动识别**：连上后发一次 `get_version_info`，按 `app_name` 认实现，结果按连接缓存。

认不出来时按 NapCat 走（生态里最常见的那一个），并在 `_proxy.onebotImpl` 里记
`'unknown'`——不假装确定，让使用者知道该去连接页把实现名选对。

---

## 新增一条接口

1. 在 `registry/entries/<分类>.ts` 里加一个 `ProxyApiEntry`。
2. `name` 用简洁英文短名，`/^[a-z][a-z0-9_]{1,39}$/`；`title` 才是中文展示名。
3. `alias` 把全部原生 action / path 都塞进去，保证老接口名还能被搜到。
4. 每个协议给一份 `impl`；协议不提供的变体写 `stub: true` 并注明原因。
5. 补齐 `examples.request / success / error`，**示例要来自实测，不要编造**。
6. 跑 `npm run check:proxy` 确认没引入孤立引用。

---

## 已知硬限制

**QQ 号 ↔ openid 之间没有官方互转通道。** 野生机器人只有 QQ 号，官方机器人只有 openid。
代理层不猜测、不转换：检测到空间不匹配就不发请求，直接返回写明「需要什么 / 传入的
看起来是什么 / 为什么不能转 / 去哪儿拿正确的」的失败信封。

这不是偷懒——同一个 QQ 群在不同官方机器人下 `group_openid` 都不同，跨机器人的转换
缓存必然串号，静默出错比明确报错危害大得多。
