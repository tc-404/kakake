/**
 * 华米登录体 AES-128-CBC。密钥/IV 与 TonyJiangWJ/mimotion、hanximeng/Zepp_API 一致。
 * mimotion: Apache-2.0
 */
import { createCipheriv } from 'node:crypto';

const HM_AES_KEY = Buffer.from('xeNtBVqzDc6tuNTh', 'utf8');
const HM_AES_IV = Buffer.from('MAAAYAAAAAAAAABg', 'utf8');

/** 固定 IV，密文不加 IV 前缀（登录 POST body） */
export function encryptHuami(plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', HM_AES_KEY, HM_AES_IV);
  return Buffer.concat([cipher.update(plain), cipher.final()]);
}
