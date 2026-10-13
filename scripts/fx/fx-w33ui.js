'use strict';
// 永久夹具：verify-round33-ui.js（结构明细行「编辑」定位）
//   sqlite .tmp-ud7/demo-test.db：w33_ui（id/nm/qty/uk；索引 w33_ix(nm)、唯一索引 w33_uq(uk)、
//     触发器 w33_tg AFTER INSERT 合法体 BEGIN SELECT 1; END——套件 U3 双击走 DDL 源码页签需含 CREATE TRIGGER）
//   mssql master.dbo：w33_ref（引用父表）+ w33_ui_m（id/nm/mgr/qty；索引 w33_ix、唯一索引 w33_uq、
//     外键 w33_fk→w33_ref(id)、检查 w33_ck(qty>=0)）——约束名 schema 内唯一，不与其他夹具冲突
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
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  try {
    // 触发器/索引随表级联：先守卫删触发器（驱动 dropObject 无 IF EXISTS 兜底），再删表
    await q('DROP TRIGGER IF EXISTS w33_tg');
    const ts0 = await c.tables();
    if (ts0.includes('w33_ui')) await c.dropTable({ table: 'w33_ui' });
    await c.createTable({
      name: 'w33_ui',
      cols: [
        { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
        { name: 'nm', dataType: 'TEXT', nullable: true },
        { name: 'qty', dataType: 'INTEGER', nullable: true },
        { name: 'uk', dataType: 'TEXT', nullable: true },
      ],
      indexesAfter: [{ name: 'w33_ix', columns: ['nm'] }],
      uniquesAfter: [{ name: 'w33_uq', columns: ['uk'] }],
    });
    // 触发器走 query()：BEGIN...END 体内分号由引擎语句切分保护，整条单语句执行
    await q('CREATE TRIGGER w33_tg AFTER INSERT ON w33_ui BEGIN SELECT 1; END');
    // 回读校验：表 / 索引+唯一索引 / 触发器 DDL
    const ts = await c.tables();
    if (!ts.includes('w33_ui')) throw new Error('sqlite w33_ui 未创建');
    const xs = await c.indexes({ table: 'w33_ui' });
    const xNames = xs.map((x) => x.name).sort().join(',');
    if (xNames !== 'w33_ix,w33_uq') throw new Error('sqlite w33_ui 索引回读异常: ' + xNames);
    const uq = xs.find((x) => x.name === 'w33_uq');
    if (!uq || uq.unique !== true) throw new Error('sqlite w33_uq 非唯一索引');
    const tgs = await c.triggers({ table: 'w33_ui' });
    const tg = tgs.find((x) => x.name === 'w33_tg');
    if (!tg || !/CREATE\s+TRIGGER/i.test(String(tg.sql || ''))) throw new Error('sqlite w33_tg 触发器回读异常');
  } finally {
    await c.close();
  }
  console.log('W33 sqlite: w33_ui(w33_ix, w33_uq, w33_tg)');

  // ---- stage2：mssql master.dbo w33_ref + w33_ui_m（幂等：先删子表再删父表）----
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
    await run('IF OBJECT_ID(\'dbo.w33_ui_m\', \'U\') IS NOT NULL DROP TABLE dbo.w33_ui_m;');
    await run('IF OBJECT_ID(\'dbo.w33_ref\', \'U\') IS NOT NULL DROP TABLE dbo.w33_ref;');
    await run('CREATE TABLE dbo.w33_ref (id INT NOT NULL, nm NVARCHAR(60) NULL, CONSTRAINT w33_ref_pk PRIMARY KEY (id));');
    await run('CREATE TABLE dbo.w33_ui_m (id INT NOT NULL, nm NVARCHAR(60) NULL, mgr INT NULL, qty INT NULL, CONSTRAINT w33_ui_pk PRIMARY KEY (id), CONSTRAINT w33_fk FOREIGN KEY (mgr) REFERENCES dbo.w33_ref (id), CONSTRAINT w33_ck CHECK (qty >= 0));');
    await run('CREATE INDEX w33_ix ON dbo.w33_ui_m (nm);');
    await run('CREATE UNIQUE INDEX w33_uq ON dbo.w33_ui_m (nm);');
    // 回读校验：两表 / 外键 / 检查 / 索引+唯一索引
    const t = await scalar('SELECT COUNT(*) FROM sys.tables WHERE schema_id = SCHEMA_ID(\'dbo\') AND name IN (\'w33_ref\', \'w33_ui_m\');');
    const fk = await scalar('SELECT COUNT(*) FROM sys.foreign_keys WHERE name = \'w33_fk\' AND parent_object_id = OBJECT_ID(\'dbo.w33_ui_m\');');
    const ck = await scalar('SELECT COUNT(*) FROM sys.check_constraints WHERE name = \'w33_ck\' AND parent_object_id = OBJECT_ID(\'dbo.w33_ui_m\');');
    const ix = await scalar('SELECT COUNT(*) FROM sys.indexes WHERE object_id = OBJECT_ID(\'dbo.w33_ui_m\') AND name IN (\'w33_ix\', \'w33_uq\');');
    if (Number(t) !== 2 || Number(fk) !== 1 || Number(ck) !== 1 || Number(ix) !== 2) {
      throw new Error('mssql w33 回读异常 t=' + t + ' fk=' + fk + ' ck=' + ck + ' ix=' + ix);
    }
  } finally {
    conn.close();
  }
  console.log('W33 mssql: w33_ref + w33_ui_m(w33_ix, w33_uq, w33_fk, w33_ck)');
  console.log('W33-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
