'use strict';
// 同步进度条夹具（verify-round48 前置）：
//  stage1（默认）：
//   - w48-src.db：employees（demo.db 同构 4 行基线，王五 salary=NULL）+ w48_t001..w48_t060
//     （id INTEGER PK / nm TEXT NOT NULL / qty INTEGER NOT NULL DEFAULT 0 / price NUMERIC(10,2)，
//       各带索引 w48_ix_NNN ON qty）；t001..t030 各 8000 行（行 = [k, 'r'+k, k%97, (k%991)/4]，k 从 1 起），
//       t031..t060 空表 → 结构比较 61 表（首 employees 末 w48_t060），新建 30 / 一致 31
//   - w48-dst.db：employees 同构同数据但王五 salary=9999（1 行漂移）+ t001..t030 同名同构同索引同 8000 行
//     （仅 w48_t001 的 k=2 行 qty=25，单行差）+ 空 w48_extra（目标独有）→ 数据比较 差异 2 / 一致 29 / 缺表 30
//   - connections.json 注册 c-w48-src / c-w48-dst（对象结构，裸名 W48源库 / W48目标库——下拉由 UI 渲染
//     name（SQLite）后缀，套件按「W48源库（SQLite）」匹配）
//  cleanup：删两个库文件 + 按 id 移除两条连接（保留其他条目）
//  建表走驱动 createTable spec（表名/索引名 JS 拼接进 spec 对象，SQL 文本由驱动生成）；
//  数据走 insertRows 批量（行数组 JS 循环构建）。幂等：先删旧库文件再重建。输出 W48-STAGE1-OK / W48-CLEANUP-OK。
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');

const UD = 'D:/DataHelm/.tmp-ud7';
const CONNS = UD + '/connections.json';
const SRC_FILE = UD + '/w48-src.db';
const DST_FILE = UD + '/w48-dst.db';
const N_TABLES = 60;   // w48_t001..w48_t060
const N_DATA = 30;     // 前 30 张各 8000 行（源）；目标侧同 30 张
const ROWS_PER = 8000;
const BATCH = 4000;

const pad3 = (n) => String(n).padStart(3, '0');

// employees：与 demo-test.db 同构（id INTEGER PRIMARY KEY AUTOINCREMENT / name / dept VARCHAR(80) DEFAULT '研发' / salary DECIMAL(10,2) / hired DATE）
const EMP_COLS = [
  { name: 'id', dataType: 'INTEGER', nullable: true, pk: true, autoInc: true },
  { name: 'name', dataType: 'TEXT', nullable: false },
  { name: 'dept', dataType: 'VARCHAR', length: 80, nullable: true, defaultValue: "'研发'" },
  { name: 'salary', dataType: 'DECIMAL', length: 10, scale: 2, nullable: true },
  { name: 'hired', dataType: 'DATE', nullable: true },
];
const EMP_COLUMNS = ['id', 'name', 'dept', 'salary', 'hired'];
const empRows = (wangWuSalary) => [
  [1, '张三', '研发', 15000.5, '2023-01-15'],
  [2, '李四', '运维', 12000, '2022-11-01'],
  [3, '王五', '测试', wangWuSalary, '2024-03-20'],
  [4, '赵六', '研发', 18000.75, '2021-06-01'],
];

const W48_COLS = [
  { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
  { name: 'nm', dataType: 'TEXT', nullable: false },
  { name: 'qty', dataType: 'INTEGER', nullable: false, defaultValue: '0' },
  { name: 'price', dataType: 'NUMERIC', length: 10, scale: 2, nullable: true },
];
const W48_COLUMNS = ['id', 'nm', 'qty', 'price'];

// 8000 行：[k, 'r'+k, k%97, (k%991)/4]（k 从 1 起）；qtyOverride 时 k=2 行 qty=25（目标 t001 单行差）
const w48Rows = (overrideT002) => {
  const rows = [];
  for (let k = 1; k <= ROWS_PER; k += 1) {
    rows.push([k, 'r' + k, overrideT002 && k === 2 ? 25 : k % 97, (k % 991) / 4]);
  }
  return rows;
};
const BASE_ROWS = w48Rows(false);
const T001_DST_ROWS = w48Rows(true);

async function insertBatched(c, table, rows) {
  for (let off = 0; off < rows.length; off += BATCH) {
    await c.insertRows({ table, columns: W48_COLUMNS, rows: rows.slice(off, off + BATCH) });
  }
}

async function stage1() {
  fs.mkdirSync(UD, { recursive: true });
  try { fs.unlinkSync(SRC_FILE); } catch (e) { /* 不存在即期望态 */ }
  try { fs.unlinkSync(DST_FILE); } catch (e) { /* 不存在即期望态 */ }

  // ---- 源库：61 表 ----
  const src = await create({ file: SRC_FILE });
  await src.createTable({ name: 'employees', cols: EMP_COLS });
  await src.insertRows({ table: 'employees', columns: EMP_COLUMNS, rows: empRows(null) });
  for (let n = 1; n <= N_TABLES; n += 1) {
    const name = 'w48_t' + pad3(n);
    await src.createTable({ name, cols: W48_COLS, indexesAfter: [{ name: 'w48_ix_' + pad3(n), columns: ['qty'] }] });
    if (n <= N_DATA) await insertBatched(src, name, BASE_ROWS);
  }
  await src.close();

  // ---- 目标库：employees（王五 9999 漂移）+ t001..t030 同构（t001 单行差）+ 空 w48_extra ----
  const dst = await create({ file: DST_FILE });
  await dst.createTable({ name: 'employees', cols: EMP_COLS });
  await dst.insertRows({ table: 'employees', columns: EMP_COLUMNS, rows: empRows(9999) });
  for (let n = 1; n <= N_DATA; n += 1) {
    const name = 'w48_t' + pad3(n);
    await dst.createTable({ name, cols: W48_COLS, indexesAfter: [{ name: 'w48_ix_' + pad3(n), columns: ['qty'] }] });
    await insertBatched(dst, name, n === 1 ? T001_DST_ROWS : BASE_ROWS);
  }
  await dst.createTable({ name: 'w48_extra', cols: W48_COLS }); // 空表：结构比较「目标独有」1
  await dst.close();

  // ---- 连接注册：{connections:[...]} 对象结构；裸名（UI 自渲染（SQLite）后缀） ----
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CONNS, 'utf8')); } catch (e) { doc = null; }
  if (!doc || !Array.isArray(doc.connections)) doc = { connections: [] };
  doc.connections = doc.connections.filter((x) => x && x.id !== 'c-w48-src' && x.id !== 'c-w48-dst');
  doc.connections.push({ id: 'c-w48-src', name: 'W48源库', type: 'sqlite', config: { file: SRC_FILE } });
  doc.connections.push({ id: 'c-w48-dst', name: 'W48目标库', type: 'sqlite', config: { file: DST_FILE } });
  fs.writeFileSync(CONNS, JSON.stringify(doc, null, 2));

  console.log('W48-STAGE1-OK');
}

async function cleanup() {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CONNS, 'utf8')); } catch (e) { doc = null; }
  if (doc && Array.isArray(doc.connections)) {
    doc.connections = doc.connections.filter((x) => x && x.id !== 'c-w48-src' && x.id !== 'c-w48-dst');
    fs.writeFileSync(CONNS, JSON.stringify(doc, null, 2));
  }
  try { fs.unlinkSync(SRC_FILE); } catch (e) { /* 不存在即期望态 */ }
  try { fs.unlinkSync(DST_FILE); } catch (e) { /* 不存在即期望态 */ }
  console.log('W48-CLEANUP-OK');
}

(async () => {
  if (process.argv[2] === 'cleanup') await cleanup();
  else await stage1();
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
