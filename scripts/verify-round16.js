'use strict';
// v0927.53 启动动画 + ER 图验证（sqlite+mssql 双连接 9228 新实例）：
//  S0 状态栏版本 / SP1 ui-debug.log 里 DH-SPLASH shown→closed 且最短展示 ≥800ms
//  A sqlite：表分类右键「查看 ER 图」→ 画布 + employees 盒子 + PK 行样式 + 缩放 + 拖拽
//  B mssql：master 右键 ER → dh_er_a/dh_er_b 盒子 + 外键连线存在
const CDP = require('chrome-remote-interface');
const fs = require('fs');
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
  const press = async (x, y, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: cnt });
  };
  const dblclick = async (x, y) => { await press(x, y, 1); await sleep(80); await press(x, y, 2); await sleep(2000); };
  const click = (x, y) => press(x, y, 1);
  const rightclick = async (x, y) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'right', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'right', clickCount: 1 });
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const posOf = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  // 在可见 tabpane 里右键树行 → 点「查看 ER 图」→ 等 ER 画布出现
  const openErFromTree = async (rowTitle) => {
    let p = null;
    for (let i = 0; i < 12 && !p; i += 1) { p = await posOf(rowTitle); if (!p) await sleep(700); }
    if (!p) return { miss: 'row' };
    await rightclick(p.x, p.y);
    await sleep(400);
    const m = await ev(`(() => {
      const items = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].filter((el) => el.getBoundingClientRect().height > 0);
      const f = items.find((el) => el.textContent.includes('查看 ER 图'));
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!m) return { miss: 'menu' };
    await click(m.x, m.y);
    for (let i = 0; i < 14; i += 1) {
      const ok = await ev(`!!document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-canvas')`);
      if (ok) return { ok: true };
      await sleep(700);
    }
    return { miss: 'canvas' };
  };

  await sleep(2500);
  // S0 版本
  const ver = await ev(`(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()`);
  if (/v0927.53/.test(String(ver))) pass('S0 状态栏 v0927.53'); else fail('S0 状态栏 v0927.53', String(ver).slice(0, 120));

  // SP1 启动动画日志：shown→closed，最短展示时长
  try {
    const log = fs.readFileSync('D:/DataHelm/.tmp-ud7/ui-debug.log', 'utf8');
    const ts = (line) => Date.parse(line.slice(0, 24));
    const shLine = log.split('\n').filter((l) => l.includes('DH-SPLASH shown v0927.53')).pop();
    const clLine = log.split('\n').filter((l) => l.includes('DH-SPLASH closed')).pop();
    if (shLine && clLine) {
      const dur = ts(clLine) - ts(shLine);
      if (dur >= 800) pass(`SP1 启动动画 shown→closed（${dur}ms ≥ 800ms）`);
      else fail('SP1 启动动画最短展示', `dur=${dur}ms`);
    } else fail('SP1 启动动画日志', `shown=${!!shLine} closed=${!!clLine}`);
  } catch (e) {
    fail('SP1 启动动画日志', e.message);
  }

  // ER 盒子布局持久化在 localStorage（userData 跨套件保留）：先清 dh_er_* 并重载，保证 A4 从自动布局起拖
  await ev(`(() => { Object.keys(localStorage).filter((k) => k.startsWith('dh_er_')).forEach((k) => localStorage.removeItem(k)); return 1; })()`);
  await ev('location.reload()');
  for (let i = 0; i < 24; i += 1) { if (await ev(`!!document.querySelector('.top-toolbar .tb-btn')`)) break; await sleep(500); }
  await sleep(800);

  // A sqlite：展开连接 → 表分类右键 → ER 图
  const p0 = await posOf('演示 SQLite 库');
  if (!p0) { fail('A1 ER 画布打开（sqlite）', 'no conn row'); } else {
    await dblclick(p0.x, p0.y);
    const r = await openErFromTree('表');
    if (r && r.ok) {
      pass('A1 sqlite 表分类右键打开 ER 图');
      // 盒子在元数据加载后才渲染：轮询等待 employees 盒子出现
      let box = null;
      for (let i = 0; i < 14 && !box; i += 1) {
        box = await ev(`(() => {
          const pane = document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden)');
          const b = pane && pane.querySelector('.er-table[data-dh-er-table="employees"]');
          if (!b) return null;
          const pk = b.querySelector('.er-row.pk');
          return { title: b.querySelector('.er-th .nm').textContent, rows: b.querySelectorAll('.er-row').length,
            pkName: pk ? pk.querySelector('.cname').textContent : null, hasKico: !!b.querySelector('.kico'),
            left: b.style.left, top: b.style.top, cx: Math.round(b.getBoundingClientRect().x + 40), hy: Math.round(b.getBoundingClientRect().y + 14) };
        })()`);
        if (!box) await sleep(700);
      }
      if (box && box.title === 'employees' && box.rows >= 1 && box.pkName === 'id' && box.hasKico) pass(`A2 employees 盒子（${box.rows} 列，PK=${box.pkName} 金色钥匙）`);
      else fail('A2 employees 盒子', JSON.stringify(box));
      // A3 缩放：放大 110% → 点百分比复位 100%
      const zin = await ev(`(() => {
        const pane = document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden)');
        const b = pane && [...pane.querySelectorAll('.tab-toolbar button')].find((x) => (x.title || '') === '放大');
        if (!b) return null; b.click(); return true;
      })()`);
      await sleep(300);
      const z1 = await ev(`document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-zoom') ? document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-zoom').getAttribute('data-dh-er-zoom') : null`);
      await ev(`document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-zoom').click()`);
      await sleep(300);
      const z2 = await ev(`document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-zoom') ? document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden) .er-zoom').getAttribute('data-dh-er-zoom') : null`);
      if (zin && z1 === '110' && z2 === '100') pass('A3 缩放（放大 110% → 复位 100%）');
      else fail('A3 缩放', `zin=${!!zin} z1=${z1} z2=${z2}`);
      // A4 拖拽盒子：mousedown 表头 → move +60/+40 → 位置变化且持久化键写入
      if (box) {
        await Input.dispatchMouseEvent({ type: 'mousePressed', x: box.cx, y: box.hy, button: 'left', clickCount: 1 });
        await sleep(60);
        await Input.dispatchMouseEvent({ type: 'mouseMoved', x: box.cx + 60, y: box.hy + 40, button: 'left', buttons: 1, clickCount: 1 });
        await sleep(60);
        await Input.dispatchMouseEvent({ type: 'mouseReleased', x: box.cx + 60, y: box.hy + 40, button: 'left', clickCount: 1 });
        await sleep(400);
        const after = await ev(`(() => {
          const b = document.querySelector('.er-table[data-dh-er-table="employees"]');
          const saved = Object.keys(localStorage).filter((k) => k.startsWith('dh_er_'));
          return { left: b.style.left, top: b.style.top, saved: saved.length };
        })()`);
        if (after.left !== box.left || after.top !== box.top) pass(`A4 拖拽盒子（${box.left},${box.top}→${after.left},${after.top}）`);
        else fail('A4 拖拽盒子', JSON.stringify(after));
        if (after.saved >= 1) pass('A4b 布局已持久化（localStorage dh_er_*）'); else fail('A4b 布局已持久化', 'no key');
      }
    } else fail('A1 sqlite 表分类右键打开 ER 图', JSON.stringify(r));
  }

  // B mssql：master 库行右键 → ER 图 → dh_er_a/b 盒子 + 外键连线
  await sleep(1200);
  const p1 = await posOf('1');
  if (!p1) { fail('B1 mssql ER 打开', 'no conn row'); } else {
    await dblclick(p1.x, p1.y);
    let master = null;
    for (let i = 0; i < 14 && !master; i += 1) { master = await posOf('master'); if (!master) await sleep(700); }
    if (!master) { fail('B1 mssql ER 打开', 'no master row'); } else {
      const r = await openErFromTree('master');
      if (r && r.ok) {
        const ttl = await ev(`(() => { const t = [...document.querySelectorAll('.ant-tabs-tab')].find((x) => x.className.includes('ant-tabs-tab-active')); return t ? t.textContent : ''; })()`);
        if (/ER 图 · master/.test(String(ttl))) pass('B1 mssql master 右键打开 ER 图（标题带库名）');
        else fail('B1 mssql master 右键打开 ER 图', `tab=${ttl}`);
        // 盒子/连线随元数据分批到达：轮询等待 dh_er_a 盒子 + dh_er_b 外键边
        let st = null;
        for (let i = 0; i < 16 && !(st && st.a && st.fkEdge); i += 1) {
          st = await ev(`(() => {
            const pane = document.querySelector('.ant-tabs-tabpane:not(.ant-tabs-tabpane-hidden)');
            if (!pane) return { miss: 'pane' };
            const a = pane.querySelector('.er-table[data-dh-er-table="dh_er_a"]');
            const b = pane.querySelector('.er-table[data-dh-er-table="dh_er_b"]');
            const edges = [...pane.querySelectorAll('path[data-dh-er-edge]')];
            const fkEdge = edges.find((e) => e.getAttribute('data-dh-er-edge').startsWith('dh_er_b.'));
            return { a: !!a, b: !!b, edgeCount: edges.length, fkEdge: !!fkEdge,
              fkD: fkEdge ? fkEdge.getAttribute('d') : null, aPk: a ? !!a.querySelector('.er-row.pk .kico') : null };
          })()`);
          if (!(st && st.a && st.fkEdge)) await sleep(800);
        }
        if (st && st.a && st.b && st.fkEdge && st.aPk) pass(`B2 mssql ER 盒子+外键连线（边 ${st.edgeCount} 条，d=${String(st.fkD).slice(0, 48)}…）`);
        else fail('B2 mssql ER 盒子+外键连线', JSON.stringify(st));
      } else fail('B1 mssql ER 打开', JSON.stringify(r));
    }
  }

  // S5 无渲染错误
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
