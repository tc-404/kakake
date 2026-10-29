import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** Ed25519 PKCS#8 前缀 + 32 字节 seed（与 QQ 开放平台示例一致） */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 回调时间戳允许的最大偏差（秒）：超出即视为重放/过期请求 */
export const QQC_CALLBACK_MAX_SKEW_SEC = 300;

/**
 * Bot Secret → 32 字节 seed：不足 32 字节时按官方示例重复拼接后截断。
 *
 * 两点注意：
 * - 截断是**字节级**的（多字节 Secret 可能被切开），但 seed 只当原始字节用，不影响正确性；
 * - 空 Secret 必须直接报错：`''.repeat(2)` 永远还是空串，原实现的 while 会死循环。
 */
export function qqOfficialSeedFromSecret(secret: string): Buffer {
  const text = String(secret ?? '');
  if (!text) {
    throw new Error('AppSecret 为空，无法派生 Ed25519 签名密钥');
  }
  let seed = text;
  while (Buffer.byteLength(seed, 'utf8') < 32) {
    seed = seed.repeat(2);
  }
  return Buffer.from(seed, 'utf8').subarray(0, 32);
}

/**
 * 回调时间戳是否新鲜（防重放）。
 * `timestamp` 为平台头里的秒级时间戳；留空或非数字一律视为不新鲜。
 */
export function qqOfficialTimestampFresh(
  timestamp: string,
  maxSkewSec: number = QQC_CALLBACK_MAX_SKEW_SEC,
  nowMs: number = Date.now(),
): boolean {
  const ts = Number.parseInt(String(timestamp ?? '').trim(), 10);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const nowSec = Math.floor(nowMs / 1000);
  return Math.abs(nowSec - ts) <= maxSkewSec;
}

function privateKeyFromSecret(secret: string) {
  const seed = qqOfficialSeedFromSecret(secret);
  return createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
}

/** 回调地址校验（op=13）：对 event_ts + plain_token 签名 */
export function qqOfficialSignValidation(
  secret: string,
  eventTs: string,
  plainToken: string,
): string {
  const key = privateKeyFromSecret(secret);
  const msg = Buffer.from(`${eventTs}${plainToken}`, 'utf8');
  return sign(null, msg, key).toString('hex');
}

/** 校验腾讯回调请求的 Ed25519 签名 */
export function qqOfficialVerifyCallbackSignature(
  secret: string,
  signatureHex: string,
  timestamp: string,
  rawBody: string | Buffer,
): boolean {
  try {
    const priv = privateKeyFromSecret(secret);
    const pub = createPublicKey(priv);
    const sig = Buffer.from(signatureHex.trim(), 'hex');
    if (sig.length !== 64) return false;
    const bodyBuf = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
    const msg = Buffer.concat([Buffer.from(timestamp, 'utf8'), bodyBuf]);
    return verify(null, msg, pub, sig);
  } catch {
    return false;
  }
}
