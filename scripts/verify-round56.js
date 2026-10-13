'use strict';
// v0927.52 修复「表」页打开 MSSQL 表报 Invalid object name（用户环境复刻）验证：
//  连接默认库=master、业务对象在独立库 dh_w56（dbo.w56_dbo_t + platform.arrival_notice_detail）。
//  T1 树只展开不打开（conn 1 → dh_w56 → 表分类）→ 两表节点可见；工具栏上下文=分类（库+空 schema）
//  T2 工具栏「表」→ 对象列表页（表·dh_w56）：v0927.52 起默认全部架构——dbo 表（w56_dbo_t）与非 dbo 表（platform.arrival_notice_detail）都在列
//  T3 行「打开」w56_dbo_t（用户原始报错路径，修复前：Invalid object name 'dh_w56.w56_dbo_t'）
//     → 数据页 2 行（丁/戊）、无 Invalid object name 报错
//  T4 单元格编辑 + 保存更改（空 schema 的 changes() 路径）：丁 → 丁改，保存后重载可见
//  T5 树双击 platform.arrival_notice_detail（带 schema 三段名回归路径）→ 2 行（甲/乙）
//  D8 fx-w56 check1：两表各 2 行；D9 cleanup；S0 版本；S5 无控制台错误
// 前置：套件自跑 fx-w56 stage1（幂等）；结尾 fx-w56 cleanup。运行于独立新实例（battery 保证无实例占用）。
const { execFileSync } = require('child_process');
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fx56 = (mode) => String(execFileSync('node', ['D:/DataHelm/scripts/fx/fx-w56.js', mode], { encoding: 'utf8' }));
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
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  /v0927\.52/.test(sb) ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ---- D0 夹具 stage1（幂等）----
  try {
    const out = fx56('stage1');
    out.indexOf('W56-STAGE1-OK') >= 0 ? pass('D0 夹具 stage1（dh_w56：platform.arrival_notice_detail + dbo.w56_dbo_t 各 2 行）') : fail('D0 stage1', out.slice(0, 120));
  } catch (e) {
    fail('D0 stage1', String(e.message).slice(0, 160));
  }

  // ---- T1 树展开到两表节点可见（不双击表——保持 treeSel=分类节点：库+空 schema）----
  let p = null;
  for (let i = 0; i < 18 && !p; i += 1) {
    p = await treePos('w56_dbo_t');
    if (p) break;
    const tb = await treePos('表');
    if (tb) { await dblclick(tb.x, tb.y); await sleep(900); continue; }
    const dbNode = await treePos('dh_w56');
    if (dbNode) { await dblclick(dbNode.x, dbNode.y); await sleep(1100); continue; }
    const c1 = await treePos('1');
    if (c1) { await dblclick(c1.x, c1.y); await sleep(1300); }
    await sleep(400);
  }
  const pPlat = await treePos('arrival_notice_detail');
  p && pPlat ? pass('T1 树展开可见两表节点（未通过树打开任何表）') : fail('T1 树展开', JSON.stringify({ dbo: !!p, plat: !!pPlat }));

  // ---- T2 工具栏「表」→ 对象列表页（库+空 schema 绑定）----
  const tbBtn = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '表'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dis: b.disabled }; })()`);
  if (!tbBtn || tbBtn.dis) {
    fail('T2 前置', tbBtn ? '表按钮禁用' : '未找到');
  } else {
    await lclick(tbBtn.x, tbBtn.y);
    let objs = null;
    for (let i = 0; i < 20 && !objs; i += 1) {
      await sleep(500);
      objs = await ev(`(() => {
        const pane = document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]');
        if (!pane) return null;
        const names = [...pane.querySelectorAll('tbody tr .objs-name')].map((n) => n.textContent);
        if (!names.length) return null;
        const ctx = pane.querySelector('.ctx');
        return { names, ctx: ctx ? ctx.textContent.replace(/\\s+/g, '') : '' };
      })()`);
    }
    objs && objs.ctx.indexOf('dh_w56') >= 0 && objs.names.includes('w56_dbo_t') && objs.names.includes('arrival_notice_detail') && objs.ctx.indexOf('全部架构') >= 0
      ? pass('T2 对象列表页绑定 dh_w56（v0927.52 起默认全部架构：' + objs.names.length + ' 个表，dbo + 非 dbo 表都在列）')
      : fail('T2 对象列表页', JSON.stringify(objs).slice(0, 300));
  }

  // ---- T3 行「打开」w56_dbo_t（用户原始报错路径）----
  let t3ok = false;
  const openBtn = await ev(`(() => {
    const row = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === 'w56_dbo_t'; });
    if (!row) return null;
    const b = [...row.querySelectorAll('button')].find((y) => y.textContent.trim() === '打开');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!openBtn) {
    fail('T3 前置', 'w56_dbo_t 行打开按钮未找到');
  } else {
    await lclick(openBtn.x, openBtn.y);
    let grid = null;
    for (let i = 0; i < 26 && !grid; i += 1) {
      await sleep(500);
      grid = await ev(`(() => {
        const pane = document.querySelector('.ant-tabs-tabpane-active');
        if (!pane || !pane.querySelector('.grid-area')) return null;
        const rows = [...pane.querySelectorAll('.grid-area .ant-table-row')];
        if (!rows.length) return null;
        const badToast = [...document.querySelectorAll('.ant-message *')].some((x) => (x.textContent || '').indexOf('Invalid object name') >= 0);
        return { n: rows.length, text: rows.map((r) => r.textContent).join('|'), badToast };
      })()`);
    }
    t3ok = !!grid && grid.n === 2 && grid.text.indexOf('丁') >= 0 && grid.text.indexOf('戊') >= 0 && !grid.badToast;
    t3ok ? pass('T3 表页「打开」dbo 表成功（2 行 丁/戊，无 Invalid object name）') : fail('T3 表页打开', JSON.stringify(grid).slice(0, 300));
  }

  // ---- T4 单元格编辑 + 保存更改（空 schema 的 changes() 路径）----
  if (!t3ok) {
    fail('T4 编辑保存', '跳过（T3 未通过）');
  } else {
    const cellPos = await ev(`(() => {
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      const cellDiv = pane ? [...pane.querySelectorAll('.grid-area .cell')].find((t) => t.textContent === '丁') : null;
      if (!cellDiv) return null;
      const r = cellDiv.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!cellPos) {
      fail('T4 前置', '丁 单元格未找到');
    } else {
      await lclick(cellPos.x, cellPos.y);
      await sleep(400);
      await ev(`(() => { const i = document.querySelector('.ant-tabs-tabpane-active .grid-area input.cell-edit-input'); if (i) { i.focus(); i.select(); } return !!i; })()`);
      await Input.insertText({ text: '丁改' });
      await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await sleep(500);
      const saveBtn = await ev(`(() => { const pane = document.querySelector('.ant-tabs-tabpane-active'); const b = pane ? [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.includes('保存更改')) : null; if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!saveBtn) {
        fail('T4 前置', '保存更改按钮未找到');
      } else {
        await lclick(saveBtn.x, saveBtn.y);
        let saved = null;
        for (let i = 0; i < 20 && !saved; i += 1) {
          await sleep(600);
          saved = await ev(`(() => {
            const pane = document.querySelector('.ant-tabs-tabpane-active');
            if (!pane) return null;
            const rows = [...pane.querySelectorAll('.grid-area .ant-table-row')];
            if (!rows.length) return null;
            const badToast = [...document.querySelectorAll('.ant-message *')].some((x) => (x.textContent || '').indexOf('Invalid object name') >= 0);
            const stillDirty = pane.querySelector('.cell.dirty') ? true : false;
            const hasNew = rows.some((r) => r.textContent.indexOf('丁改') >= 0);
            return { hasNew, badToast, stillDirty };
          })()`);
        }
        saved && saved.hasNew && !saved.badToast && !saved.stillDirty
          ? pass('T4 空 schema 数据页编辑保存成功（丁 → 丁改，UPDATE 走 [db]..[table] 默认架构）')
          : fail('T4 编辑保存', JSON.stringify(saved));
      }
    }
  }

  // ---- T5 树双击 platform.arrival_notice_detail（带 schema 三段名回归路径）----
  const p5 = await treePos('arrival_notice_detail');
  if (!p5) {
    fail('T5 前置', '树上 platform 表节点未找到');
  } else {
    await dblclick(p5.x, p5.y);
    let grid5 = null;
    for (let i = 0; i < 26 && !grid5; i += 1) {
      await sleep(500);
      grid5 = await ev(`(() => {
        const tabs = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')];
        const t = tabs.find((x) => x.textContent.replace(/\\s+/g, '') === 'arrival_notice_detail');
        if (!t) return null;
        const pane = document.querySelector('.ant-tabs-tabpane-active');
        if (!pane || pane.querySelector('.grid-area') === null) return null;
        const rows = [...pane.querySelectorAll('.grid-area .ant-table-row')];
        if (!rows.length) return null;
        return { text: rows.map((r) => r.textContent).join('|'), title: t.textContent.trim() };
      })()`);
    }
    grid5 && grid5.text.indexOf('甲') >= 0 && grid5.text.indexOf('乙') >= 0
      ? pass('T5 树双击非 dbo 表回归（platform.arrival_notice_detail 2 行 甲/乙）')
      : fail('T5 树双击回归', JSON.stringify(grid5).slice(0, 200));
  }

  // ---- D8 库端核验 ----
  try {
    const out = fx56('check1');
    const line = (out.split('\n').find((l) => l.indexOf('CHECK-JSON') === 0) || '').slice(11);
    const info = JSON.parse(line);
    info.platRows === 2 && info.dboRows === 2 ? pass('D8 库端核验：两表各 2 行') : fail('D8 库端核验', JSON.stringify(info));
  } catch (e) {
    fail('D8 库端核验', String(e.message).slice(0, 160));
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));

  // ---- D9 清理（放最后：cleanup 会踢掉实例占用的 dh_w56 会话，可能触发后续连接错误日志）----
  try {
    const out = fx56('cleanup');
    out.indexOf('W56-CLEANUP-OK') >= 0 ? pass('D9 夹具 cleanup（SINGLE_USER 踢会话后 drop dh_w56 整库）') : fail('D9 cleanup', out.slice(0, 120));
  } catch (e) {
    fail('D9 cleanup', String(e.message).slice(0, 160));
  }

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
