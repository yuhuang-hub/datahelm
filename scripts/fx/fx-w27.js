'use strict';
// 夹具 fx-w27（verify-round27 结构同步）：
//  stage1（无实例存活）: 基线重置 demo-test.db → sqlite 建 dh_w27_a（5 列 + FK mgr→dh_w27_m2.id
//    + 命名 CHECK dh_w27_ck + 索引 dh_w27_ix(qty)）与 dh_w27_b；mssql master 清旧表后建
//    dh_w27_m2、dh_w27_m（FK mgr→m2.id + CHECK + 索引 dh_w27_mix）。
//    sqlite 侧故意不建 dh_w27_m/m2 —— T2 需要 mssql 侧呈现「目标独有」而非「一致」。
//  stage2: mssql dh_w27_m 幂等加列 extra2 + 幂等建索引 dh_w27_mix2（T5 差异同步）。
//  verify-a: mssql dh_w27_a 的 INFORMATION_SCHEMA 列（6 字段）+ FK/索引/CHECK 三个单值计数
//    → JSON-A 打平数组（列行≥6 元素、计数行恰 1 元素）。
//  verify-b: sqlite dh_w27_m PRAGMA table_info 原始行（c[1]=列名）/ index_list 名前置映射行
//    + hasFk + hasCk + 表清单 → JSON-B。
//  cleanup: 双侧删除 dh_w27_a/b/m/m2（mssql 子表在前）。
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

// ---- sqlite 驱动（驱动内建表规格：cols/fkeysAfter/checksAfter/indexesAfter）----
async function openSqlite() {
  return create({ file: DB_FILE });
}

async function stage1() {
  fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });
  fs.copyFileSync('D:/DataHelm/demo.db', DB_FILE);
  const c = await openSqlite();
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  // 幂等：清旧（基线重置后本不存在，双保险）
  await q('DROP TABLE IF EXISTS "dh_w27_a"');
  await q('DROP TABLE IF EXISTS "dh_w27_b"');
  // dh_w27_a：5 列；mgr BIGINT FK 引用 dh_w27_m2 的主键 id（refColumns 必须是 ['id']）；
  // 索引必须落在 qty 上（TEXT→NVARCHAR(MAX) 不能作 mssql 索引键）
  await c.createTable({
    name: 'dh_w27_a',
    cols: [
      { name: 'id', dataType: 'BIGINT', nullable: false, pk: true },
      { name: 'mgr', dataType: 'BIGINT', nullable: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
      { name: 'qty', dataType: 'INTEGER', nullable: true },
      { name: 'price', dataType: 'DECIMAL', length: 10, scale: 2, nullable: true },
    ],
    fkeysAfter: [{ name: 'dh_w27_fk', columns: ['mgr'], refTable: 'dh_w27_m2', refColumns: ['id'] }],
    checksAfter: [{ name: 'dh_w27_ck', expr: 'qty >= 0' }],
    indexesAfter: [{ name: 'dh_w27_ix', columns: ['qty'] }],
  });
  await c.createTable({
    name: 'dh_w27_b',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
    ],
  });
  await c.close();
  // mssql 侧：先清（子表 dh_w27_a 在前），再建（被引用的 m2 在前）
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_a', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_a;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_b', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_b;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_m', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_m;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_m2', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_m2;");
    await msql(conn, 'CREATE TABLE dbo.dh_w27_m2 (id BIGINT NOT NULL PRIMARY KEY, mgr BIGINT NULL);');
    await msql(conn, "CREATE TABLE dbo.dh_w27_m (id BIGINT NOT NULL PRIMARY KEY, mgr BIGINT NULL, nm NVARCHAR(50) NULL, qty INT NULL, price DECIMAL(10,2) NULL, CONSTRAINT dh_w27_fk_m FOREIGN KEY (mgr) REFERENCES dbo.dh_w27_m2 (id), CONSTRAINT dh_w27_ck_m CHECK (qty >= 0));");
    await msql(conn, 'CREATE INDEX dh_w27_mix ON dbo.dh_w27_m (nm, qty);');
  } finally {
    conn.close();
  }
  console.log('FX-W27 stage1 ok');
}

async function stage2() {
  const conn = await mopen();
  try {
    const nCol = (await msql(conn, "SELECT COUNT(*) AS n FROM sys.columns WHERE object_id = OBJECT_ID(N'dbo.dh_w27_m') AND name = N'extra2';"))[0][0];
    if (Number(nCol) === 0) await msql(conn, 'ALTER TABLE dbo.dh_w27_m ADD extra2 NVARCHAR(50) NULL;');
    const nIx = (await msql(conn, "SELECT COUNT(*) AS n FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.dh_w27_m') AND name = N'dh_w27_mix2';"))[0][0];
    if (Number(nIx) === 0) await msql(conn, 'CREATE INDEX dh_w27_mix2 ON dbo.dh_w27_m (nm, qty);');
  } finally {
    conn.close();
  }
  console.log('FX-W27 stage2 ok');
}

// mssqlExec 风格打平：前 N 行为 dh_w27_a 的列（6 字段），后 3 行为单值计数 [n]
async function verifyA() {
  const conn = await mopen();
  let out;
  try {
    const colRows = (await msql(conn, "SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS c WHERE c.TABLE_SCHEMA = N'dbo' AND c.TABLE_NAME = N'dh_w27_a' ORDER BY c.ORDINAL_POSITION;"))
      .map(function (r) {
        // NVARCHAR(MAX)：CHARACTER_MAXIMUM_LENGTH 为 -1（个别驱动路径回 0/null → 归一 -1）
        const len = r[2] === 0 || r[2] === null || r[2] === undefined ? -1 : Number(r[2]);
        return [
          String(r[0]).trim(),
          String(r[1]).trim().toUpperCase(),
          len,
          r[3] === null || r[3] === undefined ? null : Number(r[3]),
          r[4] === null || r[4] === undefined ? null : Number(r[4]),
          String(r[5] === null || r[5] === undefined ? '' : r[5]).trim(),
        ];
      });
    // FK 按 parent_object_id 计数（sqlite 侧合成的外键名与声明名永不相等，不能按名计数）
    const fkCount = (await msql(conn, "SELECT COUNT(*) AS n FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID(N'dbo.dh_w27_a');"))[0][0];
    const ixCount = (await msql(conn, "SELECT COUNT(*) AS n FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.dh_w27_a') AND name = N'dh_w27_ix';"))[0][0];
    const ckCount = (await msql(conn, "SELECT COUNT(*) AS n FROM sys.check_constraints WHERE parent_object_id = OBJECT_ID(N'dbo.dh_w27_a');"))[0][0];
    out = colRows.concat([[Number(fkCount)], [Number(ixCount)], [Number(ckCount)]]);
  } finally {
    conn.close();
  }
  console.log('JSON-A ' + JSON.stringify(out));
}

async function verifyB() {
  const c = await openSqlite();
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  const cols = (((await q('PRAGMA table_info("dh_w27_m")')) || {}).rows) || [];
  // index_list 原始行 [seq,name,unique,origin,partial] → 名前置 [name,seq,unique,origin,partial]
  const idx = ((((await q('PRAGMA index_list("dh_w27_m")')) || {}).rows) || [])
    .map(function (r) { return [r[1], r[0], r[2], r[3], r[4]]; });
  const fkRows = ((((await q('PRAGMA foreign_key_list("dh_w27_m")')) || {}).rows) || []);
  const ddlRows = ((((await q('SELECT sql FROM sqlite_master WHERE type = \'table\' AND name = \'dh_w27_m\'')) || {}).rows) || []);
  const tables = ((((await q('SELECT name FROM sqlite_master WHERE type = \'table\'')) || {}).rows) || [])
    .map(function (r) { return r[0]; });
  const out = {
    cols: cols,
    idx: idx,
    hasFk: fkRows.length > 0,
    hasCk: /CHECK/i.test(String((ddlRows[0] || [])[0] || '')),
    tables: tables,
  };
  console.log('JSON-B ' + JSON.stringify(out));
  await c.close();
}

async function cleanup() {
  const c = await openSqlite();
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  await q('DROP TABLE IF EXISTS "dh_w27_a"');
  await q('DROP TABLE IF EXISTS "dh_w27_b"');
  await q('DROP TABLE IF EXISTS "dh_w27_m"');
  await q('DROP TABLE IF EXISTS "dh_w27_m2"');
  await c.close();
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_a', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_a;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_b', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_b;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_m', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_m;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w27_m2', N'U') IS NOT NULL DROP TABLE dbo.dh_w27_m2;");
  } finally {
    conn.close();
  }
  console.log('FX-W27 cleanup ok');
}

(async () => {
  if (stage === 'stage1') await stage1();
  else if (stage === 'stage2') await stage2();
  else if (stage === 'verify-a') await verifyA();
  else if (stage === 'verify-b') await verifyB();
  else if (stage === 'cleanup') await cleanup();
  else { console.error('FX-ERR', 'unknown stage: ' + stage); process.exit(1); }
})().catch(function (e) { console.error('FX-ERR', e && e.message); process.exit(1); });
