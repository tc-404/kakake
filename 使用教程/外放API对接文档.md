# 咔咔珂 · 外放 API 对接文档

一个**免登录、只读**的接口，用 `IP + 端口 + 路径` 即可拿到框架的运行概览：
框架名字、账号列表、运行时长、日志收发总数。适合做状态看板、监控探针、第三方展示等。

两种协议、**同一 IP 同一端口**，共用同一个「外放 API」开关：

- **HTTP**：`GET /api/public`，请求一次拿一次快照（轮询用）。
- **WebSocket**：`ws://.../api/public/ws`，连上后由框架**实时推送**同样的快照
  （状态变化时推 + 定时心跳）。

- 版本：外放 API v1
- 鉴权：**无**（不用 token、不用 Cookie）
- HTTP 方法：仅 `GET`
- Webhook（框架主动 POST 到你的 URL）：**暂未提供**，如有需要可提。

---

## 一、开启方式

1. 打开咔咔珂 Web 控制台 →「系统设置」页；
2. 找到「外放 API」卡片，把开关打开即可**立即生效**（无需重启、无需保存按钮）。

> 默认关闭。**开关关闭时接口一律返回 403、不吐任何数据。**
> 关掉开关即刻断供，已在访问的第三方下次请求就会收到 403。

---

## 二、接口地址

HTTP（轮询）：

```
GET http://<IP>:<端口>/api/public
```

WebSocket（实时推送）：

```
ws://<IP>:<端口>/api/public/ws
```

- `<端口>`：即控制台「监听地址 → 后台端口」，默认 `8787`。两种协议共用这个端口。
- 示例：`http://127.0.0.1:8787/api/public` ／ `ws://127.0.0.1:8787/api/public/ws`

---

## 三、访问情况（谁能访问、各种响应）

### 3.1 按监听地址决定访问范围

访问边界**只**取决于「外放 API 开关」，接口**不校验来源 IP**。能否连到，取决于
控制台「监听地址」这项设置：

| 监听地址 | 谁能访问 | 典型用法 |
| --- | --- | --- |
| `127.0.0.1` | 只有**本机** | 本机脚本 / 本机看板 |
| `0.0.0.0`（默认） | 本机 + **同一局域网的其它设备** | 手机、另一台电脑用 `http://<本机内网IP>:8787/api/public` |
| 端口被映射/暴露到公网 | **任何人**（互联网） | 需自行评估安全，建议加反代限流或别开公网 |

> 举例：电脑内网 IP 是 `192.168.1.20`、监听 `0.0.0.0`、开关已开，
> 那么手机连同一 WiFi，浏览器/APP 访问 `http://192.168.1.20:8787/api/public` 即可拿到数据。

### 3.2 各种请求的响应一览

| 情况 | HTTP 状态 | 返回 |
| --- | --- | --- |
| 开关开启，正常请求 | `200` | 见「四、返回内容」 |
| 开关关闭 | `403` | `{ ok:false, code:-1, message:"外放 API 未开启（请在设置页开启「外放 API」开关）" }` |
| 用了非 GET 方法（POST/PUT/DELETE…） | `404` | 该路径只注册了 GET，其它方法视为无匹配路由 |
| 路径写错（如 `/api/publics`） | `404` | 无此路由 |
| 端口不通 / 服务未启动 / 被防火墙拦 | 连接失败 | 无 HTTP 响应（超时或拒绝连接），请检查 IP、端口、监听地址、防火墙 |
| WebSocket 升级（开关开启） | `101` | 升级成功，随后开始推送快照，见「五、WebSocket 实时推送」 |
| WebSocket 升级（开关关闭） | `403` | 拒绝升级、连接立即关闭；已连着的客户端也会被主动断开 |

### 3.3 浏览器跨域（CORS）

该接口**未设置 CORS 响应头**。含义：

- `curl`、Postman、后端服务、同源页面、手机 APP 直接请求：**不受影响**，正常拿数据。
- 在**另一个网站的网页**里用浏览器 `fetch`/`XMLHttpRequest` 跨域请求：会被浏览器拦截
  （拿不到响应体）。这属于浏览器安全策略，不是接口报错。
- 如果你确有「网页跨域直接读」的需求，可告知，我可以为该接口单独放开 CORS。
- **WebSocket 不受 CORS 限制**：浏览器可跨源直连 `ws://.../api/public/ws`，接口也不校验
  来源，所以网页里想实时读、用 WS 反而更省事。

### 3.4 其它说明

- 无速率限制、无并发限制（HTTP 请自行控制轮询频率，建议 ≥ 5 秒一次；WS 已由服务端节流推送）。
- HTTP 返回 `Content-Type: application/json; charset=utf-8`；WS 每帧是一段 JSON 文本。
- 所有计数、运行时长均为**本次运行**数据，框架重启后归零。

---

## 四、返回内容（开关开启时，HTTP 200）

```json
{
  "ok": true,
  "time": 1710000000000,
  "title": "咔咔珂",
  "uptime": {
    "seconds": 3661,
    "text": "1小时1分1秒"
  },
  "logs": {
    "received": 128,
    "sent": 64
  },
  "accounts": {
    "count": 2,
    "list": [
      {
        "name": "NapCat 默认接入",
        "type": "onebot",
        "typeText": "OneBot",
        "status": "connected",
        "statusText": "已连接",
        "phase": "connected",
        "phaseText": "已连接",
        "enable": true,
        "connected": true,
        "avatar": "https://q.qlogo.cn/g?b=qq&nk=10001&s=640"
      },
      {
        "name": "我的官方机器人",
        "type": "qq_official",
        "typeText": "QQ 官方机器人",
        "status": "disconnected",
        "statusText": "未连接",
        "phase": "reconnecting",
        "phaseText": "连接中",
        "enable": true,
        "connected": false,
        "avatar": "https://.../avatar.png"
      }
    ]
  }
}
```

### 4.1 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ok` | boolean | 是否成功，正常为 `true` |
| `time` | number | 服务端当前时间戳（毫秒） |
| `title` | string | 框架显示名字：设置页「自定义标题名字」；**未设置时固定为 `咔咔珂`** |
| `uptime.seconds` | number | 框架运行时长（秒），自进程启动起算 |
| `uptime.text` | string | 运行时长可读串，如 `2天3小时5分10秒`（为 0 的高位省略） |
| `logs.received` | number | **总上报接收数**：本次运行以来收到的上报（含 QQ 官方上报 gf_event） |
| `logs.sent` | number | **总输出数**：本次运行以来的输出/调用（含 QQ 官方输出 gf_action） |
| `accounts.count` | number | 账号（连接）数量 |
| `accounts.list[]` | array | 账号列表，见 4.2 |

> 计数口径：`received` = 日志分类「上报」+「官方上报」；`sent` = 「输出」+「官方输出」。
> **模拟消息（模拟上报 / 模拟输出）不计入**，因为它是调试用的假消息。
> 计数与 `uptime` 对齐，**框架重启清零，且不受控制台「清空日志」影响**。

### 4.2 账号列表项字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 连接名字（你在控制台起的名字；官方/KOOK 取不到时兜底为机器人昵称） |
| `type` | string | 接入类型代码，见 4.3 |
| `typeText` | string | 接入类型中文名，见 4.3 |
| `status` | string | **连接状态（粗三态）**，见 4.4 |
| `statusText` | string | `status` 的中文 |
| `phase` | string | **连接阶段（细四态）**，见 4.5，比 `status` 更细 |
| `phaseText` | string | `phase` 的中文 |
| `enable` | boolean | 该连接的开关是否开启 |
| `connected` | boolean | 是否已连上 |
| `avatar` | string | 头像地址；取不到公网可用地址时为空串 `""`，见 4.6 |

### 4.3 接入类型 `type` / `typeText`

| `type` | `typeText` | 说明 |
| --- | --- | --- |
| `onebot` | `OneBot` | OneBot 协议端（如 NapCat / Lagrange 等野生机器人） |
| `qq_official` | `QQ 官方机器人` | QQ 开放平台官方机器人 |
| `weixin_bot` | `微信 AI×BOT` | 微信 iLink BOT |
| `kook` | `KOOK` | KOOK 机器人 |

### 4.4 连接状态 `status`（粗三态）

| `status` | `statusText` | 含义 |
| --- | --- | --- |
| `connected` | `已连接` | 开关开启且已连上 |
| `disconnected` | `未连接` | 开关开启但当前没连上（细分见 `phase`） |
| `disabled` | `已关闭` | 该连接开关被关掉 |

### 4.5 连接阶段 `phase`（细四态，推荐用它做状态展示）

`phase` 把「未连接」进一步拆开，是更贴近控制台展示的**四种状态**：

| `phase` | `phaseText` | 含义 | 建议配色 |
| --- | --- | --- | --- |
| `connected` | `已连接` | 已连上，正常工作 | 绿色 |
| `reconnecting` | `连接中` | 开着但还没连上，正在重试 / 等待首次连接 | 黄色 |
| `failed` | `连接失败` | 开着、一直连不上且**重连次数已耗尽**（需手动介入） | 红色 |
| `disabled` | `已关闭` | 该连接开关被关掉 | 灰色 |

`status` 与 `phase` 的对应关系：

```
status=connected     → phase=connected
status=disabled      → phase=disabled
status=disconnected  → phase=reconnecting（还在重试/等待）
                      或 phase=failed（重连放弃）
```

> 只想简单显示「在线/离线/关闭」用 `status` 即可；想区分「连接中」和「彻底失败」
> 就用 `phase`。

### 4.6 头像 `avatar` 规则

- `onebot`：按机器人 QQ 号返回 `q.qlogo.cn` 头像（公网可直接加载）。
  未上报 QQ 号时可能为空或指向默认头像。
- `qq_official`：返回官方资料里的 `avatar`（公网地址）。未拉到资料时为空串。
- `weixin_bot` / `kook`：头像是缓存图、需登录态代理，公网取不到，**固定返回空串 `""`**。

> 拿到空串时请自行用占位图兜底。

### 4.7 无账号时的返回

```json
{
  "ok": true,
  "time": 1710000000000,
  "title": "咔咔珂",
  "uptime": { "seconds": 12, "text": "12秒" },
  "logs": { "received": 0, "sent": 0 },
  "accounts": { "count": 0, "list": [] }
}
```

---

## 五、WebSocket 实时推送

想「实时」拿数据（不轮询）就用 WebSocket：

```
ws://<IP>:<端口>/api/public/ws
```

行为：

1. **握手鉴权**：升级时若「外放 API」开关是关的，直接 `403` 拒绝、连接关闭；开着才建立连接。
   访问范围与 HTTP 完全一致（见 3.1），监听 `0.0.0.0` 时同局域网也能连。
2. **连上即发**：连接建立后立刻推送一份完整快照。
3. **推送时机**：
   - 账号连接状态变化、日志上报/输出计数变化时**立即推送**（服务端会做 300ms 合并节流，避免抖动风暴）；
   - 另有**每 5 秒一次心跳**兜底，即便没有变化也会收到最新快照。
4. **消息内容**：每一帧都是一段 JSON 文本，**结构与 HTTP 的返回体完全相同**（见「四、返回内容」，
   含 `uptime` / `logs` / `accounts`）。
5. **只读**：客户端发来的任何消息都会被忽略，无需发送订阅指令。
6. **开关关闭**：运行中若把开关关掉，服务端会用关闭码 `1013` 主动断开所有在连客户端，
   之后新的连接会被 `403` 拒绝。客户端可自行重连（收到 403/断开即可退避重试）。

> 提示：无需发送心跳/ping，服务端自带 5 秒推送即可当保活；断线后按需重连即可。

---

## 六、错误返回

### HTTP 未开启（HTTP 403）

```json
{
  "ok": false,
  "code": -1,
  "message": "外放 API 未开启（请在设置页开启「外放 API」开关）"
}
```

### WebSocket 未开启

升级阶段返回 `403` 并关闭连接（收不到任何 JSON 帧）；运行中被关闭则以关闭码 `1013` 断开。

> 对接方建议：HTTP 先判断状态码 / `ok` 字段再读数据；WS 收到关闭/403 就退避重连。

---

## 七、调用示例

### curl（HTTP）

```bash
curl http://127.0.0.1:8787/api/public
```

### JavaScript · HTTP（Node / 浏览器同源）

```js
const res = await fetch('http://127.0.0.1:8787/api/public');
if (res.status === 403) {
  console.warn('外放 API 未开启');
} else {
  const data = await res.json();
  if (data.ok) {
    console.log('运行时长：', data.uptime.text);
    console.log('上报接收：', data.logs.received, ' 输出：', data.logs.sent);
    for (const acc of data.accounts.list) {
      console.log(`${acc.name} [${acc.typeText}] ${acc.phaseText}`);
    }
  }
}
```

### JavaScript · WebSocket（浏览器 / Node）

```js
// 浏览器用内置 WebSocket；Node 用 `ws`：import WebSocket from 'ws';
const ws = new WebSocket('ws://127.0.0.1:8787/api/public/ws');

ws.onmessage = (ev) => {
  const data = JSON.parse(ev.data);
  console.log('运行时长：', data.uptime.text, '在线账号：', data.accounts.count);
  for (const acc of data.accounts.list) {
    console.log(`${acc.name} [${acc.typeText}] ${acc.phaseText}`);
  }
};

// 断线（含开关被关闭时的 1013）自动退避重连
ws.onclose = () => setTimeout(() => location.reload?.(), 3000);
```

### Python · HTTP

```python
import requests

r = requests.get("http://127.0.0.1:8787/api/public", timeout=5)
if r.status_code == 403:
    print("外放 API 未开启")
else:
    data = r.json()
    if data.get("ok"):
        print("运行时长：", data["uptime"]["text"])
        print("上报接收：", data["logs"]["received"], " 输出：", data["logs"]["sent"])
        for acc in data["accounts"]["list"]:
            print(acc["name"], acc["typeText"], acc["phaseText"])
```

### Python · WebSocket

```python
# pip install websocket-client
import json, websocket

ws = websocket.create_connection("ws://127.0.0.1:8787/api/public/ws")
try:
    while True:
        data = json.loads(ws.recv())
        print("运行时长：", data["uptime"]["text"], "账号数：", data["accounts"]["count"])
finally:
    ws.close()
```

---

## 八、常见问题

- **拿到 403？** 去设置页把「外放 API」开关打开（HTTP 和 WS 共用这个开关）。
- **同网别的设备连不上？** 确认监听地址是 `0.0.0.0`、用的是本机**内网 IP**（非 127.0.0.1）、
  端口正确、系统防火墙放行了该端口、且两台设备在同一网络。
- **网页里跨域读不到？** HTTP 跨域会被浏览器拦（见 3.3），改用 **WebSocket**（不受 CORS 限制）
  或让服务端中转；也可让我为 HTTP 接口单独开 CORS。
- **WS 要不要发订阅/心跳？** 都不用，连上就会自动收到快照，服务端每 5 秒还会推一次。
- **计数会一直累加吗？** 是本次运行的累加值，框架重启后归零。
- **头像为空？** 微信 / KOOK 不给公网头像；onebot/官方未拉到资料时也可能为空，请用占位图。
