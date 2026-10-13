'use strict';
// DataHelm 后端自测：sqlutil 单元断言 + SQLite 驱动端到端，其余驱动做加载检查
const assert = (c, m) => {
  if (!c) throw new Error('断言失败: ' + m);
  console.log('  ✓', m);
};

const U = require('../electron/services/sqlutil');
require('../electron/services/connections');
require('../electron/services/db/mysql');
require('../electron/services/db/postgres');
require('../electron/services/db/mssql');
require('../electron/services/db/mongo');
require('../electron/services/db/redis');
require('../electron/services/db/oracle');
require('../electron/services/queries');
require('../electron/services/csv');
require('../electron/services/tunnel');
console.log('✓ 驱动模块全部可加载（含 oracle thin / queries / backup 服务）');
require('../electron/services/backup');

// ---- sqlutil ----
{
  const parts = U.splitStatements("SELECT 1; -- 注释; 分号\nSELECT 'a;b' AS x; /* 块;注释 */ SELECT 2\nGO\nSELECT 3");
  assert(parts.length === 4, `语句切分 (${parts.length})`);
  assert(U.splitStatements('SELECT $$a;b$$; SELECT 2').length === 2, 'PG $$ 文本');
  assert(U.q('mysql', 'a`b') === '`a``b`', 'mysql 标识符转义');
  assert(U.q('pg', 'a"b') === '"a""b"', 'pg 标识符转义');
  assert(U.lit('mysql', "a'b\\c") === "'a''b\\\\c'", 'mysql 字面量转义');
  assert(U.lit('pg', "a'b") === "'a''b'", 'pg 字面量转义');
  assert(U.lit('mssql', null) === 'NULL', 'NULL 字面量');
  const stmts = U.buildChangeSql('mysql', 'd', null, 't', {
    columns: [{ name: 'id', pk: true }, { name: 'n' }],
    deletes: [{ row: { id: 3, n: 'x' } }],
    updates: [{ row: { id: 1, n: 'old' }, set: { n: 'new' } }],
    inserts: [{ id: null, n: "O'Neil" }],
  });
  assert(stmts.length === 3 && stmts[0].sql.includes('DELETE FROM `d`.`t` WHERE `id`=?') && stmts[0].params[0] === 3, 'DELETE 参数化');
  assert(stmts[1].sql.includes('SET `n`=? WHERE `id`=?') && stmts[1].params.join(',') === 'new,1', 'UPDATE 参数化');
  assert(stmts[2].sql.includes('VALUES (?, ?)') && stmts[2].params[1] === "O'Neil", 'INSERT 参数化');
  assert(U.buildChangeSql('pg', null, null, 't', { columns: [{ name: 'id', pk: true }], inserts: [{ id: 5 }] })[0].sql.includes('$1'), 'pg 占位符');
  assert(U.buildChangeSql('oracle', null, 'S', 't', { columns: [{ name: 'id', pk: true }], inserts: [{ id: 5 }] })[0].sql.includes('VALUES (:1)'), 'oracle 占位符');
  assert(U.fullType({ dataType: 'VARCHAR', length: 50 }, 'oracle') === 'VARCHAR2(50)', 'oracle 类型映射');
  assert(U.fullType({ dataType: 'INTEGER' }, 'oracle') === 'NUMBER(10)', 'oracle 整型映射');
  // MySQL 存储过程脚本：DELIMITER 切分（体内分号不切）
  const routine = U.splitStatements(
    "DROP PROCEDURE IF EXISTS p1;\nDELIMITER ;;\nCREATE PROCEDURE p1()\nBEGIN\n  SELECT 1;\n  SELECT 'x;y';\nEND;;\nDELIMITER ;\nSELECT 2;"
  );
  assert(routine.length === 3 && /BEGIN[\s\S]*SELECT 1;[\s\S]*END/.test(routine[1]) && routine[2] === 'SELECT 2', `DELIMITER 语句切分 (${routine.length})`);
}

// ---- SQLite 端到端 ----
(async () => {
  const os = require('os');
  const path = require('path');
  const fs = require('fs');
  const sqlite = require('../electron/services/db/sqlite');

  const file = path.join(os.tmpdir(), `datahelm_test_${Date.now()}.db`);
  const s = await sqlite.create({ file });
  console.log('✓ SQLite 会话:', s.serverInfo);

  const root = await s.treeRoot();
  assert(root.length === 3 && root[0].name === '表' && root[2].name === '触发器', '对象树根节点（表/视图/触发器）');

  await s.query("CREATE TABLE t1 (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price REAL, created TEXT);");
  await s.query("INSERT INTO t1(name, price, created) VALUES ('a''b', 1.5, '2024-01-01'), ('b2', 2, NULL);");

  const cols = await s.columns({ table: 't1' });
  assert(cols.length === 4 && cols[0].pk && cols[0].autoInc, 'columns 元数据（主键/自增）');
  assert(cols[1].nullable === false, 'NOT NULL 识别');

  const p = await s.page({ table: 't1', pageNo: 1, pageSize: 10 });
  assert(p.total === 2 && p.rows.length === 2 && p.rows[0][1] === "a'b" && p.rows[1][3] === null, '分页查询与转义回读');

  const q = await s.query('SELECT * FROM t1; SELECT COUNT(*) FROM t1;');
  assert(q.length === 2 && q[1].rows[0][0] === 2, '多语句多结果集');

  const ch = await s.changes({
    table: 't1',
    columns: cols,
    updates: [{ row: { id: 2, name: 'b2', price: 2, created: null }, set: { name: 'zz' } }],
    inserts: [{ id: null, name: 'new', price: 9.9, created: null }],
    deletes: [],
  });
  assert(ch.executed === 2, 'changes 生成 2 条 SQL');
  const after = await s.page({ table: 't1', pageNo: 1, pageSize: 10 });
  assert(after.total === 3, '变更后行数');

  const ddl = await s.ddl({ table: 't1' });
  assert(/CREATE TABLE/i.test(ddl), 'DDL 读取');

  // 设计器：重命名列 + 删列 + 新增列 -> 触发重建表
  const norm = (m) => U.normCol(m);
  const afterCols = [
    { ...norm(cols[0]) },
    { ...norm(cols[1]), name: 'name2', origName: 'name' },
    { ...norm(cols[3]) },
    { name: 'extra', dataType: 'VARCHAR', length: 50, scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '', origName: '' },
  ];
  const script = await s.alterScript({ table: 't1', newName: '', before: cols, after: afterCols });
  assert(script.some((x) => /__rebuild/.test(x)), '重建表脚本生成');
  await s.applyAlter({ table: 't1', newName: '', before: cols, after: afterCols });
  const cols2 = await s.columns({ table: 't1' });
  assert(cols2.map((c) => c.name).join(',') === 'id,name2,created,extra', `重建后列: ${cols2.map((c) => c.name).join(',')}`);
  const kept = await s.page({ table: 't1', pageNo: 1, pageSize: 10 });
  assert(kept.total === 3 && kept.rows[1][1] === 'zz', '重建后数据保留');

  // 重命名表
  await s.renameTable({ table: 't1', newName: 't1_r' });
  const tbs = await s.tables();
  assert(tbs.includes('t1_r'), '重命名表');

  // 视图/触发器：对象 DDL + 删除 + dump 导出
  await s.query('CREATE VIEW v1 AS SELECT id, name2 FROM t1_r;');
  const vddl = await s.objectDdl({ kind: 'view', name: 'v1' });
  assert(/CREATE VIEW/i.test(vddl), '视图 DDL');
  const dump = await s.dumpTable({ table: 't1_r' });
  assert(/CREATE TABLE/i.test(dump) && (dump.match(/INSERT INTO/g) || []).length === 3, `dump 导出（3 行 INSERT）`);
  await s.dropObject({ kind: 'view', name: 'v1' });
  const vcats = await s.treeChildren({ type: 'cat', kind: 'view' });
  assert(!vcats.some((x) => x.name === 'v1'), '删除视图');

  s.close();
  fs.rmSync(file, { force: true });
  console.log('\n全部自测通过 ✅');
})().catch((e) => {
  console.error('\n自测失败 ❌', e);
  process.exitCode = 1; // 不用 process.exit：sql.js 下显式退出会触发 libuv 断言
});
