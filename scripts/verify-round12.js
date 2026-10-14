'use strict';
// v0927.53 数据传输向导验证（sqlite 9227 实例 + localhost MSSQL master + 临时 sqlite 目标连接）：
//  A 表右键入口：向导预勾选/选项默认值；sqlite→mssql 结构+数据（跨方言类型映射）；INFORMATION_SCHEMA 回读类型与行数
//  策略矩阵：仅结构 / 已存在=跳过 / 已存在=报错（遇错继续）
//  B 表分类入口：无预勾选 + 全选/反选；sqlite→sqlite 目标连接（自动建库文件）；离线核验目标库
//  D mssql 库节点右键含 数据传输… 入口
//  C 清理：sqlite 源表删除、mssql 临时表删除（OBJECT_ID 判空）
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
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
  const menuHas = (kw) => ev(`!![...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}))`);
  const clickMenu = async (kw, tries = 5) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => {
        const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}));
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
  const liveModal = (body) => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => { const m = x.querySelector('.ant-modal'); return m && !/ant-zoom-leave/.test(m.className) && getComputedStyle(x).display !== 'none'; }); if (!w) return null; const host = w; return (${body}); })()`);
  const modalBtn = async (kw) => {
    const b = await liveModal(`(() => { const b = [...host.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const modalClose = async () => {
    const x = await liveModal(`(() => { const c = host.querySelector('.ant-modal-close'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!x) return false;
    await lclick(x.x, x.y);
    await sleep(450);
    return true;
  };
  const clearFrozenModals = () => ev(`(() => { let n = 0; document.querySelectorAll('.ant-modal-wrap').forEach((w) => { const m = w.querySelector('.ant-modal'); if (m && /ant-zoom-leave/.test(m.className)) { w.remove(); n += 1; } }); return n; })()`);
  const closeActiveTab = async () => {
    const c = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (c) { await lclick(c.x, c.y); await sleep(700); }
    // 查询页有未保存内容时弹确认 → 放弃并关闭（否则遮罩挡住后续所有点击）
    if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) {
      await modalBtn('放弃并关闭');
      await sleep(700);
    }
    await clearFrozenModals();
  };
  // ---- 数据传输向导辅助 ----
  const trState = () => liveModal(`(() => {
    const t = host.querySelector('.ant-modal-title');
    const src = host.querySelector('[data-dh-tr="src"]');
    const rows = [...host.querySelectorAll('[data-dh-tr-name]')].map((r) => ({ name: r.getAttribute('data-dh-tr-name'), checked: !!(r.querySelector('input[type="checkbox"]') || {}).checked }));
    const allEl = host.querySelector('[data-dh-tr="all"]');
    const all = allEl ? (allEl.matches('input') ? allEl : allEl.querySelector('input')) : null;
    const radios = {};
    host.querySelectorAll('.ant-radio-wrapper').forEach((w) => { const i = w.querySelector('input'); if (i) radios[w.textContent.replace(/\\s+/g, '')] = !!i.checked; });
    // antd Checkbox 把 data-* 透传到 input 上（rc-checkbox 余参进 input）
    const ce = host.querySelector('[data-dh-tr="conterr"]');
    const ceInput = ce ? (ce.matches('input') ? ce : ce.querySelector('input')) : null;
    const sel = src ? src.textContent.match(/已选\\s*(\\d+)\\/(\\d+)/) : null;
    return { title: t ? t.textContent.trim() : null, srcText: src ? src.textContent.replace(/\\s+/g, '') : '', rows, allChecked: !!all && !!all.checked, radios, contErr: !!ceInput && !!ceInput.checked, sel: sel ? [Number(sel[1]), Number(sel[2])] : null };
  })()`);
  const trCheck = async (name) => {
    const p = await liveModal(`(() => { const r = host.querySelector('[data-dh-tr-name=' + JSON.stringify(${JSON.stringify(name)}) + '] input[type="checkbox"]'); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const trAll = async () => {
    const p = await liveModal(`(() => { const r = host.querySelector('[data-dh-tr="all"]'); const i = r ? (r.matches('input') ? r : r.querySelector('input')) : null; if (!i) return null; const b = i.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const trRadio = async (label) => {
    const p = await liveModal(`(() => { const w = [...host.querySelectorAll('.ant-radio-wrapper')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!w) return null; const b = w.getBoundingClientRect(); return { x: Math.round(b.x + Math.min(b.width / 2, 60)), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const trSelectDst = async (optText) => {
    const p = await liveModal(`(() => { const s = [...host.querySelectorAll('.ant-select')].find((x) => { const ph = x.querySelector('.ant-select-selection-placeholder'); return ph && /选择目标连接/.test(ph.textContent); }); if (!s) return null; const b = s.getBoundingClientRect(); return { x: Math.round(b.x + Math.min(b.width / 2, 60)), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(500);
    for (let i = 0; i < 6; i += 1) {
      const o = await ev(`(() => {
        const dd = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';
        const live = [...document.querySelectorAll(dd)].filter((d) => !/ant-slide-up-leave/.test(d.className));
        const o = live.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(optText)});
        if (!o) return null;
        const r = o.getBoundingClientRect();
        if (r.width < 20 || r.height < 16) return { bad: true };
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (o && !o.bad) {
        await lclick(o.x, o.y);
        await sleep(300);
        return true;
      }
      await sleep(400);
    }
    return false;
  };
  const trInput = async (placeholder, value) => {
    const p = await liveModal(`(() => { const i = [...host.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(placeholder)}); if (!i) return null; const b = i.getBoundingClientRect(); return { x: Math.round(b.x + Math.min(b.width / 2, 60)), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await ctrlA();
    await insertText(value);
    await sleep(250);
    return true;
  };
  const trRun = () => modalBtn('开始传输');
  const trLog = () => liveModal(`(() => { const l = host.querySelector('[data-dh-tr="logs"]'); return l ? l.textContent : null; })()`);
  const waitLog = async (re, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const t = await trLog();
      if (t && re.test(t)) return t;
      await sleep(700);
    }
    return trLog();
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

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.53') ? pass('S0 状态栏 v0927.53') : fail('S0 状态栏 v0927.53', sb);

  // ---- A0 sqlite 建源表（dh_ 前缀，便于清理；列覆盖 INT/TEXT/REAL/VARCHAR/DATE 类型族）----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('A0 前置', '表 分类无 新建查询'); await client.close(); return; }
  await sleep(1200);
  let ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
  await lclick(ed.x, ed.y);
  await ctrlA();
  await insertText("DROP TABLE IF EXISTS dh_src_emp;\nCREATE TABLE dh_src_emp(id INTEGER PRIMARY KEY, name TEXT NOT NULL, salary REAL, dept VARCHAR(20), hired TEXT);\nINSERT INTO dh_src_emp VALUES (1,'张三',5500.5,'研发','2024-01-15'),(2,'李四',6200,'销售','2024-02-20'),(3,'王五',7300.25,'研发','2023-12-01');");
  await sleep(300);
  let runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!runBtn) { fail('A0 前置', '无 运行 按钮'); await client.close(); return; }
  await lclick(runBtn.x, runBtn.y);
  await sleep(2000);
  await closeActiveTab();
  await sleep(400);
  await clearFrozenModals();
  // 展开表分类 → 刷新（子节点已渲染后重拉，dh_src_emp 才可见）
  p = await treePos('表');
  await dblclick(p.x, p.y);
  await sleep(900);
  await rclick(p.x, p.y);
  await clickMenu('刷新');
  await sleep(1300);
  p = await treePos('dh_src_emp');
  if (!p) { fail('A0 前置', 'dh_src_emp 未出现在树'); await client.close(); return; }
  pass('A0 sqlite 源表 dh_src_emp（3 行）');

  // ---- A1 表右键 → 向导：预勾选/默认选项 ----
  await rclick(p.x, p.y);
  if (!(await clickMenu('数据传输'))) { fail('A1 前置', '表右键无 数据传输… 菜单'); await client.close(); return; }
  await sleep(1000);
  const st1 = await trState();
  st1 && st1.title === '数据传输' && /演示SQLite库/.test(st1.srcText)
    ? pass('A1a 向导标题+源信息')
    : fail('A1a 向导标题/源', JSON.stringify(st1).slice(0, 200));
  st1 && st1.rows.length === 2 && st1.rows.find((r) => r.name === 'dh_src_emp' && r.checked) && st1.rows.find((r) => r.name === 'employees' && !r.checked) && st1.sel && st1.sel[0] === 1 && st1.sel[1] === 2
    ? pass('A1b 表右键入口预勾选当前表（1/2）')
    : fail('A1b 预勾选', JSON.stringify(st1 && st1.rows) + ' sel=' + JSON.stringify(st1 && st1.sel));
  st1 && st1.radios['结构+数据'] && st1.radios['删除重建'] && st1.contErr && !st1.radios['仅结构'] && !st1.radios['跳过'] && !st1.radios['报错']
    ? pass('A1c 默认选项（结构+数据/删除重建/遇错继续）')
    : fail('A1c 默认选项', JSON.stringify(st1 && st1.radios));

  // ---- A2 sqlite → mssql 结构+数据 ----
  (await trSelectDst('1（SQLServer）')) ? null : fail('A2 前置', '目标连接未选中');
  await trInput('目标数据库名', 'master');
  await trInput('dbo', 'dbo');
  (await trRun()) ? null : fail('A2 前置', '开始传输 未点击');
  const lg2 = await waitLog(/dh_src_emp：完成，写入 3 行/);
  lg2 && /dh_src_emp：完成，写入 3 行/.test(lg2) && /结束：成功 1、跳过 0、失败 0/.test(lg2)
    ? pass('A2 sqlite→mssql 传输（3 行+汇总）')
    : fail('A2 传输日志', String(lg2 || '').slice(0, 240));
  await modalClose();

  // ---- A3 mssql 回读：行数 + 跨方言类型映射 ----
  p = await treePos('1');
  if (p) { await dblclick(p.x, p.y); await sleep(900); }
  if (!(await queryOn('master', "SELECT CASE WHEN OBJECT_ID('dbo.dh_src_emp','U') IS NULL THEN 'MISSING' ELSE 'OK' END AS s"))) { fail('A3 前置', 'master 查询页失败'); }
  else {
    let a3 = null;
    for (let i = 0; i < 10 && a3 == null; i += 1) { a3 = await gridCell(0, 0); if (a3 == null) await sleep(400); }
    a3 === 'OK' ? pass('A3a mssql 目标表存在') : fail('A3a mssql 目标表', String(a3));
    await closeActiveTab();
    await sleep(400);
    await queryOn('master', "SELECT k.col, c.DATA_TYPE FROM (SELECT 'id' AS col UNION ALL SELECT 'name' UNION ALL SELECT 'salary' UNION ALL SELECT 'dept') k JOIN INFORMATION_SCHEMA.COLUMNS c ON c.TABLE_SCHEMA='dbo' AND c.TABLE_NAME='dh_src_emp' AND c.COLUMN_NAME=k.col ORDER BY k.col");
    await waitGrid();
    const n3 = await gridRows();
    const t = {};
    for (let i = 0; i < (n3 || 0); i += 1) t[String(await gridCell(i, 0))] = String(await gridCell(i, 1));
    t.id === 'bigint' && t.name === 'nvarchar' && t.salary === 'float' && t.dept === 'nvarchar'
      ? pass('A3b 跨方言类型映射（INTEGER→BIGINT/TEXT→NVARCHAR/REAL→FLOAT/VARCHAR→NVARCHAR）')
      : fail('A3b 类型映射', JSON.stringify(t));
    await closeActiveTab();
    await sleep(400);
    await queryOn('master', 'SELECT COUNT(*) AS c FROM dbo.dh_src_emp');
    await waitGrid();
    const c3 = await gridCell(0, 0);
    c3 === '3' ? pass('A3c mssql 行数=3') : fail('A3c mssql 行数', String(c3));
    await closeActiveTab();
    await sleep(400);
  }

  // ---- A4 仅结构 ----
  p = await treePos('dh_src_emp');
  await rclick(p.x, p.y);
  await clickMenu('数据传输');
  await sleep(900);
  await trSelectDst('1（SQLServer）');
  await trInput('目标数据库名', 'master');
  await trInput('dbo', 'dbo');
  await trRadio('仅结构');
  await trRun();
  const lg4 = await waitLog(/结构已创建/);
  lg4 && /dh_src_emp：结构已创建/.test(lg4) ? pass('A4 仅结构日志') : fail('A4 仅结构', String(lg4 || '').slice(0, 200));
  await modalClose();
  await queryOn('master', 'SELECT COUNT(*) AS c FROM dbo.dh_src_emp');
  await waitGrid();
  const c4 = await gridCell(0, 0);
  c4 === '0' ? pass('A4b 仅结构后行数=0（重建未拷数据）') : fail('A4b 仅结构行数', String(c4));
  await closeActiveTab();
  await sleep(400);

  // ---- A5 已存在=跳过 ----
  p = await treePos('dh_src_emp');
  await rclick(p.x, p.y);
  await clickMenu('数据传输');
  await sleep(900);
  await trSelectDst('1（SQLServer）');
  await trInput('目标数据库名', 'master');
  await trInput('dbo', 'dbo');
  await trRadio('跳过');
  await trRun();
  const lg5 = await waitLog(/跳过（目标已存在）/);
  lg5 && /dh_src_emp：跳过（目标已存在）/.test(lg5) && /结束：成功 0、跳过 1、失败 0/.test(lg5)
    ? pass('A5 已存在=跳过')
    : fail('A5 跳过', String(lg5 || '').slice(0, 200));
  await modalClose();
  await queryOn('master', 'SELECT COUNT(*) AS c FROM dbo.dh_src_emp');
  await waitGrid();
  const c5 = await gridCell(0, 0);
  c5 === '0' ? pass('A5b 跳过后数据未变（0 行）') : fail('A5b 跳过后行数', String(c5));
  await closeActiveTab();
  await sleep(400);

  // ---- A6 已存在=报错 + 遇错继续 ----
  p = await treePos('dh_src_emp');
  await rclick(p.x, p.y);
  await clickMenu('数据传输');
  await sleep(900);
  await trSelectDst('1（SQLServer）');
  await trInput('目标数据库名', 'master');
  await trInput('dbo', 'dbo');
  await trRadio('报错');
  await trRun();
  const lg6 = await waitLog(/失败：目标已存在同名表/);
  lg6 && /dh_src_emp：失败：目标已存在同名表/.test(lg6) && /结束：成功 0、跳过 0、失败 1/.test(lg6)
    ? pass('A6 已存在=报错（继续执行完）')
    : fail('A6 报错策略', String(lg6 || '').slice(0, 200));
  await modalClose();

  // ---- B1 表分类入口：无预勾选 + 全选/反选 ----
  p = await treePos('表');
  await rclick(p.x, p.y);
  if (!(await clickMenu('数据传输'))) { fail('B1 前置', '表分类无 数据传输… 菜单'); }
  else {
    await sleep(1000);
    const stB = await trState();
    stB && stB.rows.length === 2 && stB.rows.every((r) => !r.checked) && stB.sel && stB.sel[0] === 0
      ? pass('B1a 分类入口无预勾选（0/2）')
      : fail('B1a 分类入口', JSON.stringify(stB && stB.rows) + ' sel=' + JSON.stringify(stB && stB.sel));
    await trAll();
    let stB2 = await trState();
    stB2 && stB2.sel && stB2.sel[0] === 2 ? pass('B1b 全选（2/2）') : fail('B1b 全选', JSON.stringify(stB2 && stB2.sel));
    await trAll();
    stB2 = await trState();
    stB2 && stB2.sel && stB2.sel[0] === 0 ? pass('B1c 反选（0/2）') : fail('B1c 反选', JSON.stringify(stB2 && stB2.sel));
    await trCheck('dh_src_emp');

    // ---- B2 sqlite → 传输目标SQLite（自动建库文件；无 库/schema 输入） ----
    (await trSelectDst('传输目标SQLite（SQLite）')) ? null : fail('B2 前置', '目标连接未选中');
    const noDbInput = await liveModal(`(() => !host.querySelector('input[placeholder="目标数据库名"]'))()`);
    noDbInput ? pass('B2a sqlite 目标无 库/schema 输入') : fail('B2a sqlite 目标输入', '仍显示目标数据库输入');
    await trRun();
    const lgB = await waitLog(/dh_src_emp：完成，写入 3 行/);
    lgB && /结束：成功 1、跳过 0、失败 0/.test(lgB) ? pass('B2b sqlite→sqlite 传输（3 行）') : fail('B2b sqlite→sqlite', String(lgB || '').slice(0, 200));
    await modalClose();
  }

  // 离线核验目标库文件（驱动 persist 后读）
  const offCheck = await new Promise((resolve) => {
    try {
      const initSqlJs = require('sql.js');
      const fs = require('fs');
      initSqlJs().then((SQL) => {
        const db = new SQL.Database(fs.readFileSync('D:/DataHelm/.tmp-ud7/transfer-dst.db'));
        const r = db.exec('SELECT COUNT(*) FROM dh_src_emp');
        resolve(String(r[0].values[0][0]));
      }).catch((e) => resolve('ERR ' + e.message));
    } catch (e) {
      resolve('ERR ' + e.message);
    }
  });
  offCheck === '3' ? pass('B2c 离线核验 transfer-dst.db=3 行') : fail('B2c 离线核验', offCheck);

  // ---- D0 mssql 库节点右键含 数据传输… 入口 ----
  p = await treePos('master');
  if (!p) {
    const c1 = await treePos('1');
    if (c1) { await dblclick(c1.x, c1.y); await sleep(900); }
    p = await treePos('master');
  }
  if (!p) { fail('D0 mssql 库节点', 'master 节点未找到'); }
  else {
    await rclick(p.x, p.y);
    (await menuHas('数据传输')) ? pass('D0 mssql 库节点 数据传输… 入口') : fail('D0 mssql 库节点入口', '菜单无该项');
    await esc();
    await sleep(300);
  }

  // ---- C 清理：sqlite 源表 + mssql 目标表 ----
  // conn 1 已展开但 master 未展开 → 其 表 分类未渲染，treePos('表') 仍命中 sqlite 分类
  p = await treePos('表');
  await rclick(p.x, p.y);
  if (await clickMenu('新建查询')) {
    await sleep(1200);
    ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    await lclick(ed.x, ed.y);
    await ctrlA();
    await insertText('DROP TABLE IF EXISTS dh_src_emp;');
    await sleep(300);
    runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (runBtn) { await lclick(runBtn.x, runBtn.y); await sleep(1500); }
    await closeActiveTab();
    await sleep(400);
    pass('C1 sqlite 源表清理');
  } else {
    fail('C1 sqlite 清理', '查询页打开失败（请手工 DROP dh_src_emp）');
  }
  await clearFrozenModals();
  // mssql：master 查询删除 + OBJECT_ID 判空
  if (!(await treePos('master'))) {
    const c1b = await treePos('1');
    if (c1b) { await dblclick(c1b.x, c1b.y); await sleep(900); }
  }
  if (await queryOn('master', "IF OBJECT_ID('dbo.dh_src_emp','U') IS NOT NULL DROP TABLE dbo.dh_src_emp;")) {
    await sleep(1200);
    await closeActiveTab();
    await sleep(400);
    if (await queryOn('master', "SELECT CASE WHEN OBJECT_ID('dbo.dh_src_emp','U') IS NULL THEN 'GONE' ELSE 'STILL' END AS s;")) {
      await waitGrid();
      const gone = await gridCell(0, 0);
      const dbg = gone == null
        ? JSON.stringify(await ev(`({ tabs: [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].map((t) => t.textContent.trim()), ed: [...document.querySelectorAll('.ant-tabs-tabpane-active .cm-content .cm-line')].map((x) => x.textContent).join('|').slice(0, 160), res: (() => { const r = document.querySelector('.ant-tabs-tabpane-active .query-results'); return r ? r.textContent.slice(0, 160) : null; })() })`))
        : '';
      gone === 'GONE' ? pass('C2 mssql 目标表清理（OBJECT_ID=NULL）') : fail('C2 mssql 清理', String(gone) + ' ' + dbg);
      await closeActiveTab();
      await sleep(400);
    } else {
      fail('C2 mssql 验证查询', '查询页打开失败（请手工确认 dbo.dh_src_emp 已删除）');
    }
  } else {
    fail('C2 mssql 清理', '查询页打开失败（请手工 DROP dbo.dh_src_emp）');
  }
  await clearFrozenModals();

  // ---- S5 控制台错误 ----
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', JSON.stringify(errors.slice(0, 4)));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
