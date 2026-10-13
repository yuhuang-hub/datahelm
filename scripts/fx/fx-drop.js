'use strict';
// 电池收尾清理：drop 各轮套件在 sqlite demo-test.db 与 mssql master.dbo 创建过的全部测试对象，
// 然后 LEFT-报告两侧残留。幂等（对象已不存在 = IF EXISTS/IF OBJECT_ID 静默跳过）。
// w48_t001..060 / w48_extra 由电池在 fx-drop 之前单独跑 "node scripts/fx/fx-w48.js cleanup"，本脚本不处理。
// employees（sqlite）是基线表：不删不建；若某轮删了它，下一阶段前的 fx-reset 会恢复。
// DeleteLog / Login 是环境预置表（round44 补全计数依赖）：不删，且从 MSSQL-LEFT 中排除。
const fs = require('fs');

// ---------------- sqlite 侧 ----------------
async function sqliteSide() {
  if (!fs.existsSync('D:/DataHelm/.tmp-ud7/demo-test.db')) {
    console.log('SQLITE-LEFT ' + JSON.stringify([]));
    return;
  }
  const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');
  const c = await create({ file: 'D:/DataHelm/.tmp-ud7/demo-test.db' });
  const q = async (sqlText) => (await c.query({ sqlText: sqlText }))[0];
  // 每个对象一个 try/catch，入参必须是完整单语句字面量（禁止拼接进 sqlText）
  const drop = async (sqlText) => {
    try {
      const r = await q(sqlText);
      if (r && r.command === 'ERROR') console.log('SQLITE-WARN ' + String(r.error));
    } catch (e) {
      console.log('SQLITE-WARN ' + String(e && e.message ? e.message : e));
    }
  };
  const onePass = async () => {
    // 触发器（挂 employees/det 等表上的独立对象，须先于表删）
    await drop('DROP TRIGGER IF EXISTS trig_employees_1');
    await drop('DROP TRIGGER IF EXISTS dh_det_tg');
    await drop('DROP TRIGGER IF EXISTS dh_w26_rtg');
    await drop('DROP TRIGGER IF EXISTS w33_tg');
    // 视图
    await drop('DROP VIEW IF EXISTS dh_vd_v1');
    await drop('DROP VIEW IF EXISTS dh_vd_v2');
    await drop('DROP VIEW IF EXISTS dh_det_v');
    await drop('DROP VIEW IF EXISTS w40_alpha_v');
    await drop('DROP VIEW IF EXISTS w41_cp_v');
    // 索引（挂在 employees 上的必须显式删；挂在本脚本要删的表上的顺带先删一遍）
    await drop('DROP INDEX IF EXISTS idx_emp_name');
    await drop('DROP INDEX IF EXISTS idx_dir');
    await drop('DROP INDEX IF EXISTS dh_ix_a');
    await drop('DROP INDEX IF EXISTS dh_det_ix');
    await drop('DROP INDEX IF EXISTS dh_w26_rix');
    await drop('DROP INDEX IF EXISTS dh_w27_ix');
    await drop('DROP INDEX IF EXISTS dh_w27_mix');
    await drop('DROP INDEX IF EXISTS dh_w27_mix2');
    await drop('DROP INDEX IF EXISTS dh_w31_ix1');
    await drop('DROP INDEX IF EXISTS w32_ix');
    await drop('DROP INDEX IF EXISTS w32_uq');
    await drop('DROP INDEX IF EXISTS w33_ix');
    await drop('DROP INDEX IF EXISTS w33_uq');
    await drop('DROP INDEX IF EXISTS w34_ix');
    // 表（子表在前，两遍扫描兜底 FK 顺序）
    await drop('DROP TABLE IF EXISTS dh_vd_emp');
    await drop('DROP TABLE IF EXISTS dh_vd_dept');
    await drop('DROP TABLE IF EXISTS dh_det');
    await drop('DROP TABLE IF EXISTS dh_ix_t');
    await drop('DROP TABLE IF EXISTS dh_vd_very_long_table_name_for_header_overflow_check');
    await drop('DROP TABLE IF EXISTS base_data_containmtlcarel');
    await drop('DROP TABLE IF EXISTS dh_w26_t');
    await drop('DROP TABLE IF EXISTS dh_w26_rich');
    await drop('DROP TABLE IF EXISTS dh_w27_a');
    await drop('DROP TABLE IF EXISTS dh_w27_b');
    await drop('DROP TABLE IF EXISTS dh_w27_m');
    await drop('DROP TABLE IF EXISTS dh_w27_m2');
    await drop('DROP TABLE IF EXISTS dh_w28_t');
    await drop('DROP TABLE IF EXISTS dh_w28_nopk');
    await drop('DROP TABLE IF EXISTS dh_w29_t');
    await drop('DROP TABLE IF EXISTS dh_w31_t');
    await drop('DROP TABLE IF EXISTS dh_src_emp');
    await drop('DROP TABLE IF EXISTS dh_w30_t');
    await drop('DROP TABLE IF EXISTS w32_ui');
    await drop('DROP TABLE IF EXISTS w33_ui');
    await drop('DROP TABLE IF EXISTS w34_col');
    await drop('DROP TABLE IF EXISTS dh_imp_t1');
    await drop('DROP TABLE IF EXISTS dh_imp_j1');
    await drop('DROP TABLE IF EXISTS w40_alpha');
    await drop('DROP TABLE IF EXISTS w40_beta');
    await drop('DROP TABLE IF EXISTS w40_gamma');
    await drop('DROP TABLE IF EXISTS w41_cp');
    await drop('DROP TABLE IF EXISTS employees__rebuild');
  };
  await onePass();
  await onePass();
  // LEFT 报告：只信 live sqlite_master（.db 文件二进制里的名字是已释放页的幽灵字节）。
  // 别用 LIKE 'sqlite[_]%'——方括号转义是 MSSQL 语法，SQLite LIKE 里是字面三字符（恒不匹配）
  const r = await q('SELECT type, name FROM sqlite_master WHERE substr(name, 1, 7) != \'sqlite_\' AND name != \'employees\' ORDER BY type, name');
  const left = (r && r.rows ? r.rows : []).map((row) => ({ type: row[0], name: row[1] }));
  console.log('SQLITE-LEFT ' + JSON.stringify(left));
  await c.close();
}

// ---------------- mssql 侧 ----------------
function mssqlSide() {
  return new Promise((resolve) => {
    const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');
    const cfg = {
      server: 'localhost',
      port: 1433,
      authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
      options: { database: 'master', trustServerCertificate: true, encrypt: false },
    };
    const conn = new Connection(cfg);
    // 只能在 requestCompleted 回调里 resolve（提前 resolve 会与 row 事件竞态）
    const runSql = (sql, onRow) => new Promise((res) => {
      const req = new Request(sql, (err) => {
        if (err) console.log('MSSQL-WARN ' + String(err && err.message ? err.message : err));
        res();
      });
      if (onRow) req.on('row', onRow);
      conn.execSql(req);
    });
    const drop = (sql) => runSql(sql, null);
    const onePass = async () => {
      // 触发器 / 视图
      await drop('IF OBJECT_ID(\'dbo.trig_dh_r11_1\', \'TR\') IS NOT NULL DROP TRIGGER dbo.trig_dh_r11_1;');
      await drop('IF OBJECT_ID(\'dbo.dh_vd_v2\', \'V\') IS NOT NULL DROP VIEW dbo.dh_vd_v2;');
      // 表：子表在前（fk 在子表上），两遍扫描兜底 FK 顺序
      await drop('IF OBJECT_ID(\'dbo.w55_reo__rebuild\', \'U\') IS NOT NULL DROP TABLE dbo.w55_reo__rebuild;');
      await drop('IF OBJECT_ID(\'dbo.w55_reo\', \'U\') IS NOT NULL DROP TABLE dbo.w55_reo;');
      // round56 独立库（连接 master，先删库内对象再整库删；库不存在的分支静默通过。
      // USE 的目标库在批编译期解析，IF 守卫挡不住告警——须 EXEC 动态执行）
      await drop('IF DB_ID(N\'dh_w56\') IS NOT NULL EXEC(N\'USE dh_w56\');');
      await drop('IF OBJECT_ID(N\'platform.arrival_notice_detail\', N\'U\') IS NOT NULL DROP TABLE platform.arrival_notice_detail;');
      await drop('IF OBJECT_ID(N\'dbo.w56_dbo_t\', N\'U\') IS NOT NULL DROP TABLE dbo.w56_dbo_t;');
      await drop('IF SCHEMA_ID(N\'platform\') IS NOT NULL DROP SCHEMA platform;');
      await drop('USE master;');
      await drop('IF DB_ID(N\'dh_w56\') IS NOT NULL DROP DATABASE dh_w56;');
      // round57 独立库（连接 master，直接整库删；库不存在的分支静默通过）
      await drop('IF DB_ID(N\'dh_w57\') IS NOT NULL DROP DATABASE dh_w57;');
      await drop('IF OBJECT_ID(\'dbo.dh_test\', \'U\') IS NOT NULL DROP TABLE dbo.dh_test;');
      await drop('IF OBJECT_ID(\'dbo.dh_vd_b\', \'U\') IS NOT NULL DROP TABLE dbo.dh_vd_b;');
      await drop('IF OBJECT_ID(\'dbo.dh_er_b\', \'U\') IS NOT NULL DROP TABLE dbo.dh_er_b;');
      await drop('IF OBJECT_ID(\'dbo.w43_b\', \'U\') IS NOT NULL DROP TABLE dbo.w43_b;');
      await drop('IF OBJECT_ID(\'dbo.w46_ui_m\', \'U\') IS NOT NULL DROP TABLE dbo.w46_ui_m;');
      await drop('IF OBJECT_ID(\'dbo.dh_w27_a\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w27_a;');
      await drop('IF OBJECT_ID(\'dbo.dh_w28_t\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w28_t;');
      await drop('IF OBJECT_ID(\'dbo.dh_ref\', \'U\') IS NOT NULL DROP TABLE dbo.dh_ref;');
      await drop('IF OBJECT_ID(\'dbo.dh_vd_a\', \'U\') IS NOT NULL DROP TABLE dbo.dh_vd_a;');
      await drop('IF OBJECT_ID(\'dbo.dh_er_a\', \'U\') IS NOT NULL DROP TABLE dbo.dh_er_a;');
      await drop('IF OBJECT_ID(\'dbo.w43_a\', \'U\') IS NOT NULL DROP TABLE dbo.w43_a;');
      await drop('IF OBJECT_ID(\'dbo.w46_ref\', \'U\') IS NOT NULL DROP TABLE dbo.w46_ref;');
      await drop('IF OBJECT_ID(\'dbo.dh_w27_b\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w27_b;');
      await drop('IF OBJECT_ID(\'dbo.dh_w27_m2\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w27_m2;');
      await drop('IF OBJECT_ID(\'dbo.dh_w27_m\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w27_m;');
      await drop('IF OBJECT_ID(\'dbo.dh_w28_nopk\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w28_nopk;');
      await drop('IF OBJECT_ID(\'dbo.dh_src_emp\', \'U\') IS NOT NULL DROP TABLE dbo.dh_src_emp;');
      await drop('IF OBJECT_ID(\'dbo.dh_ix_t\', \'U\') IS NOT NULL DROP TABLE dbo.dh_ix_t;');
      await drop('IF OBJECT_ID(\'dbo.dh_r11\', \'U\') IS NOT NULL DROP TABLE dbo.dh_r11;');
      await drop('IF OBJECT_ID(\'dbo.dh_w29_t\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w29_t;');
      await drop('IF OBJECT_ID(\'dbo.dh_w29_bad\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w29_bad;');
      await drop('IF OBJECT_ID(\'dbo.dh_w29_m\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w29_m;');
      await drop('IF OBJECT_ID(\'dbo.dh_w31_t\', \'U\') IS NOT NULL DROP TABLE dbo.dh_w31_t;');
      await drop('IF OBJECT_ID(\'dbo.w32_ui_m\', \'U\') IS NOT NULL DROP TABLE dbo.w32_ui_m;');
      await drop('IF OBJECT_ID(\'dbo.w33_ui_m\', \'U\') IS NOT NULL DROP TABLE dbo.w33_ui_m;');
      await drop('IF OBJECT_ID(\'dbo.w33_ref\', \'U\') IS NOT NULL DROP TABLE dbo.w33_ref;');
      await drop('IF OBJECT_ID(\'dbo.w34_col_m\', \'U\') IS NOT NULL DROP TABLE dbo.w34_col_m;');
      await drop('IF OBJECT_ID(\'dbo.w41_cp_m\', \'U\') IS NOT NULL DROP TABLE dbo.w41_cp_m;');
      await drop('IF OBJECT_ID(\'dbo.w42_sn\', \'U\') IS NOT NULL DROP TABLE dbo.w42_sn;');
      // round27 结构同步在 master 里建的 employees
      await drop('IF OBJECT_ID(\'dbo.employees\', \'U\') IS NOT NULL DROP TABLE dbo.employees;');
    };
    conn.on('connect', (err) => {
      if (err) {
        console.log('MSSQL-WARN ' + String(err && err.message ? err.message : err));
        conn.close();
        resolve();
        return;
      }
      const names = [];
      onePass()
        .then(() => onePass())
        .then(() => {
          return runSql('SELECT name FROM sys.objects WHERE schema_id = SCHEMA_ID(\'dbo\') AND name NOT LIKE \'spt[_]%\' AND name NOT LIKE \'MSreplication%\' AND name NOT IN (\'DeleteLog\',\'Login\') AND is_ms_shipped = 0 AND type IN (\'U\',\'V\',\'TR\',\'P\',\'FN\') AND parent_object_id NOT IN (OBJECT_ID(N\'dbo.DeleteLog\'), OBJECT_ID(N\'dbo.Login\')) ORDER BY name', (cols) => { names.push(String(cols[0].value)); });
        })
        .then(() => {
          console.log('MSSQL-LEFT ' + JSON.stringify(names));
          conn.close();
          resolve();
        })
        .catch((e) => {
          console.log('MSSQL-WARN ' + String(e && e.message ? e.message : e));
          try { conn.close(); } catch (e2) {}
          resolve();
        });
    });
    conn.on('error', (err) => {
      console.log('MSSQL-WARN ' + String(err && err.message ? err.message : err));
    });
    conn.connect();
  });
}

// ---------------- 主流程 ----------------
(async () => {
  await sqliteSide();
  await mssqlSide();
  // 导入向导的三份数据文件（round20 夹具产物）——历版 fx-drop 按设计顺带清理
  for (const f of ['imp-src.csv', 'imp-src.json', 'imp-append.csv']) {
    try { fs.unlinkSync('D:/DataHelm/.tmp-ud7/' + f); } catch {}
  }
  // round29 的还原备份测试文件（backups/ 在测试 userData 内，非用户真实档案）
  try {
    for (const f of fs.readdirSync('D:/DataHelm/.tmp-ud7/backups')) {
      if (/^w29-.*\.sql$/.test(f)) { try { fs.unlinkSync('D:/DataHelm/.tmp-ud7/backups/' + f); } catch {} }
    }
  } catch {}
  console.log('DROP-OK');
  process.exit(0);
})().catch((e) => {
  console.log('FATAL ' + String(e && e.message ? e.message : e));
  process.exit(1);
});
