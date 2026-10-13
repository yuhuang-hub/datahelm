'use strict';
// v0927.52 SQL 智能补全 — UI 端到端验证（9227 测试实例，无外部夹具：
//   sqlite 用演示库 employees；mssql 现场建 w42_sn 并在结尾 DROP）
//  S0 状态栏版本 v0927.52
//  U0 连接右键「新建查询」→ sqlite 查询页编辑器就绪
//  T1 关键字补全：输入 SEL 弹出 SELECT
//  T2 片段 ssf：选中回车 → 展开 SELECT * FROM 表名
//  T3 片段 up：展开 UPDATE 骨架（SET 列 = 值 / WHERE 条件 占位）
//  T4 FROM 上下文：FROM emp → 顶选 employees 回车上屏
//  T5 列名上下文：FROM employees WHERE n → name 列置顶（boost 优先）
//  T6 别名感知：FROM employees e → e.n 弹出 employees.name
//  T7a mssql 建表 w42_sn + FROM w42_s → w42_sn 上屏
//  T7b mssql 列名上下文：FROM w42_sn WHERE n → nm 列（结尾 DROP 清理）
//  S5 无控制台错误
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(280); };
  const clickAt = async (x, y) => { await press(x, y, 'left', 1); await sleep(280); };
  const rclick = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
    await sleep(450);
  };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(140);
  };
  const insertText = (t) => Input.insertText({ text: t });
  const escKey = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(240);
  };
  const keyTap = async (key, vk) => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key, code: key, windowsVirtualKeyCode: vk });
    await Input.dispatchKeyEvent({ type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk });
    await sleep(110);
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- 侧栏树 ----
  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, tries = 14) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title); if (p) return p; await sleep(500); }
    return null;
  };
  const clickCtx = async (kw) => {
    for (let i = 0; i < 8; i += 1) {
      const p = await ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((x) => x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}) && x.getBoundingClientRect().width > 0); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (p) { await lclick(p.x, p.y); return true; }
      await sleep(300);
    }
    return false;
  };

  // ---- 查询页编辑器 ----
  const edReady = async (tries = 20) => {
    for (let i = 0; i < tries; i += 1) {
      const ok = await ev("!!document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')");
      if (ok) return true;
      await sleep(500);
    }
    return false;
  };
  const edPos = async () => ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
  const editorText = async () => ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; return [...e.querySelectorAll('.cm-line')].map((l) => l.textContent).join('\\n'); })()`);
  // 整体替换文档并在末尾逐字符补打（每次输入都会触发补全查询）
  const setDoc = async (base) => {
    const p = await edPos();
    await clickAt(p.x, p.y);
    await ctrlA();
    await insertText(base);
    await sleep(260);
  };
  const typeChars = async (s) => { for (const ch of s) { await insertText(ch); await sleep(150); } };
  const tipInfo = async () => ev(`(() => {
    const t = [...document.querySelectorAll('.cm-tooltip-autocomplete')].find((x) => x.getBoundingClientRect().width > 0);
    if (!t) return null;
    const lis = [...t.querySelectorAll('ul li')];
    const lbl = (li) => { const l = li.querySelector('.cm-completionLabel'); return (l || li).textContent; };
    const selEl = t.querySelector('ul li.cm-completionOptionSelected') || t.querySelector('ul li[aria-selected="true"]');
    return { labels: lis.map(lbl), sel: selEl ? lbl(selEl) : null };
  })()`);
  const waitTip = async (tries = 12) => {
    for (let i = 0; i < tries; i += 1) { const t = await tipInfo(); if (t && t.labels.length) return t; await sleep(400); }
    return null;
  };
  // 在补全菜单里把选中项走到目标 label 再回车（顺序不确定时也稳）
  const pickTip = async (label) => {
    let t = await waitTip();
    if (!t) return false;
    for (let i = 0; i < 8 && t.sel !== label; i += 1) {
      if (!t.labels.includes(label)) return false;
      await keyTap('ArrowDown', 40);
      t = await tipInfo();
      if (!t) return false;
    }
    if (t.sel !== label) return false;
    await keyTap('Enter', 13);
    await sleep(400);
    return true;
  };

  // ---- 连接/库下拉 + SQL 运行（复用 round19 模式） ----
  const selectOpen = async (sel) => {
    const p = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active ${sel} .ant-select-selector'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(380);
    return true;
  };
  const pickOption = async (label, tries = 10) => {
    for (let i = 0; i < tries; i += 1) {
      const o = await ev(`(() => {
        const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
        if (!dd) return null;
        const it = [...dd.querySelectorAll('.ant-select-item-option')].find((x) => x.textContent.trim() === ${JSON.stringify(label)});
        if (!it) return null;
        const dr = dd.getBoundingClientRect();
        const or = it.getBoundingClientRect();
        const cy = or.y + or.height / 2;
        if (cy < dr.y || cy > dr.y + dr.height) {
          const sc = dd.querySelector('.rc-virtual-list');
          if (sc) sc.scrollTop = cy > dr.y + dr.height ? sc.scrollHeight : 0;
          return { scrolled: true };
        }
        return { x: Math.round(or.x + or.width / 2), y: Math.round(cy) };
      })()`);
      if (!o) { await sleep(400); continue; }
      if (o.scrolled) { await sleep(250); continue; }
      await clickAt(o.x, o.y);
      return true;
    }
    return false;
  };
  const gridCell = (r0, c0) => ev(`(() => {
    const row = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[${r0}];
    if (!row) return null;
    const cell = row.querySelectorAll('.cell')[${c0}];
    return cell ? cell.textContent : null;
  })()`);
  const waitCell = async (tries = 20) => {
    for (let i = 0; i < tries; i += 1) {
      const v = await gridCell(0, 0);
      if (v != null && v !== '') return v;
      await sleep(500);
    }
    return null;
  };
  const runSql = async (sql) => {
    await setDoc(sql);
    const b = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await clickAt(b.x, b.y);
    await sleep(700);
    return true;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 状态栏版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 打开 sqlite 查询页 ----
  const conn = await waitTree('演示 SQLite 库');
  let u0 = !!conn;
  if (u0) {
    await rclick(conn.x, conn.y);
    u0 = await clickCtx('新建查询');
  }
  if (u0) u0 = await edReady();
  u0 ? pass('U0 连接右键新建查询 → 编辑器就绪') : fail('U0 打开查询页', '节点/菜单/编辑器未就绪');

  // ---- T1 关键字补全 ----
  if (u0) {
    await setDoc('');
    await typeChars('SEL');
    const t = await waitTip();
    t && t.labels.includes('SELECT') ? pass('T1 输入 SEL → 菜单含 SELECT 关键字') : fail('T1 关键字补全', JSON.stringify(t && t.labels.slice(0, 8)));
    await escKey();
  }

  // ---- T2 片段 ssf ----
  if (u0) {
    await setDoc('');
    await typeChars('ssf');
    const ok2 = await pickTip('ssf');
    const txt = await editorText();
    ok2 && txt.includes('SELECT *') && txt.includes('FROM 表名')
      ? pass('T2 片段 ssf 回车 → 展开 SELECT * FROM 表名')
      : fail('T2 ssf 展开', JSON.stringify({ ok2, txt: txt && txt.slice(0, 80) }));
    await escKey();
  }

  // ---- T3 片段 up ----
  if (u0) {
    await setDoc('');
    await typeChars('up');
    const ok3 = await pickTip('up');
    const txt = await editorText();
    ok3 && txt.includes('UPDATE 表名') && txt.includes('SET 列 = 值') && txt.includes('WHERE 条件')
      ? pass('T3 片段 up → UPDATE 骨架（SET/WHERE 占位）')
      : fail('T3 up 展开', JSON.stringify({ ok3, txt: txt && txt.slice(0, 100) }));
    await escKey();
  }

  // ---- T4 FROM 上下文表名 ----
  if (u0) {
    await setDoc('SELECT * FROM ');
    await typeChars('emp');
    const t4 = await waitTip();
    const ok4 = t4 && t4.labels.includes('employees') ? await pickTip('employees') : false;
    const txt = await editorText();
    ok4 && txt.includes('FROM employees')
      ? pass('T4 FROM emp → employees 上屏')
      : fail('T4 FROM 表名补全', JSON.stringify({ labels: t4 && t4.labels.slice(0, 10), txt: txt && txt.slice(0, 80) }));
    await escKey();
  }

  // ---- T5 列名上下文（name 置顶） ----
  if (u0) {
    await setDoc('SELECT * FROM employees WHERE ');
    await typeChars('n');
    const t = await waitTip(15);
    t && t.labels[0] === 'name' && t.labels.includes('name')
      ? pass('T5 WHERE n → name 列置顶（列名优先于关键字）')
      : fail('T5 列名上下文', JSON.stringify(t && t.labels.slice(0, 8)));
    await escKey();
  }

  // ---- T6 别名感知 ----
  if (u0) {
    await setDoc('SELECT * FROM employees e WHERE ');
    await typeChars('e.n');
    const t = await waitTip(15);
    t && t.labels.includes('name')
      ? pass('T6 别名 e.n → employees.name')
      : fail('T6 别名列名', JSON.stringify(t && t.labels.slice(0, 8)));
    await escKey();
  }

  // ---- T7 mssql：建表 + FROM/列名上下文 ----
  if (u0) {
    let t7 = true;
    if (!(await selectOpen('.q-conn-select')) || !(await pickOption('1'))) { fail('T7a 切换连接', '打不开/选不到 mssql 连接'); t7 = false; }
    else {
      // 自动连接（.q-server 出现 serverInfo）
      let srv = '';
      for (let i = 0; i < 30 && !srv; i += 1) { srv = await ev("(() => { const e = document.querySelector('.ant-tabs-tabpane-active .q-server'); return e ? e.textContent.trim() : ''; })()"); if (!srv) await sleep(500); }
      if (!srv) { fail('T7a 自动连接', 'serverInfo 未出现'); t7 = false; }
    }
    if (t7) {
      let dbOk = false;
      for (let i = 0; i < 6 && !dbOk; i += 1) { dbOk = (await selectOpen('.q-db-select')) && (await pickOption('master')); if (!dbOk) await sleep(600); }
      if (!dbOk) { fail('T7a 选库', 'master 选不到'); t7 = false; }
    }
    if (t7) {
      const DDL = "CREATE TABLE dbo.w42_sn (id INT PRIMARY KEY, nm NVARCHAR(20));\nINSERT INTO dbo.w42_sn (id, nm) VALUES (1, N'补全');";
      let cnt = null;
      for (let i = 0; i < 2 && cnt !== '1'; i += 1) {
        await runSql(DDL);
        await runSql('SELECT COUNT(*) AS c FROM dbo.w42_sn');
        cnt = await waitCell(16);
      }
      if (cnt !== '1') { fail('T7a 建表插数', 'COUNT != 1 got ' + cnt); t7 = false; }
    }
    if (t7) {
      await setDoc('SELECT * FROM ');
      await typeChars('w42_s');
      const tA = await waitTip();
      const okA = tA && tA.labels.includes('w42_sn') ? await pickTip('w42_sn') : false;
      const txt = await editorText();
      if (okA && txt.includes('FROM w42_sn')) pass('T7a mssql FROM w42_s → w42_sn 上屏');
      else { fail('T7a FROM 补全', JSON.stringify({ labels: tA && tA.labels.slice(0, 10), txt: txt && txt.slice(0, 80) })); t7 = false; }
      await escKey();
    }
    if (t7) {
      await setDoc('SELECT * FROM w42_sn WHERE ');
      await typeChars('n');
      const t = await waitTip(15);
      t && t.labels.includes('nm')
        ? pass('T7b mssql WHERE n → nm 列')
        : fail('T7b mssql 列名', JSON.stringify(t && t.labels.slice(0, 8)));
      await escKey();
    }
    // 清理（失败也尝试）
    await runSql("IF OBJECT_ID(N'dbo.w42_sn', N'U') IS NOT NULL DROP TABLE dbo.w42_sn;");
    await sleep(600);
  }

  // ---- S5 控制台错误 ----
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', JSON.stringify(errors.slice(0, 4)));
  console.log('ROUND42-DONE');
  try { await client.close(); } catch {}
})().catch((e) => { console.error('ROUND42-FATAL', e && e.message); process.exit(1); });
