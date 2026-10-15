/**
 * 远端地址归一化与来源判定。
 *
 * 咔咔珂要同时跑在挂机宝、云服务器、实体服务器与家用电脑上，监听 0.0.0.0
 * 是常态，所以"绑定地址"不能用来判断安全性，只能按**单个请求的来源地址**
 * 决定是否放行。这里提供统一的判定，避免各处自行写正则导致口径不一致。
 */

/**
 * 把各种形态的远端地址收敛成裸 IP：
 * - `::ffff:127.0.0.1`（IPv4-mapped IPv6）→ `127.0.0.1`
 * - `[::1]:52618` → `::1`
 * - `192.168.1.5:52618` → `192.168.1.5`
 * - `fe80::1%eth0` → `fe80::1`
 */
export function normalizeIpAddress(raw: string | undefined | null): string {
  if (!raw) return '';
  let ip = String(raw).trim();
  if (!ip) return '';

  // [IPv6]:port
  if (ip.startsWith('[')) {
    const end = ip.indexOf(']');
    if (end > 0) ip = ip.slice(1, end);
  }

  // IPv4-mapped IPv6
  const mapped = /^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;

  // IPv4:port（IPv6 含多个冒号，不能按冒号切）
  if (ip.includes('.') && ip.includes(':')) {
    ip = ip.slice(0, ip.indexOf(':'));
  }

  // IPv6 zone id：fe80::1%eth0
  const zone = ip.indexOf('%');
  if (zone > 0) ip = ip.slice(0, zone);

  return ip.toLowerCase();
}

/** 回环地址：127.0.0.0/8 与 ::1 */
export function isLoopbackAddress(raw: string | undefined | null): boolean {
  const ip = normalizeIpAddress(raw);
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  return /^127\./.test(ip);
}

/**
 * 本机或内网来源：回环 + IPv4 私网/链路本地 + IPv6 ULA/链路本地。
 *
 * 协议端（NapCat / Lagrange 等）通常与框架同机、同局域网或同 Docker 网段
 * （172.17.x.x 属于私网），所以这个范围足够覆盖正常部署，同时挡掉公网来源。
 */
export function isTrustedLocalAddress(raw: string | undefined | null): boolean {
  const ip = normalizeIpAddress(raw);
  if (!ip) return false;
  if (isLoopbackAddress(ip)) return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;                       // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 链路本地
    return false;
  }

  if (/^f[cd]/.test(ip)) return true;   // fc00::/7 唯一本地地址
  if (/^fe[89ab]/.test(ip)) return true; // fe80::/10 链路本地
  return false;
}

/** Express Request 与原生 IncomingMessage 都能取到来源地址 */
export interface RemoteAddressSource {
  ip?: string | undefined;
  socket?: { remoteAddress?: string | undefined | null } | null | undefined;
}

/**
 * 取请求的来源 IP。
 *
 * 注意：这里只认 TCP 连接的对端地址，**不读 X-Forwarded-For**——该头可被
 * 客户端任意伪造。因此框架挂在反向代理后面时，所有请求看起来都来自代理本身
 * （通常是 127.0.0.1），基于来源地址的放行策略会失效，此时必须靠 Access Token。
 */
export function remoteAddressOf(req: RemoteAddressSource): string {
  const direct = typeof req.ip === 'string' ? req.ip : '';
  return normalizeIpAddress(direct || req.socket?.remoteAddress || '');
}

/** 日志展示用：空地址给个占位，避免出现 "来源 " 这种断句 */
export function describeRemoteAddress(raw: string | undefined | null): string {
  return normalizeIpAddress(raw) || '未知来源';
}