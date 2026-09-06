import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

/** Ed25519 PKCS#8 前缀 + 32 字节 seed（与 QQ 开放平台示例一致） */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Bot Secret → 32 字节 seed（Go: 不足则 Repeat 再截断） */
export function qqOfficialSeedFromSecret(secret: string): Buffer {
  let seed = secret;
  while (Buffer.byteLength(seed, 'utf8') < 32) {
    seed = seed.repeat(2);
  }
  return Buffer.from(seed, 'utf8').subarray(0, 32);
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
