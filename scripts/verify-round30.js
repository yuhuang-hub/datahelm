'use strict';
// v0927.53 查询解释（EXPLAIN 执行计划）验证（9229 新实例；自足式：sqlite 自建 dh_w30_t，mssql 用系统表）：
//  v0927.53 起解释结果默认「树形」视图：断言表格前先点 data-dh-q="plan-grid" 切到表格（页签名 结果1 → 执行计划）
//  T1 sqlite EQP：解释 SELECT … WHERE id=1 → 执行计划表格网格含 SEARCH + dh_w30_t
//  T2 计划列：sqlite EQP 表头含 detail
//  T3 mssql SHOWPLAN_TEXT：切连接/库 → 解释 COUNT(sys.databases) → 表头 StmtText + 行含 |-- 树形算子
//  T4 失败路径：解释不存在的表 → message toast + DH-EXPLAIN fail 落盘，无崩溃
//  T5 失败后不毒化：同一 mssql 会话再「运行」同句 → 正常数字结果（无 StmtText，SET SHOWPLAN OFF 已恢复）
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9229) });
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(300); };
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.height > 0 || r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const logHas = (kw) => {
    try { return fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8').includes(kw); } catch { return false; }
  };
  const DBG = !!process.env.DBG30;

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // 可见结果网格文本（ResultGrid 是 virtual 表：行=div、格=.cell；内层结果 Tabs 可能多个 pane-active，取有高度的）
  const gridInfo = () => ev(`(() => {
    const gs = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid')].filter((g) => g.getBoundingClientRect().height > 0);
    if (!gs.length) return null;
    const g = gs[gs.length - 1];
    const rows = [...g.querySelectorAll('.ant-table-row')].map((r) => [...r.querySelectorAll('.cell')].map((c) => c.textContent).join(' '));
    const head = [...g.querySelectorAll('.ant-table-thead th')].map((h) => h.textContent.trim());
    const tabs = [...document.querySelectorAll('.ant-tabs-tabpane-active .ant-tabs-tab')].map((t) => t.textContent.trim());
    return { head, rows, tabs: tabs.filter((t) => t.includes('结果') || t.includes('消息') || t.includes('执行计划')) };
  })()`);
  const waitGrid = async (kws, tries = 40) => {
    for (let i = 0; i < tries; i += 1) {
      const g = await gridInfo();
      const text = g ? [g.head.join(' '), ...g.rows].join('\n') : '';
      if (g && g.rows.length && kws.every((k) => text.includes(k))) return g;
      await sleep(500);
    }
    return null;
  };

  // 编辑器整体替换输入（点击 → Ctrl+A → insertText，带落地校验重试）
  const setSql = async (text) => {
    for (let i = 0; i < 3; i += 1) {
      const p = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`);
      if (!p) return false;
      await lclick(p.x, p.y);
      await Input.dispatchKeyEvent({ type: 'rawKeyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
      await sleep(200);
      await Input.insertText({ text });
      await sleep(300);
      const got = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
      if (DBG) console.log('DBG setSql got=', String(got).slice(0, 120));
      if (got && got.includes(text.split('\\n')[0].slice(0, 12)) && got.includes(text.trim().slice(-12))) return true;
    }
    return false;
  };
  const qBtn = async (marker) => {
    const p = await posOf(`document.querySelector('[data-dh-q="${marker}"]')`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const waitToast = async (want, tries = 20) => {
    for (let i = 0; i < tries; i += 1) {
      const t = await ev(`!!document.querySelector('.ant-message-notice')`);
      if (t === want) return true;
      await sleep(300);
    }
    return false;
  };

  // ---- P0 打开 sqlite 新建查询（连接右键 → 新建查询）----
  const connPos = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === '演示 SQLite 库');
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  if (!connPos) fail('P0 定位连接节点', '未找到');
  else {
    await press(connPos.x, connPos.y, 'right', 1);
    await sleep(500);
    const mi = await posOf(`[...document.querySelectorAll('.ant-menu-item')].find((m) => m.textContent.trim() === '新建查询')`);
    if (!mi) fail('P0 右键菜单', '新建查询 项未找到');
    else {
      await lclick(mi.x, mi.y);
      let editor = null;
      for (let i = 0; i < 15 && !editor; i += 1) { editor = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`); if (!editor) await sleep(400); }
      editor ? pass('P0 打开查询页（sqlite 连接）') : fail('P0 查询页', '编辑器未出现');
    }
  }

  // ---- P1 自建夹具表（运行 CREATE + INSERT）----
  if (await setSql("CREATE TABLE dh_w30_t(id INTEGER PRIMARY KEY, nm TEXT);\nINSERT INTO dh_w30_t (id, nm) VALUES (1, '甲'), (2, '乙');")) {
    await qBtn('run');
    const g = await waitGrid(['']);
    const msgs = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .msg')].length`);
    msgs >= 2 || (g && g.rows.length) ? pass('P1 建表+插数（2 条语句执行）') : fail('P1 执行', JSON.stringify({ msgs }));
  } else fail('P1 输入 SQL', '编辑器落地失败');

  // ---- T1 sqlite EQP ----
  if (await setSql('SELECT * FROM dh_w30_t WHERE id = 1')) {
    if (await qBtn('explain')) {
      // v0927.53：解释默认树形视图，切到表格再走原网格断言（plan-grid 幂等，多点无害）
      let gridBtn = false;
      for (let i = 0; i < 20 && !gridBtn; i += 1) { gridBtn = await qBtn('plan-grid'); if (!gridBtn) await sleep(300); }
      const g = await waitGrid(['SEARCH', 'dh_w30_t']);
      g ? pass('T1 sqlite 执行计划：SEARCH dh_w30_t（INTEGER PRIMARY KEY 查找）') : fail('T1 计划网格', JSON.stringify((await gridInfo()) || null).slice(0, 300));
      g && g.tabs.some((t) => /^执行计划/.test(t)) ? pass('T1 计划以执行计划页签展示') : fail('T1 页签', JSON.stringify(g && g.tabs));
    } else fail('T1 解释按钮', '未找到');
  } else fail('T1 输入 SQL', '落地失败');

  // ---- T2 计划列名 ----
  const g2 = await gridInfo();
  g2 && g2.head.some((h) => h.includes('detail')) ? pass('T2 sqlite EQP 列含 detail') : fail('T2 列名', JSON.stringify(g2 && g2.head));

  // ---- T3 mssql SHOWPLAN_TEXT ----
  const connSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-conn-select .ant-select-selector')`);
  if (!connSel) fail('T3 连接下拉', '未找到');
  else {
    await press(connSel.x, connSel.y, 'left', 1);
    await sleep(450);
    const opt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.getAttribute('title') === '1' || o.textContent.trim() === '1')`);
    if (!opt) fail('T3 选择连接', '选项未找到');
    else {
      await lclick(opt.x, opt.y);
      let dbSel = null;
      for (let i = 0; i < 15 && !dbSel; i += 1) { dbSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-db-select .ant-select-selector')`); if (!dbSel) await sleep(400); }
      if (!dbSel) fail('T3 库下拉', '未出现');
      else {
        await sleep(1200); // treeRoot 拉库列表
        await press(dbSel.x, dbSel.y, 'left', 1);
        await sleep(450);
        // mssql 冷连接时库选项加载有先后：下拉保持开着轮询等待
        let dbopt = null;
        for (let i = 0; i < 15 && !dbopt; i += 1) {
          dbopt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.getAttribute('title') || o.textContent.trim()) === 'master')`);
          if (!dbopt) await sleep(500);
        }
        if (!dbopt) fail('T3 选择库', 'master 未找到');
        else {
          await lclick(dbopt.x, dbopt.y);
          await sleep(600);
          if (await setSql("SELECT COUNT(*) FROM sys.databases WHERE name = 'master'")) {
            if (await qBtn('explain')) {
              let gridBtn = false;
              for (let i = 0; i < 20 && !gridBtn; i += 1) { gridBtn = await qBtn('plan-grid'); if (!gridBtn) await sleep(300); }
              const g = await waitGrid(['StmtText', '|--']);
              g ? pass('T3 mssql SHOWPLAN_TEXT：StmtText + 树形算子（|--）') : fail('T3 计划网格', JSON.stringify((await gridInfo()) || null).slice(0, 400));
            } else fail('T3 解释按钮', '未找到');
          } else fail('T3 输入 SQL', '落地失败');
        }
      }
    }
  }

  // ---- T4 失败路径：不存在的表 ----
  if (await setSql('SELECT * FROM dbo.dh_w30_no_such')) {
    if (await qBtn('explain')) {
      const toast = await waitToast(true);
      const log = logHas('DH-EXPLAIN fail');
      toast && log ? pass('T4 解释失败：toast 提示 + DH-EXPLAIN fail 落盘') : fail('T4 失败路径', JSON.stringify({ toast, log }));
      await waitToast(false); // 等 toast 消失，别挡后续点击
    } else fail('T4 解释按钮', '未找到');
  } else fail('T4 输入 SQL', '落地失败');

  // ---- T5 失败后会话未毒化：正常运行同句 → 数字结果（非 StmtText 计划）----
  // 点击可能被 T4 的错误 toast 残影吃掉（网格停在 T3 的旧计划）：若仍是 StmtText 就重点运行，最多 3 次
  if (await setSql("SELECT COUNT(*) FROM sys.databases WHERE name = 'master'")) {
    let g = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await qBtn('run'))) break;
      g = await waitGrid([]);
      const t = g ? [g.head.join(' '), ...g.rows].join('\n') : '';
      if (g && g.rows.length && !t.includes('StmtText')) break;
      await sleep(800);
    }
    const text = g ? [g.head.join(' '), ...g.rows].join('\n') : '';
    const numRow = g && g.rows.length && /\d/.test(g.rows[0]);
    g && numRow && !text.includes('StmtText')
      ? pass('T5 SHOWPLAN 已复位：正常运行返回数字结果（会话未毒化）')
      : fail('T5 运行结果', JSON.stringify((g && { head: g.head, rows: g.rows.slice(0, 3) }) || null).slice(0, 300));
  } else fail('T5 输入 SQL', '落地失败');

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND30-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
