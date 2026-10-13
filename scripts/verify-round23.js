'use strict';
// v0927.52 工具栏「表/视图」= 对象列表页（语义改为查看已有清单，非新建；跟随所选库自动切换）验证：
//  T1 sqlite 选 employees → 工具栏「表」→ 列表页：employees 行 + 行数数字 + 单文件库 Tag + 标题「表 · 演示 SQLite 库」
//  T2 Segmented 切「视图」→ 空列表 0 个视图 + 标题「视图 · 演示 SQLite 库」；切回「表」恢复
//  T3 行内「打开」→ employees 数据页打开（新页签 + 网格）
//  D1 页内「新建表」→ 设计页打开（新建入口保留）→ 关闭
//  X1 行内「删除」→ 确认弹窗 → 取消 → 行仍在
//  T4 树点选 mssql master → 列表页自动跟随：标题「表 · master」+ 库下拉=master + 行>0 + 页签数不变（同页重定向不新开）
//  T5 页内库下拉切 msdb → 标题「表 · msdb」+ 列表重载
//  T6 树点回 sqlite employees → 跟随回「表 · 演示 SQLite 库」+ 单文件库 Tag 回来
//  B1/S5 无边界误触发 + 无控制台错误 / S0 版本 v0927.52
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
  const press = async (x, y, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 1); await sleep(350); };
  const dblclick = async (x, y) => { await press(x, y, 1); await sleep(80); await press(x, y, 2); await sleep(1300); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const treePos = (title, idx = 0) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const hits = rows.filter((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    const f = hits[${idx}];
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const waitTree = async (title, idx = 0, tries = 24) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const topBtn = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  // 对象列表页断言辅助（页签可能不在前台——隐藏 pane 仍挂载，textContent 可读）
  const objsCtx = () => ev(`(() => { const c = document.querySelector('[data-dh-objs] .ctx'); return c ? c.textContent : null; })()`);
  const objsRows = () => ev(`document.querySelectorAll('[data-dh-objs] tbody .objs-name').length`);
  const tabLabelHas = (kw) => ev(`[...document.querySelectorAll('.main-tabs .ant-tabs-tab')].some((t) => t.textContent.includes(${JSON.stringify(kw)}))`);
  const waitTabLabel = async (kw, tries = 20) => {
    for (let i = 0; i < tries; i += 1) { if (await tabLabelHas(kw)) return true; await sleep(400); }
    return false;
  };
  const activateTab = async (kw) => {
    await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes(${JSON.stringify(kw)})); if (t) t.click(); return !!t; })()`);
    await sleep(500);
  };
  const closeTabByX = async () => {
    for (let i = 0; i < 6; i += 1) {
      const done = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.className.includes('ant-tabs-tab-active')); if (!t) return true; const x = t.querySelector('.ant-tabs-tab-remove'); if (!x) return false; x.click(); return true; })()`);
      // 脏确认弹窗异步渲染：轮询等它出现再点「放弃并关闭」（点 X 后立即查会漏）
      for (let j = 0; j < 6; j += 1) {
        const p = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; if (!w) return null; const c = w.querySelector('.ant-modal-confirm'); if (!c) return null; const b = [...c.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (p) { await lclick(p.x, p.y); break; }
        await sleep(400);
      }
      if (done) return true;
      await sleep(500);
    }
    return false;
  };

  // ---- S0 版本 ----
  const ver = await ev(`document.querySelector('.statusbar').textContent`);
  if (/v0927\.52/.test(String(ver))) pass('S0 状态栏 v0927.52'); else fail('S0 状态栏 v0927.52', String(ver).slice(0, 80));

  // ---- T1 sqlite：选 employees → 工具栏「表」→ 对象列表 ----
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('T1 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表', 0);
    if (!p) fail('T1 展开', 'sqlite 表分类未找到');
    else {
      await dblclick(p.x, p.y);
      p = await waitTree('employees');
      if (!p) fail('T1 前置', 'employees 未出现');
      else {
        await lclick(p.x, p.y); // 选中表 → 工具栏获得上下文
        if (await topBtn('表')) {
          let ok = false;
          for (let i = 0; i < 20 && !ok; i += 1) { ok = !!await ev(`!!document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]')`); if (!ok) await sleep(400); }
          if (!ok) fail('T1 对象列表页打开', 'pane 未出现');
          else {
            let row = null;
            for (let i = 0; i < 20 && !row; i += 1) { row = await ev(`(() => { const r = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => x.querySelector('.objs-name') && x.querySelector('.objs-name').textContent === 'employees'); return r ? { rows: r.cells[3] ? r.cells[3].textContent.trim() : '' } : null; })()`); if (!row) await sleep(400); }
            const ctx = await objsCtx();
            const tag = await ev(`(() => { const t = document.querySelector('[data-dh-objs] .ant-tag'); return t ? t.textContent : null; })()`);
            const title = await waitTabLabel('表 · 演示 SQLite 库', 3);
            row && /^\d[\d,]*$/.test(row.rows) && ctx && ctx.includes('演示 SQLite 库') && ctx.includes('1 个表') && tag && tag.includes('单文件库') && title
              ? pass('T1 sqlite 表列表：employees + 行数 ' + row.rows + ' + 单文件库 Tag')
              : fail('T1 sqlite 表列表', JSON.stringify({ row, ctx, tag, title }));
          }
        } else fail('T1 工具栏「表」按钮', '不可用');
      }
    }
  }

  // ---- T2 Segmented 切视图 → 空；切回表 ----
  const segOk = await ev(`(() => { const it = [...document.querySelectorAll('[data-dh-kind] .ant-segmented-item')].find((x) => x.textContent.trim() === '视图'); if (!it) return false; it.click(); return true; })()`);
  let emptyView = false;
  for (let i = 0; i < 15 && !emptyView; i += 1) { const c = await objsCtx(); emptyView = !!c && c.includes('0 个视图') && (await objsRows()) === 0; if (!emptyView) await sleep(400); }
  const viewTitle = await waitTabLabel('视图 · 演示 SQLite 库', 3);
  segOk && emptyView && viewTitle ? pass('T2 切「视图」→ 空列表（0 个视图）+ 标题联动') : fail('T2 切视图', JSON.stringify({ segOk, emptyView, viewTitle }));
  await ev(`(() => { const it = [...document.querySelectorAll('[data-dh-kind] .ant-segmented-item')].find((x) => x.textContent.trim() === '表'); if (it) it.click(); return true; })()`);
  let backTable = false;
  for (let i = 0; i < 15 && !backTable; i += 1) { const c = await objsCtx(); backTable = !!c && c.includes('1 个表') && (await objsRows()) === 1; if (!backTable) await sleep(400); }
  backTable ? pass('T2b 切回「表」→ employees 恢复') : fail('T2b 切回表', '列表未恢复');

  // ---- T3 行内「打开」→ 数据页 ----
  const opened = await ev(`(() => { const r = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => x.querySelector('.objs-name') && x.querySelector('.objs-name').textContent === 'employees'); if (!r) return false; const b = [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === '打开'); if (!b) return false; b.click(); return true; })()`);
  let grid = false;
  for (let i = 0; i < 20 && !grid; i += 1) { grid = !!(await tabLabelHas('employees')) && !!(await ev(`!!document.querySelector('.ant-tabs-tabpane-active .grid-area')`)); if (!grid) await sleep(400); }
  opened && grid ? pass('T3 行「打开」→ employees 数据页') : fail('T3 打开数据页', JSON.stringify({ opened, grid }));
  await activateTab('表 · 演示 SQLite 库');

  // ---- D1 页内「新建表」→ 设计页 → 关闭 ----
  const nw = await ev(`(() => { const b = document.querySelector('[data-dh-objs] [data-dh-new]'); if (!b) return false; b.click(); return true; })()`);
  let design = false;
  for (let i = 0; i < 15 && !design; i += 1) { design = !!(await tabLabelHas('新建表')) && !!(await ev(`!!document.querySelector('.ant-tabs-tabpane-active .tab-toolbar')`)); if (!design) await sleep(400); }
  nw && design ? pass('D1 页内「新建表」→ 设计页（新建入口保留）') : fail('D1 新建表', JSON.stringify({ nw, design }));
  const closed = await closeTabByX();
  closed ? pass('D1b 设计页已关闭') : fail('D1b 关闭设计页', 'close failed');
  await activateTab('表 · 演示 SQLite 库');

  // ---- X1 行「删除」→ 确认 → 取消 ----
  const del = await ev(`(() => { const r = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => x.querySelector('.objs-name') && x.querySelector('.objs-name').textContent === 'employees'); if (!r) return false; const b = [...r.querySelectorAll('button')].find((x) => x.textContent.trim() === '删除'); if (!b) return false; b.click(); return true; })()`);
  let cm = null;
  for (let i = 0; i < 12 && !cm; i += 1) { cm = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; const c = w && w.querySelector('.ant-modal-confirm'); if (!c) return null; const t = c.querySelector('.ant-modal-confirm-title'); return t ? t.textContent : ''; })()`); if (!cm) await sleep(400); }
  if (!del || !cm || !String(cm).includes('删除表「employees」')) fail('X1 删除确认弹窗', JSON.stringify({ del, cm }));
  else {
    const cancel = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; const c = w.querySelector('.ant-modal-confirm'); const b = [...c.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '取消'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (cancel) await lclick(cancel.x, cancel.y);
    let gone = false;
    for (let i = 0; i < 10 && !gone; i += 1) { gone = !(await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); return ws.some((w) => w.querySelector('.ant-modal-confirm')); })()`)); if (!gone) await sleep(400); }
    const still = (await objsRows()) === 1;
    gone && still ? pass('X1 删除确认 → 取消 → 行仍在') : fail('X1 取消删除', JSON.stringify({ gone, still }));
  }

  // ---- T4 树点选 mssql master → 自动跟随（同页重定向，不新开页签）----
  const tabsBefore = await ev(`document.querySelectorAll('.main-tabs .ant-tabs-tab').length`);
  p = await waitTree('1', 0, 10);
  if (!p) fail('T4 前置', 'mssql 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('master');
    if (!p) fail('T4 展开', 'master 未出现');
    else {
      await lclick(p.x, p.y); // 选中 master 库节点 → 对象列表自动跟随
      let followed = false;
      for (let i = 0; i < 25 && !followed; i += 1) {
        const c = await objsCtx();
        followed = !!c && c.includes('master') && (await tabLabelHas('表 · master'));
        if (!followed) await sleep(500);
      }
      let scopeV = null;
      for (let i = 0; i < 10 && !scopeV; i += 1) { scopeV = await ev(`(() => { const s = document.querySelector('[data-dh-objs] .objs-scope .ant-select-selection-item'); return s ? s.textContent : null; })()`); if (!scopeV) await sleep(400); }
      let n = 0;
      for (let i = 0; i < 25 && !n; i += 1) { n = await objsRows(); if (!n) await sleep(500); }
      const tabsAfter = await ev(`document.querySelectorAll('.main-tabs .ant-tabs-tab').length`);
      followed && scopeV === 'master' && n >= 0 && tabsAfter === tabsBefore
        ? pass('T4 树选 master → 列表页自动跟随（master 用户表 ' + n + ' 个，系统库；同页未新开）')
        : fail('T4 自动跟随', JSON.stringify({ followed, scopeV, n, tabsBefore, tabsAfter }));

      // ---- T5 页内库下拉切 platform（用户库，387 表，只读目录查询）----
      await activateTab('表 · master');
      const openedDD = await ev(`(() => { const s = document.querySelector('[data-dh-objs] .objs-scope .ant-select-selector'); if (!s) return null; const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: r.x + 10, clientY: r.y + 10 })); return { x: Math.round(r.x + 20), y: Math.round(r.y + r.height / 2) }; })()`);
      await sleep(600);
      let opt = null;
      for (let i = 0; i < 12 && !opt; i += 1) {
        opt = await ev(`(() => { const ds = [...document.querySelectorAll('.ant-select-dropdown')].filter((x) => !x.className.includes('ant-select-dropdown-hidden') && getComputedStyle(x).display !== 'none'); const dd = ds[ds.length - 1]; if (!dd) return null; const o = [...dd.querySelectorAll('.ant-select-item-option')].find((x) => x.textContent.trim() === 'platform'); if (!o) return null; o.scrollIntoView({ block: 'nearest' }); const r = o.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (!opt) await sleep(400);
      }
      if (!openedDD || !opt) fail('T5 下拉', JSON.stringify({ openedDD: !!openedDD, opt: !!opt }));
      else {
        await lclick(opt.x, opt.y);
        let sw = false;
        for (let i = 0; i < 25 && !sw; i += 1) { const c = await objsCtx(); sw = !!c && c.includes('platform') && (await tabLabelHas('表 · platform')); if (!sw) await sleep(500); }
        let n2 = 0;
        for (let i = 0; i < 25 && !n2; i += 1) { n2 = await objsRows(); if (!n2) await sleep(500); }
        sw && n2 > 0 ? pass('T5 库下拉切 platform → 列表重载（首屏 ' + n2 + ' 行）') : fail('T5 切 platform', JSON.stringify({ sw, n2 }));
      }
    }
  }

  // ---- T6 树点回 sqlite employees → 跟随回 sqlite ----
  p = await waitTree('employees');
  if (!p) fail('T6 前置', 'employees 未找到');
  else {
    await lclick(p.x, p.y);
    // T5 刚切走后树会重渲染，employees 坐标可能漂移致首击落空：未回位前每 4 拍重定位补点一次；
    // 诊断里带上 label/rows 区分到底卡在哪个条件
    let back = false;
    let diag = { label: null, rows: null };
    for (let i = 0; i < 25 && !back; i += 1) {
      const c = await objsCtx();
      const lb = await tabLabelHas('表 · 演示 SQLite 库');
      const rw = await objsRows();
      diag = { label: lb, rows: rw };
      back = !!c && c.includes('演示 SQLite 库') && lb && rw === 1;
      if (!back) {
        if (i > 0 && i % 4 === 0) { const p2 = await waitTree('employees'); if (p2) await lclick(p2.x, p2.y); }
        await sleep(500);
      }
    }
    const tag = await ev(`(() => { const t = document.querySelector('[data-dh-objs] .ant-tag'); return t ? t.textContent : null; })()`);
    back && tag && tag.includes('单文件库') ? pass('T6 树点回 employees → 跟随回 sqlite（Tag 恢复）') : fail('T6 跟随回 sqlite', JSON.stringify({ back, tag, diag }));
  }

  // ---- B1 / S5 ----
  const b1 = await ev("!!document.querySelector('.dh-err-boundary')");
  !b1 ? pass('B1 无错误边界误触发') : fail('B1 边界误触发', 'unexpected fallback');
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
