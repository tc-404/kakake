/**
 * 公网 http(s) 链接校验：链接导入、头像抓取等会让后端发起请求的功能共用。
 * 拒绝回环 / 内网 / 链路本地 / CGNAT / 组播保留段 / 本地域名。
 *
 * 残余风险（已知并接受）：DNS rebinding（域名解析到内网 IP）此处拦不住，
 * 需要自定义 DNS 解析与连接钉扎才能根治；相关端点仅登录用户可调。
 */

function ipv4Private(a: number, b: number): boolean {
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true; // 组播 224-239 与保留段 240-255
  return false;
}

/**
 * 主机名是否为内网 IP 字面量。入参接受「URL.hostname 去括号后」的形态。
 * 关键点：
 * - WHATWG URL 会把十进制/十六进制/短格式 IPv4 归一成点分四段，这里按点分判；
 * - 老内核没归一化干净的纯数字/点串（如 `2130706433`、`127.1`）一律按不可信处理；
 * - IPv4 映射 IPv6 的两种形态（::ffff:127.0.0.1 与 ::ffff:7f00:1）都要展开再判。
 */
export function isPrivateIpLiteral(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    return ipv4Private(Number(v4[1]), Number(v4[2]));
  }
  // 纯数字与点组成但不是合法点分四段 → 非常规 IP 写法，按内网对待
  if (/^[0-9.]+$/.test(host)) return true;
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true;
    if (/^f[cd]/.test(host)) return true;    // fc00::/7 唯一本地地址
    if (/^fe[89ab]/.test(host)) return true; // fe80::/10 链路本地
    const mapped = /^::ffff:(.+)$/.exec(host);
    if (mapped) {
      const tail = mapped[1]!;
      if (tail.includes('.')) return isPrivateIpLiteral(tail);
      // 十六进制形态 ::ffff:7f00:1 → 127.0.0.1
      const groups = tail.split(':').filter(Boolean);
      if (groups.length >= 2) {
        const hi = Number.parseInt(groups[groups.length - 2]!, 16);
        const lo = Number.parseInt(groups[groups.length - 1]!, 16);
        if (Number.isFinite(hi) && Number.isFinite(lo)) {
          return isPrivateIpLiteral(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
        }
      }
      return true;
    }
    return false;
  }
  return false;
}

/** 断言为公网 http(s) 链接，失败抛错并返回解析结果；通过则返回 URL 供后续使用 */
export function assertPublicHttpUrl(rawUrl: string): URL {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error('链接格式无效');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('只支持 http(s) 链接');
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error('链接缺少主机名');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('不允许指向内网地址的链接');
  }
  if (isPrivateIpLiteral(host)) {
    throw new Error('不允许指向内网地址的链接');
  }
  return u;
}

/** 仅校验是否公网 http(s)，不抛错（返回 false = 不可信） */
export function isPublicHttpUrl(rawUrl: string): boolean {
  try {
    assertPublicHttpUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}
