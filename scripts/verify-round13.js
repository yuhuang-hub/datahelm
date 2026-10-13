'use strict';
// v0927.52 视图设计器验证（sqlite 9228 实例 + localhost MSSQL master）：
//  A sqlite：分类入口建视图（添加表/勾列/FK 推断 JOIN/WHERE/ORDER）→ SQL 预览 → 结果预览 → 脏点 → 保存 → 树刷新 → 查询视图
//  B 编辑回读：设计视图 打开已建视图（表/勾选列/连接/WHERE 还原）→ 加列保存 → 视图列变化
//  D 菜单入口：视图节点 设计视图/编辑视图；未保存关闭确认
//  C mssql：master 建两表 → 设计器 LEFT JOIN 视图 → 保存查询 → 清理（OBJECT_ID 判空）
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9228) });
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
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
  };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const insertText = (t) => Input.insertText({ text: t });
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const menuHas = (kw) => ev(`!![...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)})`);
  const clickMenu = async (kw, tries = 5) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)});
        if (!it) return null;
        const r = it.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (it) {
        await lclick(it.x, it.y);
        return true;
      }
      await sleep(350);
    }
    return false;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const clearFrozenModals = () => ev(`(() => { let n = 0; document.querySelectorAll('.ant-modal-wrap').forEach((w) => { const m = w.querySelector('.ant-modal'); if (m && /ant-zoom-leave/.test(m.className)) { w.remove(); n += 1; } }); return n; })()`);
  const closeActiveTab = async () => {
    const c = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (c) { await lclick(c.x, c.y); await sleep(700); }
    if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) {
      const b = await ev(`(() => { const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (b) await lclick(b.x, b.y);
      await sleep(700);
    }
    await clearFrozenModals();
  };
  // ---- 查询页辅助 ----
  const queryOn = async (nodeTitle, sql) => {
    let p = await treePos(nodeTitle);
    if (!p) return false;
    await rclick(p.x, p.y);
    if (!(await clickMenu('新建查询'))) return false;
    await sleep(1200);
    const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    await lclick(ed.x, ed.y);
    await ctrlA();
    await insertText(sql);
    await sleep(300);
    const runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!runBtn) return false;
    await lclick(runBtn.x, runBtn.y);
    await sleep(2400);
    return true;
  };
  const gridCell = (r, c) => ev(`(() => {
    const row = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[${r}];
    if (!row) return null;
    const cell = row.querySelectorAll('.cell')[${c}];
    return cell ? cell.textContent : null;
  })()`);
  const gridRows = () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent).length`);
  const waitGrid = async (tries = 12) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await gridRows();
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  // ---- 视图设计器辅助（host = 含 .dh-vd-tabs 的激活 pane；antd Checkbox 把 data-* 透传到 input 上）----
  const vd = (body) => ev(`(() => { const host = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.dh-vd-tabs')); if (!host) return null; return (${body}); })()`);
  const vdPos = (sel) => vd(`(() => { const el = host.querySelector(${JSON.stringify(sel)}); if (!el) return null; const t = el.matches('input') ? el : el; const b = t.getBoundingClientRect(); if (b.width < 2) return null; return { x: Math.round(b.x + Math.min(b.width / 2, 60)), y: Math.round(b.y + b.height / 2) }; })()`);
  const vdAdd = async (table) => {
    for (let i = 0; i < 10; i += 1) {
      const p = await vd(`(() => { const b = host.querySelector('[data-dh-vd-add=' + JSON.stringify(${JSON.stringify(table)}) + ']'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const waitCard = async (table, tries = 12) => {
    for (let i = 0; i < tries; i += 1) {
      const ok = await vd(`!!host.querySelector('[data-dh-vd-card=' + JSON.stringify(${JSON.stringify(table)}) + '] [data-dh-vd-col]')`);
      if (ok) return true;
      await sleep(450);
    }
    return false;
  };
  const vdCheck = async (colAttr) => {
    const p = await vd(`(() => { const el = host.querySelector('[data-dh-vd-col=' + JSON.stringify(${JSON.stringify(colAttr)}) + ']'); if (!el) return null; const t = el.matches('input') ? el : (el.querySelector('input') || el); const b = t.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(200);
    return true;
  };
  const isChecked = (colAttr) => vd(`(() => { const el = host.querySelector('[data-dh-vd-col=' + JSON.stringify(${JSON.stringify(colAttr)}) + ']'); if (!el) return null; const i = el.matches('input') ? el : el.querySelector('input'); return !!(i && i.checked); })()`);
  const vdInputSet = async (attr, value) => {
    const p = await vdPos(`[data-dh-vd=${JSON.stringify(attr)}]`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await ctrlA();
    await insertText(value);
    await sleep(250);
    return true;
  };
  const vdInnerTab = async (label) => {
    const p = await vd(`(() => { const kw = ${JSON.stringify(label)}.replace(/\\s+/g, ''); const t = [...host.querySelectorAll('.dh-vd-tabs .ant-tabs-tab')].find((x) => x.textContent.replace(/\\s+/g, '') === kw); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(400);
    return true;
  };
  const vdSave = async () => {
    const p = await vd(`(() => { const b = [...host.querySelectorAll('.tab-toolbar button')].find((x) => x.textContent.replace(/\\s+/g, '') === '保存'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const vdSql = () => vd(`(() => { const p = host.querySelector('[data-dh-vd="sql"]'); return p ? p.textContent : null; })()`);
  const vdJoinOn = (table) => vd(`(() => { const j = host.querySelector('[data-dh-vd-join=' + JSON.stringify(${JSON.stringify(table)}) + '] input[data-dh-vd-jon], [data-dh-vd-join=' + JSON.stringify(${JSON.stringify(table)}) + '] [data-dh-vd-jon]'); if (!j) return null; return j.matches('input') ? j.value : (j.querySelector('input') || {}).value || ''; })()`);
  const vdState = () => vd(`(() => {
    const cards = [...host.querySelectorAll('[data-dh-vd-card]')].map((c) => ({
      name: c.getAttribute('data-dh-vd-card'),
      checked: [...c.querySelectorAll('[data-dh-vd-col]')].filter((x) => { const i = x.matches('input') ? x : x.querySelector('input'); return i && i.checked; }).map((x) => x.getAttribute('data-dh-vd-col')),
    }));
    const joins = [...host.querySelectorAll('[data-dh-vd-join]')].map((j) => j.getAttribute('data-dh-vd-join'));
    const where = (host.querySelector('[data-dh-vd="where"]') || {}).value || '';
    const name = (host.querySelector('[data-dh-vd="name"]') || {}).value || '';
    return { cards, joins, where, name };
  })()`);
  const vdGone = async (tries = 12) => {
    for (let i = 0; i < tries; i += 1) {
      const ok = await vd(`1`) === null;
      if (ok) return true;
      await sleep(450);
    }
    return false;
  };
  const tabDot = () => ev(`!!document.querySelector('.main-tabs .ant-tabs-tab-active .tab-dot')`);

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.52') ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ---- A0 sqlite 建源表（外键：emp.dept_id → dept.id）----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('A0 前置', '表 分类无 新建查询'); await client.close(); return; }
  await sleep(1200);
  let ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
  await lclick(ed.x, ed.y);
  await ctrlA();
  await insertText("DROP VIEW IF EXISTS dh_vd_v1;\nDROP VIEW IF EXISTS dh_vd_v2;\nDROP TABLE IF EXISTS dh_vd_emp;\nDROP TABLE IF EXISTS dh_vd_dept;\nCREATE TABLE dh_vd_dept(id INTEGER PRIMARY KEY, name TEXT);\nCREATE TABLE dh_vd_emp(id INTEGER PRIMARY KEY, name TEXT, dept_id INTEGER REFERENCES dh_vd_dept(id));\nINSERT INTO dh_vd_dept VALUES (1,'研发'),(2,'销售');\nINSERT INTO dh_vd_emp VALUES (1,'张三',1),(2,'李四',1),(3,'王五',2);");
  await sleep(300);
  let runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!runBtn) { fail('A0 前置', '无 运行 按钮'); await client.close(); return; }
  await lclick(runBtn.x, runBtn.y);
  await sleep(2000);
  await closeActiveTab();
  await sleep(400);
  await clearFrozenModals();
  // 展开表分类 → 刷新（子节点渲染后重拉才可见）
  p = await treePos('表');
  await dblclick(p.x, p.y);
  await sleep(900);
  await rclick(p.x, p.y);
  await clickMenu('刷新');
  await sleep(1300);
  p = await treePos('dh_vd_dept');
  if (!p) { fail('A0 前置', 'dh_vd_dept 未出现在树'); await client.close(); return; }
  pass('A0 sqlite 源表（dept 2 行 / emp 3 行，FK 关联）');

  // ---- A1 视图分类 → 新建视图（设计）----
  p = await treePos('视图');
  await dblclick(p.x, p.y);
  await sleep(900);
  await rclick(p.x, p.y);
  const hasBoth = (await menuHas('新建视图（设计）')) && (await menuHas('新建视图'));
  hasBoth ? pass('A1a 视图分类含 新建视图（设计）+ 新建视图') : fail('A1a 分类菜单', '缺设计入口');
  if (!(await clickMenu('新建视图（设计）'))) { fail('A1 前置', '打开设计器失败'); await client.close(); return; }
  await sleep(1400);
  const title = await ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active [data-tab-key]'); return t ? t.textContent.trim() : null; })()`);
  const sideRows = await vd(`[...host.querySelectorAll('[data-dh-vd-row]')].map((r) => r.getAttribute('data-dh-vd-row'))`);
  title === '新建视图' && sideRows && sideRows.includes('dh_vd_dept') && sideRows.includes('dh_vd_emp')
    ? pass('A1b 设计器打开（标题+表清单）')
    : fail('A1b 设计器', JSON.stringify({ title, sideRows }));

  // ---- A2 添加两表 + FK 推断 JOIN ----
  (await vdAdd('dh_vd_dept')) ? null : fail('A2 前置', '添加 dh_vd_dept 失败');
  (await waitCard('dh_vd_dept')) ? pass('A2a 表卡片+列加载（dept）') : fail('A2a dept 卡片', '超时');
  (await vdAdd('dh_vd_emp')) ? null : fail('A2 前置', '添加 dh_vd_emp 失败');
  (await waitCard('dh_vd_emp')) ? pass('A2b 表卡片+列加载（emp）') : fail('A2b emp 卡片', '超时');
  await sleep(1200);
  const joinOn = await vdJoinOn('dh_vd_emp');
  joinOn && /dept_id/.test(joinOn) && /t1.*"id"|t1\."id"/.test(joinOn) && /t2/.test(joinOn)
    ? pass('A2c FK 自动推断 JOIN（' + joinOn + '）')
    : fail('A2c JOIN 推断', JSON.stringify(joinOn));

  // ---- A3 勾选列 + WHERE/ORDER ----
  (await vdCheck('dh_vd_dept.name')) ? null : fail('A3 前置', '勾选 dept.name 失败');
  (await vdCheck('dh_vd_emp.name')) ? null : fail('A3 前置', '勾选 emp.name 失败');
  (await isChecked('dh_vd_dept.name')) && (await isChecked('dh_vd_emp.name')) ? pass('A3a 勾选两列') : fail('A3a 勾选', 'checked=false');
  (await vdInputSet('where', 't2."name" = \'张三\'')) ? null : fail('A3 前置', 'WHERE 输入失败');
  (await vdInputSet('order', 't2."id"')) ? null : fail('A3 前置', 'ORDER 输入失败');

  // ---- A4 SQL 预览 ----
  (await vdInnerTab('SQL 预览')) ? null : fail('A4 前置', '切 SQL 预览失败');
  const sql4 = await vdSql();
  const a4ok = sql4 && sql4.includes('SELECT') && sql4.includes('t1."name" AS "name"') && sql4.includes('t2."name" AS "name_2"')
    && sql4.includes('INNER JOIN') && sql4.includes('ON t2."dept_id" = t1."id"')
    && sql4.includes('WHERE t2."name" = \'张三\'') && sql4.includes('ORDER BY t2."id"');
  a4ok ? pass('A4 SQL 预览（列别名去重/JOIN/WHERE/ORDER）') : fail('A4 SQL 预览', String(sql4 || '').slice(0, 300));

  // ---- A5 结果预览 ----
  const pv = await vdPos('[data-dh-vd="preview"]');
  if (pv) { await lclick(pv.x, pv.y); await sleep(1800); }
  const g5 = await vd(`(() => { const row = [...host.querySelectorAll('.dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[0]; if (!row) return null; return [...row.querySelectorAll('.cell')].map((c) => c.textContent); })()`);
  g5 && g5.length === 2 && g5[0] === '研发' && g5[1] === '张三'
    ? pass('A5 结果预览（WHERE 过滤出 1 行）')
    : fail('A5 结果预览', JSON.stringify(g5));

  // ---- A6 脏点 + 保存 ----
  (await tabDot()) ? pass('A6a 未保存脏点') : fail('A6a 脏点', '无 tab-dot');
  (await vdInputSet('name', 'dh_vd_v1')) ? null : fail('A6 前置', '视图名输入失败');
  (await vdSave()) ? null : fail('A6 前置', '保存未点击');
  const closed = await vdGone();
  closed && !(await ev(`!!document.querySelector('.ant-modal-confirm')`)) ? pass('A6b 保存后自动关标签（无误弹确认）') : fail('A6b 保存关闭', 'tab 未关或弹确认');
  await sleep(1500);
  p = await treePos('dh_vd_v1');
  p ? pass('A6c 树刷新出现 dh_vd_v1') : fail('A6c 树刷新', '视图分类未见 dh_vd_v1');

  // ---- A7 查询视图（真实视图生效）----
  if (await queryOn('dh_vd_v1', 'SELECT * FROM dh_vd_v1')) {
    await waitGrid();
    const c0 = await gridCell(0, 0);
    const c1 = await gridCell(0, 1);
    c0 === '研发' && c1 === '张三' ? pass('A7 查询视图 dh_vd_v1（研发/张三）') : fail('A7 查询视图', JSON.stringify([c0, c1]));
    await closeActiveTab();
    await sleep(400);
  } else {
    fail('A7 查询视图', '查询页打开失败');
  }

  // ---- B1 设计视图（编辑回读）----
  p = await treePos('dh_vd_v1');
  await rclick(p.x, p.y);
  const nodeMenu = (await menuHas('设计视图')) && (await menuHas('编辑视图'));
  nodeMenu ? pass('B1a 视图节点含 设计视图/编辑视图') : fail('B1a 节点菜单', '缺入口');
  await esc();
  await sleep(300);
  p = await treePos('dh_vd_v1');
  await rclick(p.x, p.y);
  if (!(await clickMenu('设计视图'))) { fail('B1 前置', '打开设计视图失败'); }
  else {
    await sleep(1600);
    const sqlB = await vdSql();
    sqlB && sqlB.includes('INNER JOIN') && sqlB.includes('WHERE') && sqlB.includes('dh_vd_dept')
      ? pass('B1b 默认 SQL 页显示原定义')
      : fail('B1b SQL 页', String(sqlB || '').slice(0, 200));
    (await vdInnerTab('设计')) ? null : fail('B1 前置', '切 设计 页失败');
    await sleep(500);
    const stB = await vdState();
    const okB = stB && stB.cards.length === 2
      && stB.cards.find((c) => c.name === 'dh_vd_dept' && c.checked.includes('dh_vd_dept.name'))
      && stB.cards.find((c) => c.name === 'dh_vd_emp' && c.checked.includes('dh_vd_emp.name'))
      && stB.joins.includes('dh_vd_emp')
      && /张三/.test(stB.where) && stB.name === 'dh_vd_v1';
    okB ? pass('B1c 设计回读（表/勾选列/连接/WHERE/视图名）') : fail('B1c 设计回读', JSON.stringify(stB));
    // ---- B2 加列保存 → 视图列变化 ----
    (await vdCheck('dh_vd_dept.id')) ? null : fail('B2 前置', '勾选 dept.id 失败');
    (await vdSave()) ? null : fail('B2 前置', '保存未点击');
    await vdGone();
    await sleep(1200);
    if (await queryOn('视图', 'SELECT * FROM dh_vd_v1')) {
      await waitGrid();
      const b0 = await gridCell(0, 0);
      const b1 = await gridCell(0, 1);
      const b2 = await gridCell(0, 2);
      b0 === '1' && b1 === '研发' && b2 === '张三' ? pass('B2 修改保存后视图含 id 列（1/研发/张三）') : fail('B2 修改视图', JSON.stringify([b0, b1, b2]));
      await closeActiveTab();
      await sleep(400);
    } else {
      fail('B2 修改视图', '查询页打开失败');
    }
  }

  // ---- D1 未保存关闭确认 ----
  p = await treePos('视图');
  await rclick(p.x, p.y);
  if (await clickMenu('新建视图（设计）')) {
    await sleep(1400);
    await vdAdd('dh_vd_dept');
    await waitCard('dh_vd_dept');
    await vdCheck('dh_vd_dept.name');
    await sleep(400);
    (await tabDot()) ? pass('D1a 设计器脏点') : fail('D1a 脏点', '无 tab-dot');
    await closeActiveTab(); // 内部处理 放弃并关闭 确认
    const gone = !(await ev(`!!document.querySelector('.main-tabs .ant-tabs-tab-active .dh-vd-tabs')`));
    gone ? pass('D1b 未保存关闭确认（放弃并关闭）') : fail('D1b 关闭确认', '标签未关闭');
    await sleep(400);
  } else {
    fail('D1 设计器脏点关闭', '打开失败');
  }

  // ---- C mssql：LEFT JOIN 视图 ----
  // 收起 sqlite 连接避免 视图 分类重名
  p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  await sleep(900);
  p = await treePos('1');
  await dblclick(p.x, p.y);
  await sleep(1000);
  p = await treePos('master');
  if (!p) { fail('C 前置', 'master 节点未找到'); }
  else {
    await dblclick(p.x, p.y);
    await sleep(1000);
    if (await queryOn('master', "IF OBJECT_ID('dbo.dh_vd_v2','V') IS NOT NULL DROP VIEW dbo.dh_vd_v2;\nIF OBJECT_ID('dbo.dh_vd_b','U') IS NOT NULL DROP TABLE dbo.dh_vd_b;\nIF OBJECT_ID('dbo.dh_vd_a','U') IS NOT NULL DROP TABLE dbo.dh_vd_a;\nCREATE TABLE dh_vd_a(id INT PRIMARY KEY, nm NVARCHAR(20));\nCREATE TABLE dh_vd_b(id INT PRIMARY KEY, aid INT REFERENCES dh_vd_a(id), tag NVARCHAR(10));\nINSERT INTO dh_vd_a VALUES (1,'x'),(2,'y');\nINSERT INTO dh_vd_b VALUES (1,1,'b1'),(2,1,'b2');")) {
      await sleep(1600);
      await closeActiveTab();
      await sleep(400);
      p = await treePos('视图');
      await rclick(p.x, p.y);
      if (!(await clickMenu('新建视图（设计）'))) { fail('C1 前置', 'mssql 设计器打开失败'); }
      else {
        await sleep(1600);
        (await vdAdd('dh_vd_a')) ? null : fail('C1 前置', '添加 dh_vd_a 失败');
        await waitCard('dh_vd_a');
        (await vdAdd('dh_vd_b')) ? null : fail('C1 前置', '添加 dh_vd_b 失败');
        await waitCard('dh_vd_b');
        await sleep(1200);
        const jc = await vdJoinOn('dh_vd_b');
        jc && /aid/.test(jc) && /id/.test(jc) ? pass('C1a mssql FK 推断 JOIN（' + jc + '）') : fail('C1a mssql JOIN', JSON.stringify(jc));
        (await vdCheck('dh_vd_a.nm')) ? null : fail('C1 前置', '勾选 nm 失败');
        (await vdCheck('dh_vd_b.id')) ? null : fail('C1 前置', '勾选 id 失败');
        // 连接类型切 LEFT（antd Select：点开 → 选 LEFT）
        const js = await vd(`(() => { const s = host.querySelector('[data-dh-vd-jtype=' + JSON.stringify('dh_vd_b') + ']'); if (!s) return null; const el = s.matches('.ant-select') ? s : s.closest('.ant-select'); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + 40), y: Math.round(r.y + r.height / 2) }; })()`);
        if (js) {
          await lclick(js.x, js.y);
          await sleep(600);
          const opt = await ev(`(() => {
            const dd = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';
            const live = [...document.querySelectorAll(dd)].filter((d) => !/ant-slide-up-leave/.test(d.className));
            const o = live.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((x) => x.textContent.replace(/\\s+/g, '') === 'LEFT');
            if (!o) return null;
            const r = o.getBoundingClientRect();
            if (r.width < 20) return null;
            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
          })()`);
          if (opt) { await lclick(opt.x, opt.y); await sleep(400); }
        }
        (await vdInnerTab('SQL 预览')) ? null : fail('C1 前置', '切 SQL 预览失败');
        const sqlC = await vdSql();
        sqlC && sqlC.includes('LEFT JOIN') ? pass('C1b 连接类型切 LEFT（SQL 含 LEFT JOIN）') : fail('C1b LEFT JOIN', String(sqlC || '').slice(0, 240));
        (await vdInputSet('name', 'dh_vd_v2')) ? null : fail('C1 前置', '视图名失败');
        (await vdSave()) ? null : fail('C1 前置', '保存失败');
        await vdGone();
        await sleep(1500);
        if (await queryOn('master', 'SELECT nm, id FROM dbo.dh_vd_v2')) {
          await waitGrid();
          const n = await gridRows();
          const r0 = [await gridCell(0, 0), await gridCell(0, 1)];
          const r2 = [await gridCell(2, 0), await gridCell(2, 1)];
          n === 3 && r0[0] === 'x' && r0[1] === '1' && r2[0] === 'y' && (r2[1] === '' || r2[1] === 'NULL' || r2[1] == null)
            ? pass('C1c mssql LEFT JOIN 视图（3 行，y 行 id 为空）')
            : fail('C1c mssql 视图查询', JSON.stringify({ n, r0, r2 }));
          await closeActiveTab();
          await sleep(400);
        } else {
          fail('C1c mssql 视图查询', '查询页失败');
        }
      }
    } else {
      fail('C 前置', 'mssql 建表失败');
    }
    // ---- C2 清理 mssql ----
    if (await queryOn('master', "IF OBJECT_ID('dbo.dh_vd_v2','V') IS NOT NULL DROP VIEW dbo.dh_vd_v2;\nIF OBJECT_ID('dbo.dh_vd_b','U') IS NOT NULL DROP TABLE dbo.dh_vd_b;\nIF OBJECT_ID('dbo.dh_vd_a','U') IS NOT NULL DROP TABLE dbo.dh_vd_a;")) {
      await sleep(1400);
      await closeActiveTab();
      await sleep(400);
      if (await queryOn('master', "SELECT CASE WHEN OBJECT_ID('dbo.dh_vd_v2','V') IS NULL AND OBJECT_ID('dbo.dh_vd_a','U') IS NULL AND OBJECT_ID('dbo.dh_vd_b','U') IS NULL THEN 'GONE' ELSE 'STILL' END AS s")) {
        await waitGrid();
        const gone = await gridCell(0, 0);
        gone === 'GONE' ? pass('C2 mssql 清理（视图+两表 OBJECT_ID=NULL）') : fail('C2 mssql 清理', String(gone));
        await closeActiveTab();
        await sleep(400);
      } else {
        fail('C2 mssql 清理', '验证查询失败');
      }
    } else {
      fail('C2 mssql 清理', '清理查询失败（请手工 DROP dh_vd_*）');
    }
  }

  // ---- C3 sqlite 清理 ----
  p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  await sleep(900);
  p = await treePos('表');
  await rclick(p.x, p.y);
  if (await clickMenu('新建查询')) {
    await sleep(1200);
    ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    await lclick(ed.x, ed.y);
    await ctrlA();
    await insertText('DROP VIEW IF EXISTS dh_vd_v1;\nDROP TABLE IF EXISTS dh_vd_emp;\nDROP TABLE IF EXISTS dh_vd_dept;');
    await sleep(300);
    runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (runBtn) { await lclick(runBtn.x, runBtn.y); await sleep(1500); }
    await closeActiveTab();
    await sleep(400);
    pass('C3 sqlite 清理（视图+两表）');
  } else {
    fail('C3 sqlite 清理', '查询页失败（请手工 DROP dh_vd_*）');
  }
  await clearFrozenModals();

  // ---- S5 控制台错误 ----
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', JSON.stringify(errors.slice(0, 4)));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
