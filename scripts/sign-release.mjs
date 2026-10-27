#!/usr/bin/env node
/**
 * 离线 Ed25519 签名工具：node scripts/sign-release.mjs <包体> [keyId]，
 * 生成同名 .sig（{keyId, signature, alg, signedAt}），与包体一起上传 Release。
 * 私钥：KAKAKE_SIGN_KEY > KAKAKE_SIGN_KEY_PATH > 项目根 kakake-sign.key。只签名，不联网。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function fail(msg) {
  console.error(`[sign-release] ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) {
  fail('用法: node scripts/sign-release.mjs <包体文件> [keyId]');
}
const file = path.resolve(args[0]);
const keyId = args[1] || 'kakake-2026';
if (!fs.existsSync(file)) fail(`文件不存在: ${file}`);

// 解析私钥
let keyPem = '';
if (process.env.KAKAKE_SIGN_KEY) {
  keyPem = process.env.KAKAKE_SIGN_KEY;
} else {
  const candidates = [
    process.env.KAKAKE_SIGN_KEY_PATH,
    path.join(process.cwd(), 'kakake-sign.key'),
  ].filter(Boolean);
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) {
    fail('找不到私钥：请设置 KAKAKE_SIGN_KEY / KAKAKE_SIGN_KEY_PATH，或把 kakake-sign.key 放在项目根目录');
  }
  keyPem = fs.readFileSync(found, 'utf8');
}

let priv;
try {
  priv = crypto.createPrivateKey(keyPem);
} catch (e) {
  fail(`私钥解析失败: ${e instanceof Error ? e.message : String(e)}`);
}

const buf = fs.readFileSync(file);
const digest = crypto.createHash('sha256').update(buf).digest();
const sig = crypto.sign(null, digest, priv);

const out = {
  keyId,
  alg: 'ed25519',
  signature: sig.toString('base64'),
  signedAt: new Date().toISOString(),
  // 同时记一份 sha256，便于人肉核对
  sha256: digest.toString('hex'),
};

const sigPath = `${file}.sig`;
fs.writeFileSync(sigPath, JSON.stringify(out, null, 2));
console.log(`[sign-release] 已签名: ${path.basename(file)}`);
console.log(`               -> ${path.basename(sigPath)} (keyId=${keyId})`);
