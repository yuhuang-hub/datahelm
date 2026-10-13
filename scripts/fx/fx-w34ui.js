'use strict';
// 永久夹具：verify-round34-ui.js（字段明细行「编辑字段」定位）
//   sqlite .tmp-ud7/demo-test.db：w34_col（id 主键/nm/qty/uk + 索引 w34_ix(nm)）——
//     套件 U1/U1b/U2/U3 双击/右键定位字段行（nm/qty/uk/id），U1b 需设计器「索引」页签有内容
//   mssql master.dbo：w34_col_m（id/nm/mgr/qty）——U4 右键 mgr 字段「编辑字段」定位
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

function errText(err) {
  const agg = err && Array.isArray(err.errors) && err.errors.length ? err.errors.map((x) => x.message || String(x)).join('; ') : '';
  return agg || (err && err.message) || String(err);
}

(async () => {
  // ---- stage1：sqlite 基线重置（UI 组套件共享 demo-test.db，必须先回到 demo.db 基线）----
  fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });
  fs.copyFileSync('D:/DataHelm/demo.db', 'D:/DataHelm/.tmp-ud7/demo-test.db');
  const c = await create({ file: 'D:/DataHelm/.tmp-ud7/demo-test.db' });
  try {
    const ts0 = await c.tables();
    if (ts0.includes('w34_col')) await c.dropTable({ table: 'w34_col' });
    await c.createTable({
      name: 'w34_col',
      cols: [
        { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
        { name: 'nm', dataType: 'TEXT', nullable: true },
        { name: 'qty', dataType: 'INTEGER', nullable: true },
        { name: 'uk', dataType: 'TEXT', nullable: true },
      ],
      indexesAfter: [{ name: 'w34_ix', columns: ['nm'] }],
    });
    // 回读校验：字段明细行（id/nm/qty/uk 供双击定位）+ 索引（设计器索引页签）
    const ts = await c.tables();
    if (!ts.includes('w34_col')) throw new Error('sqlite w34_col 未创建');
    const cols = await c.columns({ table: 'w34_col' });
    const cn = cols.map((x) => x.name).sort().join(',');
    if (cn !== 'id,nm,qty,uk') throw new Error('sqlite w34_col 字段回读异常: ' + cn);
    const idCol = cols.find((x) => x.name === 'id');
    if (!idCol || idCol.pk !== true) throw new Error('sqlite w34_col 主键列异常');
    const xs = await c.indexes({ table: 'w34_col' });
    if (!xs.some((x) => x.name === 'w34_ix')) throw new Error('sqlite w34_ix 未创建');
  } finally {
    await c.close();
  }
  console.log('W34 sqlite: w34_col(id/nm/qty/uk, w34_ix)');

  // ---- stage2：mssql master.dbo w34_col_m（幂等：删表重建，无外键依赖）----
  const conn = new Connection({
    server: 'localhost',
    authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
    options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 30000 },
  });
  const run = (sqlText) => new Promise((resolve, reject) => {
    const req = new Request(sqlText, (err) => (err ? reject(new Error(errText(err))) : resolve()));
    conn.execSqlBatch(req);
  });
  const scalar = (sqlText) => new Promise((resolve, reject) => {
    let v = null;
    const req = new Request(sqlText, (err) => (err ? reject(new Error(errText(err))) : resolve(v)));
    req.on('row', (cols) => { if (cols && cols[0]) v = cols[0].value; });
    conn.execSqlBatch(req);
  });
  try {
    await new Promise((resolve, reject) => {
      conn.on('connect', (err) => (err ? reject(new Error(errText(err))) : resolve()));
      conn.on('error', (e) => reject(new Error(errText(e))));
      conn.connect(); // 必须显式 connect，否则进程静默退出 0
    });
    await run('IF OBJECT_ID(\'dbo.w34_col_m\', \'U\') IS NOT NULL DROP TABLE dbo.w34_col_m;');
    await run('CREATE TABLE dbo.w34_col_m (id INT NOT NULL, nm NVARCHAR(60) NULL, mgr NVARCHAR(60) NULL, qty INT NULL, CONSTRAINT w34_col_pk PRIMARY KEY (id));');
    // 回读校验：表 + 4 个字段列（mgr 供右键「编辑字段」定位）
    const t = await scalar('SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(\'dbo\') AND name = \'w34_col_m\';');
    const n = await scalar('SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(\'dbo.w34_col_m\');');
    const mgr = await scalar('SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID(\'dbo.w34_col_m\') AND name = \'mgr\';');
    if (Number(t) !== 1 || Number(n) !== 4 || Number(mgr) !== 1) {
      throw new Error('mssql w34_col_m 回读异常 t=' + t + ' n=' + n + ' mgr=' + mgr);
    }
  } finally {
    conn.close();
  }
  console.log('W34 mssql: w34_col_m(id/nm/mgr/qty)');
  console.log('W34-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
