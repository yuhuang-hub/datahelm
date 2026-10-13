'use strict';
// 永久夹具：verify-round32-ui.js（结构明细行右键删除 dropStruct）
//   sqlite .tmp-ud7/demo-test.db：w32_ui（id/nm/uk；索引 w32_ix(nm)、唯一索引 w32_uq(uk)——
//     sqlite 唯一键组按索引名展示，用 CREATE UNIQUE INDEX 而非约束后备自动索引 sqlite_autoindex_*）
//     不建 CHECK/外键：套件 U3 走「本表无 CHECK」跳过分支（检查空分组仍可展开），U4 注明 sqlite 外键/检查
//     走设计器兜底（无夹具外键）；sqlite fk/ck 删除会抛「需重建表」引导设计器
//   mssql master.dbo：w32_ui_m（自引用外键 w32_ui_fk(mgr→id)、检查 w32_ui_ck(qty>=0)、
//     索引 w32_ui_ix(nm)、唯一索引 w32_ui_uq(uk)——套件 U5/U6 右键删外键/检查后由本夹具幂等重建）
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
    if (ts0.includes('w32_ui')) await c.dropTable({ table: 'w32_ui' });
    await c.createTable({
      name: 'w32_ui',
      cols: [
        { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
        { name: 'nm', dataType: 'TEXT', nullable: true },
        { name: 'uk', dataType: 'TEXT', nullable: true },
      ],
      indexesAfter: [{ name: 'w32_ix', columns: ['nm'] }],
      uniquesAfter: [{ name: 'w32_uq', columns: ['uk'] }],
    });
    // 回读校验：索引组仅 w32_ix；唯一键组（=唯一索引）为 w32_uq
    const ts = await c.tables();
    if (!ts.includes('w32_ui')) throw new Error('sqlite w32_ui 未创建');
    const xs = await c.indexes({ table: 'w32_ui' });
    const xNames = xs.map((x) => x.name).sort().join(',');
    if (xNames !== 'w32_ix,w32_uq') throw new Error('sqlite w32_ui 索引回读异常: ' + xNames);
    const uq = xs.find((x) => x.name === 'w32_uq');
    if (!uq || uq.unique !== true) throw new Error('sqlite w32_uq 非唯一索引');
  } finally {
    await c.close();
  }
  console.log('W32 sqlite: w32_ui(w32_ix, w32_uq)');

  // ---- stage2：mssql master.dbo w32_ui_m（幂等：删表连带外键/检查/索引后整体重建）----
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
    await run('IF OBJECT_ID(\'dbo.w32_ui_m\', \'U\') IS NOT NULL DROP TABLE dbo.w32_ui_m;');
    await run('CREATE TABLE dbo.w32_ui_m (id INT NOT NULL, nm NVARCHAR(60) NULL, uk NVARCHAR(40) NULL, qty INT NOT NULL, mgr INT NULL, CONSTRAINT w32_ui_pk PRIMARY KEY (id), CONSTRAINT w32_ui_fk FOREIGN KEY (mgr) REFERENCES dbo.w32_ui_m (id), CONSTRAINT w32_ui_ck CHECK (qty >= 0));');
    await run('CREATE INDEX w32_ui_ix ON dbo.w32_ui_m (nm);');
    await run('CREATE UNIQUE INDEX w32_ui_uq ON dbo.w32_ui_m (uk);');
    // 回读校验：表 / 自引用外键 / 检查 / 索引+唯一索引
    const t = await scalar('SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(\'dbo\') AND name = \'w32_ui_m\';');
    const fk = await scalar('SELECT COUNT(*) FROM sys.foreign_keys WHERE name = \'w32_ui_fk\' AND parent_object_id = OBJECT_ID(\'dbo.w32_ui_m\');');
    const ck = await scalar('SELECT COUNT(*) FROM sys.check_constraints WHERE name = \'w32_ui_ck\' AND parent_object_id = OBJECT_ID(\'dbo.w32_ui_m\');');
    const ix = await scalar('SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID(\'dbo.w32_ui_m\') AND name IN (\'w32_ui_ix\', \'w32_ui_uq\');');
    if (Number(t) !== 1 || Number(fk) !== 1 || Number(ck) !== 1 || Number(ix) !== 2) {
      throw new Error('mssql w32_ui_m 回读异常 t=' + t + ' fk=' + fk + ' ck=' + ck + ' ix=' + ix);
    }
  } finally {
    conn.close();
  }
  console.log('W32 mssql: w32_ui_m(w32_ui_ix, w32_ui_uq, w32_ui_fk, w32_ui_ck)');
  console.log('W32-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
