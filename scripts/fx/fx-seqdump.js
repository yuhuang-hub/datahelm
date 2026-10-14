// 自增序列导出修复验证（dumpTable 带 CREATE SEQUENCE + setval）
// 前置：docker run -d --name dh-pg17 -e POSTGRES_PASSWORD=test123 -e POSTGRES_DB=dhseq -p 5433:5432 postgres:17
//       docker run -d --name dh-pg12 -e POSTGRES_PASSWORD=test123 -e POSTGRES_DB=dhseq -p 5434:5432 postgres:12.4
// 用法：node scripts/fx/fx-seqdump.js   （连 5433 的 pg17，逐表 dumpTable 写到 fx-seqdump-out.sql）
'use strict';
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/postgres');

const OUT = 'D:/DataHelm/scripts/fx/fx-seqdump-out.sql';

async function main() {
  const s = await create({ host: '127.0.0.1', port: 5433, user: 'postgres', password: 'test123', database: 'dhseq' });
  try {
    const parts = [];
    for (const t of ['t_serial', 't_identity', 't_plain']) {
      parts.push(`-- ---------- ${t} ----------`);
      parts.push(await s.dumpTable({ schema: 'public', table: t, content: 'all' }));
      parts.push('');
    }
    fs.writeFileSync(OUT, parts.join('\n'), 'utf8');
    console.log(`OK 已写出 ${OUT}`);
  } finally {
    await s.close();
  }
}
main().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
