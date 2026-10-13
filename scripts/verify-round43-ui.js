'use strict';
// v0927.52 执行计划树形可视化验证（9227 新实例；自足式：sqlite 用 demo employees，mssql 自建 w43_a/w43_b 并自清）：
//  S0 状态栏版本 v0927.52
//  U0 sqlite 连接右键 → 新建查询 → 编辑器就绪
//  T1 sqlite EQP 树：解释 WHERE id=1 → 默认树形（QUERY PLAN 根 + SEARCH employees，无网格）
//  T2 兄弟步骤：解释 ORDER BY name → SCAN employees + USE TEMP B-TREE 两子级挂根
//  T3 折叠/展开：点根节点收起（子级隐藏）→ 再点恢复
//  T4 mssql SHOWPLAN 树：自建两表 → 解释 INNER JOIN → 语句根 + Join 算符 + ≥2 层嵌套
//  T5 双视图切换：树形 → 表格（StmtText + |-- 网格）→ 树形恢复
//  T6 自清理：DROP 两表 → sys.tables 里 w43 前缀计数为 0
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
const fs = require('fs');
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(300); };
  const posOf = async (expr) => {
    const p = await ev(`(() => { const el = ${expr}; if (!el) return null; el.scrollIntoView({ block: 'nearest' }); const r = el.getBoundingClientRect(); return r.height > 0 || r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    return p && !p.err ? p : null;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const DBG = !!process.env.DBG43;

  // 等主窗揭示
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // 活动查询页内的计划树/网格信息（嵌套 Tabs 都取有高度的最内层）
  const paneInfo = () => ev(`(() => {
    const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((p) => p.getBoundingClientRect().height > 0);
    if (!panes.length) return null;
    const pane = panes[panes.length - 1];
    const ops = [...pane.querySelectorAll('.plan-op')].map((o) => o.textContent);
    const details = [...pane.querySelectorAll('.plan-detail')].map((o) => o.textContent);
    const grid = !!pane.querySelector('.dh-grid');
    const tree = !!pane.querySelector('.plan-tree');
    const gridRows = [...pane.querySelectorAll('.dh-grid .ant-table-row')].map((r) => [...r.querySelectorAll('.cell')].map((c) => c.textContent).join(' '));
    const gridHead = [...pane.querySelectorAll('.dh-grid .ant-table-thead th')].map((h) => h.textContent.trim());
    const tabs = [...document.querySelectorAll('.ant-tabs-tabpane-active .ant-tabs-tab')].map((t) => t.textContent.trim()).filter((t) => t.includes('结果') || t.includes('消息') || t.includes('执行计划'));
    return { ops, details, grid, tree, gridRows, gridHead, tabs, deep: pane.querySelectorAll('.plan-node .plan-node .plan-node').length };
  })()`);
  const waitTree = async (tries = 30) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await paneInfo();
      if (p && p.tree && p.ops.length) return p;
      await sleep(400);
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
      if (DBG) console.log('DBG setSql got=', String(got).slice(0, 140));
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

  // ---- U0 打开 sqlite 新建查询 ----
  const connPos = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent.trim() === '演示 SQLite 库');
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  if (!connPos) fail('U0 定位连接节点', '未找到');
  else {
    await press(connPos.x, connPos.y, 'right', 1);
    await sleep(500);
    const mi = await posOf(`[...document.querySelectorAll('.ant-menu-item')].find((m) => m.textContent.trim() === '新建查询')`);
    if (!mi) fail('U0 右键菜单', '新建查询 项未找到');
    else {
      await lclick(mi.x, mi.y);
      let editor = null;
      for (let i = 0; i < 15 && !editor; i += 1) { editor = await posOf(`document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')`); if (!editor) await sleep(400); }
      editor ? pass('U0 连接右键新建查询 → 编辑器就绪') : fail('U0 查询页', '编辑器未出现');
    }
  }

  // ---- T1 sqlite EQP：单步骤树（默认树形，无网格）----
  if (await setSql('SELECT * FROM employees WHERE id = 1')) {
    if (await qBtn('explain')) {
      const p = await waitTree();
      if (DBG) console.log('DBG T1', JSON.stringify(p));
      p && p.ops[0] === 'QUERY PLAN' && p.ops.some((o) => /^SEARCH employees/.test(o)) && !p.grid
        ? pass('T1 sqlite 树：QUERY PLAN 根 + SEARCH employees（默认树形无网格）')
        : fail('T1 计划树', JSON.stringify(p).slice(0, 300));
      p && p.details.some((d) => d.includes('INTEGER PRIMARY KEY'))
        ? pass('T1 SEARCH 明细含 INTEGER PRIMARY KEY')
        : fail('T1 明细', JSON.stringify((p && p.details) || null));
      p && p.tabs.some((t) => /^执行计划/.test(t)) ? pass('T1 页签「执行计划」') : fail('T1 页签', JSON.stringify(p && p.tabs));
    } else fail('T1 解释按钮', '未找到');
  } else fail('T1 输入 SQL', '落地失败');

  // ---- T2 兄弟步骤：SCAN + USE TEMP B-TREE 挂根 ----
  if (await setSql('SELECT * FROM employees ORDER BY name')) {
    if (await qBtn('explain')) {
      let p = null;
      for (let i = 0; i < 20 && !p; i += 1) {
        const c = await paneInfo();
        if (c && c.tree && c.ops.length >= 3 && c.ops.some((o) => o.includes('TEMP B-TREE'))) p = c;
        else await sleep(400);
      }
      if (DBG) console.log('DBG T2', JSON.stringify(p));
      const kids = await ev(`(() => {
        const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((x) => x.getBoundingClientRect().height > 0);
        const pane = panes[panes.length - 1];
        return pane ? pane.querySelectorAll('.plan-tree > .plan-node > .plan-children > .plan-node').length : -1;
      })()`);
      p && p.ops.some((o) => /^SCAN employees/.test(o)) && p.ops.some((o) => /^USE TEMP B-TREE/.test(o)) && kids === 2
        ? pass('T2 SCAN + USE TEMP B-TREE 两子级挂 QUERY PLAN 根')
        : fail('T2 兄弟树', JSON.stringify({ p: p && p.ops, kids }));
    } else fail('T2 解释按钮', '未找到');
  } else fail('T2 输入 SQL', '落地失败');

  // ---- T3 折叠/展开：点根收子级，再点恢复 ----
  const rootHead = await posOf(`document.querySelector('.ant-tabs-tabpane-active .plan-tree > .plan-node > .plan-node-head')`);
  if (!rootHead) fail('T3 根节点', '未找到');
  else {
    const before = (await paneInfo()).ops.length;
    await lclick(rootHead.x, rootHead.y);
    let mid = null;
    for (let i = 0; i < 10 && !mid; i += 1) { const c = await paneInfo(); if (c && c.ops.length === 1) mid = c; else await sleep(300); }
    await lclick(rootHead.x, rootHead.y);
    let after = null;
    for (let i = 0; i < 10 && !after; i += 1) { const c = await paneInfo(); if (c && c.ops.length === before) after = c; else await sleep(300); }
    mid && after ? pass('T3 折叠/展开：' + before + ' 节点 → 1 → ' + after.ops.length) : fail('T3 折叠', JSON.stringify({ before, midOps: mid && mid.ops.length, afterOps: after && after.ops.length }));
  }

  // ---- T4 mssql SHOWPLAN：自建两表 → JOIN 计划树 ----
  const connSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-conn-select .ant-select-selector')`);
  if (!connSel) fail('T4 连接下拉', '未找到');
  else {
    await press(connSel.x, connSel.y, 'left', 1);
    await sleep(450);
    const opt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => o.getAttribute('title') === '1' || o.textContent.trim() === '1')`);
    if (!opt) fail('T4 选择连接', '选项未找到');
    else {
      await lclick(opt.x, opt.y);
      let dbSel = null;
      for (let i = 0; i < 30 && !dbSel; i += 1) { dbSel = await posOf(`document.querySelector('.ant-tabs-tabpane-active .q-db-select .ant-select-selector')`); if (!dbSel) await sleep(500); }
      if (!dbSel) fail('T4 库下拉', '未出现');
      else {
        let dbopt = null;
        for (let i = 0; i < 6 && !dbopt; i += 1) {
          await sleep(1000); // treeRoot 拉库列表
          await press(dbSel.x, dbSel.y, 'left', 1);
          await sleep(450);
          dbopt = await posOf(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((o) => (o.getAttribute('title') || o.textContent.trim()) === 'master')`);
          if (!dbopt) await press(dbSel.x, dbSel.y, 'left', 1);
        }
        if (!dbopt) fail('T4 选择库', 'master 未找到');
        else {
          await lclick(dbopt.x, dbopt.y);
          await sleep(600);
          const ddl = 'CREATE TABLE dbo.w43_a (id INT PRIMARY KEY, nm NVARCHAR(40));\nCREATE TABLE dbo.w43_b (id INT PRIMARY KEY, a_id INT REFERENCES dbo.w43_a(id));\nINSERT INTO dbo.w43_a (id, nm) VALUES (1, N\'甲\'), (2, N\'乙\');\nINSERT INTO dbo.w43_b (id, a_id) VALUES (10, 1), (20, 2);';
          if (!(await setSql(ddl))) fail('T4 输入 DDL', '落地失败');
          else if (!(await qBtn('run'))) fail('T4 运行', '按钮未找到');
          else {
            let msgs = 0;
            for (let i = 0; i < 20 && msgs < 4; i += 1) { msgs = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .msg')].length`); if (msgs < 4) await sleep(500); }
            msgs >= 4 ? pass('T4 建表+插数（4 条语句执行）') : fail('T4 DDL 执行', JSON.stringify({ msgs }));
            if (await setSql('SELECT * FROM dbo.w43_a a INNER JOIN dbo.w43_b b ON a.id = b.a_id WHERE a.id = 1')) {
              if (await qBtn('explain')) {
                const p = await waitTree();
                if (DBG) console.log('DBG T4', JSON.stringify(p));
                p && p.ops[0] === '语句' && p.ops.some((o) => /Join|Loop|Hash|Merge|Scan|Seek/.test(o)) && p.ops.length >= 3 && p.deep >= 1
                  ? pass('T4 mssql 树：语句根 + ' + p.ops.length + ' 节点 + ≥2 层算符嵌套')
                  : fail('T4 计划树', JSON.stringify(p).slice(0, 400));
              } else fail('T4 解释按钮', '未找到');
            } else fail('T4 输入 JOIN', '落地失败');
          }
        }
      }
    }
  }

  // ---- T5 双视图切换：树形 ↔ 表格 ----
  if (await qBtn('plan-grid')) {
    let g = null;
    for (let i = 0; i < 20 && !g; i += 1) { const c = await paneInfo(); if (c && c.grid && !c.tree && c.gridRows.length) g = c; else await sleep(400); }
    if (DBG) console.log('DBG T5 grid', JSON.stringify(g && { head: g.gridHead, rows: g.gridRows.slice(0, 4) }));
    const head = g ? g.gridHead.join(' ') : '';
    const body = g ? [head, ...g.gridRows].join('\n') : '';
    g && head.includes('StmtText') && body.includes('|--')
      ? pass('T5 表格视图：StmtText 网格含 |-- 算符行')
      : fail('T5 表格', JSON.stringify(g && { head: g.gridHead, rows: g.gridRows.slice(0, 3) }).slice(0, 300));
    if (await qBtn('plan-tree')) {
      let t = null;
      for (let i = 0; i < 20 && !t; i += 1) { const c = await paneInfo(); if (c && c.tree && !c.grid && c.ops.length >= 3) t = c; else await sleep(400); }
      t ? pass('T5 切回树形：' + t.ops.length + ' 节点恢复') : fail('T5 树形恢复', JSON.stringify((await paneInfo()) || null).slice(0, 200));
    } else fail('T5 树形按钮', '未找到');
  } else fail('T5 表格按钮', '未找到');

  // ---- T6 自清理：DROP 两表 + w43 计数为 0 ----
  if (await setSql('DROP TABLE dbo.w43_b;\nDROP TABLE dbo.w43_a;')) {
    if (await qBtn('run')) {
      await sleep(800);
      if (await setSql("SELECT COUNT(*) FROM sys.tables WHERE name LIKE 'w43[_]%'")) {
        if (await qBtn('run')) {
          let cnt = null;
          for (let i = 0; i < 20 && cnt == null; i += 1) {
            const c = await paneInfo();
            const t = c && c.gridRows.length ? c.gridRows[0] : '';
            if (/^\s*0\s*$/.test(t)) cnt = 0;
            else if (c && c.gridRows.length && /^\s*\d+\s*$/.test(t)) cnt = Number(t.trim());
            else await sleep(400);
          }
          cnt === 0 ? pass('T6 清理：w43 表已全部删除') : fail('T6 清理', JSON.stringify({ cnt, grid: (await paneInfo()) && (await paneInfo()).gridRows }));
        } else fail('T6 运行计数', '按钮未找到');
      } else fail('T6 输入计数', '落地失败');
    } else fail('T6 运行 DROP', '按钮未找到');
  } else fail('T6 输入 DROP', '落地失败');

  // S5 控制台错误
  await sleep(600);
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND43-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
