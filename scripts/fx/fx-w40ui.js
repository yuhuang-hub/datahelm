'use strict';
// 永久夹具 · round40（对象树过滤）— 消费方 scripts/verify-round40-ui.js
// sqlite D:/DataHelm/.tmp-ud7/demo-test.db：
//   表 w40_alpha(id/nm40/qty) / w40_beta(id/tag) / w40_gamma(id/lbl) + 视图 w40_alpha_v(id, nm40)
//   - T1 前缀 w40_：三表可见 / employees 隐藏；T2 employ 只命中 employees（列名不含 employ）
//   - T3 大小写 W40_AL；T4 w40_alpha 命中 表 + 视图 w40_alpha_v；T5 zzz 无命中
//   - T7 字段级 nm40：仅 w40_alpha 有列 nm40（beta/gamma 列名刻意避开）
//   基线 employees 只做缺失兜底，不重置既有库（套件不校验全表清单）。
// 幂等：视图 DROP IF EXISTS；表存在则先走驱动 dropTable 再重建。
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');

(async () => {
  const c = await create({ file: 'D:/DataHelm/.tmp-ud7/demo-test.db' });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];

  // 基线兜底：employees 缺失才补（列/行与 .tmp-ud7 基线一致）
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
  }

  // 清旧（幂等）：先视图后表
  await q('DROP VIEW IF EXISTS w40_alpha_v');
  const have = await c.tables();
  for (const t of ['w40_alpha', 'w40_beta', 'w40_gamma']) {
    if (have.includes(t)) await c.dropTable({ table: t });
  }

  // 三张 w40_ 前缀表：命中 前缀/大小写/表+视图同名前缀/无命中 各过滤用例
  await c.createTable({
    name: 'w40_alpha',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'nm40', dataType: 'VARCHAR', length: 60, nullable: false },
      { name: 'qty', dataType: 'INTEGER', nullable: true },
    ],
  });
  await c.createTable({
    name: 'w40_beta',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'tag', dataType: 'VARCHAR', length: 40, nullable: true },
    ],
  });
  await c.createTable({
    name: 'w40_gamma',
    cols: [
      { name: 'id', dataType: 'INTEGER', nullable: false, pk: true },
      { name: 'lbl', dataType: 'VARCHAR', length: 40, nullable: true },
    ],
  });
  await c.insertRows({ table: 'w40_alpha', columns: ['id', 'nm40', 'qty'], rows: [[1, 'a1', 10], [2, 'a2', 20]] });
  await c.insertRows({ table: 'w40_beta', columns: ['id', 'tag'], rows: [[1, 'b1'], [2, 'b2']] });
  await c.insertRows({ table: 'w40_gamma', columns: ['id', 'lbl'], rows: [[1, 'g1'], [2, 'g2']] });

  // 视图：名字含 w40_alpha（T4 过滤时与表同时命中）
  await q('CREATE VIEW w40_alpha_v AS SELECT id, nm40 FROM w40_alpha');

  // 回读校验：恰好 4 个 w40_ 对象（三表 + 一视图）
  const om = await q("SELECT type, name FROM sqlite_master WHERE name LIKE 'w40_%' ORDER BY type, name");
  if (!om || om.command !== 'SELECT' || !Array.isArray(om.rows) || om.rows.length !== 4) {
    throw new Error('w40 对象数不为 4: ' + JSON.stringify(om && om.rows));
  }
  const na = await q('SELECT COUNT(*) AS n FROM w40_alpha');
  if (!na.rows || na.rows[0][0] !== 2) throw new Error('w40_alpha 行数不为 2');
  console.log('FX w40 objects:', JSON.stringify(om.rows));

  await c.close();
  console.log('W40-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
