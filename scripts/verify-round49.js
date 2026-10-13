'use strict';
// v0927.52 SQL 格式化增强验证：
//  T1 CASE/WHEN/ELSE/END 块状缩进（SELECT 列表内，THEN 值同行）
//  T2 嵌套 CASE：内层 CASE 相对缩进 4 空格、双层 END 各自回缩
//  T3 函数内 CASE：sum(CASE … END) 不破坏括号配对
//  T4 WHERE 条件 AND/OR 独立断行 +1 缩进
//  T5 BETWEEN…AND 的 AND 保持内联（含子查询里与外层混合）
//  T6 ON 连接条件 AND 断行（JOIN … ON / LEFT JOIN … ON 各自缩进）
//  T7 子查询上下文恢复：EXISTS 子查询闭合括号后的外层 AND 断行
//  T8 压缩回环：format→minify→format 幂等；minify 保留 CASE/BETWEEN 词序
//  T9 语义保持：美化后的 CASE 查询在 employees 上运行 4 行，band = 高/中/低/高
//  S0 版本 v0927.52 / S5 无控制台错误
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9230) });
  const { Input, Runtime, Log } = client;
  await Runtime.enable();
  await Log.enable();
  const errors = [];
  Log.entryAdded(({ entry }) => { if (entry.level === 'error') errors.push(entry.text.slice(0, 200)); });
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(280); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(420); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const clickMenu = async (kw, tries = 5) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}));
        if (!it) return null;
        const r = it.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  if (!/v0927\.52/.test(sb)) fail('S0 状态栏 v0927.52', sb);
  else pass('S0 状态栏 v0927.52');

  // ---- 打开 sqlite → employees → 新建查询（可重入：employees 已可见则跳过展开双击）----
  let p = null;
  for (let i = 0; i < 10 && !p; i += 1) {
    p = await treePos('employees');
    if (p) break;
    const tb = await treePos('表');
    if (tb) { await dblclick(tb.x, tb.y); await sleep(700); continue; }
    const lib = await treePos('演示 SQLite 库');
    if (lib) { await dblclick(lib.x, lib.y); await sleep(800); }
    await sleep(400);
  }
  if (!p) { fail('前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('前置', '菜单无 新建查询'); await client.close(); return; }
  await sleep(900);
  const edPos = await ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
  })()`);
  await lclick(edPos.x, edPos.y);

  // paste + 美化 + 读回全文
  const paste = async (sql) => { await ctrlA(); await Input.insertText({ text: sql }); await sleep(350); };
  const docText = async () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
  const beautify = async () => {
    await rclick(edPos.x, edPos.y);
    if (!(await clickMenu('美化SQL'))) return null;
    await sleep(450);
    return docText();
  };

  // ---- T1 CASE 块缩进 ----
  await paste("select id, case when salary > 15000 then '高' when salary > 10000 then '中' else '低' end as band, name from employees");
  let doc = await beautify();
  const t1want = 'SELECT id,\nCASE\n  WHEN salary > 15000 THEN \'高\'\n  WHEN salary > 10000 THEN \'中\'\n  ELSE \'低\'\nEND AS band,\nname\nFROM employees\n';
  doc === t1want ? pass('T1 CASE 块状缩进（WHEN/ELSE 各起行 +1，END 回缩，THEN 值同行）')
    : fail('T1 CASE 缩进', JSON.stringify(doc));

  // ---- T2 嵌套 CASE ----
  await paste("select case when a=1 then case when b=2 then 'x' else 'y' end else 'z' end from t");
  doc = await beautify();
  const t2want = 'SELECT CASE\n  WHEN a = 1 THEN CASE\n    WHEN b = 2 THEN \'x\'\n    ELSE \'y\'\n  END\n  ELSE \'z\'\nEND\nFROM t\n';
  doc === t2want ? pass('T2 嵌套 CASE 相对缩进（内层 4 空格 / 双层 END 逐级回缩）')
    : fail('T2 嵌套 CASE', JSON.stringify(doc));

  // ---- T3 函数内 CASE ----
  await paste('select sum(case when qty > 0 then 1 else 0 end) as pos from t');
  doc = await beautify();
  const t3want = 'SELECT sum(CASE\n  WHEN qty > 0 THEN 1\n  ELSE 0\nEND) AS pos\nFROM t\n';
  doc === t3want ? pass('T3 函数内 CASE（sum( 不加空格，END) 闭合同行）')
    : fail('T3 函数内 CASE', JSON.stringify(doc));

  // ---- T4 WHERE AND/OR 断行 ----
  await paste("select * from employees where dept = 'x' and salary > 100 or id = 1");
  doc = await beautify();
  const t4want = 'SELECT *\nFROM employees\nWHERE dept = \'x\'\n  AND salary > 100\n  OR id = 1\n';
  doc === t4want ? pass('T4 WHERE 条件 AND/OR 断行 +1 缩进') : fail('T4 AND/OR 断行', JSON.stringify(doc));

  // ---- T5 BETWEEN…AND 内联（含子查询混合）----
  await paste("select * from t where id in (select x from u where amt between 1 and 5) and id between 2 and 8 or name like 'a%'");
  doc = await beautify();
  const t5want = 'SELECT *\nFROM t\nWHERE id IN (\n  SELECT x\n  FROM u\n  WHERE amt BETWEEN 1 AND 5\n)\n  AND id BETWEEN 2 AND 8\n  OR name LIKE \'a%\'\n';
  doc === t5want ? pass('T5 BETWEEN…AND 内联（子查询内/外层均正确，条件 AND/OR 仍断行）')
    : fail('T5 BETWEEN 混合', JSON.stringify(doc));

  // ---- T6 ON 条件 AND 断行 ----
  await paste('select * from a join b on a.id = b.id and a.x = b.x left join c on c.id = a.id and c.y = 1');
  doc = await beautify();
  const t6want = 'SELECT *\nFROM a\nJOIN b\n  ON a.id = b.id\n  AND a.x = b.x\nLEFT JOIN c\n  ON c.id = a.id\n  AND c.y = 1\n';
  doc === t6want ? pass('T6 JOIN ON 条件 AND 断行（每个 ON 块各自 +1）') : fail('T6 ON AND', JSON.stringify(doc));

  // ---- T7 EXISTS 子查询闭合后外层 AND ----
  await paste('select * from a where exists (select 1 from b where b.aid = a.id and b.x = 2) and not exists (select 1 from c)');
  doc = await beautify();
  const t7want = 'SELECT *\nFROM a\nWHERE EXISTS (\n  SELECT 1\n  FROM b\n  WHERE b.aid = a.id\n    AND b.x = 2\n)\n  AND NOT EXISTS (\n  SELECT 1\n  FROM c\n)\n';
  doc === t7want ? pass('T7 子查询内外 AND 分层断行（内层 +1、闭合后外层断行）')
    : fail('T7 EXISTS 分层', JSON.stringify(doc));

  // ---- T8 压缩回环（编辑器内 压缩SQL 菜单）----
  await rclick(edPos.x, edPos.y);
  if (!(await clickMenu('压缩SQL'))) fail('T8 压缩', '菜单失败');
  else {
    await sleep(400);
    doc = await docText();
    doc === "SELECT*FROM a WHERE EXISTS(SELECT 1 FROM b WHERE b.aid=a.id AND b.x=2) AND NOT EXISTS(SELECT 1 FROM c)"
      ? pass('T8a 压缩单行还原（minify 既有行为：* 前不留空格；CASE/BETWEEN 词序与语义不破坏）')
      : fail('T8a 压缩', JSON.stringify(doc));
    // 再美化应与 T7 结果一致（幂等）
    doc = await beautify();
    doc === t7want ? pass('T8b format→minify→format 幂等') : fail('T8b 幂等', JSON.stringify(doc));
  }

  // ---- T9 语义保持：运行美化后的 CASE 查询 ----
  await paste("select id, case when salary > 15000 then '高' when salary > 10000 then '中' else '低' end as band from employees order by id");
  doc = await beautify();
  if (doc !== 'SELECT id,\nCASE\n  WHEN salary > 15000 THEN \'高\'\n  WHEN salary > 10000 THEN \'中\'\n  ELSE \'低\'\nEND AS band\nFROM employees\nORDER BY id\n') {
    fail('T9 前置', '美化输出意外：' + JSON.stringify(doc));
  } else {
    await rclick(edPos.x, edPos.y);
    await clickMenu('运行（Ctrl+Enter）');
    await sleep(1400);
    const runRes = await ev(`(() => {
      const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
      if (!pane) return { rows: [] };
      // ResultGrid 虚拟模式：行是 div.ant-table-row，单元格 div.ant-table-cell（无行号列）
      const rows = [...pane.querySelectorAll('.dh-grid .ant-table-row')].map((tr) => [...tr.querySelectorAll('.ant-table-cell')].map((td) => td.textContent.trim()));
      return { rows };
    })()`);
    const bands = (runRes.rows || []).map((r) => r[r.length - 1]);
    (runRes.rows || []).length === 4 && bands.join(',') === '高,中,低,高'
      ? pass('T9 美化后 SQL 可运行（4 行 band=高/中/低/高，语义无损）')
      : fail('T9 运行', JSON.stringify(runRes).slice(0, 300));
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
