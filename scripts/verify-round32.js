'use strict';
// verify-round32：dropStructSql 方言矩阵断言（纯 SQL 生成层，不依赖数据库）
// 用法：node scripts/verify-round32.js
const U = require('../electron/services/sqlutil');

let pass = 0, fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass += 1; console.log(`  ok  ${label} -> ${a}`); }
  else { fail += 1; console.log(`  FAIL ${label}\n    expect ${b}\n    actual ${a}`); }
}
function throws(fn, label, re) {
  try { fn(); fail += 1; console.log(`  FAIL ${label}（未抛错）`); }
  catch (e) { if (!re || re.test(e.message)) { pass += 1; console.log(`  ok  ${label} -> ${e.message}`); } else { fail += 1; console.log(`  FAIL ${label} 错误信息不符: ${e.message}`); } }
}

console.log('A. mysql/mariadb（db 前缀 + DROP INDEX/FOREIGN KEY/CHECK）');
eq(U.dropStructSql('mysql', { db: 'd', table: 't', kind: 'index', name: 'i1' }), ['ALTER TABLE `d`.`t` DROP INDEX `i1`;'], 'A1 mysql 索引');
eq(U.dropStructSql('mysql', { db: 'd', table: 't', kind: 'unique', name: 'u1' }), ['ALTER TABLE `d`.`t` DROP INDEX `u1`;'], 'A2 mysql 唯一键（索引口径）');
eq(U.dropStructSql('mysql', { db: 'd', table: 't', kind: 'fkey', name: 'f1' }), ['ALTER TABLE `d`.`t` DROP FOREIGN KEY `f1`;'], 'A3 mysql 外键');
eq(U.dropStructSql('mysql', { db: 'd', table: 't', kind: 'check', name: 'c1' }), ['ALTER TABLE `d`.`t` DROP CHECK `c1`;'], 'A4 mysql 检查');
eq(U.dropStructSql('mysql', { db: 'd', table: 't', kind: 'trigger', name: 'g1' }), ['DROP TRIGGER `d`.`g1`;'], 'A5 mysql 触发器（库级）');
eq(U.dropStructSql('mariadb', { db: 'd', table: 't', kind: 'index', name: 'i1' }), ['ALTER TABLE "d"."t" DROP INDEX "i1";'], 'A6 mariadb（q() 非mysql 用双引号；实际 mariadb 连接走 mysql.js D=mysql 反引号）');

console.log('B. pg（索引 schema 级；uq/fk/ck 走 CONSTRAINT；触发器表级 ON）');
eq(U.dropStructSql('pg', { schema: 's', table: 't', kind: 'index', name: 'i1' }), ['DROP INDEX "s"."i1";'], 'B1 pg 索引');
eq(U.dropStructSql('pg', { schema: 's', table: 't', kind: 'unique', name: 'u1' }), ['ALTER TABLE "s"."t" DROP CONSTRAINT "u1";'], 'B2 pg 唯一键');
eq(U.dropStructSql('pg', { schema: 's', table: 't', kind: 'fkey', name: 'f1' }), ['ALTER TABLE "s"."t" DROP CONSTRAINT "f1";'], 'B3 pg 外键');
eq(U.dropStructSql('pg', { schema: 's', table: 't', kind: 'check', name: 'c1' }), ['ALTER TABLE "s"."t" DROP CONSTRAINT "c1";'], 'B4 pg 检查');
eq(U.dropStructSql('pg', { schema: 's', table: 't', kind: 'trigger', name: 'g1' }), ['DROP TRIGGER "g1" ON "s"."t";'], 'B5 pg 触发器（表级）');

console.log('C. mssql（索引两段名 ON 表；其余 CONSTRAINT；触发器 schema 级两段名；q() 双引号=QUOTED_IDENTIFIER 约定）');
eq(U.dropStructSql('mssql', { schema: 'dbo', table: 't', kind: 'index', name: 'i1' }), ['DROP INDEX "i1" ON "dbo"."t";'], 'C1 mssql 索引');
eq(U.dropStructSql('mssql', { schema: 'dbo', table: 't', kind: 'unique', name: 'u1' }), ['ALTER TABLE "dbo"."t" DROP CONSTRAINT "u1";'], 'C2 mssql 唯一键');
eq(U.dropStructSql('mssql', { schema: 'dbo', table: 't', kind: 'fkey', name: 'f1' }), ['ALTER TABLE "dbo"."t" DROP CONSTRAINT "f1";'], 'C3 mssql 外键');
eq(U.dropStructSql('mssql', { schema: 'dbo', table: 't', kind: 'check', name: 'c1' }), ['ALTER TABLE "dbo"."t" DROP CONSTRAINT "c1";'], 'C4 mssql 检查');
eq(U.dropStructSql('mssql', { schema: 'dbo', table: 't', kind: 'trigger', name: 'g1' }), ['DROP TRIGGER "dbo"."g1";'], 'C5 mssql 触发器');

console.log('D. sqlite（索引/唯一索引/触发器可删；外键/检查抛错引导设计器）');
eq(U.dropStructSql('sqlite', { table: 't', kind: 'index', name: 'i1' }), ['DROP INDEX "i1";'], 'D1 sqlite 索引');
eq(U.dropStructSql('sqlite', { table: 't', kind: 'unique', name: 'u1' }), ['DROP INDEX "u1";'], 'D2 sqlite 唯一键（=唯一索引）');
eq(U.dropStructSql('sqlite', { table: 't', kind: 'trigger', name: 'g1' }), ['DROP TRIGGER "g1";'], 'D3 sqlite 触发器');
throws(() => U.dropStructSql('sqlite', { table: 't', kind: 'fkey', name: 'f1' }), 'D4 sqlite 外键抛错', /重建表/);
throws(() => U.dropStructSql('sqlite', { table: 't', kind: 'check', name: 'c1' }), 'D5 sqlite 检查抛错', /重建表/);

console.log('E. oracle（索引/触发器 schema 级；uq/fk/ck 走 CONSTRAINT）');
eq(U.dropStructSql('oracle', { schema: 'S', table: 'T', kind: 'index', name: 'I1' }), ['DROP INDEX "S"."I1";'], 'E1 oracle 索引');
eq(U.dropStructSql('oracle', { schema: 'S', table: 'T', kind: 'unique', name: 'U1' }), ['ALTER TABLE "S"."T" DROP CONSTRAINT "U1";'], 'E2 oracle 唯一键');
eq(U.dropStructSql('oracle', { schema: 'S', table: 'T', kind: 'fkey', name: 'F1' }), ['ALTER TABLE "S"."T" DROP CONSTRAINT "F1";'], 'E3 oracle 外键');
eq(U.dropStructSql('oracle', { schema: 'S', table: 'T', kind: 'check', name: 'C1' }), ['ALTER TABLE "S"."T" DROP CONSTRAINT "C1";'], 'E4 oracle 检查');
eq(U.dropStructSql('oracle', { schema: 'S', table: 'T', kind: 'trigger', name: 'G1' }), ['DROP TRIGGER "S"."G1";'], 'E5 oracle 触发器');

console.log('F. 边界：未知方言');
throws(() => U.dropStructSql('mongo', { table: 't', kind: 'index', name: 'i' }), 'F1 mongo 抛错', /不支持/);

console.log(`\n结果：${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
