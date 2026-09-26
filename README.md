# 咔咔珂（kakake）

[![version](https://img.shields.io/badge/version-0.5.2-2dd4bf?style=flat-square)](../../releases)
[![download](https://img.shields.io/badge/下载-Releases-0ea5e9?style=flat-square&logo=github&logoColor=white)](../../releases/latest)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/平台-Windows%20%7C%20Linux%20%7C%20macOS-64748b?style=flat-square)](#环境要求)
[![QQ group](https://img.shields.io/badge/QQ群-955682835-1e90ff?style=flat-square&logo=tencentqq&logoColor=white)](https://qm.qq.com/q/ja7l7wLSjC)

TypeScript **插件平台框架**：本地部署、Web 控制台运维，通过 OneBot（如 NapCat）、QQ 开放平台、KOOK、微信 AI×BOT 等多种载体接入机器人能力，并兼容 NapCat 插件规范。

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
| 插件平台 | 兼容 NapCat 插件规范；按账号隔离运行副本；含插件商店与「插件开发」教程 |
| 本地持久化 | 配置、密钥、连接、插件状态保存在本机 `data/` |
| 界面外观 | 三组可调配色（字体 / 组件 / Logo）、竖横两份背景（图片或循环视频）、卡片与背景模糊、动效速度、**自定义标题名** |
| 系统信息 | 概览页实时监控 CPU / 内存 / 磁盘占用与运行时长，识别发行版 |
| 模拟消息 | 本地模拟 OneBot 群聊 / 私聊上报，真实触发已加载插件，发送与 API 调用被拦截展示、不外发 |
| 工具 · 视频解析 | 粘贴 B站 / 抖音 / 小红书 / 快手 / TikTok / YouTube / X（推特）/ Telegram 分享链接，解析标题、封面、图集与直链，支持服务端代理下载 |
| 工具 · 编码转换 | Base64 / Base32 / Hex / URL / Unicode / HTML 实体 / 进制 / gzip 互转，纯本地 |
| 工具 · Zepp 步数 | Zepp Life 账号步数同步，数据存本机 `data/` |
| 一键启动 | Windows `start.bat` / 类 Unix `start.sh`，自动装依赖并构建 Web UI |

---

## 环境要求

- **Node.js** ≥ 20
- 推荐使用 **pnpm**（亦可通过启动脚本自动处理依赖）
- Windows / Linux / macOS 均可；Windows 可直接双击 `start.bat`

可选配套：

- [NapCat](https://github.com/NapNeko/NapCatQQ) 等 OneBot 实现
- QQ 开放平台机器人（官方 WS / Webhook）
- KOOK 机器人（Bot Token）、微信 AI×BOT（iLink bot_token）

---

## 快速开始

### Windows

1. 安装 [Node.js 20+](https://nodejs.org/)
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

便携包内置官方 Node 运行时，**最终用户无需安装 Node**。与源码版 `start.bat` / `start.sh`（依赖系统 Node + bootstrap）相互独立。

### 手动 / 跨平台

```bash
# 安装依赖（按你的包管理器）
pnpm install
# 或: npm install

# 构建 Web 控制台并启动
pnpm start

# 开发：热重载后端（控制台需先 pnpm build:web；或另开 pnpm dev:web）
pnpm dev
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
│   ├── connection/          # OneBot / QQ 官方连接
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
├── 使用教程/                # 连接教程、插件开发教程原文等
│   └── 插件开发/            # 控制台「工具 → 插件开发」数据源（总览 / 野鸡 TS / 野鸡 JS-ESM / 野鸡 JS-CJS + manifest.json）
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

- **连接管理**：添加 / 启用 OneBot 与 QQ 官方连接
- **插件管理 / 插件商店**：安装、启用、配置插件
- **日志**：查看运行与动作日志
- **设置**：主机端口、日志级别、API 超时等
- **公告 / 用户协议**：首次（或框架版本升级后）需同意；记录在 `data/agreement/<版本>.json`，同一实例任意设备共享

> 控制台端口（如 8787）与 OneBot 监听口（如 6700 / 6701）不是同一回事，请勿混用。

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

### 详细教程

Linux 服务器上一键装 NapCat / 咔咔 / Node、启停与端口排查见：

**[`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt)**（仓库根目录 `mk` 脚本）

完整连接分步说明（含 Docker 网关地址、Token / X-Signature、参数速查表）见：

**[`使用教程/连接教程.txt`](./使用教程/连接教程.txt)**

推荐入门组合（本机）：

1. 咔咔添加 **反向 WS**：`0.0.0.0:6700` + Access Token  
2. NapCat 开启 **WebSocket 客户端**：`ws://127.0.0.1:6700` + 相同 Token  
3. 测试群发一条消息，确认咔咔日志有上报  

NapCat 在 Docker、咔咔在宿主机时，容器内访问宿主机常见网关为 `172.17.0.1`（以实际环境为准）。

---

## 插件系统

- 安装目录：`plugins/`
- 按机器人账号隔离的运行副本：`plugins_two/<QQ或AppID>/<pluginId>/`
- 兼容 NapCat 插件包结构（`package.json` / `plugin.json` 等）
- 可通过控制台管理启用状态与插件配置；连接与插件可按账号绑定

开发 / 安装插件时请注意：

- 插件 ≠ 平台本体；启用即表示你自愿使用该插件
- 第三方插件安全与合规由你自行甄别
- 勿将含密钥的插件配置提交到公开仓库

---

## 配置与数据

主要路径（均在本地）：

| 路径 | 用途 |
|------|------|
| `data/config.json` | 主机、端口、日志级别、API 超时等 |
| `data/auth-key.json` | 后台登录密钥 |
| `data/connections.json` | 连接配置 |
| `data/plugins.json` 等 | 插件状态与关联 |
| `log/` | 运行日志 |

默认配置概念（以实际 `config.json` 为准）：

- `host` / `port`：控制台监听
- `logLevel`：`debug` \| `info` \| `warn` \| `error`
- `apiTimeoutMs`：OneBot API 超时（大文件发送建议适当加大）

修改连接或关键配置后：保存 → 确认对端（NapCat / 开放平台）已启用 → 必要时重启咔咔 → 发消息自检。

---

## 常用命令

| 命令 | 说明 |
|------|------|
| `start.bat` / `start.sh` | 一键安装依赖、按需构建 Web、启动 |
| `start.bat force` | 强制重建 Web UI 后启动 |
| `start.bat verbose` | 保留安装/构建过程输出（默认安静，构建完再清屏） |
| `pnpm start` | 构建 Web 并启动 `src/main.ts` |
| `pnpm build:web` | 仅构建 Web 控制台 |
| `pnpm dev` | 后端 `tsx watch` 热重载 |
| `pnpm dev:web` | Web 开发相关辅助（见 `scripts/ensure-web.mjs`） |

环境变量示例：

| 变量 | 说明 |
|------|------|
| `KAKAKE_FORCE_WEB_BUILD=1` | 强制重建 Web（`start.bat force` 会设置） |
| `KAKAKE_VERBOSE_BOOT=1` | 打印全部安装/构建过程，且启动前不清屏（`start.bat verbose` 会设置） |
| `KAKAKE_BOOTSTRAP_DRY_RUN=1` | 只做依赖/构建检查，不启动服务（排查启动问题用） |
| `KAKAKE_NO_WEB=1` | 不托管 Web 控制台（仅 API / 插件 / 连接） |
| `X_PROXY_URL` | 工具「视频解析」里 X（推特）解析、twimg / telesco.pe 媒体下载走的本机代理，默认 `http://127.0.0.1:7897`（Clash 系混合端口）；设 `off` 关闭 |
| `X_FXTWITTER_FALLBACK=off` | 关闭 X 解析的第三方兜底接口（见下），默认开启 |

**关于 X（推特）解析的取数**：X 的官方嵌入接口与 twimg 媒体域名在境内无法直连，所以 X 这一路依赖 `X_PROXY_URL` 指向的本机代理。官方接口取不到数据时，解析会退回第三方公开接口 `api.fxtwitter.com`（只把推文 ID 发过去），用来补齐浏览量、收藏、转推这类官方嵌入接口不返回的统计。不希望推文 ID 外发就把 `X_FXTWITTER_FALLBACK` 设为 `off`，此时仅用官方嵌入接口。

**关于「视频解析」的限速**：解析 30 次/分钟、下载 60 次/分钟、预览 300 次/分钟，按「会话 → 登录密钥 → 来源 IP」依次分桶，状态只在内存里，重启框架即清空。

**关于 Telegram 解析**：走公开帖的分享卡片（`t.me/频道/帖号?embed=1&single`），不需要账号、api_id 或任何登录态，因此只覆盖**公开频道**——私有频道的内部链接（`t.me/c/…`）与邀请链接（`t.me/+…`）会被明确拒绝并说明原因，要读这类内容得换成 MTProto 方案。t.me 与媒体域名 `telesco.pe` 在境内无法直连，同样依赖 `X_PROXY_URL` 指向的本机代理。一条帖子里的多张图片会全部返回；若一条帖子包含多个视频，只返回第 1 个并在页面上标注数量。

**Telegram 的文件与音频拿不到**：公开卡片只渲染**图片、视频**这两类内容。附件是文件或音频时（APK、PDF、音乐、语音消息等，软件分享类频道基本全是这种），Telegram 会把整条帖子的正文与附件一起换成一句「Please open Telegram to view this post」，页面里既没有文件名也没有下载地址，工具会直接说明这一点，而不是错报成「纯文字帖」。开启了「限制保存内容」的频道同理。要解析这类资源必须改用账号态方案：MTProto（Telethon / Pyrogram / gramjs，需要 api_id + 登录会话，可读任意公开频道）或 Bot API（把机器人设为频道管理员，只能读它有权限的消息）。

---

## 开发说明

技术栈概览：

- **后端**：Node.js + NestJS（Express）+ TypeScript（`tsx` 直接运行）
- **前端**：Vite + React + React Router（源码 `src/web`，产物 `packages/web/dist`，由主进程静态托管）
- **实时**：`ws` WebSocket；HTTP / SSE 多种 OneBot 模式
- **插件**：动态加载，兼容 NapCat 插件接口风格

贡献或二开时建议：

1. 保持 Node 20+
2. 不要提交 `node_modules/`、`packages/`、`data/` 密钥、`log/`
3. 连接与插件行为以本地实测为准，并同步更新 `使用教程/`

---

## 常见问题

**1. 提示 Web UI 未构建**  
运行 `pnpm build:web` 或 `start.bat force`。

**2. 容器访问咔咔被拒绝（ECONNREFUSED）**  
咔咔监听请用 `0.0.0.0`，不要只绑 `127.0.0.1`；容器侧 URL 用宿主机网关 IP（常见 `172.17.0.1`）。

**3. 401 / 鉴权失败**  
检查两边 Access Token 是否一致；HTTP 上报可能使用 `X-Signature`，需两边 Token 相同。

**4. 收不到消息或收两遍**  
确认只启用一种连接模式；正向端口不要误填成反向监听口（如 6700）。

**5. 端口被占用**  
更换控制台或 OneBot 端口，或结束占用进程后再启动。

**6. 忘记后台密码**  
本地查看或重置 `data/auth-key.json`（重置后需重新登录；请谨慎操作）。

更多连接细节见 [`使用教程/连接教程.txt`](./使用教程/连接教程.txt)。  
Linux `mk` 脚本用法见 [`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt)。

---

## 官方渠道与协议

- 官方交流 QQ 群：[955682835](https://qm.qq.com/q/ja7l7wLSjC)
- 用户协议与公告：控制台公告页，源稿见 `src/web/content/announcement-fallback.md`
- 本软件为**本地部署**工具：维护者不托管你的账号与聊天数据；合规与账号安全由使用者自行负责

使用本项目即表示你已阅读并理解相关协议条款。若不同意，请停止使用并删除相关文件。

---

## 版本

- 当前 `package.json` 版本：`0.5.2`
- 文档随仓库更新；连接步骤以 `使用教程/连接教程.txt` 为准；`mk` 脚本以 `使用教程/MK工具教程.txt` 为准

---

**咔咔珂 · kakake** — 本地插件平台，连上载体，管好插件。
