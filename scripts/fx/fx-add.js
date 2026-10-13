'use strict';
// 夹具（round21 / round24 / round25）：
//  sqlite 演示库（.tmp-ud7/demo-test.db；基线仅缺失时从 demo.db 补拷，不覆盖已存在的库）：
//    dh_ix_t（id/nm/qty + 索引 dh_ix_a(nm)）—— round21 C1、round24 sqlite 侧
//    dh_det 富结构表 —— round24 E2：索引 dh_det_ix(nm)、外键 fk_0：mgr → employees(id)、
//      内联 UNIQUE(nm)（唯一键组出 sqlite_autoindex_dh_det_1）、表级 CHECK (id >= 0)、触发器 dh_det_tg
//    视图 dh_det_v（字段 id/nm）—— round24 E4
//    长表名表 dh_vd_very_long_table_name_for_header_overflow_check —— round25 V1 卡片头省略号
//  mssql master：dh_ix_t（id/nm/qty）+ 索引 dh_ix_a(nm) —— round21 C2 / round24 E5
// 幂等：表先 dropTable（首跑忽略 no such table）；视图/触发器 guarded DROP IF EXISTS 后重建。
// 运行时无 App 实例占用该库（battery 保证）。
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

const DEMO_SRC = 'D:/DataHelm/demo.db';
const DEMO_DST = 'D:/DataHelm/.tmp-ud7/demo-test.db';
const LONG_TABLE = 'dh_vd_very_long_table_name_for_header_overflow_check';

(async () => {
  // ---------- sqlite 演示库 ----------
  if (!fs.existsSync('D:/DataHelm/.tmp-ud7')) fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });
  if (!fs.existsSync(DEMO_DST)) fs.copyFileSync(DEMO_SRC, DEMO_DST);
  const c = await create({ file: DEMO_DST });
  // 单语句字面量执行；query() 把语句错误装进结果不抛，这里显式抛出
  const q = async (sqlText) => {
    const r = (await c.query({ sqlText: sqlText }))[0];
    if (r && r.command === 'ERROR') throw new Error('sqlite: ' + String(r.error));
    return r;
  };
  const dropT = async (t) => {
    try {
      await c.dropTable({ table: t });
    } catch (e) {
      if (!/no such table/i.test(String(e && e.message))) throw e; // 首跑：表尚不存在
    }
  };

  // 幂等清理（DROP TABLE 会带走表上的索引/触发器，但不动视图 → 视图单独 guarded drop）
  await dropT('dh_det');
  await dropT('dh_ix_t');
  await dropT(LONG_TABLE);
  await q('DROP VIEW IF EXISTS dh_det_v');
  await q('DROP TRIGGER IF EXISTS dh_det_tg');

  // dh_ix_t：普通表（id 主键）+ 索引 dh_ix_a（nm）
  await c.createTable({
    name: 'dh_ix_t',
    cols: [
      { name: 'id', dataType: 'INTEGER', length: '', scale: '', nullable: false, pk: true, autoInc: false, defaultValue: '', comment: '' },
      { name: 'nm', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'qty', dataType: 'INTEGER', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
    ],
    indexesAfter: [{ name: 'dh_ix_a', columns: ['nm'] }],
  });
  await c.insertRows({ table: 'dh_ix_t', columns: ['id', 'nm', 'qty'], rows: [[1, '甲', 10], [2, '乙', 20]] });

  // dh_det：富结构表。必须整条单语句 DDL —— 驱动 createTable 只内联外键/CHECK，
  // UNIQUE 走独立唯一索引，产生不了 sqlite_autoindex_*_1（唯一键组成员）。
  await q('CREATE TABLE dh_det (id INTEGER PRIMARY KEY, nm TEXT NOT NULL, mgr INTEGER, UNIQUE (nm), FOREIGN KEY (mgr) REFERENCES employees (id), CHECK (id >= 0))');
  await q('CREATE INDEX dh_det_ix ON dh_det (nm)');
  await c.insertRows({ table: 'dh_det', columns: ['id', 'nm', 'mgr'], rows: [[1, '研发组', 1], [2, '市场组', 2]] });
  // 触发器体内需合法占位语句（SELECT 1;），否则 sqlite 拒绝建触发器
  await q('CREATE TRIGGER dh_det_tg AFTER INSERT ON dh_det BEGIN SELECT 1; END');
  await q('CREATE VIEW dh_det_v AS SELECT id, nm FROM dh_det');

  // 长表名表（round25 V1：视图设计器卡片头省略号 + title 全名）
  await c.createTable({
    name: LONG_TABLE,
    cols: [
      { name: 'id', dataType: 'INTEGER', length: '', scale: '', nullable: false, pk: true, autoInc: false, defaultValue: '', comment: '' },
      { name: 'nm', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'val', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
    ],
  });
  await c.insertRows({ table: LONG_TABLE, columns: ['id', 'nm', 'val'], rows: [[1, '长名行一', 'a'], [2, '长名行二', 'b']] });

  await c.close(); // 落盘

  // ---------- mssql master：dh_ix_t + 索引 dh_ix_a ----------
  const conn = new Connection({
    server: 'localhost',
    authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
    options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
  });
  await new Promise((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve()));
    conn.connect(); // 必须显式 connect，否则静默退出
  });
  const run = (sqlText) =>
    new Promise((resolve, reject) => {
      const req = new Request(sqlText, (err, rowCount) => (err ? reject(err) : resolve(rowCount || 0)));
      conn.execSql(req);
    });
  await run("IF OBJECT_ID('dbo.dh_ix_t', 'U') IS NOT NULL DROP TABLE dbo.dh_ix_t");
  await run('CREATE TABLE dbo.dh_ix_t (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(80) NULL, qty INT NULL)');
  await run('CREATE INDEX dh_ix_a ON dbo.dh_ix_t (nm)');
  await run("INSERT INTO dbo.dh_ix_t (id, nm, qty) VALUES (1, N'甲', 10)");
  await run("INSERT INTO dbo.dh_ix_t (id, nm, qty) VALUES (2, N'乙', 20)");
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    conn.on('end', () => {
      clearTimeout(t);
      resolve();
    });
    conn.close();
  });

  console.log('ADD-OK');
})().catch((e) => {
  console.error('FX-ERR', e && e.message);
  process.exit(1);
});
