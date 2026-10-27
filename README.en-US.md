# Kakake (咔咔珂)

[![version](https://img.shields.io/badge/version-0.6.9--beta.2-2dd4bf?style=flat-square)](../../releases)
[![download](https://img.shields.io/badge/Download-Releases-0ea5e9?style=flat-square&logo=github&logoColor=white)](../../releases/latest)
[![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020%20%C2%B7%2022%20LTS%20recommended-3c873a?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-64748b?style=flat-square)](#requirements)
[![QQ group](https://img.shields.io/badge/QQ_Group-955682835-1e90ff?style=flat-square&logo=tencentqq&logoColor=white)](https://qm.qq.com/q/ja7l7wLSjC)

English | [简体中文](./README.md)

Kakake is a TypeScript **plugin platform framework**: deploy locally, operate via a web console, and plug bot capabilities into OneBot carriers (e.g. NapCat), the official QQ Bot platform, KOOK, WeChat AI×BOT and more — compatible with the NapCat plugin spec.

> 📦 **[Download / view the latest release →](../../releases/latest)**　·　All releases and changelogs live on the repo's **Releases** page.

> **Scope note**: Kakake is a plugin platform with an ops console — **not** a standalone bot protocol framework, and not a replacement for NapCat / NoneBot / AstrBot / Koishi. You configure the carriers and upstream protocols yourself.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Project Layout](#project-layout)
- [Admin Console](#admin-console)
- [Connections](#connections)
- [Plugin System](#plugin-system)
- [Config & Data](#config--data)
- [Common Commands](#common-commands)
- [Development](#development)
- [FAQ](#faq)
- [Channels & License](#channels--license)

---

## Features

| Capability | Description |
|------------|-------------|
| Web console | Vite + React SPA admin panel: overview, connections, plugins, plugin store, tools, logs, settings, protocols, etc. |
| OneBot access | Forward / reverse WebSocket, HTTP / HTTP SSE / HTTP client |
| Official QQ bot | Gateway WebSocket, HTTPS Webhook |
| KOOK bot | Bot Token access (`Authorization: Bot <token>`), isolated per account |
| WeChat AI×BOT | iLink bot_token QR-code login access |
| Plugin platform | Compatible with the NapCat plugin spec; per-account isolated copies; includes a plugin store and a "plugin development" tutorial |
| Local persistence | Config, keys, connections and plugin state stay in local `data/` |
| Appearance | Three adjustable color groups (font / components / logo), portrait & landscape backgrounds (image or looping video), card & background blur, animation speed, **custom console title** |
| System info | Live CPU / memory / disk usage and uptime on the overview page, with distro detection |
| Mock messages | Simulates OneBot group / private reports locally to trigger loaded plugins for real; sends and API calls are intercepted and displayed, never sent out |
| Tool · Video parser | Paste a Bilibili / Douyin / Xiaohongshu / Kuaishou / TikTok / YouTube / X (Twitter) / Telegram share link to parse title, cover, image sets and direct media links, with server-side proxied download |
| Tool · Encoding converter | Base64 / Base32 / Hex / URL / Unicode / HTML entities / radix / gzip conversion, fully local |
| AI assistant | The "AI" page in the console: custom OpenAI / Anthropic upstreams (multiple profiles); continuous task execution — analyze `plugins/` and `log/` content, create or modify plugins; file operations are limited to whitelisted directories and shown as per-file diffs, deployed only after manual confirmation |
| One-click start | Windows `start.bat` / Unix `start.sh` — installs dependencies and builds the web UI automatically |

---

## Requirements

- **Node.js** ≥ 20 (**22 LTS recommended**: Node 20 is EOL with no more security patches; the portable builds bundle Node 22)
- **pnpm** recommended (startup scripts can handle dependencies automatically)
- Windows / Linux / macOS all work; on Windows just double-click `start.bat`

Optional companions:

- A OneBot implementation such as [NapCat](https://github.com/NapNeko/NapCatQQ)
- A QQ open-platform bot (official WS / Webhook)
- A KOOK bot (Bot Token), or WeChat AI×BOT (iLink bot_token)

---

## Quick Start

### Windows

1. Install [Node.js 22 LTS](https://nodejs.org/) (20 is the minimum)
2. Double-click `start.bat` in the project root
3. Open the console in a browser (default `http://127.0.0.1:8787`)
4. Set / use the login key as prompted to enter the admin panel

Force-rebuild the web UI:

```bat
start.bat force
```

### Portable builds (no system Node needed)

On a dev machine (with Node installed), double-click **`打包.bat`** — it builds and produces:

- `dist/kakake-win-x64/` and `dist/kakake-win-x64.zip` — Windows users unzip and run the bundled `启动.bat`
- `dist/kakake-linux-x64/` and `dist/kakake-linux-x64.zip` — Linux users unzip and run `./启动.sh`

Both output folders are zipped automatically under the same name, ready to distribute.

The portable build bundles the official Node 22 LTS runtime, so **end users don't need Node installed**. It is independent of the source version's `start.bat` / `start.sh` (which rely on system Node + bootstrap).

> ⚠️ **Important note on updates**
>
> - **All "Node-free" portable builds (`kakake-win-x64` / `kakake-linux-x64` etc.) are one-shot products with no online update support** — update manually: download the new portable build and overwrite the old files (keep your `data/`, `log/`, `plugins/`, `plugins_two/` data folders).
> - **Only the source version supports online updates**: it ships `scripts/bootstrap.mjs`, which can download, stage and restart updates from within the console.
> - If update entries appear in a portable build's console, defer to this note — do not use them for portable self-updates.

### Manual / cross-platform

```bash
# Install dependencies (with your package manager)
pnpm install
# or: npm install

# Build the web console and start
pnpm start

# Development: hot-reload the backend (build the console first with pnpm build:web, or run pnpm dev:web alongside)
pnpm dev
```

On first start it will:

- Initialize `data/` and other local folders
- Generate the admin login key (`data/auth-key.json`)
- Install / build the web UI as needed (Vite output lives in the deletable `packages/web/dist`)
- Write the user-agreement acceptance record to `data/agreement/<framework version>.json` (shared per local instance; re-prompted only on a version change or missing file)

---

## Project Layout

```text
kakake/
├── start.bat / start.sh     # one-click start
├── package.json             # backend dependencies & scripts
├── scripts/                 # bootstrap, web build helpers
├── src/                     # backend & web source
│   ├── main.ts              # entry
│   ├── connection/          # OneBot / official QQ connections
│   ├── plugin/              # plugin loading & management
│   ├── admin/               # auth & admin APIs
│   ├── core/                # config, logging, types
│   └── web/                 # Vite + React console source
├── plugins/                 # plugin install directory
├── plugins_two/             # per-account isolated plugin copies
├── data/                    # local config & runtime data (don't publish)
│   └── agreement/           # user-agreement acceptance records (per version)
├── log/                     # runtime logs
├── packages/                # web deps & Vite dist (deletable; rebuilt on start)
├── 使用教程/                # connection & plugin-dev tutorials (Chinese)
└── README.md
```

Notes:

- `packages/` can be deleted entirely; it is regenerated automatically on start or `build:web` (output at `packages/web/dist`)
- `data/` and `log/` contain keys and business data — **do not** commit them to public repos
- When uploading to GitHub, make sure tokens, keys and private files are excluded

---

## Admin Console

Defaults (configurable):

| Item | Default |
|------|---------|
| Address | `0.0.0.0` / `127.0.0.1` for local access |
| Port | `8787` |
| Login | Key in `data/auth-key.json` (auth enforced) |

Main pages (subject to change between versions):

- **Connections**: add / enable OneBot and official QQ connections
- **Plugins / Plugin store**: install, enable and configure plugins
- **Logs**: runtime and action logs
- **Settings**: host, port, log level, API timeout, etc.
- **Announcement / user agreement**: accepted on first run (or after a framework version upgrade); recorded in `data/agreement/<version>.json`, shared across devices on the same instance

> The console port (e.g. 8787) is not the same thing as the OneBot listen ports (e.g. 6700 / 6701) — don't mix them up.

---

## Connections

Run **one** primary connection type at a time to avoid duplicate messages.

### OneBot (NapCat etc.)

| Mode | Meaning (brief) |
|------|-----------------|
| Reverse WebSocket | Kakake runs the server; NapCat connects in as the client (recommended for beginners) |
| Forward WebSocket | NapCat runs the WS server; Kakake connects out |
| HTTP server | NapCat POSTs events to a dedicated Kakake port; Kakake calls NapCat's HTTP API back |
| HTTP SSE server | Like the HTTP server, and also acts as an SSE event source |
| HTTP client | No separate report port; events arrive via `http://host:8787/onebot/http/<connection id>` |

### Official QQ bot

| Mode | Meaning (brief) |
|------|-----------------|
| Official WebSocket | Kakake connects to Tencent's Gateway (usually no public domain needed) |
| Official HTTPS | Webhook: Tencent POSTs to `/gfbot/<connection id>` (requires trusted HTTPS + domain) |

### KOOK bot

Create an app in the [KOOK Developer Center](https://developer.kook.cn/), get the **Bot Token**, and add a KOOK connection in the console (`Authorization: Bot <token>`, WebSocket access, plugins and data isolated per bot account).

### WeChat AI×BOT

Enter the iLink **bot_token** and scan the QR code in the console to connect; accounts are keyed by `ilink_bot_id`.

### Detailed tutorials

The tutorials folder (`使用教程/`) is in Chinese. For one-shot NapCat / Kakake / Node setup on Linux, service management and port troubleshooting, see [`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt) (the `mk` script at repo root). Step-by-step connection details (Docker gateway addresses, Token / X-Signature, parameter tables) are in [`使用教程/连接教程.txt`](./使用教程/连接教程.txt).

Recommended beginner setup (local machine):

1. Add a **reverse WS** connection in Kakake: `0.0.0.0:6700` + Access Token
2. Enable **WebSocket client** in NapCat: `ws://127.0.0.1:6700` + the same Token
3. Send a test group message and check Kakake's logs for the report

When NapCat runs in Docker and Kakake on the host, the container-side host gateway is commonly `172.17.0.1` (verify in your environment).

---

## Plugin System

- Install directory: `plugins/`
- Per-account isolated copies: `plugins_two/<QQ or AppID>/<pluginId>/`
- Compatible with the NapCat plugin package layout (`package.json` / `plugin.json` etc.)
- Manage enablement and plugin config from the console; connections and plugins can be bound per account
- Plugin types are distinguished by directory prefix: `kakake-` (OneBot), `GF-` (official QQ bot), `sssx-plugin-` (**dual**: the same code attached to both OneBot and official QQ), `WX-` (WeChat), `ss-plugin-` (KOOK etc.)

When developing / installing plugins:

- Plugins ≠ the platform itself; enabling one means you accept the risks
- Vet third-party plugins for security and compliance yourself
- Never commit plugin configs containing keys to public repos

---

## Config & Data

Main paths (all local):

| Path | Purpose |
|------|---------|
| `data/config.json` | Host, port, log level, API timeout, etc. |
| `data/auth-key.json` | Admin login key |
| `data/connections.json` | Connection configs |
| `data/plugins.json` etc. | Plugin state & bindings |
| `data/ai/` | AI assistant data: upstream profiles (contains keys — don't publish), session history, operation audit |
| `log/` | Runtime logs |

Default config concepts (see the actual `config.json`):

- `host` / `port`: console listen address
- `logLevel`: `debug` \| `info` \| `warn` \| `error`
- `apiTimeoutMs`: OneBot API timeout (increase for large file sends)

After changing connections or key config: save → confirm the peer (NapCat / open platform) is enabled → restart Kakake if needed → self-test with a message.

---

## Common Commands

| Command | Description |
|---------|-------------|
| `start.bat` / `start.sh` | Install deps, build web as needed, start |
| `start.bat force` | Force-rebuild the web UI then start |
| `start.bat verbose` | Keep install/build output visible (quiet by default; screen cleared after build) |
| `pnpm start` | Build web and start `src/main.ts` |
| `pnpm build:web` | Build the web console only |
| `pnpm dev` | Backend hot-reload via `tsx watch` |
| `pnpm dev:web` | Web dev helpers (see `scripts/ensure-web.mjs`) |

Environment variable examples:

| Variable | Description |
|----------|-------------|
| `KAKAKE_FORCE_WEB_BUILD=1` | Force web rebuild (set by `start.bat force`) |
| `KAKAKE_VERBOSE_BOOT=1` | Print all install/build output and skip screen-clear (set by `start.bat verbose`) |
| `KAKAKE_BOOTSTRAP_DRY_RUN=1` | Check deps/build only, don't start the service (troubleshooting) |
| `KAKAKE_NO_WEB=1` | Don't host the web console (API / plugins / connections only) |
| `X_PROXY_URL` | Local proxy for X (Twitter) parsing and twimg / telesco.pe media downloads in the video parser; default `http://127.0.0.1:7897` (Clash-style mixed port); set `off` to disable |
| `X_FXTWITTER_FALLBACK=off` | Disable the third-party fallback endpoint for X parsing (see below); on by default |

**About X (Twitter) parsing**: X's official embed API and the twimg media domain are unreachable from mainland China without a proxy, so this path relies on the local proxy at `X_PROXY_URL`. When the official API returns nothing, parsing falls back to the public third-party endpoint `api.fxtwitter.com` (only the tweet ID is sent) to fill in view/like/repost stats not returned by the official embed API. Set `X_FXTWITTER_FALLBACK=off` to keep tweet IDs from leaving your machine; only the official embed API is used then.

**Rate limits for the video parser**: 30 parses/min, 60 downloads/min, 300 previews/min, bucketed by session → login key → source IP; state is in-memory only and cleared on restart.

**About Telegram parsing**: uses public posts' share cards (`t.me/channel/post?embed=1&single`) — no account, api_id or login state needed, so only **public channels** are covered. Private-channel internal links (`t.me/c/…`) and invite links (`t.me/+…`) are explicitly rejected with an explanation; reading those requires an MTProto approach. `t.me` and the media domain `telesco.pe` are also unreachable from mainland China and rely on the `X_PROXY_URL` proxy. All images in a post are returned; if a post contains multiple videos, only the first is returned with a count noted on the page.

**Telegram files & audio are not available**: public cards render only **images and videos**. When an attachment is a file or audio (APK, PDF, music, voice messages — most software-share channels), Telegram replaces the whole post body and attachments with "Please open Telegram to view this post"; there is no filename or download URL, and the tool states this rather than misreporting it as a text-only post. Channels with "restrict saving content" enabled behave the same. Parsing such content requires an account-based approach: MTProto (Telethon / Pyrogram / gramjs, needs api_id + login session, reads any public channel) or Bot API (add the bot as a channel admin, limited to what it can access).

---

## Development

Tech stack:

- **Backend**: Node.js + NestJS (Express) + TypeScript (run directly with `tsx`)
- **Frontend**: Vite + React + React Router (source in `src/web`, output at `packages/web/dist`, served by the main process)
- **Realtime**: `ws` WebSocket; multiple OneBot modes over HTTP / SSE
- **Plugins**: dynamically loaded, NapCat-style plugin interface

Guidelines for contributions / forks:

1. Stay on Node ≥ 20 (22 LTS recommended, matching the bundled portable runtime)
2. Don't commit `node_modules/`, `packages/`, `data/` keys, or `log/`
3. Verify connection & plugin behavior locally, and keep `使用教程/` in sync

---

## FAQ

**1. "Web UI not built"**
Run `pnpm build:web` or `start.bat force`.

**2. ECONNREFUSED when accessing Kakake from a container**
Kakake should listen on `0.0.0.0`, not just `127.0.0.1`; use the host gateway IP from the container (commonly `172.17.0.1`).

**3. 401 / auth failures**
Check that both sides use the same Access Token; HTTP reports may use `X-Signature` — tokens must match.

**4. No messages, or messages twice**
Confirm only one connection mode is enabled; don't put the forward port into a reverse listen field (e.g. 6700).

**5. Port already in use**
Change the console or OneBot port, or stop the process holding it.

**6. Forgot the admin password**
View or reset `data/auth-key.json` locally (re-login required after reset; be careful).

**7. Image-obfuscation "large image server-side processing" unavailable / missing `sharp`**
That feature depends on `sharp` (with prebuilt binaries for your platform), loaded on demand after the framework starts: if missing, only this one feature is affected — the framework runs normally. Go to **Console → Settings → Image engine environment** and click "One-click install"; no restart needed afterwards.

The install location is **`data/runtime-deps/node_modules/sharp`**: MKbot plugins also install sharp into `data/runtime-deps`, so host and plugins **share one copy** (no more tens of MB each); if a working sharp already exists anywhere (including the copy bundled in portable builds), it is used directly. Online updates only replace source code and `package.json` and don't touch these folders, so you may need to reinstall once after a version upgrade. Older versions whose startup logs showed `Cannot find package 'sharp'` will no longer fail to boot over this.

More connection details: [`使用教程/连接教程.txt`](./使用教程/连接教程.txt) (Chinese).
Linux `mk` script usage: [`使用教程/MK工具教程.txt`](./使用教程/MK工具教程.txt) (Chinese).

---

## Channels & License

- Official QQ group: [955682835](https://qm.qq.com/q/ja7l7wLSjC) (Chinese)
- User agreement & announcements: the announcement page in the console; source at `src/web/content/announcement-fallback.md`
- This is a **locally deployed** tool: maintainers do not host your accounts or chat data; compliance and account safety are your own responsibility

By using this project you confirm you have read and understood the agreement. If you disagree, stop using it and delete the related files.

---

## Version

- Current `package.json` version: `0.6.9-beta.2`
- GitHub Release assets ship with Ed25519 signatures (`<asset>.sig`), generated automatically by a CI workflow after each release
- Docs update with the repo; for connection steps refer to `使用教程/连接教程.txt`; for the `mk` script refer to `使用教程/MK工具教程.txt` (both in Chinese)

---

**Kakake** — a local plugin platform: connect a carrier, manage your plugins.
