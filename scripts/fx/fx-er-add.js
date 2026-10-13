'use strict';
// 夹具（round16 ER 图）：mssql master 建 dh_er_a / dh_er_b 两表 + 外键 fk_dh_er_b_aid
// （dh_er_b.aid → dh_er_a.id）—— B2 断言两盒子、以 dh_er_b. 开头的外键连线
// （ErTab 边 key = 子表名.外键名）、dh_er_a 有主键行（金钥匙）。dh_er_a 置 PRIMARY KEY 满足
// .er-row.pk .kico 断言。
// 幂等：先删子表（带外键依赖）再删父表；OBJECT_ID 守卫使首跑无表时为空操作。
// 运行时无 App 实例连着该库（battery 保证）。
const { Connection, Request } = require('D:/DataHelm/node_modules/tedious');

(async () => {
  const conn = new Connection({
    server: 'localhost',
    authentication: { type: 'default', options: { userName: 'sa', password: 'Destroy0922' } },
    options: { port: 1433, database: 'master', encrypt: false, trustServerCertificate: true, connectTimeout: 15000, requestTimeout: 60000 },
  });
  await new Promise((resolve, reject) => {
    conn.on('connect', (err) => (err ? reject(err) : resolve()));
    conn.connect(); // 忘了 connect 会静默退出 0
  });
  const run = (sqlText) =>
    new Promise((resolve, reject) => {
      const req = new Request(sqlText, (err, rowCount) => (err ? reject(err) : resolve(rowCount || 0)));
      conn.execSql(req);
    });

  // 幂等清理：子表先删（外键依赖父表，反序会报依赖错误）
  await run("IF OBJECT_ID('dbo.dh_er_b', 'U') IS NOT NULL DROP TABLE dbo.dh_er_b");
  await run("IF OBJECT_ID('dbo.dh_er_a', 'U') IS NOT NULL DROP TABLE dbo.dh_er_a");

  await run('CREATE TABLE dbo.dh_er_a (id INT NOT NULL PRIMARY KEY, nm NVARCHAR(80) NULL)');
  await run('CREATE TABLE dbo.dh_er_b (id INT NOT NULL PRIMARY KEY, aid INT NOT NULL, val NVARCHAR(80) NULL, CONSTRAINT fk_dh_er_b_aid FOREIGN KEY (aid) REFERENCES dbo.dh_er_a (id))');

  await run("INSERT INTO dbo.dh_er_a (id, nm) VALUES (1, N'甲方')");
  await run("INSERT INTO dbo.dh_er_a (id, nm) VALUES (2, N'乙方')");
  await run("INSERT INTO dbo.dh_er_b (id, aid, val) VALUES (1, 1, N'单甲')");
  await run("INSERT INTO dbo.dh_er_b (id, aid, val) VALUES (2, 2, N'单乙')");

  await new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    conn.on('end', () => {
      clearTimeout(t);
      resolve();
    });
    conn.close();
  });

  console.log('ER-ADD-OK');
})().catch((e) => {
  console.error('FX-ERR', e && e.message);
  process.exit(1);
});
