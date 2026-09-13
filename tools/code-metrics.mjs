// 代码体量指标：找出所有 >60 行的函数/hook
import fs from 'node:fs';
import path from 'node:path';

const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (/\.(js|jsx)$/.test(f)) files.push(p);
  }
})('src');
files.push('server/index.mjs', 'server/accounts.mjs', 'server/sync.mjs', 'server/kv.mjs', 'server/ocr.mjs', 'server/mailer.mjs');

const rows = [];
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const starts = [];
  lines.forEach((l, i) => {
    if (/^(export )?(async )?function \w+/.test(l) || /^(export )?const \w+ = (async )?\(/.test(l) || /^(export )?const \w+ = (async )?function/.test(l)) {
      starts.push({ name: l.trim().replace(/\s*\{$/, '').slice(0, 48), line: i + 1, i });
    }
  });
  starts.forEach((s, k) => {
    const len = (k + 1 < starts.length ? starts[k + 1].i : lines.length) - s.i;
    rows.push({ file: f.split(path.sep).join('/'), name: s.name, line: s.line, len });
  });
}

rows.sort((a, b) => b.len - a.len);
console.log('=== 最长的 15 个函数 ===');
rows.slice(0, 15).forEach((r) => console.log(`  ${String(r.len).padStart(5)} 行  ${r.file}:${r.line}  ${r.name}`));

const over100 = rows.filter((r) => r.len > 100);
const over200 = rows.filter((r) => r.len > 200);
console.log(`\n=== 汇总 ===`);
console.log(`  函数总数: ${rows.length}`);
console.log(`  >100 行: ${over100.length} 个  (${over100.map((r) => r.file.replace('src/', '') + ':' + r.line).join(', ')})`);
console.log(`  >200 行: ${over200.length} 个`);
const avg = rows.reduce((a, b) => a + b.len, 0) / rows.length;
console.log(`  平均长度: ${avg.toFixed(1)} 行`);
