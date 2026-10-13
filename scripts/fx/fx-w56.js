'use strict';
// 夹具（round56 / v0927.52 MSSQL 空库名/空 schema 限定名修复——复刻用户环境）：
//  连接配置无默认业务库（database=master），业务对象放在独立库 dh_w56：
//  stage1：库 dh_w56 + schema platform + platform.arrival_notice_detail(id,nnm) 2 行 + dbo.w56_dbo_t(id,nm) 2 行
//  check1：CHECK-JSON {platRows, dboRows}；退出码 0
//  cleanup：drop 两表 + schema platform + 库 dh_w56（先 USE master 再删库）
// 幂等：stage1 先 drop 旧对象再建。运行时无 App 实例占用该库（battery 保证）。
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
    await run("IF DB_ID(N'dh_w56') IS NULL CREATE DATABASE dh_w56");
    await run('USE dh_w56');
    await run("IF SCHEMA_ID(N'platform') IS NULL EXEC(N'CREATE SCHEMA platform')");
    await run("IF OBJECT_ID(N'platform.arrival_notice_detail', N'U') IS NOT NULL DROP TABLE platform.arrival_notice_detail");
    await run('CREATE TABLE platform.arrival_notice_detail (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(20) NULL)');
    await run("INSERT INTO platform.arrival_notice_detail (id, nm) VALUES (1, N'甲')");
    await run("INSERT INTO platform.arrival_notice_detail (id, nm) VALUES (2, N'乙')");
    await run("IF OBJECT_ID(N'dbo.w56_dbo_t', N'U') IS NOT NULL DROP TABLE dbo.w56_dbo_t");
    await run('CREATE TABLE dbo.w56_dbo_t (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(20) NULL)');
    await run("INSERT INTO dbo.w56_dbo_t (id, nm) VALUES (10, N'丁')");
    await run("INSERT INTO dbo.w56_dbo_t (id, nm) VALUES (11, N'戊')");
    console.log('W56-STAGE1-OK');
  } else if (mode === 'check1') {
    await run('USE dh_w56');
    const plat = await queryRows('SELECT COUNT(*) AS n FROM platform.arrival_notice_detail');
    const dbo = await queryRows('SELECT COUNT(*) AS n FROM dbo.w56_dbo_t');
    console.log('CHECK-JSON ' + JSON.stringify({ platRows: Number(plat[0].n), dboRows: Number(dbo[0].n) }));
  } else if (mode === 'cleanup') {
    // App 实例可能仍连着 dh_w56（page 读路径批前 USE）——SINGLE_USER + ROLLBACK IMMEDIATE
    // 强制踢掉占用会话后整库删（实例随后即被 battery/套件轮换杀掉，连接已断无实害）
    await run('USE master');
    await run("IF DB_ID(N'dh_w56') IS NOT NULL ALTER DATABASE dh_w56 SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
    await run("IF DB_ID(N'dh_w56') IS NOT NULL DROP DATABASE dh_w56;");
    console.log('W56-CLEANUP-OK');
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
