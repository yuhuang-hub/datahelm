'use strict';
// v0927.53 顶部工具栏 + 查询页连接/库下拉（9228 实例 + localhost MSSQL）：
//  T1 工具栏 8 个按钮（连接/新建查询/查询列表/表/视图/ER图/用户/备份）；T1b 未打开连接时 表/视图/新建查询/用户/ER图 禁用；T1c 打开 sqlite 后恢复
//  T2 工具栏「新建查询」→ 打开查询页：连接下拉=演示 SQLite 库；sqlite 无库下拉；自动连接出 serverInfo
//  T3 sqlite 跑 SELECT 1+1 → 结果 2
//  T4 连接下拉切到「1」（SQLServer）→ 库下拉出现（master/tempdb…）且自动连接（q-server 非空）
//  T5 库下拉切 tempdb → SELECT DB_NAME()=tempdb（驱动层 USE 生效）
//  T6 切回 master → SELECT DB_NAME()=master
//  T7 工具栏「表」→ 上下文跟随活动查询页（mssql master）→ 新建表设计页打开
//  T8 关闭设计页（无脏直接关）
//  S0 版本 v0927.53；S5 无控制台错误
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(280); };
  const dblclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(80); await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 2); await sleep(1300); };
  const clickAt = async (x, y) => { await press(x, y, 'left', 1); await sleep(280); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const insertText = (t) => Input.insertText({ text: t });
  const escKey = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // antd Select：mousedown 打开；选项渲染在 body 下的 portal
  const selectOpen = async (sel) => {
    const p = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active ${sel} .ant-select-selector'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await press(p.x, p.y, 'left', 1);
    await sleep(350);
    return true;
  };
  const pickOption = async (label, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      // rc-virtual-list 只保证渲染，不保证在视口内：按中心点判可见，超出的先滚动再取坐标
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
      if (!o) { await sleep(350); continue; }
      if (o.scrolled) { await sleep(220); continue; }
      await clickAt(o.x, o.y);
      return true;
    }
    return false;
  };
  // 键盘导航选 option：逐步 ArrowDown 读 active 项文本（虚拟列表未渲染的目标项也能走到，滚动由 antd 内部驱动）
  const keyTap = async (code, vk, key) => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', code, key, windowsVirtualKeyCode: vk });
    await Input.dispatchKeyEvent({ type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
    await sleep(90);
  };
  const pickOptionKeys = async (label, maxSteps = 24) => {
    for (let i = 0; i < maxSteps; i += 1) {
      const act = await ev(`(() => {
        const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
        if (!dd) return { open: false };
        const a = dd.querySelector('.ant-select-item-option-active');
        return { open: true, t: a ? a.textContent.trim() : null };
      })()`);
      if (!act.open) return false;
      if (act.t === label) { await keyTap('Enter', 13, 'Enter'); await sleep(450); return true; }
      await keyTap('ArrowDown', 40, 'ArrowDown');
    }
    return false;
  };
  const selectValue = (sel) => ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active ${sel} .ant-select-selection-item'); return e ? e.textContent.trim() : null; })()`);
  const has = (sel) => ev(`!!document.querySelector('.ant-tabs-tabpane-active ${sel}')`);

  const runSqlInEditor = async (sql) => {
    const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    await clickAt(ed.x, ed.y);
    await ctrlA();
    await insertText(sql);
    await sleep(300);
    const runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!runBtn) return false;
    await clickAt(runBtn.x, runBtn.y);
    await sleep(600);
    return true;
  };
  const gridCell = (r0, c0) => ev(`(() => {
    const row = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[${r0}];
    if (!row) return null;
    const cell = row.querySelectorAll('.cell')[${c0}];
    return cell ? cell.textContent : null;
  })()`);
  const waitCell = async (tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const v = await gridCell(0, 0);
      if (v != null && v !== '') return v;
      await sleep(500);
    }
    return null;
  };

  // ---- 等主窗揭示（默认 1.5s Splash）----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // T1 工具栏 10 按钮（v0927.53 新增 数据同步，位于 结构同步 后）
  const tb = await ev(`(() => {
    const btns = [...document.querySelectorAll('.top-toolbar .tb-btn')];
    return { n: btns.length, labels: btns.map((b) => b.textContent.replace(/\\s+/g, '')), disabled: btns.filter((b) => b.disabled).map((b) => b.textContent.replace(/\\s+/g, '')) };
  })()`);
  const WANT = ['连接', '新建查询', '查询列表', '表', '视图', 'ER图', '用户', '结构同步', '数据同步', '备份'];
  tb && tb.n === 10 && JSON.stringify(tb.labels) === JSON.stringify(WANT)
    ? pass('T1 工具栏 10 按钮：' + WANT.join('/'))
    : fail('T1 工具栏按钮', JSON.stringify(tb));
  // T1b v0927.53 起规则：未打开连接时 表/视图/新建查询/用户/ER图 全禁用；打开连接后按选择恢复
  const DIS_INIT = ['新建查询', '表', '视图', 'ER图', '用户'];
  tb && JSON.stringify(tb.disabled) === JSON.stringify(DIS_INIT)
    ? pass('T1b 初始（未打开连接）：新建查询/表/视图/ER图/用户 全禁用')
    : fail('T1b 初始可用态', JSON.stringify(tb && tb.disabled));

  // T1c 打开 sqlite 连接（双击）→ 表/视图/新建查询/用户 恢复可用（sqlite 无库层；ER 仍待选中表）
  let connP = null;
  for (let i = 0; i < 12 && !connP; i += 1) {
    connP = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === '演示 SQLite 库'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!connP) await sleep(500);
  }
  if (!connP) fail('T1c 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(connP.x, connP.y);
    let tb1c = null;
    for (let i = 0; i < 14 && !(tb1c && tb1c.t === true); i += 1) {
      await sleep(500);
      tb1c = await ev(`(() => { const g = (k) => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === k); return b ? !b.disabled : null; }; return { t: g('表'), v: g('视图'), q: g('新建查询'), u: g('用户'), e: g('ER图') }; })()`);
    }
    tb1c && tb1c.t === true && tb1c.v === true && tb1c.q === true && tb1c.u === true && tb1c.e === false
      ? pass('T1c 打开 sqlite 连接后：表/视图/新建查询/用户 恢复可用（ER 仍禁用）')
      : fail('T1c 打开后可用态', JSON.stringify(tb1c));
  }

  // T2 工具栏新建查询 → 查询页：连接下拉=演示 SQLite 库；sqlite 无库下拉
  const nb = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '新建查询'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!nb) fail('T2 工具栏新建查询', 'no button');
  else {
    await clickAt(nb.x, nb.y);
    let qv = null;
    for (let i = 0; i < 20 && !qv; i += 1) { qv = await selectValue('.q-conn-select'); if (!qv) await sleep(500); }
    qv === '演示 SQLite 库' ? pass('T2 查询页连接下拉=演示 SQLite 库（工具栏上下文默认）') : fail('T2 连接下拉', String(qv));
    const noDb = !(await has('.q-db-select'));
    noDb ? pass('T2b sqlite 不显示库下拉') : fail('T2b sqlite 库下拉应隐藏');
    // 自动连接（sqlite）
    let srv = '';
    for (let i = 0; i < 16 && !srv; i += 1) { srv = await ev("(() => { const e = document.querySelector('.ant-tabs-tabpane-active .q-server'); return e ? e.textContent.trim() : ''; })()"); if (!srv) await sleep(500); }
    srv ? pass('T2c 自动连接出 serverInfo（' + srv + '）') : fail('T2c 自动连接', 'serverInfo 为空');
  }

  // T3 sqlite 跑 SELECT
  if (await runSqlInEditor('SELECT 1+1 AS v')) {
    const v = await waitCell();
    v === '2' ? pass('T3 sqlite 运行 SELECT 1+1 → 2') : fail('T3 sqlite 运行', String(v));
  } else fail('T3 sqlite 运行', '运行按钮/编辑器不可用');

  // T4 连接下拉切「1」（SQLServer）→ 库下拉出现 + 自动连接
  if (!(await selectOpen('.q-conn-select'))) fail('T4 切换连接', 'conn select 打不开');
  else if (!(await pickOption('1'))) fail('T4 切换连接', '选项 1 不存在');
  else {
    let v = null;
    for (let i = 0; i < 20 && v !== '1'; i += 1) { v = await selectValue('.q-conn-select'); if (v !== '1') await sleep(500); }
    v === '1' ? pass('T4 连接切换到 1（SQLServer）') : fail('T4 连接切换', String(v));
    let dbSel = false;
    for (let i = 0; i < 20 && !dbSel; i += 1) { dbSel = await has('.q-db-select'); if (!dbSel) await sleep(500); }
    dbSel ? pass('T4b mssql 显示库下拉') : fail('T4b 库下拉', '未出现');
    let srv = '';
    for (let i = 0; i < 24 && !srv; i += 1) { srv = await ev("(() => { const e = document.querySelector('.ant-tabs-tabpane-active .q-server'); return e ? e.textContent.trim() : ''; })()"); if (!srv) await sleep(500); }
    srv ? pass('T4c 切连接后自动连接（' + srv.slice(0, 40) + '）') : fail('T4c 自动连接', 'serverInfo 为空');

    // T5 库下拉选项含 master/tempdb；切 tempdb → DB_NAME()=tempdb
    if (!(await selectOpen('.q-db-select'))) fail('T5 库下拉', '打不开');
    else {
      let opts = [];
      // antd v5 Select 虚拟列表只渲染可见窗口：本服务器 11 个库、tempdb 按序排最后——
      // 顶部窗口只渲染前 10 个。跨滚动位置收集并集：读当前窗 → 滚到底 → 再读。
      // 另：T4c 切连接触发的重渲染可能把刚打开的下拉关掉（隐藏层读空）——
      // 连续 3 拍无选项就 ESC 重开一次（自愈）
      const seen = new Set();
      let dry = 0;
      for (let i = 0; i < 16 && !(seen.has('tempdb') && seen.has('master')); i += 1) {
        const cur = await ev(`[...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].map((x) => x.textContent.trim())`);
        if (Array.isArray(cur) && cur.length) { cur.forEach((x) => seen.add(x)); dry = 0; } else { dry += 1; }
        if (dry >= 3) { await escKey(); await sleep(300); await selectOpen('.q-db-select'); dry = 0; }
        await ev(`(() => { const h = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .rc-virtual-list-holder'); if (h) h.scrollTop = h.scrollHeight; return true; })()`);
        await sleep(350);
      }
      seen.forEach((x) => opts.push(x));
      opts.includes('tempdb') && opts.includes('master') ? pass('T5a 库选项含 master/tempdb（共 ' + opts.length + ' 个）') : fail('T5a 库选项', JSON.stringify(opts));
      await escKey();
      // 键盘遍历偶发丢键（重开下拉后焦点未就绪）：失败回退点击式选择；
      // 高负载下开下拉/找选项都可能空手：整体再重试两轮
      let t5ok = false;
      for (let a = 0; a < 3 && !t5ok; a += 1) {
        t5ok = (await selectOpen('.q-db-select')) && (await pickOptionKeys('tempdb'));
        if (!t5ok) t5ok = (await selectOpen('.q-db-select')) && (await pickOption('tempdb'));
        if (!t5ok) { await escKey(); await sleep(500); }
      }
      if (!t5ok) fail('T5 切 tempdb', '选项不存在');
      else {
        let dbv = null;
        for (let i = 0; i < 8 && dbv !== 'tempdb'; i += 1) { dbv = await selectValue('.q-db-select'); if (dbv !== 'tempdb') await sleep(300); }
        if (dbv !== 'tempdb') fail('T5b DB_NAME', 'tempdb 未选中（value=' + dbv + '）');
        else if (await runSqlInEditor('SELECT DB_NAME() AS d')) {
          // 定向等值（与 T6 同理）：网格可能仍显示上一条结果，waitCell 会秒回旧值
          let v2 = null;
          for (let i = 0; i < 16 && v2 !== 'tempdb'; i += 1) { v2 = await gridCell(0, 0); if (v2 !== 'tempdb') await sleep(500); }
          v2 === 'tempdb' ? pass('T5b SELECT DB_NAME() → tempdb（驱动层 USE 生效）') : fail('T5b DB_NAME', String(v2));
        } else fail('T5b DB_NAME', '运行失败');
      }

      // T6 切回 master → DB_NAME()=master（网格上一条结果已是 tempdb——必须定向等值变化，waitCell 会秒回旧值）
      {
        let t6ok = false;
        for (let a = 0; a < 3 && !t6ok; a += 1) {
          t6ok = (await selectOpen('.q-db-select')) && (await pickOptionKeys('master'));
          if (!t6ok) t6ok = (await selectOpen('.q-db-select')) && (await pickOption('master'));
          if (!t6ok) { await escKey(); await sleep(500); }
        }
        if (t6ok && (await runSqlInEditor('SELECT DB_NAME() AS d'))) {
        let v3 = null;
        for (let i = 0; i < 16 && v3 !== 'master'; i += 1) {
          v3 = await gridCell(0, 0);
          if (v3 !== 'master') await sleep(500);
        }
        v3 === 'master' ? pass('T6 切回 master → DB_NAME()=master') : fail('T6 master', String(v3));
      } else fail('T6 切回 master', '切换/运行失败');
      }
    }
  }

  // T7 工具栏「表」→ 上下文跟随活动查询页（mssql master）→ 对象列表页（v0927.53 语义：查看已有清单）
  const tb2 = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '表'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), dis: b.disabled }; })()`);
  if (!tb2 || tb2.dis) fail('T7 工具栏表', tb2 ? 'disabled' : 'no button');
  else {
    await clickAt(tb2.x, tb2.y);
    let opened = false;
    for (let i = 0; i < 16 && !opened; i += 1) {
      opened = await ev(`(() => { const ok = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].some((t) => t.textContent.replace(/\\s+/g, '') === '表·master'); return ok && !!document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]'); })()`);
      if (!opened) await sleep(500);
    }
    opened ? pass('T7 工具栏「表」→ 对象列表页「表 · master」（上下文跟随查询页，新语义）') : fail('T7 对象列表页', 'tab 未出现');
    // T8 关闭列表页（无脏直接关，无确认）
    const rm = await ev(`(() => { const tabs = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')]; const t = tabs.find((x) => x.textContent.replace(/\\s+/g, '') === '表·master'); if (!t) return null; const i = t.querySelector('.ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (rm) {
      await clickAt(rm.x, rm.y);
      await sleep(700);
      const gone = !(await ev(`[...document.querySelectorAll('.main-tabs .ant-tabs-tab')].some((t) => t.textContent.replace(/\\s+/g, '') === '表·master')`));
      gone ? pass('T8 关闭对象列表页（无脏直接关）') : fail('T8 关闭列表页', '仍在');
    } else fail('T8 关闭对象列表页', '无关闭按钮');
  }

  // S5 无控制台错误
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
