/**
 * 远端地址归一化与来源判定。框架常绑 0.0.0.0，故「绑定地址」不可信，只能按
 * 单个请求的来源地址决定是否放行；此处统一口径，避免各处正则不一致。
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

/**
 * 反向代理痕迹探测：返回请求里出现的代理专属头名列表（空数组 = 直连）。
 *
 * 为什么需要它：`remoteAddressOf` 刻意不读 X-Forwarded-For（可伪造），于是
 * 「无 Access Token 时只信本机/内网」这条策略在反代环境下会静默失效——
 * 反代后的请求 TCP 对端必然是代理本机（127.0.0.1），`isTrustedLocalAddress`
 * 一律放行，等于把入口开放给反代背后的所有人。
 *
 * 这里的判据是**头是否存在**，不是头的内容：直连的 NapCat / QQ 官方 / KOOK
 * 都不会发这些头，只有代理会加。所以「头存在」本身就是「前方有代理」的可靠
 * 信号，与头内容是否被伪造无关。
 *
 * 注意 `X-Real-IP` 与 `X-Forwarded-Server` 也纳入：前者常被 nginx 默认加上，
 * 后者是代理链标识，二者同样只在有代理时出现。
 */
const PROXY_HEADER_NAMES = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-server',
  'x-real-ip',
  'forwarded',
] as const;

export function proxyHeadersPresent(
  headers: Record<string, unknown> | undefined | null,
): string[] {
  if (!headers) return [];
  const present: string[] = [];
  for (const name of PROXY_HEADER_NAMES) {
    const v = headers[name];
    // 空串 / 空数组都视为未出现：代理偶尔会带一个空的 X-Forwarded-For
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    present.push(name);
  }
  return present;
}

/** 日志展示用：空地址给个占位，避免出现 "来源 " 这种断句 */
export function describeRemoteAddress(raw: string | undefined | null): string {
  return normalizeIpAddress(raw) || '未知来源';
}

/**
 * 「没配 Access Token」时的来源放行判定——**四个入口共用同一套逻辑**：
 * OneBot HTTP 上报、OneBot HTTP SSE 取流、OneBot 反向 WS、`/api/local`。
 *
 * 判定顺序（先严后宽）：
 *   1. 有反向代理痕迹 → **一律拒绝**。此时 TCP 对端必然是代理本机，
 *      「只信内网」已经失效，唯一安全的做法是要求 Access Token。
 *      这不是误杀：直连的协议端不会带代理头，带头就只有代理一种解释。
 *   2. 来源是本机/内网 → 放行（传统部署形态）。
 *   3. 其它 → 拒绝。
 *
 * 之所以把这条从各调用点收上来：此前四处各自判断，其中三处漏了代理检测，
 * 而漏掉的那三处正是「反代 + 无 token = 全网可写」的入口。
 */
export function tokenlessSourceVerdict(
  headers: Record<string, unknown> | undefined | null,
  from: string,
): { ok: true } | { ok: false; reason: string } {
  const proxyHeaders = proxyHeadersPresent(headers);
  if (proxyHeaders.length > 0) {
    return {
      ok: false,
      reason: `检测到反向代理头（${proxyHeaders.join('、')}）：请求来源已不可信，`
        + '远程访问必须为该连接配置 Access Token（或不要把反代暴露到公网）',
    };
  }
  if (isTrustedLocalAddress(from)) return { ok: true };
  return {
    ok: false,
    reason: `未配置 Access Token，仅接受本机 / 内网来源（当前来源 ${describeRemoteAddress(from)}）`,
  };
}