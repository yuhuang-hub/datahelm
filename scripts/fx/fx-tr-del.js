'use strict';
// 传输向导夹具清理（verify-round12 收尾配套）：
//  - 从 connections.json 按 id 移除 dh-tr-dst-sqlite（保留其他条目；文件缺失/损坏时不动）
//  - 删除 D:/DataHelm/.tmp-ud7/transfer-dst.db
//  幂等：条目不存在 / 文件不存在都算成功。输出 TR-DEL-OK。
const fs = require('fs');

const UD = 'D:/DataHelm/.tmp-ud7';
const CONNS = UD + '/connections.json';
const DB_FILE = UD + '/transfer-dst.db';
const CONN_ID = 'dh-tr-dst-sqlite';

(async () => {
  let doc = null;
  try { doc = JSON.parse(fs.readFileSync(CONNS, 'utf8')); } catch (e) { doc = null; }
  if (doc && Array.isArray(doc.connections)) {
    doc.connections = doc.connections.filter((x) => x && x.id !== CONN_ID);
    fs.writeFileSync(CONNS, JSON.stringify(doc, null, 2));
  }
  try { fs.unlinkSync(DB_FILE); } catch (e) { /* 不存在即期望态 */ }
  console.log('TR-DEL-OK');
})().catch((e) => { console.error('FX-ERR', e && e.message); process.exit(1); });
