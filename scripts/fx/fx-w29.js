'use strict';
// 夹具 fx-w29（verify-round29 运行 SQL 文件 / 还原备份）：
//  stage1（无实例存活）: 基线重置 demo-test.db（脚本自带 CREATE，sqlite 侧不预建 dh_w29_t）+
//    mssql master 预清 dh_w29_t / dh_w29_bad / dh_w29_m（守卫式 DROP，幂等）+
//    向 backups 目录写 3 个脚本：
//      w29-restore.sql        sqlite 方言 4 句（含 '甲;分号' 半角分号串、'引''号' 转义引号、UPDATE）
//      w29-restore-mssql.sql  3 个 GO 批（两条 INSERT 合并为一条多 VALUES；末批无尾随 GO）
//      w29-bad.sql            4 句，第 2 句违反 NOT NULL（重跑时第 1 句 CREATE 因表已存在即停）
//    → JSON-B 基线行数（employees 计数 + 文件数）。
//  verify-a: sqlite dh_w29_t（SELECT id,nm,qty，数值 Number 归一）→ JSON-A。
//  verify-b: mssql dh_w29_t（SELECT id,nm,qty）→ JSON-B。
//  verify-c: mssql dh_w29_bad（SELECT 仅 id,nm —— 该表无 qty 列）→ JSON-C。
//  cleanup: 删 3 个脚本文件 + 双侧清 dh_w29_t / dh_w29_bad / dh_w29_m。
const fs = require('fs');
const path = require('path');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

const DB_FILE = 'D:/DataHelm/.tmp-ud7/demo-test.db';
const BACKUP_DIR = 'D:/DataHelm/.tmp-ud7/backups';
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
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync('D:/DataHelm/demo.db', DB_FILE);
  // mssql 预清（守卫式，幂等；dh_w29_m 为历史遗留名一并清）
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_t;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_bad', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_bad;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_m', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_m;");
  } finally {
    conn.close();
  }
  // sqlite 方言还原脚本：分号在引号内不切分、'' 转义引号、UPDATE 原样执行（共 4 句）
  fs.writeFileSync(
    path.join(BACKUP_DIR, 'w29-restore.sql'),
    [
      'CREATE TABLE dh_w29_t (id INTEGER PRIMARY KEY, nm TEXT, qty INTEGER);',
      "INSERT INTO dh_w29_t (id, nm, qty) VALUES (1, '甲;分号', 10);",
      "INSERT INTO dh_w29_t (id, nm, qty) VALUES (2, '引''号', 10);",
      'UPDATE dh_w29_t SET qty = 33 WHERE id = 2;',
    ].join('\n') + '\n',
    'utf8'
  );
  // mssql GO 分批脚本：3 批（多 VALUES 单句 + 末批 UPDATE，无尾随 GO）
  fs.writeFileSync(
    path.join(BACKUP_DIR, 'w29-restore-mssql.sql'),
    [
      'CREATE TABLE dbo.dh_w29_t (id BIGINT NOT NULL PRIMARY KEY, nm NVARCHAR(50) NULL, qty INT NULL);',
      'GO',
      "INSERT INTO dbo.dh_w29_t (id, nm, qty) VALUES (1, N'甲', 10), (2, N'乙', 10);",
      'GO',
      'UPDATE dbo.dh_w29_t SET qty = 20 WHERE id = 2;',
    ].join('\n') + '\n',
    'utf8'
  );
  // 坏脚本：第 2 句违反 NOT NULL；重跑时第 1 句 CREATE 因表已存在即失败（T6 首错即停）
  fs.writeFileSync(
    path.join(BACKUP_DIR, 'w29-bad.sql'),
    [
      'CREATE TABLE dbo.dh_w29_bad (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(10) NOT NULL);',
      'INSERT INTO dbo.dh_w29_bad (id, nm) VALUES (1, NULL);',
      "INSERT INTO dbo.dh_w29_bad (id, nm) VALUES (2, N'y');",
      "INSERT INTO dbo.dh_w29_bad (id, nm) VALUES (3, N'z');",
    ].join('\n') + '\n',
    'utf8'
  );
  // 基线行数自检（demo.db 应为 employees 4 行）
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  const cntRows = (((await q('SELECT COUNT(*) AS c FROM employees')) || {}).rows) || [];
  const employees = cntRows.length ? Number(cntRows[0][0]) : -1;
  await c.close();
  console.log('JSON-B ' + JSON.stringify({ employees: employees, files: 3 }));
  console.log('FX-W29 stage1 ok');
}

async function verifyA() {
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  const rows = ((((await q('SELECT id, nm, qty FROM dh_w29_t ORDER BY id')) || {}).rows) || [])
    .map(function (r) { return { id: Number(r[0]), nm: String(r[1]), qty: Number(r[2]) }; });
  console.log('JSON-A ' + JSON.stringify(rows));
  await c.close();
}

async function verifyB() {
  const conn = await mopen();
  let rows;
  try {
    rows = (await msql(conn, 'SELECT id, nm, qty FROM dbo.dh_w29_t ORDER BY id;'))
      .map(function (r) { return { id: Number(r[0]), nm: String(r[1]), qty: Number(r[2]) }; });
  } finally {
    conn.close();
  }
  console.log('JSON-B ' + JSON.stringify(rows));
}

async function verifyC() {
  const conn = await mopen();
  let rows;
  try {
    // dh_w29_bad 无 qty 列：只查 id/nm
    rows = (await msql(conn, 'SELECT id, nm FROM dbo.dh_w29_bad ORDER BY id;'))
      .map(function (r) { return { id: Number(r[0]), nm: String(r[1]) }; });
  } finally {
    conn.close();
  }
  console.log('JSON-C ' + JSON.stringify(rows));
}

async function cleanup() {
  // 删 3 个脚本文件
  ['w29-restore.sql', 'w29-restore-mssql.sql', 'w29-bad.sql'].forEach(function (f) {
    const p = path.join(BACKUP_DIR, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  // sqlite 侧（脚本运行后存在 dh_w29_t）
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  await q('DROP TABLE IF EXISTS "dh_w29_t"');
  await c.close();
  // mssql 侧
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_t;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_bad', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_bad;");
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w29_m', N'U') IS NOT NULL DROP TABLE dbo.dh_w29_m;");
  } finally {
    conn.close();
  }
  console.log('FX-W29 cleanup ok');
}

(async () => {
  if (stage === 'stage1') await stage1();
  else if (stage === 'verify-a') await verifyA();
  else if (stage === 'verify-b') await verifyB();
  else if (stage === 'verify-c') await verifyC();
  else if (stage === 'cleanup') await cleanup();
  else { console.error('FX-ERR', 'unknown stage: ' + stage); process.exit(1); }
})().catch(function (e) { console.error('FX-ERR', e && e.message); process.exit(1); });
