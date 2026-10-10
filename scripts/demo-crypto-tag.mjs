// 演示脚本：把「系统类型 + 版本号」塞进 10 字节，并且能一字不差地解开
// 运行：node scripts/demo-crypto-tag.mjs
import crypto from 'node:crypto';

const MASTER = crypto.createHash('sha256').update('kakake-demo-master-key-v1').digest();
const RAW = 'Debian GNU/Linux 13 (trixie)|12.23.05';

const hex = (b) => Buffer.from(b).toString('hex').replace(/(..)/g, '$1 ').trim();
const step = (n, title, buf, note) => {
  console.log(`\n[${n}] ${title}`);
  if (Buffer.isBuffer(buf)) {
    console.log(`    十六进制  ${hex(buf)}`);
    console.log(`    长度      ${buf.length} 字节${note ? '   ← ' + note : ''}`);
  } else {
    console.log(`    值        ${buf}${note ? '   ← ' + note : ''}`);
  }
};

// ============================================================ 字典 & 编解码
const OS_TABLE = [
  'Windows NT 10.0',
  'Ubuntu 24.04 LTS',
  'Debian GNU/Linux 12 (bookworm)',
  'Debian GNU/Linux 13 (trixie)',
  'macOS 15 Sequoia',
];
const ID_OF = new Map(OS_TABLE.map((n, i) => [n, i + 1]));

// 版本用 base-12 打包：0123456789 → 0..9 ，小数点 → 10 ，补位符 → 11
// 固定 13 个符号位，12^13 ≈ 2^46.6，装得进 6 字节，所以字母/前导零一个都不会丢
const MAXLEN = 13;
const SYM = '0123456789.';

function packVersion(str) {
  if (!/^[0-9.]+$/.test(str)) throw new Error('版本含非法字符: ' + str);
  if (str.length > MAXLEN) throw new Error('版本过长，上限 ' + MAXLEN + ' 字符');
  let n = 0n;
  for (let i = 0; i < MAXLEN; i++) {
    const ch = str[i];
    const d = ch === undefined ? 11n : BigInt(SYM.indexOf(ch));
    n = n * 12n + d;
  }
  const b = Buffer.alloc(6);
  let x = n;
  for (let i = 5; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; }
  return b;
}

function unpackVersion(buf) {
  let x = 0n;
  for (const byte of buf) x = (x << 8n) | BigInt(byte);
  const arr = [];
  for (let i = 0; i < MAXLEN; i++) { arr.push(Number(x % 12n)); x /= 12n; }
  while (arr.length && arr[0] === 11) arr.shift(); // 低位的补位符丢掉
  return arr.reverse().map((d) => SYM[d]).join('');
}

const deriveKey = (salt) => Buffer.from(crypto.hkdfSync('sha256', MASTER, salt, 'kakake-tag-v1', 32));

// AES-256-CTR 保长加密：密文长度 === 明文长度
const lock = (pt, salt) => {
  const c = crypto.createCipheriv('aes-256-ctr', deriveKey(salt), Buffer.alloc(16, 0));
  return Buffer.concat([c.update(pt), c.final()]);
};
// 解密就是同一套操作的完全对称形式
const unlock = (ct, salt) => {
  const d = crypto.createDecipheriv('aes-256-ctr', deriveKey(salt), Buffer.alloc(16, 0));
  return Buffer.concat([d.update(ct), d.final()]);
};

// ============================================================ 加密
console.log('══════════════════════ 加 密 ══════════════════════');
console.log(`\n主密钥（SHA-256）  ${hex(MASTER)}`);

step('输入', '原始字符串', RAW, `UTF-8 共 ${Buffer.byteLength(RAW)} 字节`);

const [osName, verStr] = RAW.split('|');
step(1, '按竖线拆成两段', `OS = "${osName}"   版本 = "${verStr}"`);

const id = ID_OF.get(osName);
step(2, `查字典 → 槽位 ${id}`, Buffer.from([id]), '1 字节替掉了 28 个字符');

const verBin = packVersion(verStr);
step(3, '版本按 base-12 无损打包', verBin, '补位符保证 "05" 的前导零不丢');

const plaintext = Buffer.concat([Buffer.from([id]), verBin]);
step(4, '拼接成明文', plaintext, '37 字节 → 7 字节');

const salt = crypto.randomBytes(3);
step(5, '生成随机盐', salt, '预留 3 字节');

const key = deriveKey(salt);
step(6, 'HKDF 派生一次性密钥', key, '每条消息用不同密钥，IV 可以固定为 0');

const ct = lock(plaintext, salt);
step(7, 'AES-256-CTR 加密', ct, '7 字节进 7 字节出，零膨胀');

const token = Buffer.concat([salt, ct]);
step(8, '最终密文 token', token, '★ 正好 10 字节');
console.log(`\n    可见形式  base64 = ${token.toString('base64')} (${token.toString('base64').length} 字符)`);

// ============================================================ 解密
console.log('\n\n══════════════════════ 解 密 ══════════════════════');
step('输入', '收到的 token', token);

const gotSalt = token.subarray(0, 3);
step(1, '切前 3 字节当盐', gotSalt);

const gotCt = token.subarray(3);
step(2, '剩下 7 字节是荷载', gotCt);

const gotKey = deriveKey(gotSalt);
step(3, '用同一个盐还原密钥', gotKey, '与加密时第 6 步逐字节相同');

const gotPt = unlock(gotCt, gotSalt);
step(4, 'AES-256-CTR 解密', gotPt, '回到打包后的明文');

const gotId = gotPt[0];
step(5, `第 1 字节反查字典 → ${gotId}`, `"${OS_TABLE[gotId - 1]}"`);

const gotVer = unpackVersion(gotPt.subarray(1));
step(6, '后 6 字节解回版本', `"${gotVer}"`, '注意 "05" 完整回来了');

const recovered = `${OS_TABLE[gotId - 1]}|${gotVer}`;
step(7, '拼回最终字符串', `"${recovered}"`);

console.log('\n══════════════════════ 比 对 ══════════════════════');
console.log(`  加密前    "${RAW}"`);
console.log(`  解密后    "${recovered}"`);
console.log(`  逐字节    ${Buffer.from(RAW).equals(Buffer.from(recovered)) ? '完全一致 ✓' : '不一致 ✗'}`);
console.log(`  密文长度  ${token.length} 字节（上限 10）`);

// 同一内容连跑三次，确认盐带来的差异
console.log('\n══════════ 同一明文加密三次（证明不是固定映射）══════════');
for (let i = 0; i < 3; i++) {
  const s = crypto.randomBytes(3);
  const t = Buffer.concat([s, lock(plaintext, s)]);
  const back = unlock(t.subarray(3), t.subarray(0, 3));
  console.log(`  第 ${i + 1} 次  ${t.toString('hex')}   解开 → 字节${back.equals(plaintext) ? '一致 ✓' : '损坏 ✗'}`);
}
