import fs from 'node:fs';

const src = fs.readFileSync('src/proxy/registry/entries/wild.ts', 'utf8');
const lines = src.split(/\r?\n/);
const blocks = [];
let buf = null;
for (const l of lines) {
  if (/^\s{2}\{$/.test(l)) { buf = [l]; continue; }
  if (buf !== null) {
    buf.push(l);
    if (/^\s{2}\},?$/.test(l)) { blocks.push(buf.join('\n')); buf = null; }
  }
}
let n = 0;
let nullCount = 0;
for (const b of blocks) {
  const name = (/\bname\s*:\s*'([a-z0-9_]+)'/.exec(b) ?? [])[1];
  const acts = [...b.matchAll(/\baction\s*:\s*'([^']+)'/g)].map((m) => m[1]);
  const sup = ((/\bsupport\s*:\s*\[([^\]]*)\]/.exec(b) ?? [])[1] ?? '').replace(/'/g, '').trim();
  const nullData = /success:\s*\{[^}]*data:\s*null/.test(b);
  if (nullData) nullCount++;
  console.log(`${++n}. ${name.padEnd(26)} [${sup}] -> ${[...new Set(acts)].join(',')}${nullData ? '   (data=null)' : ''}`);
}
console.log(`\n共 ${n} 条，其中 data: null（返回结构未文档化）${nullCount} 条`);
