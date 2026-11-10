# Telegram Bot 接入教程（咔咔珂）

> 适用：咔咔珂（kakake）`type: 'telegram'` 连接，显示名 **Telegram Bot**。
> 本文对应的 Bot API 版本：**10.4（2026-11-09）**。涉及新增能力（Rich Messages、Ephemeral Messages、Widgets、`sendMessageDraft` 等）时，参数以 Telegram 官方 Bot API 文档为准，框架侧只负责把方法名与参数透传过去。
>
> 读完本文你应该能：建好机器人、按自己环境选对一种对接方式、把消息收发跑通、写出第一个 `TG-plugin-` 插件、并对照排错清单自行定位绝大多数问题。

---

## 目录

- [0. 先分清楚：三个维度，不是三选一](#0-先分清楚三个维度不是三选一)
- [1. @BotFather：建机器人与必开的开关](#1-botfather建机器人与必开的开关)
- [2. 在咔咔里添加 Telegram Bot 连接](#2-在咔咔里添加-telegram-bot-连接)
- [3. 方式一：getUpdates 长轮询（无需公网）](#3-方式一getupdates-长轮询无需公网)
- [4. 方式二：setWebhook（HTTPS 回调）](#4-方式二setwebhookhttps-回调)
- [5. 方式三：本地 Bot API Server](#5-方式三本地-bot-api-server)
- [6. 测试环境 `/bot<token>/test/METHOD`](#6-测试环境-bottokentestmethod)
- [7. 网络与代理 `telegramProxyUrl`](#7-网络与代理-telegramproxyurl)
- [8. Update 全类型表](#8-update-全类型表)
- [9. 消息与媒体](#9-消息与媒体)
- [10. 键盘、回调与内联查询](#10-键盘回调与内联查询)
- [11. 命令解析 `/cmd@bot` 与 Deep Linking](#11-命令解析-cmd@bot-与-deep-linking)
- [12. Inline Mode、Mini Apps 与 Stars 支付](#12-inline-mode迷你应用与-stars-支付)
- [13. 限频与 429 重试策略](#13-限频与-429-重试策略)
- [14. 隐私模式、MarkdownV2 转义、file_id 复用、Bot-to-Bot 防循环](#14-隐私模式markdownv2-转义file_id-复用bot-to-bot-防循环)
- [15. Bot API 10.x 新能力与在本框架里怎么调](#15-bot-api-10x-新能力与在本框架里怎么调)
- [16. 插件侧：开发 `TG-plugin-`](#16-插件侧开发-tg-plugin-)
- [17. 排错清单](#17-排错清单)
- [18. 配置字段速查表](#18-配置字段速查表)
- [19. 官方限制速查表](#19-官方限制速查表)

---

## 0. 先分清楚：三个维度，不是三选一

新手最容易把「三种对接方式」理解成互斥的三选一，其实它们分属**三个互相独立的维度**，可以任意组合：

| 维度 | 由谁决定 | 取值 | 管的是什么 |
|------|----------|------|------------|
| 怎么**收** Update | `mode` | `polling`（`getUpdates` 长轮询，默认） / `webhook`（`setWebhook` HTTPS 回调） | 框架从哪拿到事件 |
| API 请求**发去哪** | `telegramApiBase` | 留空 = 官方 `https://api.telegram.org`；填地址 = 本地 Bot API Server | 发消息 / 传文件走哪台服务器 |
| 走**生产还是测试** | `telegramTestEnv` | `false` / `true` | URL 里是否插入 `/test/` |

所以：

- `polling` + 官方服务器 + 生产环境 —— 本机开发最省事的组合，什么都不用额外配；
- `webhook` + 官方服务器 + 生产环境 —— 有公网域名的生产部署；
- `webhook` 或 `polling` + **本地 Bot API Server** —— 要传大文件 / 要本地绝对路径；
- 任意组合 + `telegramTestEnv: true` —— 在测试环境里调试，不碰真实会话。

**唯一的硬互斥**：同一个 token **不能同时** `setWebhook` 和 `getUpdates`，切换时必须先 `deleteWebhook`（否则 409，见 §17）。另外同一个 token 同一时刻只能挂在**官方服务器或某一个本地服务器**上，切换服务器要先 `logOut`（见 §5.2）。

---

## 1. @BotFather：建机器人与必开的开关

### 1.1 建机器人、拿 token

1. 在 Telegram 里搜索并打开 [@BotFather](https://t.me/BotFather)（认准蓝色认证标）。
2. 发送 `/newbot`。
3. 按提示先给**显示名**（可含空格、可中文，例如「咔咔测试机」），再给**用户名**（必须以 `bot` 结尾、全局唯一、只能用字母数字下划线，例如 `kakake_demo_bot`）。
4. BotFather 回一段文字，里面那串就是 **token**，形如：

   ```
   1234567890:AAH1b2c3d4e5f6G7h8i9j0K1l2M3n4O5p6Q
   ```

   `:` 左边是机器人 ID（`telegramBotUserId` 的来源），右边是密钥。

> **token 就是密码**。谁拿到它谁就能完全控制这个机器人：读消息、发消息、改设置。不要发到群里、不要截图、不要提交到 GitHub、不要写进插件配置里公开分发。泄露了立刻到 BotFather 用 `/revoke`（或 `/token`）重签，旧的马上失效。

### 1.2 把机器人加进群 / 开始私聊

- 私聊：搜索 `@kakake_demo_bot` → `Start`。
- 群聊：把机器人当成员拉进群；想让它当管理员（删消息、禁言）再单独提权。

### 1.3 BotFather 开关速查

给 @BotFather 发命令 → 选中你的机器人 → 按提示操作。**下面这些默认不一定开，用到哪个开哪个**：

| 命令 | 作用 | 什么时候必须开 |
|------|------|----------------|
| `/setprivacy` | 隐私模式开关 | **要收群里普通文本消息时必须关**（见 §14.1） |
| `/setcommands` | 设置指令菜单（输入框敲 `/` 时弹出的提示） | 想让 `/help` 等有补全提示 |
| `/setdescription` | 机器人简介（进资料页看到的短说明） | 锦上添花 |
| `/setabouttext` | 「关于」文本 | 锦上添花 |
| `/setuserpic` | 头像 | 锦上添花 |
| `/setinline` | **Inline Mode** | 要实现「任意聊天框输入 `@机器人 关键词` 出结果」时（见 §12.1） |
| `/setjoingroups` | 允许 / 禁止被拉进群 | 要进群就必须「允许」（默认通常是允许） |
| `/setdomain` | 绑定 Mini App / Web App 域名 | 要做 Mini Apps 时 |
| `/setinlinegeo` / `/setinlinefeedback` | Inline 位置 / 反馈相关 | 按业务需要 |
| `/token` / `/revoke` | 重签 token | 泄露或轮换凭证 |
| `/deletebot` | 删除机器人 | 不打算用了 |

**几个容易被忽略的「能力开关」**（10.x 起更常见，按需要在 BotFather 里开）：

- **Bot-to-Bot**：默认关闭，机器人之间不互发消息。开了之后必须自己做防循环（见 §14.4），否则两个机器人能把群刷爆。
- **Guest Mode / Managed Bots**：把机器人托管给第三方 / 让机器人在受限会话里工作，属于账号级能力，需要在 BotFather 显式开启，不是代码里能硬开的。
- **Inline Mode 反馈**：`/setinlinefeedback` 决定 `chosen_inline_result` 是否推送，影响你能否统计用户选了哪条 Inline 结果。

> 命令格式示例（`/setcommands`）：
> ```
> start - 开始使用
> help - 查看帮助
> ping - 连通性测试
> ```
> 每行一条，`命令 - 描述`，命令不要带 `/`、只能小写字母数字下划线、最长 32 字符。

### 1.4 测试环境的机器人

BotFather 里可以切到**测试环境**单独建一个机器人（见 §6）。测试环境的 token 与生产环境**不通用**：拿测试 token 打生产地址会 401，反之亦然。

---

## 2. 在咔咔里添加 Telegram Bot 连接

控制台 → **连接 → 添加 → Telegram Bot**，按下面填：

| 表单项 | 对应字段 | 填什么 |
|--------|----------|--------|
| 名称 | `name` | 随意，仅用于列表辨识 |
| 类型 | `type` | `telegram`（选 Telegram Bot 即自动） |
| Bot Token | `telegramToken` | §1.1 拿到的那串，**必填** |
| 接入方式 | `mode` | `polling`（默认） / `webhook` |
| Bot API 基址 | `telegramApiBase` | 留空走官方；填 `http://127.0.0.1:8081` 走本地服务器 |
| 测试环境 | `telegramTestEnv` | 调试时勾上 |
| Webhook URL | `telegramWebhookUrl` | `webhook` 模式必填，完整公网 HTTPS 地址 |
| Secret Token | `telegramWebhookSecret` | `webhook` 模式强烈建议填 |
| 最大连接数 | `telegramWebhookMaxConnections` | 1–100（本地服务器可更高），默认 40 |
| 固定投递 IP | `telegramWebhookIpAddress` | 不用 DNS、直接指定 Telegram 往哪个 IP 推 |
| 自签证书路径 | `telegramWebhookCertificatePath` | PEM 文件路径，作为 `certificate` 上传 |
| 订阅类型 | `telegramAllowedUpdates` | 数组，留空 = 框架默认全集 |
| 丢弃积压更新 | `telegramDropPendingUpdates` | 切换接入方式时勾上 |
| 轮询超时（秒） | `telegramPollingTimeout` | 默认 30 |
| 轮询上限 | `telegramPollingLimit` | 1–100，默认 100 |
| 起始 offset | `telegramOffset` | 一般不用手填，框架自动确认并持久化 |
| 代理地址 | `telegramProxyUrl` | 服务器直连不通时填，如 `http://127.0.0.1:7897` |
| 响应内直接回复 | `telegramWebhookReplyInResponse` | 把首个 API 调用塞进 webhook 2xx 响应体 |
| 文本解析模式 | `telegramParseMode` | `HTML`（默认，省心）/ `MarkdownV2` / `Markdown` / `Rich` |

### 2.1 保存后会发生什么

1. 框架调 `getMe` 验证 token 是否合法；
2. 回填 `telegramBotUserId`（机器人 ID）、`telegramBotUsername`（不带 `@` 的用户名）、`telegramBotFirstName`（显示名），连接列表里就能看到「@xxx · 长轮询」这样的摘要；
3. `telegramBotUserId` 成为**账号隔离键**：插件运行副本落在 `plugins_two/<telegramBotUserId>/<插件id>/`，多个机器人各跑各的、数据不互通；
4. 连接指纹按 `telegram|<telegramBotUserId>` 计算，导入去重、变更检测都靠它。

> 连接配置保存在 `data/connections.json`，**里面有明文 token**，这个文件不要公开、不要提交到仓库。

### 2.2 事件通道与插件族

| 概念 | 值 |
|------|----|
| 连接类型 | `type: 'telegram'` |
| 显示名 | `Telegram Bot` |
| 事件通道 | `telegram/event` |
| 动作回执通道 | `telegram/action_result` |
| 插件目录前缀 | `TG-plugin-` |
| 插件 kind | `'tg'` |
| 账号隔离键 | `telegramBotUserId` |
| `frameworkEnv.protocol` | `'telegram'` |
| `frameworkEnv.ob11Mode` | `'telegram-bot-api'` |
| 事件标记 | `event.telegram === true` |

---

## 3. 方式一：`getUpdates` 长轮询（无需公网）

### 3.1 什么时候用

- 本机开发、内网服务器、家里 NAS；
- 没有公网 IP / 域名 / 证书，也不想折腾反向代理；
- 机器人消息量不大（个人 / 小群）。

**优点**：零网络前提，启用就能收消息。**代价**：框架要主动维持一条长连接，进程停了期间的新消息要等恢复后才拉到（且最多保留 24 小时）。

### 3.2 逐步配置

1. 控制台 → 连接 → 添加 → Telegram Bot；
2. 填 `telegramToken`；
3. `mode` 选 **polling（长轮询）**；
4. 其它全部留默认；
5. 启用；
6. 给机器人私聊发一句 `你好`，看咔咔「日志」页有没有收到 `telegram/event`。

就这么多。不需要填 URL、不需要开端口映射。

### 3.3 offset：确认语义（最容易写错的地方）

`getUpdates` 用 `offset` 告诉服务器「这个 ID 之前的我都处理完了」。**正确公式是**：

```
下一次 offset = 本批处理过的最大 update_id + 1
```

- 填小了 → 同一批 update 反复下发（消息重复处理）；
- 填大了 → 中间的 update 被跳过（丢消息）；
- 框架会把 `telegramOffset` 持久化，重启后从上次确认的位置继续，**不要手填、不要清零**。

`telegramDropPendingUpdates: true` 的作用是切换接入方式时丢弃积压，等价于 `deleteWebhook?drop_pending_updates=True` / `getUpdates?offset=-1` 的语义，日常跑着别开。

### 3.4 `allowed_updates`：订阅哪些 Update

留空时框架用**默认全集**。注意 Telegram 有一批类型**默认不推送、必须显式订阅**，比如 `chat_member`、`message_reaction`、`chat_boost` 等。要处理这些事件，就在 `telegramAllowedUpdates` 里把它们列出来，例如：

```json
[
  "message", "edited_message", "callback_query", "inline_query",
  "my_chat_member", "chat_member", "message_reaction", "chat_join_request"
]
```

> `allowed_updates` 只对**你订阅的**类型生效，未订阅的类型服务器根本不会下发，插件里写再多判断也没用。完整类型见 §8。

### 3.5 `timeout` / `limit`

| 参数 | 范围 | 默认 | 说明 |
|------|------|------|------|
| `telegramPollingTimeout` | 秒（常用 0–50） | 30 | 长轮询挂起时长。越大请求次数越少、延迟越低；太小会空转刷请求 |
| `telegramPollingLimit` | **1–100** | 100 | 单次最多取回多少条 update |

> `limit` 官方硬性上限就是 **100**，填超过会被拒绝或截断。`timeout` 单位是**秒**不是毫秒。

### 3.6 退避重连与 24 小时保留

网络抖动 / 502 / 429 都会让长轮询断掉。框架侧的稳妥策略（也是你自己写轮询脚本时该照抄的）：

1. 单次失败不要立刻猛重试，按 `1s → 2s → 4s → 8s …` 指数退避，封顶（如 30–60s）；
2. 遇到 429 用响应里的 `retry_after`（秒）作为**最短**等待，不看自己的退避表；
3. 401（token 失效）**不要重试**，直接停用连接并报日志，重试只会刷屏；
4. 409 说明 webhook 还挂着，先 `deleteWebhook`；
5. 恢复后带上持久化的 `telegramOffset` 继续，别从头开始。

**Update 在 Telegram 服务器上最多保留 24 小时**。停机超过一天的消息会永久丢失，所以：

- 别把 Bot API 当消息队列 / 审计日志用；
- 需要可靠留存的，收到就立刻落到自己的库（`ctx.dataPath`）；
- 重要业务建议改用 `webhook` + 自己的持久化，或加一层外部队列。

### 3.7 自检清单

```
[ ] 连接列表摘要显示 @用户名 · 长轮询
[ ] 私聊发 /start，日志出现 telegram/event
[ ] 群里发普通文本也能收到（否则看 §14.1 隐私模式）
[ ] 停掉咔咔、发几条消息、再启动 → 消息被补拉且不重复
[ ] 日志里没有反复出现的 401 / 409 / 429
```

---

## 4. 方式二：`setWebhook`（HTTPS 回调）

### 4.1 硬性前提

Webhook 是 **Telegram 服务器主动 POST 到你的地址**，所以必须满足：

| 条件 | 要求 |
|------|------|
| 协议 | **HTTPS**，必须可信证书（自签证书要按 §4.7 上传） |
| 端口 | **只接受 443 / 80 / 88 / 8443**，其它端口一律拒绝 |
| 地址 | 公网可达的域名或 IP，不能是 `127.0.0.1` / 内网地址 |
| 证书 | CN / SAN 必须与 `telegramWebhookUrl` 里的域名匹配 |
| 路径 | 固定 `/tgbot/<连接id>` |

> 80 端口虽在允许列表里，但 webhook 仍要求 HTTPS；80 通常只用于本地 Bot API Server 场景或重定向，别指望明文 HTTP 能直接收生产 webhook。

### 4.2 回调地址 `/tgbot/<连接id>`

咔咔为每个 Telegram 连接分配一个 id，回调路径固定为：

```
https://bot.example.com/tgbot/<连接id>
```

`<连接id>` 在控制台连接列表里能看到（也可在 `data/connections.json` 里查 `id`）。**反代必须把这一段路径原样转发到咔咔**，不要重写、不要去掉前缀。

`telegramWebhookUrl` 就填这个完整地址。填入后框架会替你调 `setWebhook`。

### 4.3 `secret_token` 校验

`setWebhook` 支持一个 `secret_token` 参数：Telegram 之后每个 POST 都会带上

```
X-Telegram-Bot-Api-Secret-Token: <你设的值>
```

咔咔会拿它和连接里的 `telegramWebhookSecret` 比对，**不一致直接拒绝**，用来挡掉扫端口的伪造请求。

规则（官方硬性）：

- 长度 **1–256** 位；
- 字符集**只有** `A-Z` `a-z` `0-9` `_` `-`，其它字符（空格、中文、`:`、`/`…）一律非法。

生成示例：

```bash
# 32 位随机字符串，符合要求
openssl rand -hex 16
```

> 即使你开了防火墙，也建议**一定**配 `secret_token`：回调地址一旦泄露，没校验就等于任何人都能往你的机器人里灌假事件。

### 4.4 Nginx 反向代理完整示例

咔咔默认监听 `8787`。用 Nginx 终止 TLS 并把 `/tgbot/` 转过去：

```nginx
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate     /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location /tgbot/ {
        proxy_pass http://127.0.0.1:8787;      # 结尾不要加 /，否则路径被改写
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 关键：把 Telegram 带来的校验头透传给咔咔
        proxy_set_header X-Telegram-Bot-Api-Secret-Token
                         $http_x_telegram_bot_api_secret_token;
        proxy_read_timeout 60s;
    }
}

# 可选：80 只做 ACME 校验 / 跳转
server {
    listen 80;
    server_name bot.example.com;
    location / { return 301 https://$host$request_uri; }
}
```

检查与重载：

```bash
nginx -t && systemctl reload nginx
curl -i https://bot.example.com/tgbot/<连接id>     # 未带 secret 时应被咔咔拒绝
```

**常见反代坑**：

- `proxy_pass http://127.0.0.1:8787/;` 结尾多了 `/` → `/tgbot/xxx` 被改写成 `/xxx`，咔咔收不到；
- 忘了透传 `X-Telegram-Bot-Api-Secret-Token` → 所有请求都被判校验失败；
- 用 `location /tgbot` （少了尾斜杠）匹配不到子路径；
- 证书链不全（只配了 `cert.pem` 没配 `fullchain.pem`）→ Telegram 侧报 TLS 错误，`getWebhookInfo` 里能看到 `last_error_message`。

### 4.5 `setWebhook` / `getWebhookInfo` / `deleteWebhook`

框架会替你调 `setWebhook`，但排查时自己敲一遍最直观（把 `<token>`、`xxx`、`<连接id>` 换成自己的）：

```bash
# 设置（drop_pending_updates=true 丢弃切换前积压的旧 update）
curl "https://api.telegram.org/bot<token>/setWebhook" \
  -F "url=https://bot.example.com/tgbot/<连接id>" \
  -F "secret_token=xxx" \
  -F "max_connections=40" \
  -F "allowed_updates=[\"message\",\"callback_query\"]" \
  -F "drop_pending_updates=true"

# 查看当前状态 ← 排错第一命令
curl "https://api.telegram.org/bot<token>/getWebhookInfo"

# 删除（切回长轮询前必须先删）
curl "https://api.telegram.org/bot<token>/deleteWebhook?drop_pending_updates=true"
```

`getWebhookInfo` 返回里重点看：

| 字段 | 健康值 | 异常含义 |
|------|--------|----------|
| `url` | 你的回调地址 | 空 = 没设上；和预期不符 = 被人改过 |
| `has_custom_certificate` | 按你是否上传 | 自签证书没传上去 |
| `pending_update_count` | 接近 0 | 一直涨 = 咔咔没在消费 / 回调不通 |
| `last_error_date` / `last_error_message` | 无 | 有值 = Telegram 投递失败的原因（TLS、超时、4xx/5xx） |
| `max_connections` | 你设的值 | — |
| `allowed_updates` | 你订阅的列表 | 漏订阅 = 收不到某类事件 |
| `ip_address` | 解析出的 IP | 可用 `telegramWebhookIpAddress` 固定 |

### 4.6 `drop_pending_updates` / `max_connections` / `ip_address`

| 参数 | 字段 | 说明 |
|------|------|------|
| `drop_pending_updates` | `telegramDropPendingUpdates` | 设 / 删 webhook 时丢弃排队中的旧 update。**切换接入方式时勾上**，避免把几小时前的旧消息又处理一遍；正常运行时别开 |
| `max_connections` | `telegramWebhookMaxConnections` | 同时向你的 webhook 地址发起的最大连接数，**1–100**（本地 Bot API Server 可放宽到更高）。默认 40。并发不够会堆积 `pending_update_count` |
| `ip_address` | `telegramWebhookIpAddress` | 绕过 DNS，直接指定 Telegram 往哪个 IP 推。适合 DNS 还没生效、或要固定走某台机器 |
| `allowed_updates` | `telegramAllowedUpdates` | 见 §3.4 |

### 4.7 自签证书：`certificate` 上传

用可信 CA（Let's Encrypt）时**不用**传证书。只有自签证书才需要把**公钥 PEM** 作为 `certificate` 这个 `InputFile` 随 `setWebhook` 一起上传：

```bash
# 生成自签证书（CN / SAN 必须与 bot.example.com 一致，否则仍会失败）
openssl req -newkey rsa:2048 -sha256 -nodes -x509 -days 3650 \
  -keyout private.key -out public.pem \
  -subj "/CN=bot.example.com" \
  -addext "subjectAltName=DNS:bot.example.com"

curl "https://api.telegram.org/bot<token>/setWebhook" \
  -F "url=https://bot.example.com/tgbot/<连接id>" \
  -F "certificate=@public.pem"
```

在咔咔里对应 `telegramWebhookCertificatePath`：填 `public.pem` 的**绝对路径**，框架会替你 multipart 上传。

> 上传的是**公钥**（`.pem`），不是私钥；私钥给 Nginx 用。CN / SAN 不匹配时 `getWebhookInfo` 会给出 TLS 相关错误，见 §17。

### 4.8 webhook 响应内直接回复

正常流程是：收到 POST → 插件调 `sendMessage` → 再发一次 HTTP 请求给 Bot API。Telegram 允许**在 webhook 的 2xx 响应体里直接放一个 API 方法调用**，省掉这一次请求：

```json
{
  "method": "sendMessage",
  "chat_id": 123456789,
  "text": "收到"
}
```

咔咔的 `telegramWebhookReplyInResponse`（对应 `telegramWebhookReplyInResponse` 配置）开启后，会把本次事件产生的**首个** API 调用按这种格式放进响应体。

**取舍**：

- 省一次往返、降低延迟、减轻限频压力；
- 但**拿不到这次调用的返回结果**（没有 `result`、没有 `message_id`），需要回执的场景（撤回、编辑、拿 file_id）别用；
- 一次响应只能放**一个**方法，其余调用仍走常规请求。

### 4.9 与 polling 互斥 / 409

同一 token 上 `setWebhook` 与 `getUpdates` **不能并存**。出现

```
409 Conflict: can't use getUpdates method while webhook is active
```

说明 webhook 还挂着。处理：

```bash
curl "https://api.telegram.org/bot<token>/deleteWebhook?drop_pending_updates=true"
curl "https://api.telegram.org/bot<token>/getWebhookInfo"   # 确认 url 已空
```

然后在咔咔里把 `mode` 改回 `polling`、勾一次 `telegramDropPendingUpdates`、重启连接。

---

## 5. 方式三：本地 Bot API Server

### 5.1 什么时候需要

官方服务器有两道文件大小天花板，本地服务器能解开：

| 能力 | 官方 Bot API Server | 本地 Bot API Server |
|------|--------------------|---------------------|
| 上传文件 | **50 MB** | **2000 MB**（2 GB） |
| 下载文件 | **20 MB** | **无大小限制** |
| 协议 / 端口 | HTTPS / 443 | **HTTP + 任意端口** |
| `getFile` 的 `file_path` | 需要再拼 `https://api.telegram.org/file/bot<token>/…` 下载 | **直接是服务器本地绝对路径**，读文件即可 |
| 运维 | 免维护 | 自己管进程、磁盘、证书、可达性 |

典型场景：发大型视频 / 备份包、批量下载频道媒体、内网隔离环境、想把文件直接落到本地磁盘给别的程序读。

> 对小机器人来说，官方服务器**总是更省事**：不用维护进程、不用管磁盘、不用担心版本落后。别为了「听起来更快」而上本地服务器。

### 5.2 `logOut` 后切换（互斥性）

一个 token **同一时刻只能挂在一种服务器上**。从官方切到本地必须先在官方服务器上注销：

```bash
# 1）在官方服务器上注销（之后官方地址暂时不能再用这个 token）
curl "https://api.telegram.org/bot<token>/logOut"

# 2）启动本地 Bot API Server（--local 模式才解锁大文件 / 本地路径）
telegram-bot-api --api-id <api_id> --api-hash <api_hash> --local \
  --http-port 8081 --dir /var/lib/telegram-bot-api --verbosity 1

# 3）咔咔连接里把 telegramApiBase 填成 http://127.0.0.1:8081
```

想切回官方服务器，则在**本地服务器**上调 `logOut`，再请求官方 `https://api.telegram.org/bot<token>/getMe` 重新激活。`api_id` / `api_hash` 来自 [my.telegram.org](https://my.telegram.org/)（不是 BotFather，是 Telegram 核心 API 的应用凭证）。

> 注意：`logOut` 是**服务器端**状态，不是本地配置。忘了这步直接改 `telegramApiBase`，常见现象是 `getMe` 正常但收不到 update，或报 token 已被另一台服务器占用。

### 5.3 在咔咔里配置

| 字段 | 值 |
|------|----|
| `telegramApiBase` | `http://127.0.0.1:8081`（不带尾斜杠；框架会规范化） |
| `mode` | `polling` 或 `webhook` 都行 |
| `telegramWebhookUrl` | 若用 webhook，此时可以填内网 `http://` 地址（本地服务器不强制 HTTPS） |
| `telegramWebhookMaxConnections` | 本地服务器可配到远高于 100 |
| `telegramProxyUrl` | 本地服务器一般不需要 |

### 5.4 `file_path` 是本地绝对路径

官方服务器下 `getFile` 返回：

```json
{ "file_id": "AgADBA...", "file_path": "photos/file_0.jpg" }
```

要再拼 `https://api.telegram.org/file/bot<token>/photos/file_0.jpg` 下载。

本地服务器 `--local` 模式下 `file_path` 变成：

```json
{ "file_id": "AgADBA...", "file_path": "/var/lib/telegram-bot-api/photos/file_0.jpg" }
```

**直接 `fs.readFileSync(file_path)` 即可**，不需要也不应该再拼 URL 去下载。插件里判断方式：

```js
const file = await ctx.actions.call('getFile', { file_id });
const p = String(file?.result?.file_path ?? file?.file_path ?? '');
if (p.startsWith('/')) {
  // 本地 Bot API Server：直接读本地文件
  return fs.readFileSync(p);
}
// 官方服务器：走 https://api.telegram.org/file/bot<token>/<p>
```

### 5.5 性能与运维取舍

**收益**：更低延迟、大文件、本地路径、可完全内网、可自定义并发。
**成本**：

- 要常驻一个进程 + 足够磁盘（文件会一直堆在 `--dir` 里，自己定期清）；
- 本地服务器版本要跟上 Bot API 版本，太旧会不支持新方法与新 Update 类型；
- webhook 模式下 **Telegram 要能连到你的本地服务器**，HTTPS / 证书 / 端口映射得自己扛（或把 webhook 指到反代再转给本地服务器）；
- `--local` 模式会绕过一些官方侧限制，相应地也要自己承担文件安全与访问控制。

**与 `mode` 正交**：`telegramApiBase` 只改「请求发去哪」，`polling` / `webhook` 照常用。别把「本地服务器」当成第三种收消息方式——它不改变 Update 从哪来。

---

## 6. 测试环境 `/bot<token>/test/METHOD`

Telegram 提供一套与生产**完全隔离**的测试环境，用来调试而不打扰真实用户、不产生真实消息。

### 6.1 URL 形态

```
生产： https://api.telegram.org/bot<token>/METHOD_NAME
测试： https://api.telegram.org/bot<token>/test/METHOD_NAME
                                          ^^^^
```

在咔咔里只需勾 **`telegramTestEnv`**（字段 `telegramTestEnv: true`），框架拼 URL 时自动插入 `/test/`；`buildTelegramApiUrl` 这类纯函数也是照这个规则生成地址。

### 6.2 用之前要知道

- 测试环境的机器人要**单独在 @BotFather 里创建**（BotFather 提供切换测试环境的入口），拿到的 token 与生产 token 不同；
- 测试环境里**没有真实用户、没有真实会话**，你得自己用测试账号跟机器人对话；
- 生产 token 打到 `/test/` 地址、或测试 token 打到生产地址 → **401 Unauthorized**；
- 测试环境同样遵循 `getUpdates` / `setWebhook` 互斥；
- 别拿测试环境做压测，它的限频与资源跟生产不是一回事。

### 6.3 建议流程

1. 建测试机器人 → 拿测试 token；
2. 咔咔里新建一条 Telegram 连接，勾 `telegramTestEnv`，`mode` 用 `polling`；
3. 用测试账号把指令、回调、Inline 全跑一遍；
4. 验证通过后，换生产 token、去掉 `telegramTestEnv` 勾、正式启用。

---

## 7. 网络与代理 `telegramProxyUrl`

服务器（尤其境内云主机）直连 `api.telegram.org` 不通时，在连接里填：

```
telegramProxyUrl = http://127.0.0.1:7897
```

支持常见 HTTP 代理（Clash / V2Ray 的混合端口等）。框架发起的所有 Bot API 请求（含 `getUpdates` / `setWebhook` / `sendMessage` / `getFile` 下载）都会走它。

要点：

- 这是**连接级配置字段**，写在连接表单 / `data/connections.json` 里，**不是环境变量**；
- 它和「工具 → 视频解析」用的 `X_PROXY_URL` 环境变量是**两条独立链路**，改一个不影响另一个；
- 出向代理只解决「咔咔 → Telegram」，**不解决** webhook 的「Telegram → 咔咔」入向可达性。webhook 仍要公网域名 + 443/80/88/8443 + 反代；
- 用本地 Bot API Server 时，请求目标是 `127.0.0.1`，一般不需要代理；
- 代理不稳定会表现为 `getUpdates` 反复超时 / 长轮询频繁重连，先确认代理本身能 `curl https://api.telegram.org`。

---

## 8. Update 全类型表

`getUpdates` / webhook 拿到的每个对象叫 **Update**，顶层一定有 `update_id`，另有**恰好一个**内容字段。框架用 `telegramUpdateType(update)` 判断它是哪一类，再规范化成事件对象。

| 内容字段 | 触发场景 | 备注 |
|----------|----------|------|
| `message` | 新消息（私聊 / 群 / 频道） | 最常用 |
| `edited_message` | 消息被编辑 | 内容与 `message` 同构 |
| `channel_post` | 频道新帖 | 机器人须是频道管理员 |
| `edited_channel_post` | 频道帖被编辑 | |
| `business_connection` | Business 连接建立 / 断开 | 企业功能 |
| `business_message` | Business 消息 | |
| `edited_business_message` | Business 消息被编辑 | |
| `deleted_business_messages` | Business 消息被删 | |
| `message_reaction` | 有人给消息加了表情反应 | **需显式订阅** |
| `message_reaction_count` | 匿名反应数变化 | **需显式订阅** |
| `inline_query` | 任意聊天框输入 `@机器人 关键词` | 需开 Inline Mode，见 §12.1 |
| `chosen_inline_result` | 用户选中了某条 Inline 结果 | 需 `/setinlinefeedback` |
| `callback_query` | 用户点了内联键盘按钮 / 回调按钮 | 见 §10.3 |
| `shipping_query` | 支付：收货地址确认 | Stars / 支付流程 |
| `pre_checkout_query` | 支付：付款前最终确认 | 必须 10 秒内 `answerPreCheckoutQuery` |
| `poll` | 投票状态变化 | |
| `poll_answer` | 有人投票（匿名投票） | |
| `my_chat_member` | **机器人自己**的群成员状态变了（被拉群 / 被踢 / 提权） | 常用，判断「新群」 |
| `chat_member` | 群里**某个成员**状态变了 | **需显式订阅** |
| `chat_join_request` | 有人申请入群 | |
| `chat_boost` | 群 / 频道获得助推 | **需显式订阅** |
| `removed_chat_boost` | 助推被移除 | **需显式订阅** |
| `checklist_tasks_done` / `checklist_tasks_added` 等 | 10.x 清单类事件 | 按 Bot API 10.4 文档 |

> **两条经验**：
> 1. 除 `message`/`edited_message`/`channel_post`/`callback_query`/`inline_query`/`my_chat_member` 等常见类型外，很多类型**默认不下发**，必须列进 `telegramAllowedUpdates`；
> 2. 插件里先判类型再取字段，别默认每个 Update 都有 `message`——`callback_query`、`inline_query` 就没有。

框架的 `TELEGRAM_ALL_UPDATE_TYPES` 常量列出了默认全集，配置 `telegramAllowedUpdates` 时可以从它里面挑。

---

## 9. 消息与媒体

### 9.1 文本与 entities

一条 `message` 里文本可能出现在两个地方：

- `text`：纯文本消息；
- `caption`：图片 / 视频 / 文档等媒体附带的说明文字。

`entities` / `caption_entities` 是**结构化标注**（`bot_command`、`mention`、`hashtag`、`url`、`bold`、`italic`、`code`、`text_link`、`spoiler` 等），比自己正则解析可靠。命令解析优先读 `bot_command` 实体（见 §11）。

### 9.2 媒体类型

| 字段 | 内容 | 发送方法 |
|------|------|----------|
| `photo` | 照片，**是尺寸数组**（`PhotoSize[]`），取最大那张的 `file_id` | `sendPhoto` |
| `video` | 视频 | `sendVideo` |
| `animation` | GIF / 动图 | `sendAnimation` |
| `audio` | 音频文件（带标题 / 演唱者） | `sendAudio` |
| `voice` | 语音消息（ogg） | `sendVoice` |
| `video_note` | 圆形视频消息 | `sendVideoNote` |
| `document` | 通用文件（PDF / ZIP / APK…） | `sendDocument` |
| `sticker` | 贴纸 | `sendSticker` |
| `location` / `venue` | 位置 / 地点 | `sendLocation` / `sendVenue` |
| `contact` | 名片 | `sendContact` |
| `poll` / `dice` | 投票 / 骰子 | `sendPoll` / `sendDice` |

### 9.3 `file_id` 复用

每个媒体对象都带 `file_id`，它是**这个文件的稳定标识**：

- 同一个文件重复发，**直接传 `file_id`**，不用重新上传，省带宽也省限频；
- `file_id` 只对**当前机器人**有效，换 token 作废；
- 同一文件可能有多个不同尺寸的 `file_id`（`photo` 数组即如此），按需要选；
- 想拿到实际字节：先 `getFile({ file_id })` 拿 `file_path`，再按 §5.4 判断是本地绝对路径还是要拼官方下载 URL。

```js
// 复用已知 file_id 发图
await ctx.actions.call('sendPhoto', {
  chat_id,
  photo: 'AgACAgQAAxkBAAI...',   // 直接复用
  caption: '这是上次那张图',
});
```

### 9.4 发送媒体的三种入参

```js
// ① 复用 file_id（推荐）
await ctx.actions.call('sendPhoto', { chat_id, photo: fileId });

// ② 给一个公网 URL，Telegram 自己去拉
await ctx.actions.call('sendPhoto', { chat_id, photo: 'https://example.com/a.jpg' });

// ③ 上传本地文件（multipart）：把本地路径交给框架，由它按 InputFile 处理
await ctx.actions.call('sendDocument', { chat_id, document: '/data/a.pdf' });
```

> 上传走官方服务器时单文件 ≤ **50 MB**；超过就得上本地 Bot API Server（§5）。`caption` 同样受解析模式影响，MarkdownV2 下也要转义。

---

## 10. 键盘、回调与内联查询

### 10.1 回复键盘（ReplyKeyboardMarkup）

贴在输入框下方的自定义按钮，点一下等于发一条文本：

```js
await ctx.actions.call('sendMessage', {
  chat_id,
  text: '选一个：',
  reply_markup: {
    keyboard: [
      [{ text: '帮助' }, { text: '签到' }],
      [{ text: '📍 发位置', request_location: true }],
    ],
    resize_keyboard: true,
    one_time_keyboard: true,
  },
});
```

收起来用 `ReplyKeyboardRemove`：`{ reply_markup: { remove_keyboard: true } }`。

### 10.2 内联键盘（InlineKeyboardMarkup）

按钮贴在**消息下方**，点击不产生聊天消息，而是触发 `callback_query`：

```js
await ctx.actions.call('sendMessage', {
  chat_id,
  text: '确认吗？',
  reply_markup: {
    inline_keyboard: [[
      { text: '✅ 确认', callback_data: 'ok:42' },
      { text: '❌ 取消', callback_data: 'cancel:42' },
    ]],
  },
});
```

`callback_data` 最长 64 字节，别塞大 JSON；状态放自己库里，只用一个短 key。

### 10.3 处理 `callback_query` + `answerCallbackQuery`

**必须** `answerCallbackQuery`，否则客户端按钮一直转圈，且同一条查询不能无限期挂着。

框架把回调规范化成 `notice`：**`callback_query_id` / `callback_data` / `chat_id` 在顶层**，整个原生对象在 `event.raw.callback_query`（详见 §16.2）。别直接读 `event.callback_query`：

```js
export async function plugin_onevent(ctx, event) {
  if (event.telegram !== true) return;
  const rawCq = event.raw?.callback_query;
  if (event.notice_type !== 'callback_query' && !rawCq) return;

  const id = event.callback_query_id ?? rawCq?.id;
  const data = String(event.callback_data ?? rawCq?.data ?? '');
  const chatId = event.chat_id ?? rawCq?.message?.chat?.id ?? rawCq?.from?.id;

  // 先 ACK，再干活（避免用户看到转圈）
  await ctx.actions.call('answerCallbackQuery', {
    callback_query_id: id,
    text: data.startsWith('ok:') ? '已确认' : '已取消',
    show_alert: false,
  });

  if (data.startsWith('ok:') && chatId) {
    await ctx.actions.call('sendMessage', { chat_id: chatId, text: '收到确认 ✅' });
  }
}
```

### 10.4 Inline Mode 与 `answerInlineQuery`

用户在**任意聊天框**输入 `@你的机器人 关键词`，Telegram 把 `inline_query` 推给机器人，机器人用 `answerInlineQuery` 回一组结果，用户点选后插入到当前聊天。前提是 BotFather `/setinline` 已开（§1.3）。

框架把内联查询规范化成 `request`：**`query_id` / `query` / `offset` 在顶层**，原生对象在 `event.raw.inline_query`：

```js
export async function plugin_onevent(ctx, event) {
  if (event.telegram !== true) return;
  const rawIq = event.raw?.inline_query;
  if (event.request_type !== 'inline_query' && !rawIq) return;

  const id = event.query_id ?? rawIq?.id;
  const keyword = String(event.query ?? rawIq?.query ?? '').trim();
  await ctx.actions.call('answerInlineQuery', {
    inline_query_id: id,
    cache_time: 300,
    results: [{
      type: 'article',
      id: '1',
      title: `你搜了：${keyword || '（空）'}`,
      input_message_content: { message_text: `🔎 ${keyword || '（空）'}` },
    }],
  });
}
```

> `inline_query` 没有 `chat_id`，别拿发消息的思路去处理它。`answerInlineQuery` 也有时限，别在里面做慢查询。

---

## 11. 命令解析 `/cmd@bot` 与 Deep Linking

### 11.1 群里的 `/cmd@bot`

群里同时有多个机器人时，用户会写 `/help@你的机器人` 来指定目标。命令实体里也带这个后缀：

- `message.entities` 里 `type === 'bot_command'` 的那段就是 `/help@kakake_demo_bot`；
- 解析时必须**剥掉 `@用户名` 后缀**，否则 `/help@bot` 永远匹配不上 `help`。

框架的 `parseTelegramCommand(text, botUsername?)` 就是干这个的，返回形如：

```js
{ command: 'help', args: '', target: 'kakake_demo_bot' }
```

行为要点：

| 输入 | `botUsername='kakake_demo_bot'` | 结果 |
|------|--------------------------------|------|
| `/start` | — | `{ command: 'start', args: '' }` |
| `/start@bot hello world` | 传入 | `{ command: 'start', args: 'hello world', target: 'bot' }` |
| `/ping@别的bot` | 传入 | `target` 指向别人 → **插件应忽略**，不是发给自己的 |
| `你好` | — | `null`（不是命令） |

插件里的稳妥写法（框架已把命令解析好，优先用 `command` / `command_target` / `command_args`，正则兜底）：

```js
const text = String(event.raw_message ?? event.raw?.message?.text ?? '').trim();
const cmd = event.command
  ? { name: event.command, target: event.command_target, args: event.command_args ?? '' }
  : (() => {
      const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(text);
      return m ? { name: m[1], target: m[2], args: (m[3] ?? '').trim() } : null;
    })();
if (!cmd) return;                     // 不是命令
if (cmd.target && cmd.target.toLowerCase() !== String(ctx.frameworkEnv?.botUsername ?? '').toLowerCase()) {
  return;                             // 明确发给别的机器人，忽略
}
```

### 11.2 `/setcommands` 与指令菜单

给 @BotFather 发 `/setcommands` 设置菜单后，用户在聊天框敲 `/` 会看到补全提示。菜单只是**提示**，不负责解析——收到消息还是要自己判断。

### 11.3 Deep Linking（`/start` 带参数）

`https://t.me/kakake_demo_bot?start=ref_123` 点进去，机器人收到的 `/start` 文本是：

```
/start ref_123
```

解析出 `args` 就能做邀请归因、绑定账号、直达某个功能：

```js
if (name === 'start') {
  const ref = args.trim();            // 'ref_123'
  await ctx.actions.call('sendMessage', {
    chat_id, text: ref ? `欢迎，来自 ${ref} 👋` : '欢迎使用！',
  });
}
```

> 参数只能放在 `/start`（或 `/startgroup`）后面，长度有限，别塞大对象；复杂状态用短 token + 自己库里查。

---

## 12. Inline Mode、Mini Apps 与 Stars 支付

### 12.1 Inline Mode

见 §10.4。要点：BotFather `/setinline` 开、`answerInlineQuery` 回结果、`chosen_inline_result` 需 `/setinlinefeedback` 才会推。它没有 `chat_id`、也不产生普通消息。

### 12.2 Mini Apps（Web Apps）

用 `web_app` 类型的按钮或 `InlineKeyboardMarkup` 打开一个网页应用：

```js
await ctx.actions.call('sendMessage', {
  chat_id,
  text: '打开面板',
  reply_markup: {
    inline_keyboard: [[{
      text: '打开',
      web_app: { url: 'https://bot.example.com/app' },
    }]],
  },
});
```

要点：

- 域名要在 BotFather 用 `/setdomain` 绑定；
- 页面里用 Telegram 的 WebApp JS SDK 拿 `initData`，**必须在服务端校验签名**（别信前端传来的用户身份）；
- 应用回传数据走 `web_app_data` 这类消息字段，或你自己的后端接口。

### 12.3 Stars 支付

Telegram 的虚拟货币 **Stars** 可用于售卖数字商品 / 服务，流程是：

```js
// 1）发账单（价格以 XTR 计）
await ctx.actions.call('sendInvoice', {
  chat_id,
  title: '会员 30 天',
  description: '解锁全部功能',
  payload: 'vip_30d',
  currency: 'XTR',
  prices: [{ label: '30 天', amount: 100 }],   // 100 Stars
});

// 2）处理 pre_checkout_query（必须尽快 ACK；原生对象在 event.raw 里）
await ctx.actions.call('answerPreCheckoutQuery', {
  pre_checkout_query_id: event.raw?.pre_checkout_query?.id,
  ok: true,
});

// 3）收到 successful_payment 后发货
```

相关 Update 类型：`shipping_query`（需要收货地址时）、`pre_checkout_query`（付款前确认，必须 `answerPreCheckoutQuery`）、`message.successful_payment`（付款成功）。**别在 `pre_checkout_query` 里做慢操作**，超时用户就付不了款。

---

## 13. 限频与 429 重试策略

### 13.1 官方限频（准确数值）

| 场景 | 限制 |
|------|------|
| 单聊（私聊） | 约 **1 条/秒** |
| 群组 | 约 **20 条/分钟** |
| 广播 / 群发 | 约 **30 条/秒** |
| 超限时响应 | `429 Too Many Requests`，带 `retry_after`（**秒**）与可选 `parameters.migrate_to_chat_id` |

> 这些是经验上限，Telegram 会按负载动态调整。**不要把它们当配额打满**，留余量。

### 13.2 429 重试策略

```js
async function callWithRetry(ctx, method, params, maxRetries = 5) {
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return await ctx.actions.call(method, params);
    } catch (err) {
      const retry = Number(err?.retry_after ?? err?.parameters?.retry_after
        ?? err?.response?.parameters?.retry_after ?? 0);
      if (retry <= 0 || i === maxRetries) throw err;   // 非 429 或重试耗尽
      await new Promise((r) => setTimeout(r, retry * 1000));
    }
  }
}
```

要点：

1. **`retry_after` 是权威值**，别用自己的固定间隔覆盖它；
2. 遇到 `migrate_to_chat_id`（群升级为超级群）要**更新持久化的 chat_id**，之后改用新 ID；
3. 401 / 403 / 400（参数错、token 错、无权限）**不要重试**，重试只是刷屏；
4. 409 是 webhook / polling 冲突，按 §4.9 处理，不是限频；
5. 批量广播前做**排队 + 限速**（令牌桶 / 间隔发送），别一次性 `Promise.all` 几百条；
6. 优先用 `telegramWebhookReplyInResponse`（§4.8）省掉一次请求，间接降低限频压力。

---

## 14. 隐私模式、MarkdownV2 转义、file_id 复用、Bot-to-Bot 防循环

### 14.1 隐私模式（收不到群消息的第一嫌疑）

**默认开启**。开启时机器人在群里**只**收到：

- 以 `/` 开头的命令；
- 回复机器人自己消息的文本；
- `@机器人用户名` 的提及；
- 服务消息（进群 / 退群等）。

普通群聊文本**根本不会下发**，插件里怎么判断都收不到。

关闭步骤：

1. 给 @BotFather 发 `/setprivacy`；
2. 选中你的机器人 → 选 **Disable**；
3. **★ 把机器人移出群，再重新拉进群**（这一步不做，已存在的群不会生效）；
4. 群里发一句普通文本验证。

> 关掉隐私模式意味着机器人能读到群里所有消息，**涉及隐私与合规**：只在确实需要全量消息的业务里关，并在机器人简介里说明。另外，群组里即使关了隐私模式，管理员仍可通过群设置限制。

### 14.2 MarkdownV2 转义

`MarkdownV2` 要求转义这些字符：

```
_ * [ ] ( ) ~ ` > # + - = | { } . !
```

（在 `pre` / `code` 代码块内还需额外处理 `` ` `` 和 `\`。）

不转义就会报 `400 Bad Request: can't parse entities`。框架的 `escapeMarkdownV2(text)` 与 `escapeHtml(text)` 就是干这个的：

```js
import { escapeMarkdownV2, escapeHtml } from '.../telegram.types.js';

await ctx.actions.call('sendMessage', {
  chat_id,
  text: escapeMarkdownV2('价格：a_b * c！(1.0)'),
  parse_mode: 'MarkdownV2',
});
```

**更省心的选择**：把 `telegramParseMode` 设为 `HTML`（框架默认），只需转义 `<` `>` `&`（用 `escapeHtml`），规则少得多、也不容易被用户文本里的符号炸掉。

> 还有两个坑：`entities`/`caption_entities` 与 `parse_mode` 互斥；链接里的 URL 若含特殊字符也要处理。把**用户输入的任意文本**直接拼进 MarkdownV2 是事故高发区。

### 14.3 `file_id` 复用

见 §9.3。一句话：**同一文件重复发就传 `file_id`，不要重新上传**；它只对当前 token 有效；`getFile` 拿路径时按 §5.4 区分本地 / 官方服务器。

### 14.4 Bot-to-Bot 防循环

BotFather 默认关闭机器人之间互发消息。若你在受管环境里开了这个能力（或群里还有别的机器人），两个机器人互回能把群刷爆。防御：

```js
export async function plugin_onmessage(ctx, event) {
  if (event.telegram !== true) return;
  const isBot = event.sender?.is_bot ?? event.raw?.message?.from?.is_bot;
  if (isBot) return;   // ★ 机器人发的消息一律不回
  // …正常处理
}
```

再稳一点可以加：忽略自己发出的 `message_id`、对同一 `chat_id + 文本` 在短时间内去重、给自动回复加冷却。

---

## 15. Bot API 10.x 新能力与在本框架里怎么调

当前 Bot API 版本 **10.4（2026-11-09）**，带来一批新能力：

| 能力 | 说明 | 框架里怎么调 |
|------|------|--------------|
| **Rich Messages** | 更丰富的富文本 / 结构化消息呈现 | `telegramParseMode: 'Rich'`，或 `actions.call('<官方方法名>', {...})` |
| **Ephemeral Messages** | 阅后即焚 / 临时消息 | `actions.call('<官方方法名>', {...})` |
| **Widgets** | 可嵌入的交互组件 | `actions.call('<官方方法名>', {...})` |
| **`sendMessageDraft` 流式草稿** | 边生成边把草稿推给用户，适合 AI 流式输出 | `actions.call('sendMessageDraft', { chat_id, ... })` |
| **Guest Mode / Managed Bots** | 机器人托管 / 受限会话能力 | **BotFather 账号级开关**，不是代码能硬开的 |
| 其它 10.x Update 类型 | 清单、反应、助推等（见 §8） | 列进 `telegramAllowedUpdates` 才会下发 |

### 15.1 框架的统一调用方式

**关键设计**：`actions.call(action, params)` 的 `action` 可以直接是**任意 Bot API 方法名**，框架不维护一份白名单，也不做协议翻译——新方法出来即可用，不用等框架升级：

```js
// 常规方法
await ctx.actions.call('sendMessage', { chat_id, text: '你好' });
await ctx.actions.call('answerCallbackQuery', { callback_query_id, text: 'ok' });
await ctx.actions.call('getFile', { file_id });

// 10.x 新方法：直接传方法名即可
await ctx.actions.call('sendMessageDraft', { chat_id, text: '正在生成…' });
```

也支持 `api` 透传形态（把方法与参数打包成一个对象交给框架），适合从配置 / 队列里动态取方法名的场景：

```js
await ctx.actions.call('api', { method: 'sendMessage', chat_id, text: '你好' });
```

> 因为不做白名单，`actions.call` 里的方法名与参数字段**要和官方 Bot API 文档一致**（驼峰方法名、下划线参数名，例如 `chat_id`、`callback_query_id`）。拼错不会在框架层被拦下，会原样交给 Telegram 报 400。

### 15.2 流式草稿的典型用法（AI 场景）

```js
// 收到用户消息后，把 LLM 的流式输出持续推成草稿
const chatId = event.chat_id ?? event.raw?.message?.chat?.id;
await ctx.actions.call('sendMessageDraft', { chat_id: chatId, text: '' });
for await (const chunk of llmStream(prompt)) {
  await ctx.actions.call('sendMessageDraft', { chat_id: chatId, text: chunk });
}
await ctx.actions.call('sendMessage', { chat_id: chatId, text: finalText });
```

草稿是「临时态」，最终仍要发一条正式消息；注意别把草稿调用也塞进限频瓶颈（§13），必要时合并 chunk、控制推送频率。

### 15.3 版本兼容

- 本地 Bot API Server 版本落后时，新方法会报 `404 / method not found`，先升级本地服务器；
- 测试环境（§6）与生产环境的能力开放进度可能不同，新能力先在测试环境验证；
- 新 Update 类型记得同步加进 `telegramAllowedUpdates`。

---

## 16. 插件侧：开发 `TG-plugin-`

### 16.1 目录结构与 kind

```
plugins/
└── TG-plugin-hello/            # 前缀必须是 TG-plugin-（大小写敏感）
    ├── package.json            # name / version / type:"module" / main
    ├── plugin.json             # displayName / entry / description
    ├── index.mjs               # 入口，导出 plugin_init / plugin_onmessage / plugin_onevent / plugin_cleanup
    └── 插件文档.md              # 控制台「查看说明」渲染它
```

| 项 | 值 |
|----|----|
| 目录前缀 | `TG-plugin-` |
| 插件 kind | `'tg'` |
| 归属协议 | Telegram Bot（`frameworkEnv.protocol === 'telegram'`） |
| 入口导出 | `plugin_init`（必须）、`plugin_onmessage`、`plugin_onevent`、`plugin_cleanup`（推荐） |
| 事件通道 | `telegram/event`；动作回执走 `telegram/action_result` |

> 完整可运行的最小示例见 [`使用教程/插件开发/TG-Telegram机器人/TG-plugin-hello/`](<./插件开发/TG-Telegram机器人/TG-plugin-hello/>)，分步片段见同目录 `分步例子/`。

### 16.2 `plugin_onevent` / `plugin_onmessage` 收到的事件形状

框架把 Telegram Update 规范化成 **OneBot v11 风格**事件对象后分发，并把**整个原生 Update 原样保留在 `raw`**：

- `plugin_onevent`：**所有** Update 都进这里（消息、回调、内联查询、成员变动、反应……）；
- `plugin_onmessage`：**消息类**事件进这里（`post_type === 'message'`）；
- 动作回执（`telegram/action_result`）**不进** `plugin_onmessage`，只在 `plugin_onevent` 里看得到；
- 事件对象**带 `telegram: true` 标记**，与 KOOK 的 `event.kook === true`、微信的 `event.weixin_bot === true` 是同一套约定；
- 字段名与 OneBot 插件基本一致（`post_type` / `message_type` / `user_id` / `message` 段数组 / `raw_message`），习惯 `kakake-plugin-*` 写法的插件能平滑迁移。

规范化后的事件对象（**字段以框架实际透传为准**）：

| 字段 | 说明 |
|------|------|
| `telegram` / `platform` / `protocol` | `true` / `'telegram'` / `'telegram'`，用来和其它协议区分 |
| `post_type` | `message`（消息）/ `notice`（回调、成员变动、反应、投票等）/ `request`（内联查询、入群申请） |
| `update_type` / `t` | 原始 Update 类型，如 `message` / `callback_query` / `inline_query`（由 `telegramUpdateType` 判定） |
| `update_id` | 原始 Update ID，`offset` 确认靠它 |
| `message_type` | `private` / `group` / `channel`（由 `chat.type` 映射） |
| `chat_id` | 会话 ID（发消息要用的那个）；部分非消息事件可能没有 |
| `message_id` / `user_id` / `group_id` | 消息 ID / 发送者 / 群 ID（私聊时 `group_id` 为 undefined） |
| `raw_message` | **纯文本字符串**（`text` 或 `caption` 归一化结果） |
| `message` | **OneBot 风格消息段数组** `[{ type, data }]`，不是原生 Message 对象 |
| `sender` / `chat` | 发送者（= 原生 `from`）/ 会话对象；`sender.is_bot` 用于防循环 |
| `command` / `command_args` / `command_target` | 命令解析结果，已剥掉 `/cmd@bot` 后缀（见 §11.1） |
| `notice_type` / `callback_query_id` / `callback_data` | 回调事件的拍平字段 |
| `request_type` / `query_id` / `query` / `offset` | 内联查询的拍平字段 |
| `raw` | **整个原生 Telegram Update**，含 `raw.message` / `raw.callback_query` / `raw.inline_query` |

> **注意**：事件上**没有** `event.text`、`event.callback_query`、`event.inline_query` 这类顶层字段——文本读 `raw_message`，回调读 `callback_query_id` / `callback_data`，内联查询读 `query_id` / `query`，需要原生结构时从 `raw` 取。
>
> **实操建议**：第一次接线时先在 `plugin_onevent` 里 `ctx.logger.info(JSON.stringify(event))` 打一条真实事件，对照上表确认字段名与层级，再写业务逻辑。

由于 Update 类型很多，**取字段一律用兼容写法**（既认框架拍平的字段，也回退到 `raw` 原生结构）：

```js
const chatId = event.chat_id
  ?? event.raw?.message?.chat?.id
  ?? event.raw?.callback_query?.message?.chat?.id
  ?? event.raw?.callback_query?.from?.id;
const text = String(
  event.raw_message ?? event.raw?.message?.text ?? event.raw?.message?.caption ?? '',
).trim();
const isBot = Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
```

### 16.3 `actions.call('sendMessage', { chat_id, text })` 用法

**这是 Telegram 插件发消息的标准写法**——参数遵循 Bot API 原生命名（`chat_id`、`text`、`parse_mode`、`reply_markup`…），不是 OneBot 的 `message` 段数组：

```js
export async function plugin_onmessage(ctx, event) {
  if (event.telegram !== true) return;            // 认协议
  const chatId = event.chat_id ?? event.raw?.message?.chat?.id;
  if (!chatId) return;

  await ctx.actions.call('sendMessage', {
    chat_id: chatId,
    text: '你好呀 👋',
  });
}
```

要点：

- `chat_id` 既可以是数字（私聊 / 群）也可以是 `@channelusername`（频道）；
- 失败会 **throw**，要 `try/catch`；
- 任意 Bot API 方法都能直接传方法名：`answerCallbackQuery`、`getFile`、`sendPhoto`、`sendMessageDraft`、`answerInlineQuery` …（见 §15.1）；
- 也支持 `api` 透传：`ctx.actions.call('api', { method: 'sendMessage', chat_id, text })`。

### 16.4 `frameworkEnv` 字段

| 字段 | Telegram 连接下的值 |
|------|---------------------|
| `frameworkEnv.protocol` | `'telegram'` |
| `frameworkEnv.ob11Mode` | `'telegram-bot-api'` |
| `frameworkEnv.protocolVersion` / `frameworkVersion` | 框架 / Bot API 版本，可用于能力探测 |
| `frameworkEnv.botUsername` | 机器人用户名（剥 `/cmd@bot` 用） |

判断当前是不是 Telegram 连接，优先用 `frameworkEnv.protocol`，事件对象上的 `event.telegram === true` 作互补标记，挑一种读法别两套分支打架：

```js
export async function plugin_init(ctx) {
  ctx.logger.info(`协议=${ctx.frameworkEnv?.protocol} · 模式=${ctx.frameworkEnv?.ob11Mode}`);
}
```

### 16.5 账号隔离目录

```
plugins_two/
└── <telegramBotUserId>/        # 账号隔离键 = getMe 拿到的机器人 ID
    └── TG-plugin-hello/        # 按账号跑的插件运行副本
```

- 多个 Telegram 机器人各跑各的实例、各存各的数据，**天然不互通**；
- 数据只写 `ctx.dataPath`（即上面这层），**别写 `ctx.pluginPath`**（那是运行副本，重载会被覆盖）；
- 配置在 `ctx.configPath`（`<dataPath>/config.json`）；
- 要跨机器人打通状态，得自己做一层外部存储，框架不代劳。

### 16.6 完整最小插件（`index.mjs`）

```js
// TG-plugin-hello/index.mjs —— 最小可运行 Telegram 插件
export async function plugin_init(ctx) {
  ctx.logger.info(`[TG] 已加载 · 协议=${ctx.frameworkEnv?.protocol} · 数据目录=${ctx.dataPath}`);
}

// 会话 ID：框架已提到顶层，raw 兜底
function chatIdOf(event) {
  return event.chat_id
    ?? event.raw?.message?.chat?.id
    ?? event.raw?.callback_query?.message?.chat?.id
    ?? event.raw?.callback_query?.from?.id;
}

// 纯文本：框架给 raw_message；message 是 OneBot 段数组，别当对象取 .text
function textOf(event) {
  return String(
    event.raw_message ?? event.raw?.message?.text ?? event.raw?.message?.caption ?? '',
  ).trim();
}

function isFromBot(event) {
  return Boolean(event.sender?.is_bot ?? event.raw?.message?.from?.is_bot);
}

// 所有事件（含 callback_query / inline_query / 动作回执）
export async function plugin_onevent(ctx, event) {
  if (!event || event.telegram !== true) return;

  // 内联键盘回调：框架拍平为 callback_query_id / callback_data，原生在 raw
  const rawCq = event.raw?.callback_query;
  if (event.notice_type === 'callback_query' || rawCq) {
    try {
      await ctx.actions.call('answerCallbackQuery', {
        callback_query_id: event.callback_query_id ?? rawCq?.id,
        text: '已收到',
      });
    } catch (err) {
      ctx.logger.warn(`[TG] ACK 失败：${err?.message ?? err}`);
    }
  }
}

// 消息类事件
export async function plugin_onmessage(ctx, event) {
  if (event.telegram !== true) return;
  if (isFromBot(event)) return;                    // 防 Bot-to-Bot 循环

  const chatId = chatIdOf(event);
  const text = textOf(event);
  if (!chatId) return;

  // 命令：框架已解析好，优先用 command / command_target / command_args
  const cmd = event.command
    ? { name: event.command, target: event.command_target, args: event.command_args ?? '' }
    : null;
  if (cmd) {
    const me = String(ctx.frameworkEnv?.botUsername ?? '').toLowerCase();
    if (cmd.target && cmd.target.toLowerCase() !== me) return;   // 发给别的机器人
    const replies = {
      start: '欢迎使用！发送 /help 查看指令。',
      help: '可用指令：/start、/help、/ping',
      ping: 'pong',
    };
    const reply = replies[cmd.name] ?? `未知指令：/${cmd.name}（args=${cmd.args}）`;
    await ctx.actions.call('sendMessage', { chat_id: chatId, text: reply });
    return;
  }

  if (text === '你好') {
    await ctx.actions.call('sendMessage', { chat_id: chatId, text: '你好呀 👋' });
  }
}

export async function plugin_cleanup() {
  // 清定时器 / 落盘 / 断连接
}
```

### 16.7 事件通道与回执

- 收：`telegram/event` —— 所有规范化后的 Update；
- 回执：`telegram/action_result` —— 一次 `actions.call` 的结果（成功 / 失败、`retry_after` 等），只在 `plugin_onevent` 里可见，别拿它当聊天消息处理。

---

## 17. 排错清单

| 现象 | 最可能的原因 | 怎么处理 |
|------|--------------|----------|
| **401 Unauthorized** | token 填错 / 被 `/revoke` 吊销 / 测试 token 打生产地址（或反之）/ token 还挂在另一台服务器 | 到 BotFather 用 `/token` 重签；核对 `telegramTestEnv` 与 token 是否配套；切服务器前先 `logOut`（§5.2） |
| **409 Conflict: can't use getUpdates method while webhook is active** | 同一 token 上 webhook 与 polling 并存 | `deleteWebhook` → `getWebhookInfo` 确认 `url` 为空 → 切 `mode`（§4.9） |
| **429 Too Many Requests** | 触发限频（单聊 ~1/s、群 ~20/min、广播 ~30/s） | 按响应 `retry_after` 秒数退避；批量发送排队限速；别 `Promise.all` 猛发（§13） |
| **400 can't parse entities** | `MarkdownV2` 没转义特殊字符 / 用户文本里带了 `_*[]()…` | 用 `escapeMarkdownV2`，或把 `telegramParseMode` 改成 `HTML` + `escapeHtml`（§14.2） |
| **群里收不到普通消息** | **隐私模式默认开启**；或 `allowed_updates` 漏订阅 | `/setprivacy` 关闭 → **把机器人移出群再重新拉入** → 验证；检查 `telegramAllowedUpdates`（§14.1 / §3.4） |
| **回调地址不通 / `pending_update_count` 一直涨** | 域名不可达 / 端口不是 443·80·88·8443 / 反代改写路径 / 没透传校验头 / 证书链不全 | `getWebhookInfo` 看 `last_error_message`；`curl` 直接打 `/tgbot/<连接id>`；核对 §4.4 的 Nginx（尤其 `proxy_pass` 结尾不要 `/`、要透传 `X-Telegram-Bot-Api-Secret-Token`） |
| **证书 CN / SAN 不匹配** | 自签证书域名与 `telegramWebhookUrl` 不一致 / 只上传了私钥 / 用了 `cert.pem` 而非 `fullchain.pem` | 重新生成带 `subjectAltName=DNS:域名` 的证书，只上传**公钥 PEM**；Nginx 配 `fullchain.pem`（§4.7） |
| **`secret_token` 一直校验失败** | 值超 256 位 / 含非法字符（空格、中文、`:`、`/`）/ 反代丢了头 | 用 `openssl rand -hex 16` 重生成；确认 `proxy_set_header X-Telegram-Bot-Api-Secret-Token`（§4.3） |
| **`method not found` / 404** | 本地 Bot API Server 版本太旧，不支持新方法与新 Update 类型 | 升级 `telegram-bot-api`；或临时把 `telegramApiBase` 留空走官方（§15.3） |
| **消息重复处理 / 重启后又收一遍** | `offset` 没确认或没持久化 | 让框架自动管 `telegramOffset`，别手填、别清零；切换时勾 `telegramDropPendingUpdates`（§3.3） |
| **插件完全不触发** | 目录前缀不是 `TG-plugin-` / 总开关或连接开关没开 / 事件没带 `telegram: true` | 核对前缀与两个开关；`plugin_onevent` 里先打一条 `JSON.stringify(event)` 看形状（§16.2） |
| **两个机器人互相刷屏** | 开了 Bot-to-Bot 且没防循环 | `if (from?.is_bot) return;`（§14.4） |
| **文件传不上去 / 下载失败** | 官方服务器 50MB 上传 / 20MB 下载上限 | 改本地 Bot API Server（§5）或压缩文件；复用 `file_id` 别重传（§9.3） |
| **`getUpdates` 反复超时** | 代理不稳 / 长轮询被中间设备掐断 | 检查 `telegramProxyUrl` 能否 `curl https://api.telegram.org`；调大 `telegramPollingTimeout`；按 §3.6 退避 |

**通用排查顺序**：连接列表摘要是否正常 → `getMe` 是否 200 → `getWebhookInfo`（webhook 时）→ 日志页看 `telegram/event` 有没有进来 → 插件开关 → 事件形状 → 具体错误码。

---

## 18. 配置字段速查表

| 字段 | 类型 | 默认 | 说明 |
|------|------|------|------|
| `type` | `'telegram'` | — | 连接类型 |
| `mode` | `'polling'` \| `'webhook'` | `polling` | 收 Update 的方式 |
| `telegramToken` | string | 必填 | BotFather token |
| `telegramApiBase` | string | `https://api.telegram.org` | 本地 Bot API Server 地址（HTTP / 任意端口） |
| `telegramTestEnv` | boolean | `false` | 走 `/bot<token>/test/METHOD` |
| `telegramWebhookUrl` | string | — | 完整回调 URL，路径 `/tgbot/<连接id>` |
| `telegramWebhookSecret` | string | — | 1–256 位 `A-Za-z0-9_-`，校验 `X-Telegram-Bot-Api-Secret-Token` |
| `telegramWebhookMaxConnections` | number | 40 | 1–100（本地服务器可更高） |
| `telegramWebhookIpAddress` | string | — | 固定投递 IP |
| `telegramWebhookCertificatePath` | string | — | 自签公钥证书 PEM 路径 |
| `telegramAllowedUpdates` | string[] | 默认全集 | 订阅的 Update 类型 |
| `telegramDropPendingUpdates` | boolean | `false` | 切换时丢弃积压 |
| `telegramPollingTimeout` | number | 30 | 长轮询超时（秒） |
| `telegramPollingLimit` | number | 100 | 单次取回上限 1–100 |
| `telegramOffset` | number | 0 | 游标，框架自动确认持久化 |
| `telegramProxyUrl` | string | — | 出向 HTTP 代理 |
| `telegramWebhookReplyInResponse` | boolean | `false` | 首个 API 调用放进 webhook 2xx 响应体 |
| `telegramParseMode` | `'HTML'` \| `'MarkdownV2'` \| `'Markdown'` \| `'Rich'` | `HTML` | 默认文本解析模式 |
| `telegramBotUserId` | string | 回填 | `getMe` 机器人 ID，**账号隔离键** |
| `telegramBotUsername` | string | 回填 | `getMe` 用户名（不带 `@`） |
| `telegramBotFirstName` | string | 回填 | `getMe` 显示名 |

---

## 19. 官方限制速查表

| 项 | 数值 / 规则 |
|----|-------------|
| Webhook 端口 | **443 / 80 / 88 / 8443**（仅这四个） |
| `secret_token` | **1–256** 位，仅 `A-Z a-z 0-9 _ -` |
| `getUpdates.limit` | **1–100** |
| `getUpdates.timeout` | 单位**秒** |
| Update 保留时长 | 最多 **24 小时** |
| 官方服务器上传 | **50 MB** |
| 官方服务器下载 | **20 MB** |
| 本地服务器上传 | **2000 MB** |
| 本地服务器下载 | **无限制** |
| 单聊发送 | 约 **1 条/秒** |
| 群组发送 | 约 **20 条/分钟** |
| 广播 | 约 **30 条/秒** |
| 超限响应 | `429` + `retry_after`（秒） |
| 隐私模式 | **默认开启**；`/setprivacy` 关闭后需**重新拉群** |
| `callback_data` | 最长 64 字节 |
| 命令用户名后缀 | `/cmd@bot`，解析时要剥 |
| MarkdownV2 | 需转义 `_ * [ ] ( ) ~ \` > # + - = \| { } . !` |
| 当前 Bot API | **10.4（2026-11-09）** |

---

## 附：本教程与其它文档的关系

- [`连接教程.txt`](./连接教程.txt) —— 所有连接类型的速查（含本文的浓缩版「十、Telegram Bot」一节）；
- [`插件开发/manifest.json`](<./插件开发/manifest.json>) 与 [`插件开发/SKILL.md`](<./插件开发/SKILL.md>) —— 插件开发总览与前缀规则；
- [`插件开发/TG-Telegram机器人/`](<./插件开发/TG-Telegram机器人/>) —— `TG-plugin-` 完整示例与分步片段；
- [Telegram 官方 Bot API 文档](https://core.telegram.org/bots/api) —— 方法参数、Update 字段、新能力的**权威来源**（框架只做透传，字段名以它为准）。

> 本框架不托管你的账号与聊天数据。token、`data/connections.json`、插件配置里的密钥请自行保管；群里启用全量消息（关闭隐私模式）前请确认符合所在群的隐私要求。
