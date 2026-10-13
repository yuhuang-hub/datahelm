'use strict';
// 永久夹具 · round46（树分组右键新建 + 收展悬浮修复）— 消费方 scripts/verify-round46-ui.js
// mssql master.dbo：
//   w46_ref(rid PK, code)（父表）+ w46_ui_m(id PK, nm, ref_id)（子表，恰好 1 条外键 w46_fk → w46_ref(rid)）
//   U8b 断言 w46_ui_m 外键分区 = w46_fk 1 条 + 新空行 = 2 行 → 子表外键数必须恰好 1。
// sqlite D:/DataHelm/.tmp-ud7/demo-test.db：
//   套件 U1-U7 全部作用于基线表 employees（字段/索引/外键/唯一键/检查/触发器 分组），无需专用 w46 表，
//   仅做 employees 缺失兜底（不重置既有基线）。
// 幂等：子表（含外键）先 drop，再父表（OBJECT_ID 守卫）。
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
  // ---- sqlite 侧：employees 基线兜底（U1-U7 的宿主表）----
  const c = await create({ file: 'D:/DataHelm/.tmp-ud7/demo-test.db' });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  if (!(await c.tables()).includes('employees')) {
    await c.createTable({
      name: 'employees',
      cols: [
        { name: 'id', dataType: 'INTEGER', nullable: false, pk: true, autoInc: true },
        { name: 'name', dataType: 'TEXT', nullable: false },
        { name: 'dept', dataType: 'VARCHAR', length: 80, nullable: true, defaultValue: "'研发'" },
        { name: 'salary', dataType: 'DECIMAL', length: 10, scale: 2, nullable: true },
        { name: 'hired', dataType: 'DATE', nullable: true },
      ],
    });
    await c.insertRows({
      table: 'employees',
      columns: ['id', 'name', 'dept', 'salary', 'hired'],
      rows: [
        [1, '张三', '研发', 15000.5, '2023-01-15'],
        [2, '李四', '运维', 12000, '2022-11-01'],
        [3, '王五', '测试', null, '2024-03-20'],
        [4, '赵六', '研发', 18000.75, '2021-06-01'],
      ],
    });
    console.log('FX employees 缺失，已补基线');
  } else {
    const n = await q('SELECT COUNT(*) AS n FROM employees');
    if (!n.rows || n.rows[0][0] === 0) {
      await c.insertRows({
        table: 'employees',
        columns: ['id', 'name', 'dept', 'salary', 'hired'],
        rows: [
          [1, '张三', '研发', 15000.5, '2023-01-15'],
          [2, '李四', '运维', 12000, '2022-11-01'],
          [3, '王五', '测试', null, '2024-03-20'],
          [4, '赵六', '研发', 18000.75, '2021-06-01'],
        ],
      });
      console.log('FX employees 空表，已补基线行');
    }
  }
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

  // 幂等清理：子表（含 FK）先删，父表后删
  await mssqlRun(conn, "IF OBJECT_ID(N'dbo.w46_ui_m', N'U') IS NOT NULL DROP TABLE dbo.w46_ui_m");
  await mssqlRun(conn, "IF OBJECT_ID(N'dbo.w46_ref', N'U') IS NOT NULL DROP TABLE dbo.w46_ref");

  await mssqlRun(conn, 'CREATE TABLE dbo.w46_ref (rid INT NOT NULL CONSTRAINT pk_w46_ref PRIMARY KEY, code NVARCHAR(20) NULL)');
  await mssqlRun(conn, 'CREATE TABLE dbo.w46_ui_m (id INT NOT NULL CONSTRAINT pk_w46_ui_m PRIMARY KEY, nm NVARCHAR(50) NULL, ref_id INT NULL CONSTRAINT w46_fk FOREIGN KEY REFERENCES dbo.w46_ref (rid))');
  await mssqlRun(conn, "INSERT INTO dbo.w46_ref (rid, code) VALUES (1, N'R1')");
  await mssqlRun(conn, "INSERT INTO dbo.w46_ref (rid, code) VALUES (2, N'R2')");
  await mssqlRun(conn, "INSERT INTO dbo.w46_ui_m (id, nm, ref_id) VALUES (1, N'子1', 1)");
  await mssqlRun(conn, "INSERT INTO dbo.w46_ui_m (id, nm, ref_id) VALUES (2, N'子2', NULL)");

  // 回读校验：子表外键必须恰好 1 条且名为 w46_fk（U8b 期望 外键分区 2 行 = 1 FK + 新空行）
  const fks = await mssqlAsk(conn, "SELECT name FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID(N'dbo.w46_ui_m')");
  if (fks.length !== 1 || String(fks[0][0]).trim() !== 'w46_fk') {
    throw new Error('w46_ui_m 外键不为恰好 1 条 w46_fk: ' + JSON.stringify(fks));
  }
  const childRows = await mssqlAsk(conn, 'SELECT COUNT(*) AS n FROM dbo.w46_ui_m');
  if (String(childRows[0][0]) !== '2') throw new Error('w46_ui_m 行数不为 2');
  console.log('FX mssql w46_ref(2 行) + w46_ui_m(2 行, FK w46_fk) 就绪');
  conn.close();

  console.log('W46-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
