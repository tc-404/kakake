/**
 * 在线更新 / 插件安装的离线验签公钥环。
 * 公钥可公开；私钥 kakake-sign.key 只在维护者本地与 CI Secrets。
 * 更新包必须由对应私钥签出、本公钥验过；恶意镜像换包也伪造不了签名。
 * 轮换：追加 keyId -> base64(SPKI)，新私钥签名，旧密钥保留一段宽限期。
 */

/** keyId -> base64(去掉 PEM 头的 SPKI 公钥) */
export type SigningKeyRing = Record<string, string>;

export const UPDATE_SIGNING_KEYS: SigningKeyRing = {
  // 首把密钥，2026 启用。如需轮换，新增一项即可，勿删旧项直到宽限期结束。
  'kakake-2026':
    'MCowBQYDK2VwAyEAi8HqXWglxnFU9wRglCCd468qC9gFbNEK9juVix+4sK8=',
};

import { createPublicKey, verify as cryptoVerify, createHash } from 'node:crypto';

/**
 * 验证某包体（Buffer）的 Ed25519 签名是否有效。
 *
 * @param payload   下载下来的包体原始字节
 * @param signatureB64  对 `sha256(payload)` 的 Ed25519 签名，base64 编码
 * @param keyId     签名所用密钥的 id（对应 UPDATE_SIGNING_KEYS 的键）
 * @returns true=验签通过；false=密钥未知 / 签名不符 / 任何异常
 *
 * 说明：Ed25519 在 Node 中 algorithm 固定为 null；签名与验签必须对同一段
 * 数据（这里统一取 sha256(payload) 的摘要字节）进行，发布端 sign-release.mjs 须一致。
 */
export function verifyUpdateSignature(
  payload: Buffer,
  signatureB64: string,
  keyId: string,
): boolean {
  const pubB64 = UPDATE_SIGNING_KEYS[keyId];
  if (!pubB64) return false;
  try {
    const pub = createPublicKey({
      key: `-----BEGIN PUBLIC KEY-----\n${pubB64}\n-----END PUBLIC KEY-----`,
      format: 'pem',
    });
    const digest = createHash('sha256').update(payload).digest();
    const sig = Buffer.from(signatureB64, 'base64');
    return cryptoVerify(null, digest, pub, sig);
  } catch {
    return false;
  }
}

/**
 * 同 verifyUpdateSignature，但入参是【已算好的十六进制 sha256 摘要】而非原始包体。
 *
 * 下载流程中已在流式下载时算出 sha256（见 update-install.service.ts），直接复用即可，
 * 无需再把整包读进内存。签名与验签都对「sha256(payload) 的 32 字节摘要」进行，
 * 与 sign-release.mjs 的 `crypto.sign(null, digest, priv)` 保持一致。
 */
export function verifyUpdateSignatureDigest(
  digestHex: string,
  signatureB64: string,
  keyId: string,
): boolean {
  const pubB64 = UPDATE_SIGNING_KEYS[keyId];
  if (!pubB64) return false;
  try {
    const pub = createPublicKey({
      key: `-----BEGIN PUBLIC KEY-----\n${pubB64}\n-----END PUBLIC KEY-----`,
      format: 'pem',
    });
    const digest = Buffer.from(digestHex, 'hex');
    const sig = Buffer.from(signatureB64, 'base64');
    return cryptoVerify(null, digest, pub, sig);
  } catch {
    return false;
  }
}
