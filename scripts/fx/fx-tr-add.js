'use strict';
// 传输向导夹具（verify-round12 B 组前置）：注册 sqlite 目标连接 + 重建空目标库
//  - 连接：id dh-tr-dst-sqlite / 裸名「传输目标SQLite」（UI 自己渲染成 传输目标SQLite（SQLite））
//  - 库文件：D:/DataHelm/.tmp-ud7/transfer-dst.db —— 先删旧文件再由 sqlite 驱动新建零表空库
//    （B2 传输时 dh_src_emp 由向导自动建表；B2c 离线核验读同一文件）
//  - connections.json 为 {connections:[...]} 对象结构：读-改-写保留其他种子条目
//  幂等：按 id 过滤后再 push；库文件每次重建为空。输出 TR-ADD-OK。
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');

const UD = 'D:/DataHelm/.tmp-ud7';
const CONNS = UD + '/connections.json';
const DB_FILE = UD + '/transfer-dst.db';
const CONN_ID = 'dh-tr-dst-sqlite';

(async () => {
  fs.mkdirSync(UD, { recursive: true });

  // 清 transfer-dst.db → 驱动新建零表空库（create 即 persist 落盘，close 再 persist 一次）
  try { fs.unlinkSync(DB_FILE); } catch (e) { /* 不存在即期望态 */ }
  const c = await create({ file: DB_FILE });
  await c.close();

  // 连接注册：对象结构，保留其他条目（c-sqlite-demo / c-mssql-1 …）
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CONNS, 'utf8')); } catch (e) { doc = null; }
  if (!doc || !Array.isArray(doc.connections)) doc = { connections: [] };
  doc.connections = doc.connections.filter((x) => x && x.id !== CONN_ID);
  doc.connections.push({ id: CONN_ID, name: '传输目标SQLite', type: 'sqlite', config: { file: DB_FILE } });
  fs.writeFileSync(CONNS, JSON.stringify(doc, null, 2));

  console.log('TR-ADD-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
