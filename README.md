# 咔咔珂（kakake）

简体中文 | [English](./README.en-US.md)

[![version](https://img.shields.io/badge/version-0.6.11--beta.1-2dd4bf?style=flat-square)](../../releases)
[![download](https://img.shields.io/badge/下载-Releases-0ea5e9?style=flat-square&logo=github&logoColor=white)](../../releases/latest)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020%20%C2%B7%20%E6%8E%A8%E8%8D%90%2022%20LTS-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/%E5%B9%B3%E5%8F%B0-Windows%20%7C%20Linux%20x64%20%E4%BE%BF%E6%90%BA%20%7C%20macOS%20%E6%BA%90%E7%A0%81-64748b?style=flat-square)](#环境要求)
[![QQ group](https://img.shields.io/badge/QQ群-955682835-1e90ff?style=flat-square&logo=tencentqq&logoColor=white)](https://qm.qq.com/q/ja7l7wLSjC)

TypeScript **插件平台框架**：本地部署、Web 控制台运维，通过 OneBot（如 NapCat）、QQ 开放平台、KOOK、微信 AI×BOT、Telegram Bot 等多种载体接入机器人能力，并兼容 NapCat 插件规范。

> 📦 **[前往 Releases 下载 / 查看最新发布版 →](../../releases/latest)**　·　所有发布与更新说明都在仓库的 **Releases** 页。

> **定位说明**：咔咔珂是插件平台与运维后台，**不是**独立机器人协议框架，也不替代 NapCat / NoneBot / AstrBot / Koishi 等项目。连接载体与上游协议由你自行配置。

---

## 目录

- [功能概览](#功能概览)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [管理后台](#管理后台)
- [连接方式](#连接方式)
- [插件系统](#插件系统)
- [配置与数据](#配置与数据)
- [常用命令](#常用命令)
- [开发说明](#开发说明)
- [常见问题](#常见问题)
- [官方渠道与协议](#官方渠道与协议)

---

## 功能概览

| 能力 | 说明 |
|------|------|
| Web 控制台 | Vite + React SPA 管理后台：概览、连接、插件、资源商店、工具、日志、设置、协议等 |
| OneBot 接入 | 反向 / 正向 WebSocket，HTTP / HTTP SSE / HTTP 客户端 |
| QQ 官方机器人 | Gateway WebSocket、HTTPS Webhook |
| KOOK 机器人 | Bot Token 接入（`Authorization: Bot <token>`），按账号隔离 |
| 微信 AI×BOT | iLink bot_token 扫码登录接入 |
| Telegram Bot | `getUpdates` 长轮询 / `setWebhook` HTTPS 回调，可切本地 Bot API Server 与测试环境；BotFather 开关、限频与隐私模式全套支持 |
| 插件平台 | 兼容 NapCat 插件规范；按账号隔离运行副本；含插件商店与「插件开发」教程 |
| 本地持久化 | 配置、密钥、连接、插件状态保存在本机 `data/` |
| 界面外观 | 三组可调配色（字体 / 组件 / Logo）、竖横两份背景（图片或循环视频）、卡片与背景模糊、动效速度、**自定义标题名** |
| 系统信息 | 概览页实时监控 CPU / 内存 / 磁盘占用与运行时长，识别发行版 |
| 模拟消息 | 本地模拟 OneBot 群聊 / 私聊上报，真实触发已加载插件，发送与 API 调用被拦截展示、不外发 |
| 工具 · 视频解析 | 粘贴 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram 分享链接，解析标题、封面、图集与直链，支持服务端代理下载 |
| 工具 · 编码转换 | Base64 / Base32 / Hex / URL / Unicode / HTML 实体 / 进制 / gzip 互转，纯本地 |
| AI 助手 | 控制台「AI」页：自定义 OpenAI / Anthropic 上游（多档案），连续执行式任务——分析 `plugins/` `log/` 内容、创作与修改插件；文件操作限定白名单目录并逐文件展示 diff，改动需人工确认后才部署 |
| 一键启动 | Windows `start.bat` / 类 Unix `start.sh`，自动装依赖并构建 Web UI |

---

## 环境要求

- **Node.js** ≥ 20（**推荐 22 LTS**：Node 20 已 EOL、不再有安全补丁，便携发行版内置的就是 Node 22）
- 依赖管理统一使用 **npm**（Node 自带，无需单独安装）
- Windows / Linux / macOS 均可运行源码版；**便携发行版仅提供 Windows / Linux x64**，macOS 请用源码方式运行
- Windows 可直接双击 `start.bat`

可选配套：

- [NapCat](https://github.com/NapNeko/NapCatQQ) 等 OneBot 实现
- QQ 开放平台机器人（官方 WS / Webhook）
- KOOK 机器人（Bot Token）、微信 AI×BOT（iLink bot_token）
- Telegram Bot（[@BotFather](https://t.me/BotFather) 签发 token，长轮询或 Webhook）
- 仅 Webhook 方式需要：公网域名 + 可信 HTTPS 证书（官方只接受 443 / 80 / 88 / 8443 端口）

---

## 快速开始

### Windows

1. 安装 [Node.js 22 LTS](https://nodejs.org/)（最低 20 可用）
2. 双击项目根目录的 `start.bat`
3. 浏览器打开控制台（默认 `http://127.0.0.1:8787`）
4. 按提示设置 / 使用登录密钥进入后台

强制重建 Web UI：

```bat
start.bat force
```

### 便携发行版（免装系统 Node）

开发机（需已装 Node）双击 **`打包.bat`**，会构建并生成：

- `dist/kakake-win-x64/` 与 `dist/kakake-win-x64.zip` — Windows 用户解压后运行其中的 `启动.bat`
- `dist/kakake-linux-x64/` 与 `dist/kakake-linux-x64.zip` — Linux 用户解压后运行 `./启动.sh`

两个成品目录会各自自动压成同名 `.zip`，可直接分发，无需手动压缩。

便携包内置官方 Node 22 LTS 运行时，**最终用户无需安装 Node**。与源码版 `start.bat` / `start.sh`（依赖系统 Node + bootstrap）相互独立。

> ⚠️ **关于更新的重要声明**
>
> - **所有「免 Node.js」的便携分发版（`kakake-win-x64` / `kakake-linux-x64` 等）均为一次性产品，不支持在线更新**，只能**手动部署更新**：下载新版便携包，解压后把新文件覆盖到原目录（保留你的 `data/`、`log/`、`plugins/`、`plugins_two/` 数据目录即可）。
> - **只有开发版（即源码版）支持在线更新**：源码版含 `scripts/bootstrap.mjs`，可在控制台内一键下载、暂存并重启应用更新。
> - 便携版控制台中若出现更新相关入口，请以本声明为准，勿用于便携版自更新。

### 手动 / 跨平台

```bash
# 安装依赖
npm install

# 构建 Web 控制台并启动
npm start

# 开发：热重载后端（控制台需先 npm run build:web；或另开 npm run dev:web）
npm run dev
```

首次启动会：

- 初始化 `data/` 等本地目录
- 生成后台登录密钥（`data/auth-key.json`）
- 按需安装 / 构建 Web UI（Vite 产物在可删除的 `packages/web/dist`）
- 用户协议同意记录写入 `data/agreement/<框架版本>.json`（本机实例共享；换版本或缺文件才再弹）

---

## 目录结构

```text
kakake/
├── start.bat / start.sh     # 一键启动
├── package.json             # 后端依赖与脚本
├── scripts/                 # bootstrap、Web 构建辅助
├── src/                     # 后端与 Web 源码
│   ├── main.ts              # 入口
│   ├── connection/          # OneBot / QQ 官方 / KOOK / 微信 / Telegram Bot 连接
│   ├── plugin/              # 插件加载与管理
│   ├── admin/               # 鉴权与管理 API
│   ├── core/                # 配置、日志、类型
│   └── web/                 # Vite + React 控制台源码
├── plugins/                 # 插件安装目录
├── plugins_two/             # 按账号隔离的插件运行副本
├── data/                    # 本地配置与运行数据（勿随意公开）
│   └── agreement/           # 用户协议同意记录（按框架版本命名）
├── log/                     # 运行日志
├── packages/                # Web 依赖与 Vite dist（可整夹删除，启动会重建）
├── 使用教程/                # 连接教程、Telegram Bot 接入教程、插件开发教程原文等
│   └── 插件开发/            # 控制台「工具 → 插件开发」数据源（总览 / 野鸡 TS / 野鸡 JS-ESM / 野鸡 JS-CJS / 双生 / QQ 官方 / Telegram / 扩展 + manifest.json）
└── README.md
```

说明：

- `packages/` 可整夹删除；启动或 `build:web` 时由脚本自动生成（产物为 `packages/web/dist`）
- `data/`、`log/` 含密钥与业务数据，**不要**提交到公开仓库
- 上传到 GitHub 时请确认已排除 Token、密钥与隐私文件

---

## 管理后台

默认监听（可在配置中修改）：

| 项 | 默认值 |
|----|--------|
| 地址 | `0.0.0.0` / 本机访问 `127.0.0.1` |
| 端口 | `8787` |
| 登录 | `data/auth-key.json` 中的密钥（强制鉴权） |

主要页面能力（随版本可能增减）：

- **连接管理**：添加 / 启用 OneBot、QQ 官方、KOOK、微信、Telegram Bot 连接
- **插件管理 / 插件商店**：安装、启用、配置插件
- **日志**：查看运行与动作日志
- **设置**：主机端口、日志级别、API 超时等
- **公告 / 用户协议**：首次（或框架版本升级后）需同意；记录在 `data/agreement/<版本>.json`，同一实例任意设备共享

> 控制台端口（如 8787）与 OneBot 监听口（如 6700 / 6701）不是同一回事，请勿混用。Telegram Webhook 回调走控制台对外地址 `/tgbot/<连接id>`，与 OneBot 监听口也不是一回事。

---

## 连接方式

平时建议只启用 **一种** 主连接方式，避免重复收消息。

### OneBot（NapCat 等）

| 模式 | 含义（简要） |
|------|----------------|
| 反向 WebSocket | 咔咔开 Server，NapCat 作为 Client 连入（推荐入门） |
| 正向 WebSocket | NapCat 开 WS Server，咔咔主动连过去 |
| HTTP 服务器 | NapCat POST 事件到咔咔独立端口，咔咔再调 NapCat HTTP API |
| HTTP SSE 服务器 | 类似 HTTP 服务器，并可作为 SSE 事件源 |
| HTTP 客户端 | 不上报独立口；事件可走 `http://主机:8787/onebot/http/<连接id>` |

### QQ 官方机器人

| 模式 | 含义（简要） |
|------|----------------|
| 官方 WebSocket | 咔咔连接腾讯 Gateway（一般无需公网域名） |
| 官方 HTTPS | Webhook：腾讯 POST 到 `/gfbot/<连接id>`（需可信 HTTPS 与域名） |

### KOOK 机器人

在 [KOOK 开发者中心](https://developer.kook.cn/) 建应用拿到 **Bot Token**，控制台添加 KOOK 连接填入即可（`Authorization: Bot <token>`，WebSocket 接入，按机器人账号隔离插件与数据）。

### 微信 AI×BOT

填入 iLink **bot_token**，控制台扫码登录后接入；账号以 `ilink_bot_id` 作隔离键。

### Telegram Bot

在 [@BotFather](https://t.me/BotFather) 用 `/newbot` 建机器人拿到 **token**（形如 `123456:ABC-DEF…`，等同密钥，勿公开），控制台添加连接选择 **Telegram Bot** 填入即可。框架用 `getMe` 回填 `telegramBotUserId` / `telegramBotUsername` / `telegramBotFirstName`，并以 `telegramBotUserId` 作为插件与数据的**账号隔离键**。

| 对接方式 | `mode` | 适用场景 |
|----------|--------|----------|
| 长轮询（默认） | `polling` | `getUpdates` 长轮询，**无需公网 IP / 域名 / 证书**，本机开发与内网部署首选 |
| Webhook | `webhook` | `setWebhook` HTTPS 回调，适合有公网域名与可信证书的生产部署 |
| 本地 Bot API Server | 两者皆可 | 把 `telegramApiBase` 指向自建服务器：HTTP / 任意端口、上传 2000MB、下载无大小限制、`getFile` 直接返回本地绝对路径 |

三者**正交**：`mode` 决定「怎么收 Update」，`telegramApiBase` 决定「API 请求发去哪」，可任意组合；`telegramTestEnv` 再决定「走生产还是测试环境」。

**配置要点**（控制台连接表单，对应 `data/connections.json` 字段）：

- 必填 `telegramToken`；`mode` 取 `polling` / `webhook`。
- 轮询：`telegramPollingTimeout`（长轮询秒数，默认 30）、`telegramPollingLimit`（1–100）、`telegramOffset`（游标，按 `update_id` 确认并持久化）、`telegramAllowedUpdates`（订阅的 Update 类型）。
- Webhook：`telegramWebhookUrl` 填完整公网 HTTPS 地址，回调**路径固定为 `/tgbot/<连接id>`**（例：`https://bot.example.com/tgbot/abcd1234`，反代须把这一路径原样转发到咔咔）；`telegramWebhookSecret` 为 1–256 位、仅 `A-Za-z0-9_-`，框架用它校验请求的 `X-Telegram-Bot-Api-Secret-Token` 头，不一致直接拒绝；另可配 `telegramWebhookMaxConnections`（1–100）、`telegramWebhookIpAddress`、`telegramWebhookCertificatePath`（自签证书 PEM 作为 `certificate` 上传）、`telegramDropPendingUpdates`、`telegramWebhookReplyInResponse`（把本次事件产生的首个 API 调用直接放进 2xx 响应体，省一次请求但拿不到 `result`）。官方 Webhook **只接受 443 / 80 / 88 / 8443 四个端口**。
- `telegramApiBase` 留空走官方 `https://api.telegram.org`；填自建地址即切到本地 Bot API Server（切换前须在官方服务器上 `logOut`，且一个 token 同一时刻只能挂在一种服务器上）。
- `telegramTestEnv`：勾上后请求走 `/bot<token>/test/METHOD`，在**测试环境**里跑，不碰真实会话与数据。
- `telegramProxyUrl`：服务器无法直连 Telegram 时填 HTTP 代理（如 `http://127.0.0.1:7897`）。
- `telegramParseMode`：默认文本解析模式，建议 `HTML`；用 `MarkdownV2` 必须对 `_*[]()~`>#+-=|{}.!` 等字符转义。
- 插件侧：`actions.call('sendMessage', { chat_id, text })` 可直接调用任意 Bot API 方法名（`answerCallbackQuery`、`getFile`、`sendMessageDraft` …），事件对象带 `telegram: true` 标记、走 `telegram/event` 与 `telegram/action_result` 通道。

**几个容易踩的官方限制**：

- **隐私模式默认开启**：群里机器人只收得到 `/命令`、`@机器人` 的回复与部分服务消息，收不到普通群聊文本。要全量消息就到 BotFather 用 `/setprivacy` 关闭，**关闭后必须把机器人移出群再重新拉入**才生效。
- **限频**：单聊约 1 条/秒、群组约 20 条/分钟、广播约 30 条/秒；触发 429 时响应带 `retry_after`，按其秒数退避重试。
- **文件大小**：官方服务器上传上限 50MB、下载上限 20MB；本地 Bot API Server 上传 2000MB、下载无限制。
- **Update 最多保留 24 小时**；`getUpdates` 与 `setWebhook` **不能同时用**，切换时先 `deleteWebhook`（否则报 409）。
- Inline Mode、允许入群、Bot-to-Bot、Managed Bots 等能力都要在 BotFather 用 `/setinline`、`/setjoingroups` 等开关显式打开。
- 当前 Bot API 版本 **10.4**（2026-11-09），支持 Rich Messages、Ephemeral Messages、Widgets、`sendMessageDraft` 流式草稿等；用 `actions.call` 传方法名即可调用。

> 完整分步教程（BotFather 开关、证书与 Nginx 反代、Update 全类型、键盘与内联查询、`file_id` 复用、Stars 支付、10.x 新能力、插件侧事件形状与排错清单）见 **[`使用教程/Telegram Bot 接入教程.md`](<./使用教程/Telegram Bot 接入教程.md>)**。

### 详细教程

Linux 服务器上一键装 NapCat / 咔咔 / Node、启停与端口排查见：

**[`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt)**（仓库根目录 `mk` 脚本）

完整连接分步说明（含 Docker 网关地址、Token / X-Signature、参数速查表、Telegram Bot 一节）见：

**[`使用教程/连接教程.txt`](./使用教程/连接教程.txt)**

Telegram Bot 专项完整教程见：

**[`使用教程/Telegram Bot 接入教程.md`](<./使用教程/Telegram Bot 接入教程.md>)**

推荐入门组合（本机）：

1. 咔咔添加 **反向 WS**：`0.0.0.0:6700` + Access Token  
2. NapCat 开启 **WebSocket 客户端**：`ws://127.0.0.1:6700` + 相同 Token  
3. 测试群发一条消息，确认咔咔日志有上报  

NapCat 在 Docker、咔咔在宿主机时，容器内访问宿主机常见网关为 `172.17.0.1`（以实际环境为准）。

---

## 插件系统

- 安装目录：`plugins/`
- 按机器人账号隔离的运行副本：`plugins_two/<QQ或AppID或telegramBotUserId>/<pluginId>/`
- 兼容 NapCat 插件包结构（`package.json` / `plugin.json` 等）
- 可通过控制台管理启用状态与插件配置；连接与插件可按账号绑定
- 插件类型按目录名前缀区分：`kakake-`（OneBot）、`GF-`（QQ 官方机器人）、`sssx-plugin-`（**双生**：同一份代码同时挂 OneBot 与 QQ 官方两条协议）、`WX-`（微信）、`ss-plugin-`（KOOK 等）、`TG-plugin-`（**Telegram Bot**）、`kz-plugin-`（**扩展**：不绑任何连接，只由总开关启停，数据目录为 `data/<插件id>`）

开发 / 安装插件时请注意：

- 插件 ≠ 平台本体；启用即表示你自愿使用该插件
- 第三方插件安全与合规由你自行甄别
- 勿将含密钥的插件配置提交到公开仓库

### 插件信任模型

**安装插件 = 在本机以框架同等权限运行任意代码**：插件可以读写你的文件、发起任意网络请求、启动子进程，框架不对插件代码做沙箱隔离。请只安装来自可信来源的插件，安装前自行审查其源码。商店分发中带 `.sig` 签名的插件包会强制执行 Ed25519 验签；**不带 `.sig` 的包不会被拦截**，是否安装取决于你自己的判断。

---

## 配置与数据

主要路径（均在本地）：

| 路径 | 用途 |
|------|------|
| `data/config.json` | 主机、端口、日志级别、API 超时等 |
| `data/auth-key.json` | 后台登录密钥 |
| `data/connections.json` | 连接配置（含 Telegram token 等密钥，勿公开） |
| `data/plugins.json` 等 | 插件状态与关联 |
| `data/ai/` | AI 助手数据：上游档案（含密钥，勿公开）、会话历史、操作审计 |
| `log/` | 运行日志 |

默认配置概念（以实际 `config.json` 为准）：

- `host` / `port`：控制台监听
- `logLevel`：`debug` \| `info` \| `warn` \| `error`
- `apiTimeoutMs`：OneBot API 超时（大文件发送建议适当加大）

修改连接或关键配置后：保存 → 确认对端（NapCat / 开放平台 / BotFather）已启用 → 必要时重启咔咔 → 发消息自检。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `start.bat` / `start.sh` | 一键安装依赖、按需构建 Web、启动 |
| `start.bat force` | 强制重建 Web UI 后启动 |
| `start.bat verbose` | 保留安装/构建过程输出（默认安静，构建完再清屏） |
| `npm start` | 构建 Web 并启动 `src/main.ts` |
| `npm run build:web` | 仅构建 Web 控制台 |
| `npm run dev` | 后端 `tsx watch` 热重载 |
| `npm run dev:web` | Web 开发相关辅助（见 `scripts/ensure-web.mjs`） |

环境变量示例：

| 变量 | 说明 |
|------|------|
| `KAKAKE_FORCE_WEB_BUILD=1` | 强制重建 Web（`start.bat force` 会设置） |
| `KAKAKE_VERBOSE_BOOT=1` | 打印全部安装/构建过程，且启动前不清屏（`start.bat verbose` 会设置） |
| `KAKAKE_BOOTSTRAP_DRY_RUN=1` | 只做依赖/构建检查，不启动服务（排查启动问题用） |
| `KAKAKE_NO_WEB=1` | 不托管 Web 控制台（仅 API / 插件 / 连接） |
| `X_PROXY_URL` | 工具「视频解析」里 X（推特）解析、twimg / telesco.pe 媒体下载走的本机代理，默认 `http://127.0.0.1:7897`（Clash 系混合端口）；设 `off` 关闭 |
| `X_FXTWITTER_FALLBACK=off` | 关闭 X 解析的第三方兜底接口（见下），默认开启 |

> **Telegram Bot 连接的代理不走环境变量**：服务器无法直连 `api.telegram.org` 时，在**连接表单**里填 `telegramProxyUrl`（如 `http://127.0.0.1:7897`），它是连接级配置、按连接生效。上表的 `X_PROXY_URL` 只作用于「工具 → 视频解析」，**不影响** Telegram Bot 连接；Webhook 方式另外要求 Telegram 服务器能反向访问你的公网地址，这与出向代理是两码事。

**关于 X（推特）解析的取数**：X 的官方嵌入接口与 twimg 媒体域名在境内无法直连，所以 X 这一路依赖 `X_PROXY_URL` 指向的本机代理。官方接口取不到数据时，解析会退回第三方公开接口 `api.fxtwitter.com`（只把推文 ID 发过去），用来补齐浏览量、收藏、转推这类官方嵌入接口不返回的统计。不希望推文 ID 外发就把 `X_FXTWITTER_FALLBACK` 设为 `off`，此时仅用官方嵌入接口。

**关于「视频解析」的限速**：解析 30 次/分钟、下载 60 次/分钟、预览 300 次/分钟，按「会话 → 登录密钥 → 来源 IP」依次分桶，状态只在内存里，重启框架即清空。

**关于 Telegram 解析**：走公开帖的分享卡片（`t.me/频道/帖号?embed=1&single`），不需要账号、api_id 或任何登录态，因此只覆盖**公开频道**——私有频道的内部链接（`t.me/c/…`）与邀请链接（`t.me/+…`）会被明确拒绝并说明原因，要读这类内容得换成 MTProto 方案。t.me 与媒体域名 `telesco.pe` 在境内无法直连，同样依赖 `X_PROXY_URL` 指向的本机代理。一条帖子里的多张图片会全部返回；若一条帖子包含多个视频，只返回第 1 个并在页面上标注数量。

**Telegram 的文件与音频拿不到**：公开卡片只渲染**图片、视频**这两类内容。附件是文件或音频时（APK、PDF、音乐、语音消息等，软件分享类频道基本全是这种），Telegram 会把整条帖子的正文与附件一起换成一句「Please open Telegram to view this post」，页面里既没有文件名也没有下载地址，工具会直接说明这一点，而不是错报成「纯文字帖」。开启了「限制保存内容」的频道同理。要解析这类资源必须改用账号态方案：MTProto（Telethon / Pyrogram / gramjs，需要 api_id + 登录会话，可读任意公开频道）或 Bot API（把机器人设为频道管理员，只能读它有权限的消息）。

> 注意区分：**「工具 → 视频解析」里的 Telegram 链接解析**（读公开帖子，不需要 token、只读）与 **「连接方式 → Telegram Bot」**（用 BotFather token 收发消息、跑插件）是两个完全独立的功能，共用 `X_PROXY_URL` 也不是同一条链路。

---

## 开发说明

技术栈概览：

- **后端**：Node.js + NestJS（Express）+ TypeScript（`tsx` 直接运行）
- **前端**：Vite + React + React Router（源码 `src/web`，产物 `packages/web/dist`，由主进程静态托管）
- **实时**：`ws` WebSocket；HTTP / SSE 多种 OneBot 模式；Telegram `getUpdates` 长轮询 / Webhook
- **插件**：动态加载，兼容 NapCat 插件接口风格

贡献或二开时建议：

1. 保持 Node ≥ 20（推荐 22 LTS，与便携包内置运行时一致）
2. 不要提交 `node_modules/`、`packages/`、`data/` 密钥、`log/`
3. 连接与插件行为以本地实测为准，并同步更新 `使用教程/`

---

## 常见问题

**1. 提示 Web UI 未构建**  
运行 `npm run build:web` 或 `start.bat force`。

**2. 容器访问咔咔被拒绝（ECONNREFUSED）**  
咔咔监听请用 `0.0.0.0`，不要只绑 `127.0.0.1`；容器侧 URL 用宿主机网关 IP（常见 `172.17.0.1`）。

**3. 401 / 鉴权失败**  
检查两边 Access Token 是否一致；HTTP 上报可能使用 `X-Signature`，需两边 Token 相同。Telegram 报 401 Unauthorized 则是 `telegramToken` 填错、被吊销或用了测试环境 token 打生产地址。

**4. 收不到消息或收两遍**  
确认只启用一种连接模式；正向端口不要误填成反向监听口（如 6700）。Telegram 群里收不到普通聊天文本，多半是 **BotFather 隐私模式默认开启**——用 `/setprivacy` 关闭后**重新拉群**；Webhook 与轮询同时开也会导致异常。

**5. 端口被占用**  
更换控制台或 OneBot 端口，或结束占用进程后再启动。

**6. 忘记后台密码**  
本地查看或重置 `data/auth-key.json`（重置后需重新登录；请谨慎操作）。

**7. 图片混淆的「超大图服务端处理」不可用 / 提示缺少 `sharp`**  
该功能依赖 `sharp`（含当前平台的预编译二进制），它在框架启动后按需加载：缺了只影响这一个
功能，框架照常运行。到 **控制台 → 设置 → 图片引擎环境** 点「一键安装」即可，装完**无需重启**。

安装位置是 **`data/runtime-deps/node_modules/sharp`**：MKbot 插件也把 sharp 装在
`data/runtime-deps`，所以宿主与插件**共用同一份**（不再各装几十 MB）；只要任一位置已经
有可用的 sharp（包括便携包内置的那份），就会直接用，不需要再装。在线更新只替换源码与
`package.json`、不会动这些目录，所以版本更新后按需补一次即可。启动日志里出现
`Cannot find package 'sharp'` 的旧版本，升级到本版后不会再因此起不来。

**8. Telegram 报 409 Conflict（"can't use getUpdates method while webhook is active"）**  
同一 token 不能既 `setWebhook` 又 `getUpdates`。先调 `deleteWebhook`（或勾 `telegramDropPendingUpdates`），再切回 `polling`；检查 `getWebhookInfo` 的 `url` 是否为空。

**9. Telegram 报 429 / "Too Many Requests: retry after N"**  
触发限频（单聊约 1 条/秒、群组约 20 条/分钟、广播约 30 条/秒）。按响应里的 `retry_after` 秒数退避后重试，别无脑猛发；批量广播前做排队与限速。

**10. Telegram 报 "can't parse entities" / 回调地址不通 / 证书报错**  
`can't parse entities` = `MarkdownV2` 文本没转义特殊字符（或改回 `HTML`）；回调地址不通先确认公网可达、端口是 443/80/88/8443 之一、反代把 `/tgbot/<连接id>` 原样转发、且 `X-Telegram-Bot-Api-Secret-Token` 与 `telegramWebhookSecret` 一致；自签证书需保证 CN / SAN 与域名匹配并通过 `telegramWebhookCertificatePath` 上传。

更多连接细节见 [`使用教程/连接教程.txt`](./使用教程/连接教程.txt)；Telegram Bot 专项见 [`使用教程/Telegram Bot 接入教程.md`](<./使用教程/Telegram Bot 接入教程.md>)。  
Linux `mk` 脚本用法见 [`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt)。

---

## 官方渠道与协议

- 官方交流 QQ 群：[955682835](https://qm.qq.com/q/ja7l7wLSjC)
- 用户协议与公告：控制台公告页，源稿见 `src/web/content/announcement-fallback.md`
- 本软件为**本地部署**工具：维护者不托管你的账号与聊天数据；合规与账号安全由使用者自行负责

使用本项目即表示你已阅读并理解相关协议条款。若不同意，请停止使用并删除相关文件。

---

## 版本

- 当前 `package.json` 版本：`0.6.11-beta.1`
- GitHub Release 资产附有 Ed25519 签名（`<资产>.sig`），由 CI 工作流在发版后自动生成
- 文档随仓库更新；连接步骤以 `使用教程/连接教程.txt` 为准；Telegram Bot 以 `使用教程/Telegram Bot 接入教程.md` 为准；`mk` 脚本以 `使用教程/MK工具教程.txt` 为准

---

**咔咔珂 · kakake** — 本地插件平台，连上载体，管好插件。
