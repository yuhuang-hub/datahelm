'use strict';
// 永久夹具 · round41（数据页多行复制）— 消费方 scripts/verify-round41-ui.js
// sqlite D:/DataHelm/.tmp-ud7/demo-test.db：
//   w41_cp(id/nm/qty) 4 行边界值——甲 / Bob's "quote", comma（单引号+双引号+逗号）/ NULL / line1\nline2（换行）
//   视图 w41_cp_v 恰好 2 列（id, nm）4 行，首行 (1, 甲)（T6/T7 勾选首行复制精确匹配）
// mssql master.dbo：
//   w41_cp_m(id INT / nm NVARCHAR / qty INT) 2 行：(1, 甲, 10)、(2, Beta, 20)（T8 INSERT 精确匹配）
// 幂等：视图 DROP IF EXISTS；表存在先 drop 再建（OBJECT_ID 守卫）。
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
const tedious = require('D:/DataHelm/node_modules/tedious');

const mssqlRun = (conn, sqlText) => new Promise((resolve, reject) => {
  const req = new tedious.Request(sqlText, (err, rowCount) => {
    if (err) {
      const agg = err && Array.isArray(err.errors) && err.errors.length ? err.errors.map((x) => x.message || String(x)).join('; ') : '';
      reject(new Error(agg || (err && err.message) || String(err)));
      return;
    }
    resolve(rowCount || 0);
  });
  conn.execSql(req);
});
const mssqlAsk = (conn, sqlText) => new Promise((resolve, reject) => {
  const rows = [];
  const req = new tedious.Request(sqlText, (err) => {
    if (err) {
      const agg = err && Array.isArray(err.errors) && err.errors.length ? err.errors.map((x) => x.message || String(x)).join('; ') : '';
      reject(new Error(agg || (err && err.message) || String(err)));
      return;
    }
    resolve(rows);
  });
  req.on('row', (cols) => { rows.push(cols.map((col) => col.value)); }); // 行为列对象数组，取 c.value
  conn.execSql(req);
});

(async () => {
  // ---- sqlite 侧 ----
  const c = await create({ file: 'D:/DataHelm/.tmp-ud7/demo-test.db' });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];

  await q('DROP VIEW IF EXISTS w41_cp_v');
  if ((await c.tables()).includes('w41_cp')) await c.dropTable({ table: 'w41_cp' });

  await c.createTable({
    name: 'w41_cp',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'nm', dataType: 'TEXT', nullable: true },
      { name: 'qty', dataType: 'INTEGER', nullable: true },
    ],
  });
  // 顺序插入：数据页无排序时按 rowid 序展示，行序 1..4 与套件勾选(0/2/3 与 1/2)一致
  await c.insertRows({
    table: 'w41_cp',
    columns: ['id', 'nm', 'qty'],
    rows: [
      [1, '甲', 10],
      [2, 'Bob\'s "quote", comma', 20],
      [3, null, 30],
      [4, 'line1\nline2', 40],
    ],
  });
  await q('CREATE VIEW w41_cp_v AS SELECT id, nm FROM w41_cp');

  const cnt = await q('SELECT COUNT(*) AS n FROM w41_cp');
  if (!cnt.rows || cnt.rows[0][0] !== 4) throw new Error('w41_cp 行数不为 4');
  const vpeek = await q('SELECT id, nm FROM w41_cp_v LIMIT 1');
  if (!vpeek.columns || vpeek.columns.length !== 2) throw new Error('w41_cp_v 列数不为 2: ' + JSON.stringify(vpeek.columns));
  if (String(vpeek.rows[0][0]) !== '1' || vpeek.rows[0][1] !== '甲') throw new Error('w41_cp_v 首行不为 (1, 甲)');
  const nullRow = await q('SELECT nm IS NULL AS null_flag FROM w41_cp WHERE id = 3');
  if (!nullRow.rows || nullRow.rows[0][0] !== 1) throw new Error('w41_cp id=3 的 nm 不为 NULL');
  console.log('FX sqlite w41_cp 4 行 + w41_cp_v 2 列 就绪');
  await c.close();

  // ---- mssql 侧（显式 connect，否则静默退出 0）----
  const conn = await new Promise((resolve, reject) => {
    const cc = new tedious.Connection({
      server: 'localhost',
      authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
      options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
    });
    cc.on('connect', (err) => (err ? reject(err) : resolve(cc)));
    cc.on('error', (e) => reject(e));
    cc.connect();
  });

  await mssqlRun(conn, "IF OBJECT_ID(N'dbo.w41_cp_m', N'U') IS NOT NULL DROP TABLE dbo.w41_cp_m");
  await mssqlRun(conn, 'CREATE TABLE dbo.w41_cp_m (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(100) NULL, qty INT NULL)');
  await mssqlRun(conn, "INSERT INTO dbo.w41_cp_m (id, nm, qty) VALUES (1, N'甲', 10)");
  await mssqlRun(conn, "INSERT INTO dbo.w41_cp_m (id, nm, qty) VALUES (2, N'Beta', 20)");

  const mrows = await mssqlAsk(conn, 'SELECT id, nm, qty FROM dbo.w41_cp_m ORDER BY id');
  if (mrows.length !== 2) throw new Error('w41_cp_m 行数不为 2: ' + JSON.stringify(mrows));
  if (String(mrows[0][0]) !== '1' || String(mrows[0][1]).trim() !== '甲' || String(mrows[0][2]) !== '10') throw new Error('w41_cp_m 第 1 行不符: ' + JSON.stringify(mrows[0]));
  if (String(mrows[1][0]) !== '2' || String(mrows[1][1]).trim() !== 'Beta' || String(mrows[1][2]) !== '20') throw new Error('w41_cp_m 第 2 行不符: ' + JSON.stringify(mrows[1]));
  console.log('FX mssql w41_cp_m 2 行就绪');
  conn.close();

  console.log('W41-OK');
  // sql.js 的 async handle 关闭是异步的：立即退出触发 UV_HANDLE_CLOSING 断言（Windows）——等一拍再显式退
  await new Promise((r) => setTimeout(r, 200));
  process.exit(0);
})().catch(async (e) => { console.error('FX-ERR', e && e.message); await new Promise((r) => setTimeout(r, 200)); process.exit(1); });
