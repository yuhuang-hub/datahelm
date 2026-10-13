'use strict';
// 夹具（round57 / v0927.52 五特性——① objs 页 MSSQL 多架构 ② sp_rename 纯点分 ④ 重建 FK 提示）：
//  连接配置无默认业务库（database=master），业务对象放在独立库 dh_w57：
//  stage1：库 dh_w57 + schema w57s + w57s.w57_ord(id,nm) 2 行 + dbo.w57_cfg(id,nm) 1 行
//          + dbo.w57_log(id,aid REFERENCES w57s.w57_ord(id))——他表 FK 引用非 dbo 表（④ 提示素材）
//  check1：CHECK-JSON {ordRows, cfgRows, logFks}；退出码 0
//  cleanup：USE master → SINGLE_USER 踢会话 → 整库删
// 幂等：stage1 先 drop 旧库再建（整库级，比逐对象稳）。运行时无 App 实例占用该库（battery 保证）。
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

const mode = process.argv[2] || 'stage1';
const conn = new Connection({
  server: 'localhost',
  authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
  options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
});
const run = (sqlText) =>
  new Promise((resolve, reject) => {
    const req = new Request(sqlText, (err, rowCount) => (err ? reject(err) : resolve(rowCount || 0)));
    conn.execSql(req);
  });
const queryRows = (sqlText) =>
  new Promise((resolve, reject) => {
    const out = [];
    const req = new Request(sqlText, (err) => (err ? reject(err) : resolve(out)));
    req.on('row', (cols) => {
      const o = {};
      cols.forEach((c) => { o[c.metadata.colName] = c.value; });
      out.push(o);
    });
    conn.execSql(req);
  });

(async () => {
  await new Promise((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve()));
    conn.connect(); // 必须显式 connect，否则静默退出
  });
  if (mode === 'stage1') {
    await run('USE master');
    await run("IF DB_ID(N'dh_w57') IS NOT NULL ALTER DATABASE dh_w57 SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
    await run("IF DB_ID(N'dh_w57') IS NOT NULL DROP DATABASE dh_w57;");
    await run('CREATE DATABASE dh_w57');
    await run('USE dh_w57');
    await run('CREATE SCHEMA w57s');
    await run('CREATE TABLE w57s.w57_ord (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(20) NULL, note NVARCHAR(20) NULL)');
    await run("INSERT INTO w57s.w57_ord (id, nm, note) VALUES (1, N'甲', N'n1')");
    await run("INSERT INTO w57s.w57_ord (id, nm, note) VALUES (2, N'乙', N'n2')");
    await run('CREATE TABLE dbo.w57_cfg (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(20) NULL)');
    await run("INSERT INTO dbo.w57_cfg (id, nm) VALUES (9, N'丙')");
    await run('CREATE TABLE dbo.w57_log (id INT NOT NULL PRIMARY KEY, aid INT NULL REFERENCES w57s.w57_ord(id), msg NVARCHAR(20) NULL)');
    console.log('W57-STAGE1-OK');
  } else if (mode === 'check1') {
    await run('USE dh_w57');
    // ordRows 计两张可能名（T4 会把 w57_ord 改名成 w57_ord2；IF 守卫 + 延迟名称解析保护缺表分支）；logFks 同理按引用对象名 IN 计
    const ord = await queryRows("DECLARE @n INT = 0; IF OBJECT_ID(N'w57s.w57_ord','U') IS NOT NULL SET @n = @n + (SELECT COUNT(*) FROM w57s.w57_ord); IF OBJECT_ID(N'w57s.w57_ord2','U') IS NOT NULL SET @n = @n + (SELECT COUNT(*) FROM w57s.w57_ord2); SELECT @n AS n");
    const cfg = await queryRows('SELECT COUNT(*) AS n FROM dbo.w57_cfg');
    const fks = await queryRows("SELECT COUNT(*) AS n FROM sys.foreign_keys fk JOIN sys.objects rt ON rt.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id WHERE rs.name = 'w57s' AND rt.name IN ('w57_ord','w57_ord2')");
    console.log('CHECK-JSON ' + JSON.stringify({ ordRows: Number(ord[0].n), cfgRows: Number(cfg[0].n), logFks: Number(fks[0].n) }));
  } else if (mode === 'cleanup') {
    // App 实例可能仍连着 dh_w57——SINGLE_USER + ROLLBACK IMMEDIATE 踢掉后整库删
    await run('USE master');
    await run("IF DB_ID(N'dh_w57') IS NOT NULL ALTER DATABASE dh_w57 SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
    await run("IF DB_ID(N'dh_w57') IS NOT NULL DROP DATABASE dh_w57;");
    console.log('W57-CLEANUP-OK');
  } else {
    throw new Error('unknown mode: ' + mode);
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    conn.on('end', () => {
      clearTimeout(t);
      resolve();
    });
    conn.close();
  });
  process.exit(0);
})().catch((e) => {
  console.error('FX-ERR', e.message);
  process.exit(1);
});
