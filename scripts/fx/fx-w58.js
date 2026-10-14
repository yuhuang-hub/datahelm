'use strict';
// 夹具（round58 / v0927.53 库节点菜单 db 兜底修复——复刻用户报告场景）：
//  连接配置无默认业务库（database=master），业务对象放在独立库 dh_w58：
//  stage1：库 dh_w58 + dbo.w58_a(id, nm) 1 行
//  check1：CHECK-JSON {rows}；退出码 0
//  cleanup：SINGLE_USER 踢会话后 drop 整库
// 幂等：stage1 先 drop 旧对象再建。运行时无 App 实例占用该库（套件轮换保证）。
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
    await run("IF DB_ID(N'dh_w58') IS NULL CREATE DATABASE dh_w58");
    await run('USE dh_w58');
    await run("IF OBJECT_ID(N'dbo.w58_a', N'U') IS NOT NULL DROP TABLE dbo.w58_a");
    await run('CREATE TABLE dbo.w58_a (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(20) NULL)');
    await run("INSERT INTO dbo.w58_a (id, nm) VALUES (1, N'w58甲')");
    console.log('W58-STAGE1-OK');
  } else if (mode === 'check1') {
    await run('USE dh_w58');
    const a = await queryRows('SELECT COUNT(*) AS n FROM dbo.w58_a');
    console.log('CHECK-JSON ' + JSON.stringify({ rows: Number(a[0].n) }));
  } else if (mode === 'cleanup') {
    await run('USE master');
    await run("IF DB_ID(N'dh_w58') IS NOT NULL ALTER DATABASE dh_w58 SET SINGLE_USER WITH ROLLBACK IMMEDIATE;");
    await run("IF DB_ID(N'dh_w58') IS NOT NULL DROP DATABASE dh_w58;");
    console.log('W58-CLEANUP-OK');
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
