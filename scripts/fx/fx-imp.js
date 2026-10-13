'use strict';
// 夹具（round20 导入向导）：写三个导入源文件（UTF-8）+ 幂等清掉上次向导建的表。
//  imp-src.csv —— 表头必须精确为 id,name,qty,note；4 数据行。id=1 → 张三（W4b）；
//    首行 note 为含引号转义（""）与半角分号（;）的引号字段（解析后：备注"甲";含分号），
//    行三 note 含引号包裹的逗号；全列推断 整数/文本/整数/文本（W3a），4 列 4 行（W2），导入 4 行（W3b）。
//    注意：分隔符按全文计数嗅探（逗号 16 vs 分号 1），逗号安全胜出。
//  imp-src.json —— 对象数组（键序 nm/qty/price，2 行）；推断 文本/整数/小数（W5a），建 dh_imp_j1 导入 2 行（W5b）。
//  imp-append.csv —— 4 列带表头 + 2 数据行（W6a）；追加到现有 dh_imp_t1 → 4+2=6（W6e/W6f）。
// 幂等：dh_imp_t1 / dh_imp_j1 先 dropTable（首跑忽略 no such table），保证向导「新建表」可重复执行；
// demo-test.db 缺失时从 demo.db 补拷基线（round20 需要 employees 数据页）。运行时无 App 实例（battery 保证）。
const fs = require('fs');
const { create } = require('D:/DataHelm/electron/services/db/sqlite.js');

const DIR = 'D:/DataHelm/.tmp-ud7';
const DEMO_SRC = 'D:/DataHelm/demo.db';
const DEMO_DST = DIR + '/demo-test.db';

const CSV_MAIN =
  [
    'id,name,qty,note',
    '1,张三,3,"备注""甲"";含分号"',
    '2,李四,5,普通备注',
    '3,王五,2,"带,逗号"',
    '4,赵六,8,行四备注',
  ].join('\r\n') + '\r\n';

const JSON_MAIN = '[\r\n  { "nm": "苹果", "qty": 3, "price": 2.5 },\r\n  { "nm": "香蕉", "qty": 5, "price": 1.25 }\r\n]\r\n';

const CSV_APPEND =
  [
    'id,name,qty,note',
    '5,钱七,4,追加第一行',
    '6,孙八,7,追加第二行',
  ].join('\r\n') + '\r\n';

(async () => {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(DIR + '/imp-src.csv', CSV_MAIN, 'utf8');
  fs.writeFileSync(DIR + '/imp-src.json', JSON_MAIN, 'utf8');
  fs.writeFileSync(DIR + '/imp-append.csv', CSV_APPEND, 'utf8');

  // 幂等：清掉上一轮向导生成的表（否则 CREATE TABLE 重名 → W3b 失败）
  if (!fs.existsSync(DEMO_DST)) fs.copyFileSync(DEMO_SRC, DEMO_DST);
  const c = await create({ file: DEMO_DST });
  const dropT = async (t) => {
    try {
      await c.dropTable({ table: t });
    } catch (e) {
      if (!/no such table/i.test(String(e && e.message))) throw e; // 首跑：表尚不存在
    }
  };
  await dropT('dh_imp_t1');
  await dropT('dh_imp_j1');
  await c.close(); // 落盘

  console.log('IMP-OK');
})().catch((e) => {
  console.error('FX-ERR', e && e.message);
  process.exit(1);
});
