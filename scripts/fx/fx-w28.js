'use strict';
// 夹具 fx-w28（verify-round28 数据同步）：
//  stage1（无实例存活）: 基线重置 demo-test.db → sqlite 建 dh_w28_t（id PK/nm TEXT/qty INT/price NUMERIC(10,2)，
//    4 行：甲10/5.5、乙20/3.25、丙30/8、丁40/1.1）+ dh_w28_nopk（无主键，两侧都必须存在——
//    单侧存在会显示「目标缺表/目标独有」而非「无主键」）；mssql master 建 dh_w28_t
//    （1 行与源全同、id2 乙X/25 →更新、id5 戊50/9.99 →删除）+ dh_w28_nopk。
//  stage2: mssql 目标侧幂等漂移 —— UPDATE id1 为 甲X/11 + 守卫式 INSERT id6（T6 关「删除」应用：
//    id1 按源恢复 甲/10、id6 保留；T7 开「删除」→ id6 删除）。
//  verify-a/b/c: mssql SELECT id,nm,qty,price 全参与列，数值一律 Number() 归一
//    （BIGINT id/DECIMAL price 经 tedious 回字符串）→ JSON-A / JSON-B / JSON-C。
//  cleanup: 双侧删除 dh_w28_t / dh_w28_nopk。
const fs = require('fs');
const path = require('path');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

const DB_FILE = 'D:/DataHelm/.tmp-ud7/demo-test.db';
const stage = process.argv[2] || 'stage1';

// ---- tedious（mssql master）----
function mopen() {
  return new Promise(function (resolve, reject) {
    const conn = new Connection({
      server: 'localhost',
      authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
      options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
    });
    conn.on('connect', function (err) { if (err) reject(err); else resolve(conn); });
    conn.on('error', function (e) { reject(e); });
    conn.connect();
  });
}
function msql(conn, sqlText) {
  return new Promise(function (resolve, reject) {
    const rows = [];
    const req = new Request(sqlText, function (err) {
      if (err) {
        const agg = err && Array.isArray(err.errors) && err.errors.length
          ? err.errors.map(function (x) { return x.message || String(x); }).join('; ')
          : null;
        reject(new Error(agg || (err && err.message) || String(err)));
        return;
      }
      resolve(rows);
    });
    req.on('row', function (cols) { rows.push(cols.map(function (c) { return c.value; })); });
    conn.execSql(req);
  });
}

async function stage1() {
  fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });
  fs.copyFileSync('D:/DataHelm/demo.db', DB_FILE);
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  // 幂等：清旧
  await q('DROP TABLE IF EXISTS "dh_w28_t"');
  await q('DROP TABLE IF EXISTS "dh_w28_nopk"');
  await c.createTable({
    name: 'dh_w28_t',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
      { name: 'qty', dataType: 'INTEGER', nullable: true },
      { name: 'price', dataType: 'NUMERIC', length: 10, scale: 2, nullable: true },
    ],
  });
  await c.insertRows({
    table: 'dh_w28_t',
    columns: ['id', 'nm', 'qty', 'price'],
    rows: [
      [1, '甲', 10, 5.5],
      [2, '乙', 20, 3.25],
      [3, '丙', 30, 8],
      [4, '丁', 40, 1.1],
    ],
  });
  await c.createTable({
    name: 'dh_w28_nopk',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
    ],
  });
  await c.close();
  // mssql 侧（目标）：1 行与源全同、id2 漂移（→更新）、id5 多出（→删除）
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w28_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w28_t;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w28_nopk', N'U') IS NOT NULL DROP TABLE dbo.dh_w28_nopk;");
    await msql(conn, 'CREATE TABLE dbo.dh_w28_t (id BIGINT NOT NULL PRIMARY KEY, nm NVARCHAR(50) NULL, qty INT NULL, price DECIMAL(10,2) NULL);');
    await msql(conn, "INSERT INTO dbo.dh_w28_t (id, nm, qty, price) VALUES (1, N'甲', 10, 5.50), (2, N'乙X', 25, 3.25), (5, N'戊', 50, 9.99);");
    await msql(conn, 'CREATE TABLE dbo.dh_w28_nopk (id BIGINT NULL, nm NVARCHAR(50) NULL);');
  } finally {
    conn.close();
  }
  console.log('FX-W28 stage1 ok');
}

async function stage2() {
  const conn = await mopen();
  try {
    // 漂移施加在 MSSQL 目标侧（sqlite 源保持 甲/10；T6 断言应用后恢复 + id6 保留）
    await msql(conn, "UPDATE dbo.dh_w28_t SET nm = N'甲X', qty = 11 WHERE id = 1;");
    const n6 = (await msql(conn, 'SELECT COUNT(*) AS n FROM dbo.dh_w28_t WHERE id = 6;'))[0][0];
    if (Number(n6) === 0) await msql(conn, "INSERT INTO dbo.dh_w28_t (id, nm, qty, price) VALUES (6, N'己', 60, 6.66);");
  } finally {
    conn.close();
  }
  console.log('FX-W28 stage2 ok');
}

// 全参与列 SELECT + 数值 Number() 归一（mssql BIGINT/DECIMAL 回字符串）
async function mRows() {
  const conn = await mopen();
  try {
    return (await msql(conn, 'SELECT id, nm, qty, price FROM dbo.dh_w28_t ORDER BY id;'))
      .map(function (r) { return { id: Number(r[0]), nm: String(r[1]), qty: Number(r[2]), price: Number(r[3]) }; });
  } finally {
    conn.close();
  }
}

async function verifyA() {
  console.log('JSON-A ' + JSON.stringify(await mRows()));
}
async function verifyB() {
  console.log('JSON-B ' + JSON.stringify(await mRows()));
}
async function verifyC() {
  console.log('JSON-C ' + JSON.stringify(await mRows()));
}

async function cleanup() {
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  await q('DROP TABLE IF EXISTS "dh_w28_t"');
  await q('DROP TABLE IF EXISTS "dh_w28_nopk"');
  await c.close();
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w28_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w28_t;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w28_nopk', N'U') IS NOT NULL DROP TABLE dbo.dh_w28_nopk;");
  } finally {
    conn.close();
  }
  console.log('FX-W28 cleanup ok');
}

(async () => {
  if (stage === 'stage1') await stage1();
  else if (stage === 'stage2') await stage2();
  else if (stage === 'verify-a') await verifyA();
  else if (stage === 'verify-b') await verifyB();
  else if (stage === 'verify-c') await verifyC();
  else if (stage === 'cleanup') await cleanup();
  else { console.error('FX-ERR', 'unknown stage: ' + stage); process.exit(1); }
})().catch(function (e) { console.error('FX-ERR', e && e.message); process.exit(1); });
