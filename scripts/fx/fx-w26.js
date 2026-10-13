'use strict';
// 夹具（round26 树两级展开 / 宽表 / 视图设计器）：自带重置 —— 先把 demo-test.db 覆拷回
// demo.db 基线（employees：id INTEGER 主键 / name TEXT / dept VARCHAR(80) / salary
// DECIMAL(10,2) / hired DATE，T1c 断言），再建：
//   dh_w26_t：15 列宽表（id + c1..c14，全部字面列定义）—— D2 行高/滚动、V2 卡片 15 复选框
//   dh_w26_rich：富结构表 —— T4 五分组：索引 dh_w26_rix、唯一键 sqlite_autoindex_dh_w26_rich_1
//     （内联 UNIQUE 才产生 sqlite_autoindex，驱动 createTable 做不到）、外键 fk_0（mgr → employees(id)、
//     驱动 fkeys() 按列表 id 合成名）、检查 CHECK_1（表级 CHECK，界面按序号合成名）、触发器 dh_w26_rtg
//   base_data_containmtlcarel：长表名 —— V1 侧栏「已添加」不折行 + 表名省略号
// 幂等：重置后 dropTable（首跑忽略 no such table）+ 触发器 guarded DROP IF EXISTS。
// 运行时无 App 实例占用该库（battery 保证）。
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');

const DEMO_SRC = 'D:/DataHelm/demo.db';
const DEMO_DST = 'D:/DataHelm/.tmp-ud7/demo-test.db';
const LONG_TABLE = 'base_data_containmtlcarel';

(async () => {
  if (!fs.existsSync('D:/DataHelm/.tmp-ud7')) fs.mkdirSync('D:/DataHelm/.tmp-ud7', { recursive: true });
  fs.copyFileSync(DEMO_SRC, DEMO_DST); // 本夹具自带重置：回到 employees 基线
  const c = await create({ file: DEMO_DST });
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

  await dropT('dh_w26_t');
  await dropT('dh_w26_rich');
  await dropT(LONG_TABLE);
  await q('DROP TRIGGER IF EXISTS dh_w26_rtg');

  // dh_w26_t：15 列（id + c1..c14），列定义逐条字面量（不用循环拼 CREATE）
  await c.createTable({
    name: 'dh_w26_t',
    cols: [
      { name: 'id', dataType: 'INTEGER', length: '', scale: '', nullable: false, pk: true, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c1', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c2', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c3', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c4', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c5', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c6', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c7', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c8', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c9', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c10', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c11', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c12', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c13', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'c14', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
    ],
  });
  await c.insertRows({
    table: 'dh_w26_t',
    columns: ['id', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13', 'c14'],
    rows: [
      [1, 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10', 'v11', 'v12', 'v13', 'v14'],
      [2, 'w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9', 'w10', 'w11', 'w12', 'w13', 'w14'],
    ],
  });

  // dh_w26_rich：富结构表 —— 整条单语句 DDL（内联 UNIQUE 才有 sqlite_autoindex_dh_w26_rich_1）
  await q('CREATE TABLE dh_w26_rich (id INTEGER PRIMARY KEY, nm TEXT NOT NULL, mgr INTEGER, val REAL, UNIQUE (nm), FOREIGN KEY (mgr) REFERENCES employees (id), CHECK (id >= 0))');
  await q('CREATE INDEX dh_w26_rix ON dh_w26_rich (nm)');
  // 触发器体内需合法占位语句（SELECT 1;）
  await q('CREATE TRIGGER dh_w26_rtg AFTER INSERT ON dh_w26_rich BEGIN SELECT 1; END');
  await c.insertRows({ table: 'dh_w26_rich', columns: ['id', 'nm', 'mgr', 'val'], rows: [[1, '甲', 1, 1.5], [2, '乙', 2, 2.5]] });

  // 长表名表（V1 侧栏行）
  await c.createTable({
    name: LONG_TABLE,
    cols: [
      { name: 'id', dataType: 'INTEGER', length: '', scale: '', nullable: false, pk: true, autoInc: false, defaultValue: '', comment: '' },
      { name: 'nm', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
      { name: 'val', dataType: 'TEXT', length: '', scale: '', nullable: true, pk: false, autoInc: false, defaultValue: '', comment: '' },
    ],
  });
  await c.insertRows({ table: LONG_TABLE, columns: ['id', 'nm', 'val'], rows: [[1, '长名甲', 'a'], [2, '长名乙', 'b']] });

  await c.close(); // 落盘
  console.log('W26-OK');
})().catch((e) => {
  console.error('FX-ERR', e && e.message);
  process.exit(1);
});
