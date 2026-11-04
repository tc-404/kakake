import os from 'node:os';
import { IS_TERMUX } from './runtime-env.js';

/**
 * 后台访问地址相关工具：判断公网 IPv4、探测本机公网出口、拼装快捷登录地址。
 *
 * 探测顺序（越靠前优先级越高）：
 * 1. `KAKAKE_PUBLIC_HOST`：手动指定公网 IP 或域名，最可靠；
 * 2. 本机网卡上直接绑定的公网 IPv4（独立服务器、部分云厂商如此）；
 * 3. 云厂商元数据接口（链路本地地址，不经过公网第三方服务）。
 */

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 云厂商实例元数据：均为链路本地/厂商保留地址，请求不出内网 */
const METADATA_URLS = [
  // 阿里云
  'http://100.100.100.200/latest/meta-data/eipv4',
  // 腾讯云
  'http://metadata.tencentyun.com/latest/meta-data/public-ipv4',
  // AWS / 京东云 / 华为云 等 EC2 兼容路径
  'http://169.254.169.254/latest/meta-data/public-ipv4',
];

/** 监听地址是否为“所有网卡”，只有这种情况下才有外网访问一说 */
export function isWildcardHost(host: string): boolean {
  const h = host.trim();
  return h === '0.0.0.0' || h === '::' || h === '[::]' || h === '';
}

/** 是不是可对外访问的公网 IPv4（排除内网、回环、链路本地、CGNAT、组播等） */
export function isPublicIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  const parts = [a, b, Number(m[3]), Number(m[4])];
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a >= 224) return false;
  return true;
}

/** 本机网卡上直接绑定的公网 IPv4 */
export function listNicPublicIpv4(): string[] {
  const found: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      // Node 18+ family 为 'IPv4'，旧版本可能是数字 4
      const family = String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (info.internal) continue;
      if (isPublicIpv4(info.address) && !found.includes(info.address)) {
        found.push(info.address);
      }
    }
  }
  return found;
}

/** 无需联网即可确定的公网地址：环境变量 > 网卡上的公网 IPv4 */
export function resolvePublicHostSync(): string | null {
  const manual = (process.env.KAKAKE_PUBLIC_HOST ?? '').trim();
  if (manual) return manual;
  return listNicPublicIpv4()[0] ?? null;
}

/** 是不是内网 IPv4（10/8、172.16/12、192.168/16） */
function isPrivateIpv4(ip: string): boolean {
  const m = IPV4_RE.exec(ip.trim());
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

/** 网卡类别，用于给候选地址排优先级 */
export type NicKind = 'wifi' | 'ethernet' | 'tether' | 'cellular' | 'vpn' | 'virtual' | 'other';

/**
 * 按网卡名判断类别。
 *
 * 这一步在手机上是必需的：安卓的 Wi-Fi 恒为 wlan 开头，蜂窝数据是 rmnet 或 ccmni 开头，
 * 而国内运营商给蜂窝分配的往往也是 10.x 私网地址——它和 Wi-Fi 地址一样“看着像内网”，
 * 却完全无法从局域网访问。只看地址段分不出来，必须靠网卡名区分。
 * VPN（tun*）同理，挂着 VPN 时也会多出一个 10.x。
 */
export function classifyNic(name: string): NicKind {
  const n = name.toLowerCase();
  // 顺序有讲究：wlan 必须在 wl/en 之前判掉，虚拟网卡与隧道要先排除
  if (/^(tun|tap|ipsec|utun|wg|ppp|nordlynx)/.test(n)) return 'vpn';
  if (/^(rmnet|ccmni|cc2mni|pdp|wwan|v4-rmnet|clat)/.test(n)) return 'cellular';
  if (/^(docker|br-|bridge|veth|virbr|vmnet|vboxnet|zt|tailscale)/.test(n)) return 'virtual';
  if (/^(ap\d|swlan|softap|rndis|usb|bt-pan)/.test(n)) return 'tether';
  if (/^(wlan|wl|wifi|wi-fi|airport|无线)/.test(n)) return 'wifi';
  if (/^(eth|en|em|eno|ens|enp|以太网)/.test(n)) return 'ethernet';
  return 'other';
}

/** 手机上 Wi-Fi 最优先；蜂窝与 VPN 排到最后 */
const NIC_RANK_MOBILE: NicKind[] = ['wifi', 'ethernet', 'tether', 'other', 'cellular', 'vpn', 'virtual'];
/** 电脑/服务器上有线优先 */
const NIC_RANK_DESKTOP: NicKind[] = ['ethernet', 'wifi', 'other', 'tether', 'vpn', 'cellular', 'virtual'];

function nicRank(kind: NicKind): number {
  const table = IS_TERMUX ? NIC_RANK_MOBILE : NIC_RANK_DESKTOP;
  const i = table.indexOf(kind);
  return i < 0 ? table.length : i;
}

/** 同类网卡内的次序：家用路由最常用 192.168 段，10.x 更多见于运营商与 VPN */
function subnetRank(ip: string): number {
  if (ip.startsWith('192.168.')) return 0;
  const m = IPV4_RE.exec(ip);
  if (m && Number(m[1]) === 172) return 1;
  return 2;
}

/** 给人看的网卡类别名 */
export function describeNicKind(kind: NicKind): string {
  switch (kind) {
    case 'wifi':
      return 'Wi-Fi';
    case 'ethernet':
      return '有线';
    case 'tether':
      return '热点/USB 共享';
    case 'cellular':
      return '蜂窝数据';
    case 'vpn':
      return 'VPN';
    case 'virtual':
      return '虚拟网卡';
    default:
      return '未知网卡';
  }
}

export type LanCandidate = { address: string; iface: string; kind: NicKind };

/**
 * 本机内网 IPv4 候选，已按“别的设备最可能连得上”排序。
 * 手机（Termux）与家用电脑上没有公网 IP，能访问后台的就是这些地址。
 */
export function listLanIpv4Detailed(): LanCandidate[] {
  const found: LanCandidate[] = [];
  for (const [iface, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      // Node 18+ family 为 'IPv4'，旧版本可能是数字 4
      const family = String(info.family);
      if (family !== 'IPv4' && family !== '4') continue;
      if (info.internal) continue;
      if (!isPrivateIpv4(info.address)) continue;
      if (found.some((c) => c.address === info.address)) continue;
      found.push({ address: info.address, iface, kind: classifyNic(iface) });
    }
  }
  return found.sort(
    (a, b) => nicRank(a.kind) - nicRank(b.kind) || subnetRank(a.address) - subnetRank(b.address),
  );
}

/** 本机内网 IPv4 列表（同一 Wi-Fi 下别的设备能用的地址） */
export function listLanIpv4(): string[] {
  return listLanIpv4Detailed().map((c) => c.address);
}

/** 最可能被同一局域网其它设备访问到的内网 IPv4，拿不到返回 null */
export function resolveLanHostSync(): string | null {
  return listLanIpv4Detailed()[0]?.address ?? null;
}

/**
 * 向云厂商元数据接口要公网 IPv4（NAT/EIP 机型网卡上看不到公网 IP 时用）。
 * 全部失败或超时返回 null；`KAKAKE_NO_PUBLIC_IP_PROBE=1` 可完全关闭。
 * Termux（手机）上没有这类元数据服务，直接跳过，免得白等三次超时。
 */
export async function detectCloudPublicIpv4(timeoutMs = 1500): Promise<string | null> {
  if (process.env.KAKAKE_NO_PUBLIC_IP_PROBE === '1') return null;
  if (IS_TERMUX) return null;
  const probes = METADATA_URLS.map(async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return isPublicIpv4(text) ? text : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
  const results = await Promise.all(probes);
  return results.find((ip): ip is string => Boolean(ip)) ?? null;
}

/** 带 IPv6 字面量括号的主机名，便于拼 URL */
function formatUrlHost(host: string): string {
  const h = host.trim();
  if (h.includes(':') && !h.startsWith('[')) return `[${h}]`;
  return h;
}

/**
 * 免手输的快捷登录地址。
 * 密钥含 `+` `=` `&` 等字符时必须转义，否则 Express 解析 query 会把 `+` 变成空格。
 */
export function buildQuickLoginUrl(host: string, port: number, key: string): string {
  return `http://${formatUrlHost(host)}:${port}/?key=${encodeURIComponent(key)}`;
}