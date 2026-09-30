# HTTPS 远程访问教程

> 适用：咔咔珂 v0.5.4 及以上
> 场景：把管理后台暴露到公网（远程管理机器人）时，用 HTTPS 保护登录密钥不被窃听。
> 局域网内自用（`http://192.168.x.x:8787`）不需要本教程。

## 一、为什么需要 HTTPS

咔咔珂的快捷登录链接带着**登录密钥**（`?key=…`）。用 HTTP 直接暴露公网时：

- 密钥在网络上是明文，同网络的设备、运营商中间节点都可能截获；
- 拿到密钥 = 拿到后台完整控制权（读写配置、装插件、操作所有连接）。

HTTPS 把整条链路加密，截获者只能看到乱码。**咔咔珂本身不需要任何改动**——TLS 由前面的反向代理负责，咔咔珂继续监听 `8787`。

## 二、方案怎么选

| 你的情况 | 推荐方案 |
|---|---|
| 有云服务器 + 有域名 | 方案一 Caddy（最省事，证书全自动） |
| 有云服务器 + 有域名 + 已在用 Nginx | 方案二 Nginx + certbot |
| 没有公网服务器 / 家宽无公网 IP / 手机 Termux | 方案三 内网穿透 |
| **没有域名，只有 IP** | 直接看 **第九节**（HTTP 直连 / IP 证书 / 组网隧道） |
| **NAT 转发型服务器（云电脑 / 共享公网 IP）** | 直接看 **9.4**（能访问；HTTPS 走 Tunnel 或 DNS 验证） |

## 三、通用关键点（三种方案都适用）

1. **反代目标**：`http://127.0.0.1:8787`，路径**原样转发**，不要重写。
2. **WebSocket**：外放 API 的 WS 推送走 `/api/public/ws`，与后台共用一个端口，反代要支持 WebSocket 升级（Caddy 自动支持；Nginx 见方案二配置）。
3. **日志页是 SSE 实时推送**：反代必须关闭缓冲，否则日志页面不滚动（Caddy 自动；Nginx 见 `proxy_buffering off`）。
4. **上传体积**：管理后台上传插件包，Nginx 默认 1MB 上限会报 413，记得调大 `client_max_body_size`。
5. **更安全的监听地址**：如果反代和咔咔珂在同一台机器，建议把后台设置的监听地址从 `0.0.0.0` 改成 `127.0.0.1`——这样 8787 端口从公网直接摸不到，所有流量都必须过 HTTPS 反代。

## 四、方案一：Caddy（推荐）

Caddy 自动申请并续期 Let's Encrypt 证书，配置只有三行。

1. 安装 Caddy：`https://caddyserver.com/docs/install`（Windows / macOS / Linux 均有包）。
2. 域名 DNS 加一条 A 记录指向服务器公网 IP。
3. 编辑 Caddyfile（Linux 通常在 `/etc/caddy/Caddyfile`）：

```caddyfile
bot.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

4. 重载：`caddy reload`（或 `systemctl reload caddy`）。

完成。访问 `https://bot.example.com` 即可。WebSocket、SSE、证书续期 Caddy 全部自动处理。

## 五、方案二：Nginx + certbot

1. 安装 Nginx 与 certbot：

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

2. 站点配置 `/etc/nginx/sites-available/kakake`：

```nginx
# WebSocket 升级映射（/api/public/ws 需要）
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name bot.example.com;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket（外放 API 推送 /api/public/ws）
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # SSE（日志页实时滚动）：关缓冲、不限读超时
        proxy_buffering off;
        proxy_read_timeout 3600s;

        # 插件包上传
        client_max_body_size 200m;
    }
}
```

3. 启用并申请证书（certbot 会自动改写为 443 并配置续期）：

```bash
sudo ln -s /etc/nginx/sites-available/kakake /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d bot.example.com
```

## 六、方案三：没有公网服务器（内网穿透）

### 6.1 Cloudflare Tunnel（免费、无需开端口、自带 HTTPS）

适合家里宽带、云函数服务器、Termux 手机，**以及 NAT 转发型服务器（共享 IP）——cloudflared 只发出站连接，不需要任何入站端口映射**（见 9.4）。前提：有一个接入 Cloudflare 的域名。

```bash
# 登录并创建隧道（按提示在浏览器授权）
cloudflared tunnel login
cloudflared tunnel create kakake
cloudflared tunnel route dns kakake bot.example.com
```

配置 `~/.cloudflared/config.yml`：

```yaml
tunnel: kakake
credentials-file: /路径/kakake.json
ingress:
  - hostname: bot.example.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

启动：`cloudflared tunnel run kakake`。访问 `https://bot.example.com` 即可，证书由 Cloudflare 边缘提供。

### 6.2 frp（自备一台 VPS）

- VPS 上跑 frps（服务端），本机跑 frpc（客户端）。
- frpc 配置把本地 `8787` 映射到 VPS 的某端口；TLS 同样在 VPS 侧用 Caddy/Nginx 做（参考方案一/二）。
- frp 本身不提供 HTTPS 证书管理，别用 frp 的 `https` 插件硬做，反代一层更省心。

## 七、验证清单

配置完成后逐项确认：

- [ ] 浏览器打开 `https://你的域名`，出现管理后台登录页，地址栏显示锁标志；
- [ ] 日志页面能**实时滚动**（SSE 通了；若不滚动，检查 `proxy_buffering off`）；
- [ ] 连接管理里外放 API 的 WS 推送正常（若断连，检查 WebSocket 升级头）;
- [ ] 快捷登录链接已是 `https://` 开头，点开能直接进后台；
- [ ] 上传一个插件包不报 413（若报错，调大 `client_max_body_size`）；
- [ ] 用公网 IP 直接访问 `http://IP:8787` **应当失败**（说明 8787 没漏到公网，全部流量走了 HTTPS）。

## 八、安全提醒

- HTTPS 只保护**传输过程**，密钥本身别外发、别截图；
- 服务器防火墙/安全组只放行 `443`（和 SSH 的 22），`8787` 不要对公网开放；
- 条件允许就把咔咔珂监听地址改成 `127.0.0.1`（后台「设置」里改），只让反代够得着它；
- 日志文件里的快捷登录链接已做打码处理（`?key=***`），完整密钥只在启动屏幕显示一次。

## 九、没有域名，只有 IP 怎么办

**先说结论：能进后台。** 域名只影响「能不能拿到浏览器信任的 HTTPS 证书」，不影响访问本身——浏览器输入 `http://服务器IP:8787` 照样打开后台。区别只在加密和风险，按你的接受度选下面三种之一：

### 9.1 直接 HTTP + IP 访问（最简单，有风险）

什么 proxy 都不用配，防火墙放行 8787，浏览器输 `http://IP:8787` 就完事。**NAT 转发型服务器（云电脑/共享 IP）同样能进**，地址换成 `http://共享IP:服务商分配的映射端口` 即可（见 9.4）。但快捷登录链接里的密钥是明文传输，公共 Wi-Fi 下有被嗅探的可能，且公网扫描器会持续探测 8787 端口。

如果选这条路，至少做到：

- **防火墙白名单**：安全组/防火墙只放行你常用的出口 IP（家里宽带、办公室），而不是 `0.0.0.0/0`；
- **用完即关**：临时远程管理时才开 8787，管理完关掉；
- **改监听地址**：平时把监听地址设为 `127.0.0.1`，需要时用 SSH 隧道进（见 9.3）。

### 9.2 给 IP 上正规 HTTPS：Let's Encrypt IP 证书（2026 年起可用）

2026 年 1 月起，Let's Encrypt 正式支持**纯 IP 地址证书**（IPv4/IPv6），不用域名也能拿到浏览器信任的证书。

> ⚠️ **NAT 转发型服务器（共享 IP）不适用本节**：IP 证书验证要求 80/443 从公网直达，而这俩端口在共享 IP 上通常不归你。请直接看 9.4。

- 证书有效期固定 **160 小时（约 6.5 天）**，必须全自动续期，没有自动化就别选这条路；
- 验证只支持 http-01 / tls-alpn-01，即 **80/443 端口必须能从公网直达这台 IP**（家宽无公网 IP、内网穿透场景不适用，请回方案三）；
- 需要 Certbot 5.4+（nginx/apache 插件暂不支持 IP 证书，用 webroot 模式）。

以 Nginx + webroot 为例：

```bash
# 先用 staging 测试（成功后去掉 --staging 正式申请）
sudo certbot certonly --staging \
  --preferred-profile shortlived \
  --webroot --webroot-path /var/www/html \
  --ip-address 你的公网IP
```

拿到证书后手动挂到 Nginx（`/etc/letsencrypt/live/<IP>/fullchain.pem` 和 `privkey.pem`），并配一个续期后自动重载 Nginx 的 deploy-hook。因为证书 6 天一换，**续期自动化是硬性前提**，折腾度明显高于域名方案。

嫌浏览器警告的话也可以自签证书（`openssl` 或 mkcert），但每台访问设备都要手动信任一次，手机浏览器操作繁琐，不如上面两种。

### 9.3 不碰证书的加密方案（个人远程管理推荐）

**Tailscale / ZeroTier 组网（最推荐）**：服务器和你手机/电脑都装客户端，登同一账号，组成虚拟局域网。之后用 `http://100.x.x.x:8787`（Tailscale 分配的内网 IP）直接访问后台——流量走 WireGuard 加密，不需要域名、不需要证书、8787 完全不对公网暴露。安卓/Windows/macOS/Linux 全平台支持，手机跑咔咔珂的尤其合适。

**SSH 隧道（临时管理）**：在你自己的电脑上执行：

```bash
ssh -L 8787:127.0.0.1:8787 用户名@服务器IP
```

然后本地浏览器打开 `http://localhost:8787`。流量全程走 SSH 加密，配合监听地址 `127.0.0.1` 使用时，公网连 8787 端口都摸不到。偶尔改配置的场合零成本。（NAT 服务器的 SSH 本身也是映射端口，命令加 `-p 映射端口` 即可。）

### 9.4 NAT 转发型服务器（云电脑 / 共享公网 IP）

很多便宜服务器是 NAT 转发型（俗称云电脑、NAT VPS）：多台机器**共享同一个公网 IP**，服务商给每台分配几个**高位映射端口**（例如外部 `28080` → 你机器的 `8787`），80/443 通常不在你手里。这种情况：

**能进后台吗？能。** 浏览器输 `http://共享IP:映射端口`（填映射到 8787 的那个外部端口）即可，9.1 的风险与缓解措施同样适用。

**想上 HTTPS？Let's Encrypt 的 IP 证书这条路走不通**（验证要占 80/443），但有两条正路：

**路线 A：Cloudflare Tunnel（零端口，NAT 场景首选）**

cloudflared 只发起**出站**连接——不需要任何入站端口、不关心你有没有独立公网 IP，NAT 机器上照常工作。按第六节 6.1 配置即可，最终用 `https://你的域名` 访问，证书、443 标准端口、DDoS 防护全部由 Cloudflare 边缘提供。

**路线 B：免费域名 + DNS 验证证书 + 挂在映射端口上**

一个常见误解是「证书需要 80 端口」——其实**证书跟监听端口无关**，TLS 可以挂在任何端口（比如 10443）。要绕开的只是「验证」这一步：HTTP 验证要占 80，但 **DNS 验证（DNS-01）只需往域名加一条 TXT 记录，完全不需要入站端口**：

1. 弄一个免费域名（DuckDNS 等），或把现有域名托管到 Cloudflare；
2. 用 acme.sh 走 DNS 验证签证书（DuckDNS 有现成 API；托管在 Cloudflare 的可用 CF API 全自动续期）；
3. Caddy/Nginx 用这张证书监听你的映射端口；
4. 访问 `https://你的域名:映射端口`，浏览器无警告。

**Tailscale / ZeroTier 照常可用**：同样只走出站连接，跟端口映射无关，纯个人管理依然是零折腾选项。

**一句话建议**：只是自己远程管后台，选 Tailscale 或 SSH 隧道，加密、免证书、不暴露端口三件事一次解决；NAT 服务器想给域名级 HTTPS，有域名（免费也行）就用 Cloudflare Tunnel，没有域名又想加密才考虑 9.2 的 IP 证书（仅限真公网 IP）。

