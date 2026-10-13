'use strict';
// 夹具 fx-w31（verify-round31 索引可视化设计器）：
//  stage1（无实例存活）: 基线重置 demo-test.db → sqlite 建 dh_w31_t（id PK / nm TEXT / qty INT，2 行）；
//    mssql master 建 dbo.dh_w31_t（id BIGINT PK / nm NVARCHAR(50) / qty INT）。
//    表达式键/降序/部分索引（LOWER(nm) + "nm" DESC + WHERE qty>0）由套件经设计器 UI 落库，夹具不建索引。
//  verify-s: sqlite_master 索引 DDL 回读 → JSON-S 行 {name, sql}（套件断言 sql 含 "nm" DESC /
//    LOWER(nm) / WHERE qty>0，编辑后为 qty>5）。
//  verify-m: mssql 侧两个独立单语句查询（无 CONVERT/CAST）—— 索引元数据（name/has_filter/
//    filter_definition）+ 首键列（key_ordinal=1），按名合并 → JSON-M 行 [name, hasFilter, 谓词, 首键]。
//    驱动映射里筛选谓词字段名为 where（此处按自算 hasFilter 输出，谓词原文含 qty）。
//  cleanup: 双侧删除 dh_w31_t（电池 fx w31 cleanup 依赖本阶段，round12 排序亦依赖其运行）。
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
  await q('DROP TABLE IF EXISTS "dh_w31_t"');
  await c.createTable({
    name: 'dh_w31_t',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
      { name: 'qty', dataType: 'INTEGER', nullable: true },
    ],
  });
  await c.insertRows({
    table: 'dh_w31_t',
    columns: ['id', 'nm', 'qty'],
    rows: [
      [1, '甲', 10],
      [2, '乙', 20],
    ],
  });
  await c.close();
  // mssql 侧（D 组设计器在 dbo.dh_w31_t 上建筛选索引 dh_w31_mix）
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w31_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w31_t;");
    await msql(conn, 'CREATE TABLE dbo.dh_w31_t (id BIGINT NOT NULL PRIMARY KEY, nm NVARCHAR(50) NULL, qty INT NULL);');
  } finally {
    conn.close();
  }
  console.log('FX-W31 stage1 ok');
}

async function verifyS() {
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  const rows = ((((await q('SELECT name, sql FROM sqlite_master WHERE type = \'index\' AND tbl_name = \'dh_w31_t\'')) || {}).rows) || [])
    .map(function (r) { return { name: r[0], sql: r[1] }; });
  console.log('JSON-S ' + JSON.stringify(rows));
  await c.close();
}

async function verifyM() {
  const conn = await mopen();
  let out;
  try {
    // 查询一：索引元数据（has_filter 用 CASE 表达，规避 CONVERT/CAST 与 tedious BIT 解析歧义）
    const meta = await msql(conn, "SELECT i.name, CASE WHEN i.has_filter = 1 THEN 1 ELSE 0 END AS has_filter, i.filter_definition FROM sys.indexes i WHERE i.object_id = OBJECT_ID(N'dbo.dh_w31_t') AND i.name IS NOT NULL AND i.is_primary_key = 0 ORDER BY i.name;");
    // 查询二：首键列（key_ordinal = 1）
    const keys = await msql(conn, "SELECT i.name, c.name AS first_key FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.key_ordinal = 1 JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id WHERE i.object_id = OBJECT_ID(N'dbo.dh_w31_t') AND i.name IS NOT NULL AND i.is_primary_key = 0 ORDER BY i.name;");
    const keyMap = {};
    keys.forEach(function (r) { keyMap[String(r[0])] = String(r[1]); });
    out = meta.map(function (r) {
      return [
        String(r[0]),
        Number(r[1]),
        r[2] === null || r[2] === undefined ? '' : String(r[2]),
        keyMap[String(r[0])] || '',
      ];
    });
  } finally {
    conn.close();
  }
  console.log('JSON-M ' + JSON.stringify(out));
}

async function cleanup() {
  const c = await create({ file: DB_FILE });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  await q('DROP TABLE IF EXISTS "dh_w31_t"');
  await c.close();
  const conn = await mopen();
  try {
    await msql(conn, "IF OBJECT_ID(N'dbo.dh_w31_t', N'U') IS NOT NULL DROP TABLE dbo.dh_w31_t;");
  } finally {
    conn.close();
  }
  console.log('FX-W31 cleanup ok');
}

(async () => {
  if (stage === 'stage1') await stage1();
  else if (stage === 'verify-s') await verifyS();
  else if (stage === 'verify-m') await verifyM();
  else if (stage === 'cleanup') await cleanup();
  else { console.error('FX-ERR', 'unknown stage: ' + stage); process.exit(1); }
})().catch(function (e) { console.error('FX-ERR', e && e.message); process.exit(1); });
