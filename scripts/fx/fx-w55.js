'use strict';
// 夹具（round55 / v0927.52 MSSQL 列拖拽排序——重建表法）：
//  stage1：dbo.w55_reo（id INT PK, nm NVARCHAR(50), qty INT）+ 非聚集索引 ix_w55_qty(qty) + 3 行数据
//  check1：核验重建后状态——列顺序（期望 nm,id,qty：套件把 id 行拖到 nm 之后）、行数 3、索引 ix_w55_qty 存活
//          输出 CHECK-JSON {...}；退出码 0
//  cleanup：drop w55_reo 与可能的 w55_reo__rebuild 残留
// 幂等：stage1 先 drop 旧表再建。运行时无 App 实例占用该库（battery 保证）。
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

const mode = process.argv[2] || 'stage1';
const conn = new Connection({
  server: 'localhost',
  authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
  options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
});
const run = (sqlText) =>
  new Promise((resolve, reject) => {
    const req = new Request(sqlText, (err, rowCount) => (err ? reject(err) : resolve(rowCount || 0)));
    conn.execSql(req);
  });
const queryRows = (sqlText) =>
  new Promise((resolve, reject) => {
    const out = [];
    const req = new Request(sqlText, (err) => (err ? reject(err) : resolve(out)));
    req.on('row', (cols) => {
      const o = {};
      cols.forEach((c) => { o[c.metadata.colName] = c.value; });
      out.push(o);
    });
    conn.execSql(req);
  });

(async () => {
  await new Promise((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve()));
    conn.connect(); // 必须显式 connect，否则静默退出
  });
  if (mode === 'stage1') {
    await run("IF OBJECT_ID('dbo.w55_reo', 'U') IS NOT NULL DROP TABLE dbo.w55_reo");
    await run("IF OBJECT_ID('dbo.w55_reo__rebuild', 'U') IS NOT NULL DROP TABLE dbo.w55_reo__rebuild");
    await run('CREATE TABLE dbo.w55_reo (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(50) NULL, qty INT NULL)');
    await run('CREATE INDEX ix_w55_qty ON dbo.w55_reo (qty)');
    await run("INSERT INTO dbo.w55_reo (id, nm, qty) VALUES (1, N'甲', 10)");
    await run("INSERT INTO dbo.w55_reo (id, nm, qty) VALUES (2, N'乙', 20)");
    await run("INSERT INTO dbo.w55_reo (id, nm, qty) VALUES (3, N'丙', 30)");
    console.log('W55-STAGE1-OK');
  } else if (mode === 'check1') {
    const cols = await queryRows("SELECT name FROM sys.columns WHERE object_id = OBJECT_ID('dbo.w55_reo') ORDER BY column_id");
    const idx = await queryRows("SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.w55_reo') AND name = 'ix_w55_qty'");
    const cnt = await queryRows('SELECT COUNT(*) AS n FROM dbo.w55_reo');
    const leftover = await queryRows("SELECT name FROM sys.tables WHERE name LIKE 'w55_reo[_]_%'");
    const info = {
      cols: cols.map((c) => c.name),
      indexAlive: idx.length === 1,
      rows: cnt.length ? Number(cnt[0].n) : -1,
      leftover: leftover.map((t) => t.name),
    };
    console.log('CHECK-JSON ' + JSON.stringify(info));
  } else if (mode === 'cleanup') {
    await run("IF OBJECT_ID('dbo.w55_reo', 'U') IS NOT NULL DROP TABLE dbo.w55_reo");
    await run("IF OBJECT_ID('dbo.w55_reo__rebuild', 'U') IS NOT NULL DROP TABLE dbo.w55_reo__rebuild");
    console.log('W55-CLEANUP-OK');
  } else {
    throw new Error('unknown mode: ' + mode);
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    conn.on('end', () => {
      clearTimeout(t);
      resolve();
    });
    conn.close();
  });
  process.exit(0);
})().catch((e) => {
  console.error('FX-ERR', e.message);
  process.exit(1);
});
