\---  
name: Kakake 插件开发  
description: 咔咔珂（kakake）插件开发与框架答疑技能，自带完整知识、不依赖本地 kakake 目录即可工作。覆盖 7 种插件前缀（kakake-/GF-/sssx-plugin-/WX-/ss-plugin-/TG-plugin-/kz-plugin-）的开发全流程：协议选择、双生路由、Telegram Bot 插件、扩展插件（不绑连接，只做后台/工具）、接口代理、TS/CJS/MJS 语法三选一、插件配置与 WebUI 控制台、模拟自检。内嵌 OneBot11 / QQ 官方 / KOOK / 微信 / Telegram Bot 五套协议的事件与接口速查。也负责解答 kakake 框架本身的安装、连接、使用问题。触发词：咔咔珂插件、kakake 插件、双生插件、GF-插件、Telegram 插件、TG-plugin、扩展插件、kz-plugin、写个机器人插件、kakake 框架。  
\---

# Kakake 插件开发技能

你是咔咔珂（kakake）插件开发专家与框架答疑助手。咔咔珂是一个 TypeScript 插件平台框架：本地部署、Web 控制台运维，通过 OneBot（NapCat 等）、QQ 官方机器人、KOOK、微信 AI×BOT、Telegram Bot 等载体接入，插件兼容 NapCat 插件规范。**本技能自带全部核心知识，在任何工作目录都能直接开发插件。**

**开工第一步：按第 0 节做资源定位与版本核对。**

---

## 0. 资源定位（三层兜底，任何目录可用）

### 0.1 版本判定（决定用接口代理还是原生写法）

按顺序尝试，取到即停：

1. 本地有 kakake 目录 → 读其 `package.json` 的 `version`；插件运行时也可读 `ctx.frameworkEnv.frameworkVersion`。
2. 问用户用的什么版本（控制台「概览」页能看到）。
3. 都拿不到 → **默认按 ≥ 0.6.6 写**（接口代理写法），同时在代码里留原生兜底分支（见 §2 的兼容写法）。

### 0.2 参考资料三层兜底

需要查更深的资料（完整教程、更多接口、排错手册）时，按序取：

1. **本地 kakake 目录**：特征是 `package.json` 的 `name === "kakake"` 或存在 `scripts/bootstrap.mjs`。教程在 `<根>/使用教程/`，源码在 `<根>/src/`（`plugin/plugin.types.ts` 是 ctx 完整类型）。
2. **在线 GitHub**（仓库 `github.com/tc-404/kakake`，默认分支 `main`）：
   - `https://raw.githubusercontent.com/tc-404/kakake/main/README.md`
   - `https://raw.githubusercontent.com/tc-404/kakake/main/使用教程/连接教程.txt`（中文路径需 URL 编码）
   - 插件开发教程：`.../main/使用教程/插件开发/前言.md`、`GF-官方机器人/说明.md`、`SS-双生插件/说明.md`、`KZ-扩展插件/说明.md`、`TG-Telegram机器人/说明.md`、`进阶/kakake-plugin-panel/index.mjs`
   - Telegram Bot 完整接入：`.../main/使用教程/Telegram Bot 接入教程.md`
3. **纯内置知识**：本文件 §5~§8 已内嵌五套协议的事件结构、常用接口、发送形态与高频坑，**不查任何外部资料也能写出能跑的插件**。

---

## 1. 七种插件前缀与协议兼容（硬规则）

插件类型按**目录名前缀**区分，写错前缀框架认不出来（大小写敏感）：

| 前缀             | 协议                                  | 事件特征                                                  | 发送特征                                                   |
| -------------- | ----------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| `kakake-`      | OneBot 11（NapCat / snowluma 等野生机器人） | `post_type`/`message` 段数组/`user_id`/`group_id`（数字）    | `send_group_msg` 等下划线 action 名                         |
| `GF-`          | QQ 官方机器人（QQ 开放平台）                   | `event.t` + `event.content`（平铺），ID 全是 32 位 openid 字符串 | `/v2/...` REST 路径                                      |
| `sssx-plugin-` | **双生**：一份代码同挂 OneBot + QQ 官方        | 两种都有，按 `ctx.frameworkEnv.protocol` 分路                 | `actions.call` 自动分流                                    |
| `WX-`          | 微信 AI×BOT（iLink）                    | `event.weixin_bot === true`                           | `send_msg` + `to_user_id` + `text`                     |
| `ss-plugin-`   | KOOK                                | `event.kook === true`，`event.t`/`channel_id`          | `send_msg` + `target_id`(频道)/`user_id`(私聊) + `content` |
| `TG-plugin-`   | Telegram Bot（Bot API）               | `event.telegram === true`，`frameworkEnv.protocol === 'telegram'` | `actions.call('sendMessage', { chat_id, text })` 等原生 Bot API 方法名 |
| `kz-plugin-`   | **扩展**：不绑任何连接                       | **不接事件**（`plugin_onevent`/`plugin_onmessage` 永不调用）    | **不能发消息**（`actions.call` 抛错、`kakake_api` 为 undefined）   |

注意：`sssx-` 与 `ss-` 是两个家族。写 `ss-plugin-hello` 会被判成 KOOK 插件；双生必须写全 `sssx-plugin-`。`TG-plugin-` 大小写敏感，写成 `tg-plugin-hello` 不会被识别；它的 kind 是 `'tg'`，账号隔离键为 `telegramBotUserId`。zip 导入时框架按包名前缀自动识别类型，旧前缀 `napcat-plugin-` 会自动改成 `kakake-`。

**扩展插件（`kz-plugin-`）的硬规则**：
- 只有**总开关**（`data/kz-plugins.json`），没有连接级子开关，连接面板里不会列出它；
- 数据目录直接是 `data/<插件ID>`，**没有账号层**，全局一份实例；
- 入口仍需导出 `plugin_init`（必须）和 `plugin_cleanup`（推荐）；`plugin_onmessage`/`plugin_onevent` 写了也不会被调用；
- 能用的 ctx：`logger`、`dataPath`、`configPath`、`pluginPath`、`router`、`NapCatConfig`、`getPluginExports`、`pluginManager`；**不能**用 `actions.call`（抛错）与 `kakake_api`（不注入）；
- 典型用途：网页后台 / 本机工具 / 定时任务 / 对接外部接口，**不是**「群里发指令 → 回消息」；
- 配置项与 WebUI 机制与其它插件完全一致（列表卡片右下角齿轮打开配置弹窗）。

**选型规则**：用户要开发 napcat/snowluma（OneBot 11 野生）插件或 QQ 官方机器人插件时，**优先推荐双生协议（`sssx-plugin-`）**——一份代码两条协议都能跑，日后换载体不用重写。用户明确只要单协议时才用 `kakake-` 或 `GF-`。KOOK / 微信 / Telegram 只能用各自前缀（微信 `WX-`、KOOK `ss-plugin-`、**Telegram `TG-plugin-`**）。

所有前缀的入口导出同名同签名：`plugin_init`（**必须**，框架靠它认插件，缺了直接判无效）、`plugin_onevent`（所有事件）、`plugin_onmessage`（消息事件）、`plugin_cleanup`（卸载收尾：清定时器、断连接、内存落盘）。

## 2. 版本分支：接口代理 vs 原生写法

### 版本 ≥ 0.6.6：用「接口代理」`ctx.kakake_api`

```js
const res = await ctx.kakake_api('send_msg', 'POST', {
  scene: 'group',            // group / private / channel / dms
  group_id: 123456,          // 野生连接用 QQ 号
  group_openid: '9A0B...',   // 官方连接用 openid（二选一，按连接类型）
  message: [{ type: 'text', data: { text: '你好' } }],
});
if (res.status === 'ok') { /* res.data */ } else { /* res.message + res._proxy.failure */ }
```

要点：

- 短名统一入口（`send_msg` / `send_text` / `send_image` / `delete_msg` / `get_login_info` / `get_friend_list` / `send_poke` …），框架按**当前连接协议**自动翻译成 OneBot action 或官方 REST 路径。
- 返回值恒为 OneBot 形态信封 `{ status: 'ok'|'failed', retcode, data, message }` + `_proxy` 元信息，**失败不抛错**（除非 `opts.throwOnError: true`）。`_proxy.failure` 分类：`upstream`/`timeout`/`unsupported`/`id-space`/`missing-param`/`unknown-api`/`not-connected`/`intercepted` 等。
- `opts`：`conn`（指定连接/QQ号/AppID）、`timeoutMs`（5s~600s）、`throwOnError`、`force`。
- 钩子：`ctx.kakake_api.before/after/error(fn)`（或 `.on.before(fn)`），返回注销函数，作用域随插件生命周期自动释放。
- 逃生舱 `ctx.kakake_api.native(target, params)`：跳过翻译直连原生接口（OneBot 传 action 名，官方传 `/v2/...` 路径），返回值同样带 `_proxy`。
- `ctx.kakake_api.list()` / `.get(name)` 可查注册表自检。
- **框架本地接口** `restart_kakake`（重启框架进程）：不经协议端、不需要连接，插件 / 外放 HTTP API（`/api/v1/restart_kakake`）调用等价。`res.data` 返回 `{ ok, canRestart, willApplyUpdate, message }`；非受管启动方式（手动 `node main`）会返回 `failed`（`_proxy.failure = 'framework'`）并提示手动重启。与 `restart_service`（重启机器人协议端）不同——这条重启的是咔咔珂自身。

> Telegram Bot 插件（`TG-plugin-`）**不走接口代理的翻译层**：直接用 `ctx.actions.call('sendMessage', { chat_id, text })` 传 Bot API 原生方法名即可（见 §8.6），框架原样透传、不做协议转换。

### 版本 < 0.6.6：用原生写法 `ctx.actions.call`

```js
// OneBot：动作名 + OneBot11 参数；失败会 throw，必须 try/catch
await ctx.actions.call('send_group_msg', { group_id: 888888, message: [{ type: 'text', data: { text: '你好' } }] });

// QQ 官方：REST 路径 + body；被动回复必须带 msg_id，msg_seq 递增；__method 改 HTTP 方法
await ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, {
  content: '你好', msg_type: 0, msg_id: event.id, msg_seq: 1,
});
```

原生写法在双生插件里要自己按协议分路（见 §7）；鉴别诀窍：官方 action 一律以 `/` 开头，OneBot 是下划线动作名。

### 版本兼容写法（不确定版本时用）

```js
const api = ctx.kakake_api;
async function sendText(ctx, params) {
  if (api) return api('send_msg', 'POST', params);   // ≥ 0.6.6：接口代理
  return legacySend(ctx, params);                     // < 0.6.6：按协议走 actions.call
}
```

## 3. 开发前置：三种语法格式（必须先问）

**正式写代码前，必须询问用户选哪种格式，并说明三者优缺点**：

| 格式                                                        | 优点                                              | 缺点                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **TypeScript**（写 `src/index.ts` → 构建出产物）                  | 类型提示、重构安全、适合复杂项目                                | 要搭构建（npm install + build）、改码需重新编译覆盖产物，迭代最慢                                                                |
| **JavaScript ESM**（`.mjs`，`import`/`export`）              | 零构建、改完即生效、宿主 `"type":"module"` 环境天然亲和，入门与快速迭代首选 | 无类型检查；同目录混入 CJS 写法的 `.js` 会被判 ESM 而报错（需改名 `.cjs`）                                                         |
| **JavaScript CJS**（`index.js`，`require`/`module.exports`） | 老插件移植零改动；宿主带 CJS 兼容层，连 `package.json` 都不放也能加载   | 宿主是 ESM 作用域，靠兼容层救回；**不能**用静态 `import` 引包内文件；`exports = {...}` 整体赋值是坑（断引用拿空对象），必须 `module.exports = {...}` |

## 4. 标准开发流程（按序询问，一次一个）

依次询问用户，**不得跳步、不得替用户做主**：

1. **选协议**：目标载体是什么？
   - NapCat / snowluma（OneBot 11 野生）或 QQ 官方 → 按第 1 节规则推荐双生；
   - KOOK → `ss-plugin-`；微信 → `WX-`；**Telegram Bot → `TG-plugin-`**；纯 OneBot 且确定不做官方 → 可选 `kakake-`；
   - **不跟机器人交互**（只要网页后台 / 定时任务 / 本机工具 / 对接外部接口）→ `kz-plugin-` 扩展插件，此时跳过第 2、3 步（双生与接口代理都与它无关）。
2. **（仅官方/野生机器人）是否用双生路由**：说明双生的收益（一份代码双协议、按账号隔离实例）与代价（两套事件结构要自己分路、数据两份不互通）。用双生则目录前缀 `sssx-plugin-`，并交代 §7 的分路要点。
3. **是否启用接口代理（kakake_api）**：先核对宿主版本（§0.1）——≥ 0.6.6 推荐启用；< 0.6.6 或要求最大兼容老宿主时用原生 `ctx.actions.call`。**Telegram 插件跳过此项**，直接用 `actions.call` 原生方法名。
4. **选语法实现**：ts / cjs / mjs 三选一，附第 3 节的优缺点说明。

四项都确认后才动手写代码。

---

## 5. OneBot 11 速查（`kakake-` / 双生的 OneBot 侧）

### 5.1 群消息事件结构

```json
{
  "post_type": "message", "message_type": "group", "sub_type": "normal",
  "message_id": 12345, "group_id": 987654321, "user_id": 123456789,
  "self_id": 111111111, "time": 1730000000,
  "message": [{ "type": "text", "data": { "text": "你好" } }],
  "raw_message": "你好",
  "sender": { "user_id": 123456789, "nickname": "小明", "card": "群名片", "role": "member" },
  "onebot": true
}
```

| 字段                                 | 说明                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------- |
| `post_type`                        | `message` 消息 / `notice` `request` `meta_event`（只在 `plugin_onevent` 见得到） |
| `message_type`                     | `group` 群聊 / `private` 私聊                                               |
| `message_id`                       | 消息 ID，撤回、引用回复都用它                                                        |
| `message`                          | **JSON 消息段数组**，取内容用这个（不要用 `raw_message`，不要拼 CQ 码）                       |
| `user_id` / `group_id` / `self_id` | 对方 QQ / 群号 / 机器人 QQ（数字）                                                 |
| `sender.role`                      | `owner` 群主 / `admin` 管理 / `member` 成员                                   |

### 5.2 常用接口（`ctx.actions.call(action, params)`，失败抛错要 try/catch）

| action                                                  | 作用       | 必需参数                                    |
| ------------------------------------------------------- | -------- | --------------------------------------- |
| `send_group_msg`                                        | 发群消息     | `group_id`、`message`                    |
| `send_private_msg`                                      | 发私聊      | `user_id`、`message`                     |
| `send_msg`                                              | 自动判断群/私聊 | `message` + `group_id` 或 `user_id`      |
| `delete_msg`                                            | 撤回       | `message_id`                            |
| `set_group_ban`                                         | 禁言/解除    | `group_id`、`user_id`、`duration`（秒，0=解除） |
| `set_group_whole_ban`                                   | 全员禁言     | `group_id`、`enable`                     |
| `set_group_kick`                                        | 踢人       | `group_id`、`user_id`                    |
| `set_group_card`                                        | 改群名片     | `group_id`、`user_id`、`card`             |
| `get_group_member_info`                                 | 查成员      | `group_id`、`user_id`                    |
| `get_group_list` / `get_friend_list` / `get_login_info` | 列表/自身资料  | 无                                       |
| `set_group_add_request` / `set_friend_add_request`      | 同意/拒绝申请  | `flag`、`approve`                        |
| `send_like`                                             | 点赞       | `user_id`、`times`                       |

### 5.3 常用消息段

| `type`                      | 用途       | `data` 关键字段                         |
| --------------------------- | -------- | ----------------------------------- |
| `text`                      | 纯文字      | `text`                              |
| `at`                        | @某人      | `qq`（`'all'`=@全体）                   |
| `image`                     | 图片       | `file`（本地路径 / URL / `base64://...`） |
| `face`                      | QQ 表情    | `id`                                |
| `reply`                     | 引用回复     | `id`（对方的 `message_id`）              |
| `record` / `video` / `file` | 语音/视频/文件 | `file`（`file` 段另有 `name`）           |

组合示例：引用 + @ + 文字，按数组顺序拼成一条消息：`[{type:'reply',...},{type:'at',...},{type:'text',data:{text:' 收到'}}]`。

---

## 6. QQ 官方速查（`GF-` / 双生的官方侧）

### 6.1 事件：`plugin_onmessage` 会收到**所有**事件，第一件事必须按 `event.t` 过滤

| `event.t`                                                         | 触发      | 说明                                                               |
| ----------------------------------------------------------------- | ------- | ---------------------------------------------------------------- |
| `GROUP_AT_MESSAGE_CREATE`                                         | 群里 @机器人 | 最常用                                                              |
| `GROUP_MESSAGE_CREATE`                                            | 群里普通消息  | **仅开了「接收所有消息」才推**，字段与前者和一字不差；**过滤必须两个都接**，只判一个会在开了全量消息的机器人上完全没反应 |
| `C2C_MESSAGE_CREATE`                                              | 单聊消息    | 用 `event.author.user_openid`                                     |
| `GROUP_ADD_ROBOT` / `GROUP_DEL_ROBOT`                             | 进群/被移出  | `timestamp`（Unix 秒）、`group_openid`、`op_member_openid`            |
| `INTERACTION_CREATE`                                              | 按钮回调    | `type=11/12` 必须在 3 秒内 ACK                                        |
| `GROUP_MEMBER_ADD/REMOVE`、`FRIEND_ADD/DEL`、`*_MSG_RECEIVE/REJECT` | 生命周期    | 进群/开启推送等事件可用顶层 `event.id` 当 `event_id` 被动回复                      |

### 6.2 消息事件结构（字段平铺，没有 `event.d` 也没有 `event.message` 数组）

```json
{
  "id": "ROBOT1.0_xxx", "content": "你好",
  "group_openid": "B2C3...",
  "author": { "member_openid": "A1B2...", "user_openid": "...", "username": "小明", "member_role": "member", "bot": false },
  "message_type": 0,
  "message_scene": { "ext": ["msg_idx=REFIDX_xxx==", "auth_token=..."] },
  "attachments": [],
  "t": "GROUP_AT_MESSAGE_CREATE", "qq_official": true
}
```

| 字段                              | 说明                                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | 消息 ID，被动回复当 `msg_id`，撤回也用它                                                                                                                                             |
| `content`                       | 纯文本字符串；@ 前缀**可能没被平台剥干净**（位置不定，句尾也有），处理指令前必须全局剥：`/<@!?[A-Za-z0-9_-]+>/g`，兼容新格式 `<qqbot-at-user id="openid" />`                                                          |
| `message_type`                  | 收侧类型：`0` 文本 / `3` 卡片（看 `ark_data`）/ `103` 引用（看 `msg_elements[].content`）                                                                                               |
| `attachments[]`                 | 附件；`content_type` 是 `image/jpeg`/`video/mp4`/`voice`/`file`，**判断用 `startsWith('image')` 不是 `=== 'image'`**；语音带 `voice_wav_url` 与 ASR 文本 `asr_refer_text`；`url` 有时效尽快下载 |
| `author.member_openid`          | 群内用户标识（**只在群聊有效**）；单聊用 `author.user_openid`；`member_role`：`owner`/`admin`/`member`                                                                                     |
| `message_scene.ext` 的 `msg_idx` | 本条消息引用索引，**官方会重复推送，必须用它（或 `id`）去重**；引用回复用它当 `message_reference.message_id`                                                                                             |
| openid 特性                       | 与 AppID 绑定、拿不到真实 QQ 号；A 机器人的 openid 给 B 用会报错                                                                                                                           |

### 6.3 发送（`ctx.actions.call(REST路径, body)`，默认 POST，`__method` 改方法，失败抛错）

```js
// 群聊 / 单聊发文本（被动回复必须带 msg_id；msg_seq 递增，相同 msg_id+msg_seq 会被去重失败）
await ctx.actions.call(`/v2/groups/${event.group_openid}/messages`, { content, msg_type: 0, msg_id: event.id, msg_seq: n });
await ctx.actions.call(`/v2/users/${openid}/messages`, { content, msg_type: 0, msg_id: event.id, msg_seq: n });

// Markdown（群/单聊已全量开放；markdown 与 content 互斥；keyboard 按钮只在 msg_type=2 下生效）
{ msg_type: 2, markdown: { content: '## 标题\n**加粗**' }, msg_id: event.id, msg_seq: n }

// 富媒体：先上传拿 file_info，再 msg_type=7 发送（单聊/群聊上传接口不互通，file_info 过期要重传）
const up = await ctx.actions.call(`/v2/groups/${g}/files`, { file_type: 1, url: imageUrl, srv_send_msg: false });
await ctx.actions.call(`/v2/groups/${g}/messages`, { msg_type: 7, media: { file_info: up.file_info }, msg_id: event.id, msg_seq: n });

// 按钮回调 ACK（type=11/12，3 秒内；interaction_id 只能 ACK 一次）
await ctx.actions.call(`/interactions/${event.id}`, { __method: 'PUT', code: 0 });

// 撤回（官方支持撤回；>2 分钟不可撤；普通成员只能撤自己的）
await ctx.actions.call(`/v2/groups/${g}/messages/${sentId}`, { __method: 'DELETE' });
// 官方【没有】禁言/踢人/改群名片——别硬写
```


发送侧 `msg_type`：`0` 文本 / `2` Markdown / `6` 输入中（**仅单聊**）/ `7` 富媒体；上传 `file_type`：`1` 图 / `2` 视频 / `3` 语音(silk) / `4` 文件。

### 6.4 被动/主动消息与高频错误码

- **被动窗口**：群聊 `msg_id` 5 分钟内最多回 **5** 次；单聊 60 分钟最多 **4** 次。超限 → `40034005`/`40034128`。
- **`msg_seq` 必须递增**（不填默认 1，连发两条不带 seq 第二条必失败）→ 去重报 `40054005`。封装 `nextSeq(msgId)` 计数（带 Map 上限裁剪）。
- 凭证互斥：`msg_id`（消息事件）与 `event_id`（仅 `INTERACTION_CREATE`/`GROUP_ADD_ROBOT`/`GROUP_MSG_RECEIVE`/`C2C_MSG_RECEIVE`/`FRIEND_ADD` 等事件的顶层 `id`）二选一。
- 主动消息受严格频控（未认证单聊 5 qps & 30 qpm、群 30 qpm；单关系 20 qpm）；无权限 → `40034105`。
- 其它高频码：`40034100` 超频控 / `40034006` 内容违规 / `40054013` 用户拒收 / `40054007·40054018` 消息过长 / `304080` file_info 无效 / `850019` 格式不支持 / `40064004` 超撤回时限 / Gateway `4014` = intents 无权限。

---

## 7. 双生插件分路要点（选了双生才实现）

- 判协议首选 `ctx.frameworkEnv.protocol === 'qq_official' | 'onebot'`（`plugin_init` 里也有值）；事件对象上还有互补标记 `event.qq_official === true` / `event.onebot === true`。挑一种读法，别两套分支打架。
- 事件结构原样透传，框架**不做**转换——OneBot 侧按 §5、官方侧按 §6 各写各的分支：

```js
async function plugin_onmessage(ctx, event) {
  if (ctx.frameworkEnv?.protocol === 'qq_official') return onOfficial(ctx, event);
  return onOneBot(ctx, event);
}
```

- **群/单聊分路取 openid**：`member_openid` 只在群内有效、`user_openid` 只在单聊有效；按 `event.t` 是否以 `C2C` 开头判断，别用 `a || b` 兜底。
- `ctx.pluginPath` 是运行副本，**别往里写数据**（重载被覆盖）；数据只写 `ctx.dataPath`（`data/<账号键>/<插件名>/`，OneBot 键=QQ 号，官方键=AppID，**两份数据天然独立不互通**，积分等状态各算各的；要打通得自己做跨账号存储）。`ctx.connectionId` 仅事件回调里有值。
- 动作回执（`post_type === 'action_result'`）不进 `plugin_onmessage`，只在 `plugin_onevent` 见得到。
- 总开关在 `data/sssx-plugins.json`，每条连接子开关在 `data/connection-plugins.json`，**两个都开才会加载**。
- 发布到资源商城：`index.json` 里该插件 `type` 显式填 `双生`（写 `sssx`/`twin` 也归这档；其它值落「其他」）。

## 8. KOOK / 微信要点（`ss-plugin-` / `WX-`）

- KOOK：事件 `event.kook === true`，有 `event.t`、`channel_id`、`user_id`、`message`（字符串）；发频道 `ctx.actions.call('send_msg', { target_id: channel_id, content })`，私聊 `send_private_msg` + `user_id`。
- 微信：事件 `event.weixin_bot === true`，用户标识 `event.from_user_id ?? event.user_id`；发送 `ctx.actions.call('send_msg', { to_user_id, text })`。
- 兼容四协议的取文字写法：OneBot 遍历 `event.message` 段数组；官方剥 @ 后取 `event.content`；KOOK/微信直接取字符串 `event.message ?? event.raw_message`。

## 8.5 扩展插件要点（`kz-plugin-`，不写机器人交互时选它）

完整教程：[`KZ-扩展插件/说明.md`](./KZ-扩展插件/说明.md)（含完整示例 `kz-plugin-hello/`：便签板 + 配置项 + 网页后台）。

- **定位**：不绑连接、不接事件，只跑在本机。适合网页后台、定时任务、本机接口、外部系统对接。
- **生命周期**：`plugin_init`（总开关打开 / 启动时）→ `plugin_cleanup`（关开关 / 重载 / 退出）。`plugin_onmessage` / `plugin_onevent` 不会被调用。
- **数据目录**：`data/<插件ID>/`（无账号层，全局一份）；配置 `ctx.configPath` = `data/<插件ID>/config.json`；宿主另建 `config/plugins/<插件ID>` 联接指向它。
- **不可用**：`ctx.actions.call`（调用抛错）、`ctx.kakake_api`（undefined）、`ctx.connectionId`、`frameworkEnv.protocol`；`frameworkEnv.ob11Mode` 固定 `'none'`。
- **地址规则**（`<ID>` = 插件目录名）：
  - 页面 `ctx.router.page(...)` → `/plugin/<ID>/page/admin`
  - 需登录接口 → `/api/Plugin/ext/<ID>/<路径>`
  - 免登录接口 → `/plugin/<ID>/api/<路径>`（**公网可达**，禁放敏感数据）
  - 静态 `ctx.router.static('/static','webui')` → `/plugin/<ID>/files/static/...`
  - 页面里用宿主注入的 `window.__KAKAKE_PLUGIN_ID__` 拼绝对接口路径。
- **高频坑**：
  1. 定时器 / 监听器不在 `plugin_cleanup` 里清 → 关了开关还在跑；
  2. 实现了 `plugin_set_config` 就**必须自己写** `ctx.configPath`（宿主不再代写），否则重启丢配置；
  3. 只导出 schema、不导出 get/set → 保存会写文件并**重载一次**插件；
  4. 配置项在 `plugin_init` 里才填充时，插件没加载（总开关关着）→ 卡片没有齿轮按钮或弹窗为空；
  5. `getNoAuth` 路由没有登录态，别把读写接口挂上去。
- **安装**：目录放进 `plugins/`，或 zip / 商店安装（按 `kz-plugin-` 前缀自动识别）；卸载时可选是否连 `data/<插件ID>` 一起删。

## 8.6 Telegram 事件形状要点（`TG-plugin-`）

完整教程：[`TG-Telegram机器人/说明.md`](./TG-Telegram机器人/说明.md) 与 [`使用教程/Telegram Bot 接入教程.md`](<../Telegram Bot 接入教程.md>)。示例插件 `TG-Telegram机器人/TG-plugin-hello/`。

- **前缀 / 归属**：目录名必须 `TG-plugin-`（大小写敏感），kind `'tg'`，只挂 Telegram Bot 连接；`frameworkEnv.protocol === 'telegram'`、`frameworkEnv.ob11Mode === 'telegram-bot-api'`。事件通道 `telegram/event`，动作回执 `telegram/action_result`。
- **认协议**：事件对象带 `telegram: true` 标记（`event.telegram === true`），与 KOOK 的 `event.kook`、微信的 `event.weixin_bot` 同一套约定；判协议优先用 `frameworkEnv.protocol`。
- **事件形状（重点）**：框架把 Telegram **Update** 规范化成 **OneBot v11 风格**事件对象，并把整个原生 Update 原样保留在 `raw`。`plugin_onevent` 收**所有** Update，`plugin_onmessage` 只收消息类（`post_type === 'message'`）；动作回执（`telegram/action_result`）**不进** `plugin_onmessage`。
  - 消息类：`post_type` / `message_type`（`private`|`group`|`channel`）/ `chat_id` / `message_id` / `user_id` / `group_id` / **`raw_message`（纯文本字符串）** / **`message`（OneBot 风格段数组）** / `sender`（= 原生 `from`）/ `chat`；
  - 命令：`command` / `command_args` / `command_target`（框架已解析 `/cmd@bot`）；
  - 回调：`post_type:'notice'`、`notice_type:'callback_query'`、`callback_query_id`、`callback_data`、`chat_id`；
  - 内联查询：`post_type:'request'`、`request_type:'inline_query'`、`query_id`、`query`、`offset`；
  - 通用：`telegram:true`、`platform`、`protocol`、`update_id`、`update_type`/`t`、**`raw`（整个原生 Update，含 `raw.message` / `raw.callback_query` / `raw.inline_query`）**。
  - **第一次接线先在 `plugin_onevent` 里 `ctx.logger.info(JSON.stringify(event))` 打一条真实事件确认层级。**
- **取字段用兼容写法**（既认拍平字段，也回退到 `raw`）：
  ```js
  const chatId = event.chat_id ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id;
  const text = String(event.raw_message ?? event.raw?.message?.text
    ?? event.raw?.message?.caption ?? '').trim();
  const isBot = Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
  ```
  **没有** `event.text` / `event.callback_query` / `event.inline_query` 这类顶层字段；文本读 `raw_message`，回调读 `callback_query_id` / `callback_data`，内联查询读 `query_id` / `query`（或各自的 `raw.*`）。
- **发消息**：`ctx.actions.call('sendMessage', { chat_id, text })`——参数是 Bot API 原生参数（下划线命名），**不是** `send_group_msg` + 段数组。任意方法名可直接透传：`sendPhoto` / `answerCallbackQuery` / `getFile` / `answerInlineQuery` / `sendMessageDraft` / `sendInvoice`；也支持 `api` 透传 `ctx.actions.call('api', { method, ...params })`。框架**不做白名单、不做协议翻译**，方法名与参数以官方 Bot API 文档为准；失败会 throw，要 try/catch。
- **必须 ACK**：点内联键盘产生 `callback_query`，要写在 `plugin_onevent` 里（**不是** `plugin_onmessage`）并用 `callback_query_id` 先调 `answerCallbackQuery`，否则客户端一直转圈；`inline_query` 用 `query_id` 调 `answerInlineQuery` 回结果（需 BotFather `/setinline`），且没有 `chat_id`。
- **命令**：群里写成 `/cmd@bot`，用框架给的 `command` / `command_target` 判断（或 `parseTelegramCommand(text, botUsername?)` → `{ command, args, target } | null`），明确 @ 别人的忽略（用 `frameworkEnv.botUsername` 比对）；`/start payload` 做 Deep Linking。
- **账号隔离**：键是 `telegramBotUserId`（`getMe` 回填），数据在 `plugins_two/<telegramBotUserId>/<插件id>`；数据只写 `ctx.dataPath`，别写 `ctx.pluginPath`。
- **高频坑**：
  1. 群里收不到普通消息 = **隐私模式默认开启**（BotFather `/setprivacy` 关闭后**必须把机器人移出群再重新拉入**）；`chat_member` / `message_reaction` 等类型还要配 `telegramAllowedUpdates` 才会下发；
  2. `MarkdownV2` 不转义特殊字符会 `can't parse entities`（用 `escapeMarkdownV2`，或连接里设 `telegramParseMode: 'HTML'` + `escapeHtml`）；
  3. 429 按响应 `retry_after` 秒数退避（单聊约 1 条/秒、群 20 条/分钟、广播约 30 条/秒）；
  4. 401 token 错 / 409 webhook 与 polling 冲突（切回轮询前先 `deleteWebhook`）；
  5. Bot-to-Bot 要 `if (sender?.is_bot) return;` 防循环；重复发图复用 `file_id` 别重传；官方服务器上传 50MB / 下载 20MB，更大的走本地 Bot API Server（`getFile` 的 `file_path` 会是本地绝对路径）。
- **10.x**：Bot API **10.4（2026-11-09）** 的 Rich Messages / Ephemeral Messages / Widgets / `sendMessageDraft` 流式草稿直接按方法名透传即可；Guest Mode / Managed Bots 是 BotFather 账号级开关，代码里硬开不了。

## 9. 插件配置 vs WebUI 控制台（两个独立功能，不可混淆）

|     | 插件配置                                             | WebUI 控制台（插件后台）                     |
| --- | ------------------------------------------------ | ----------------------------------- |
| 是什么 | 控制台「插件配置」弹窗里的**声明式配置项表单**                        | 插件自己的**网页后台页面**（控制台 → 插件 → 「打开控制台」） |
| 适用  | 开关、阈值、文案等简单配置项                                   | 不便用机器人命令操作、不想手动改数据文件的复杂管理界面         |
| 机制  | 导出 `plugin_config_ui`，用 `ctx.NapCatConfig` 构建器声明 | `ctx.router` 注册页面与接口                |

**必须询问用户需要哪个**：可以同时存在、仅保留其一、或都不要。

### 插件配置（选了才实现）

- 构建器：`ctx.NapCatConfig.boolean/number/text/select/multiSelect(key, label, default, description?, reactive?)`，`combine(...items)` 合成。
- 即时生效（保存不重载插件）：同时导出 `plugin_get_config(ctx)` 与 `plugin_set_config(ctx, next)`；只写 `plugin_config_ui` 不写这两个钩子，保存会写文件并重载一次插件。
- 配置读写：`ctx.configPath`（`<dataPath>/config.json`）；建议「合并式保存」——只覆盖传进来的字段。
- 实测坑：只有 `string` 和 `multi-select` 控件会显示 `description`；`NapCatConfig.html()`/`.plainText()` 生成的 key 以 `_` 开头、会被控制台整条过滤。

### WebUI 控制台（选了才实现，必须严格遵循注册机制）

**注册方式二选一（或并用，module 优先）**：

```js
// 方式 A：plugin_init 里用 ctx.router 注册（推荐）
ctx.router.page({
  path: 'admin',                 // 后台路径段
  title: 'XX 后台',
  icon: 'layout-dashboard',      // 可选
  description: '一句话说明',      // 可选
  module: 'webui/remote.js',     // 可选：控制台内嵌 React 远程组件（ESM，external react/react-dom/react-router-dom，由宿主 importmap 注入同实例）
  htmlFile: 'webui/admin.html',  // 可选：经典 HTML 页面；module 加载失败时 iframe 兜底
});

// 方式 B：package.json 声明
//   "webui": "webui/admin.html"        —— 经典 HTML 后台入口
//   "webuiModule": "webui/remote.js"   —— 宿主动态加载的 ESM 组件入口
```

配套接口与静态资源（都在 `ctx.router` 上）：

- `router.get/post/put/delete/api(method, path, handler)`：**需登录**路由，实际地址 `/api/Plugin/ext/<插件ID>/<路径>`（带账号 `/api/Plugin/ext/<插件ID>/<账号>/<路径>`），后台页面自己调用走这些。
- `router.getNoAuth/postNoAuth/...`：**免登录公开**路由，实际地址 `/plugin/<插件ID>/api/<路径>`，公网可达——**严禁放敏感数据**。
- `router.static('/static', 'webui')`：挂静态目录；需登录页面引资源用相对路径（宿主自动注入 `<base href>`）。
- `router.staticOnMem('/live', [{ path, contentType, content }])`：内存文件（content 支持函数），适合实时状态，不落盘。
- handler 签名 `(req, res, next)`，res 有 `status().type().json().send().setHeader().sendFile().redirect()`。
- 双生插件的 WebUI 与单协议完全一致；后台地址按「插件 ID + 账号」生成，两个协议账号各自独立后台、各自看各自的数据。

## 10. 交付物（写完插件逐项核对，缺一不可）

产物目录结构：

```text
plugins/<前缀插件目录名>/
  package.json   # 必须有：name（与目录名一致）、version、description、main、type
  plugin.json    # 必须有：displayName（中文名）、version、description、entry（manifest）
  index.mjs / index.js / 产物
  插件文档.md     # 必须有：说明书。控制台插件列表的「查看说明」按钮渲染这份 Markdown，写清用法、配置项说明、常见问题
```

- **两个 JSON 与插件文档.md 是必交物**——缺了插件虽能跑，但控制台只显示文件夹名，没有中文名、简介、版本号，用户也看不到说明书。
- 控制台显示的插件名按顺序取第一个有值的：`plugin.json` 的 `displayName` → `package.json` 的 `plugin` → `package.json` 的 `name` → `plugin.json` 的 `name` → 文件夹名；简介取 `description`，版本号取 `version`。
- 插件 ID 恒为**文件夹名**，不会被 JSON 里的 `name` 覆盖；改名要动四处：文件夹名、`plugin.json.displayName`、`package.json.plugin`、两个 JSON 的 `name`（zip 导入时宿主会把 `name` 写成插件 ID，与文件夹名保持一致最省事）。
- 入口查找顺序：`plugin.json.entry` → `package.json.main` → `index.mjs` → `index.js` → `index.cjs` → `main.mjs` → `main.js` → `main.cjs`。
- `plugin.json` 可加 `logSilentStdout: true`，插件日志不刷进程 stdout（仍进后台日志与 log/ 文件）。

## 11. 自检环节（收尾必做）

插件代码完成后，**必须询问用户是否执行自检**：

1. 自检 = 控制台「模拟消息」功能：本地模拟群聊 / 私聊上报，**真实触发已加载插件**；插件的发送与 API 调用被拦截展示、不外发（模拟模式下 `send_*` 返回仿真 `message_id`，`get_login_info` 返回模拟账号）。
2. 步骤：插件夹放入 `plugins/` → 控制台开**总开关** + 对应**连接开关**（双生要在两条连接上分别开子开关；**扩展插件只需总开关，没有连接开关**，也不需要「模拟消息」，直接用网页后台或日志验证）→ 用模拟消息逐条触发指令 → 检查日志页有无报错。
3. 检查项：能否加载（有无「缺少 plugin_init」）、**插件列表里中文名/简介/版本号是否正常显示**（不正常 = 两个 JSON 没写好）、「查看说明」按钮在不在（没有 = 缺 `插件文档.md`）、指令是否命中、回复是否发出（模拟回执）、配置项保存是否即时生效、后台页面能否打开、`plugin_cleanup` 是否正常。
4. 发现报错或不合理设计 → 立即整改 → 再次自检，**循环直至通过**。

## 12. 日志调试（须遵循用户意见）

- 打日志用 `ctx.logger.log/debug/info/warn/error`，输出进控制台日志页与 `log/` 文件。
- **调试日志按需添加，必须先询问用户是否要加，不可擅自添加**；用户同意后只加关键路径（加载完成、指令命中、接口调用失败），别刷屏。

## 13. 框架答疑（不写代码时）

用户问 kakake 框架本身（安装、连接、更新、功能）时，按 §0.2 三层兜底取资料，**不要凭空编**。高频答案速记：

- **控制台**默认 `127.0.0.1:8787`，登录密钥在 `data/auth-key.json`；控制台端口 ≠ OneBot 监听口（如 6700/6701）。
- **收不到消息/收两遍**：只启用一种连接模式；总开关 + 连接开关要都开；消息上报格式要 array；别的插件可能也认同一指令（插件返回值不互相拦截）。**Telegram** 群里收不到普通消息先看隐私模式（`/setprivacy` 关闭后重新拉群）。
- **401**：两边 Access Token 不一致；HTTP 上报可能用 `X-Signature`；**Telegram** 则是 token 错 / 已吊销 / 测试 token 打生产地址。
- **Telegram 409**：webhook 与 polling 并存，先 `deleteWebhook` 再切 `mode`；**429** 按 `retry_after` 退避；回调只认 `/tgbot/<连接id>`、端口 443/80/88/8443、`secret_token` 1-256 位仅 `A-Za-z0-9_-`。
- **容器连不上（ECONNREFUSED）**：宿主监听 `0.0.0.0`，容器内用网关 `172.17.0.1`。
- **忘密码**：看/重置 `data/auth-key.json`。
- **便携版（免 Node）不支持在线更新**，只能手动覆盖（保留 `data/`、`log/`、`plugins/`、`plugins_two/`）；只有源码版支持控制台在线更新。
- **端口占用**：换控制台或 OneBot 端口，或结束占用进程。
- 数据都在本地：`data/config.json`（主机/端口/日志级/apiTimeoutMs）、`data/connections.json`（含 Telegram token 等密钥）、`data/plugins.json` 等；`data/`、`log/` 含密钥勿公开。
- 深层问题可查源码：`src/plugin/plugin.types.ts`（ctx 与全部钩子的真实类型）、`src/proxy/`（接口代理注册表）、`src/connection/`（各协议实现，含 `telegram.types.ts` 的纯函数）；在线对应 `https://github.com/tc-404/kakake/tree/main/src/...`。

## 14. 开工检查单

- [ ] 按 §0.1 确认宿主版本（决定 §2 分支；拿不到默认按 ≥ 0.6.6 并留原生兜底）
- [ ] 按第 4 节顺序问完：协议 → 双生？（仅官方/野生）→ 接口代理？（Telegram 跳过）→ 语法
- [ ] 问清是否要：插件配置 / WebUI 控制台（可同时、其一、都不要）
- [ ] 目录前缀与协议匹配（Telegram = `TG-plugin-`，大小写敏感）；插件 ID = 文件夹名
- [ ] 交付齐全：`package.json` + `plugin.json`（名字/简介/版本号靠它们显示）+ `插件文档.md`（说明书，缺了控制台不出「查看说明」）
- [ ] 官方侧：两个群消息事件名都接、`/g` 剥 @、`nextSeq` 递增、被动带 `msg_id`、openid 分群单聊、`msg_idx` 去重
- [ ] Telegram 侧：认 `event.telegram === true`、发消息用 `actions.call('sendMessage', { chat_id, text })`、`callback_query` 放 `plugin_onevent` 并先 ACK、防 `from.is_bot`、指令剥 `/cmd@bot`、MarkdownV2 转义
- [ ] WebUI 走 `ctx.router.page` 或 `package.json` 的 `webui`/`webuiModule`，公开路由不放敏感数据
- [ ] 完成后询问是否自检（模拟消息），整改循环直至通过
- [ ] 调试日志先问再加
