'use strict';
// v0927.52 SQL 历史跨连接聚合验证：
//  T1 默认范围=当前连接：仅 sqlite 条目、无连接 chip、耗时 chip 照旧（round50 行为不变）
//  T2 切「全部连接」：sqlite 1 条 + mssql 种子 2 条按时间归并（首条=最新 sqlite 运行）；
//     行内连接 chip（演示 SQLite 库 / 1）；统计 计时 3 次 · … · 2 个连接；清空按钮禁用
//  T3 聚合视图点击他连接条目 → 载入编辑器 + 弹窗关闭（SQL 只是文本，跨连接载入合法）
//  T4 重开弹窗：范围回默认当前连接；清空按钮恢复可用
//  T5 切到具体他连接（mssql '1'）：仅其 2 条、无 chip（单连接视图）；清空禁用（防误删他连接）
//  S0 版本 v0927.52 / S5 无控制台错误
// 前置 T0：清空当前连接历史（可重入；localStorage 跨实例共享）。mssql 历史用 CDP 直接种子
// （dh_hist_c-mssql-1 两条 legacy_r52m*），不依赖真实 mssql 连接——聚合逻辑只读 localStorage。
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

  // ---- 打开 sqlite → employees → 新建查询（可重入，同 round50/51）----
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
  const docText = async () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
  const paste = async (sql) => {
    for (let i = 0; i < 3; i += 1) {
      await lclick(edPos.x, edPos.y);
      await sleep(150);
      await ctrlA();
      await Input.insertText({ text: sql });
      await sleep(400);
      const d = await docText();
      if (d === sql || d.includes(sql.slice(0, 24))) return true;
    }
    return false;
  };
  const clickRun = async () => {
    for (let i = 0; i < 6; i += 1) {
      const b = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        const btn = pane ? pane.querySelector('[data-dh-q="run"]') : null;
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (b) { await lclick(b.x, b.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const clickMsgTab = async () => {
    for (let i = 0; i < 6; i += 1) {
      const t = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        if (!pane) return null;
        const tab = [...pane.querySelectorAll('.ant-tabs-nav .ant-tabs-tab')].find((x) => x.textContent.trim().indexOf('消息') === 0);
        if (!tab) return null;
        const r = tab.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (t) { await lclick(t.x, t.y); return true; }
      await sleep(400);
    }
    return false;
  };
  const waitFresh = async (marker, tries = 30) => {
    for (let i = 0; i < tries; i += 1) {
      const st = await ev(`(() => {
        const panes = [...document.querySelectorAll('.ant-tabs-tabpane-active')];
        const pane = panes.find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap') && x.querySelector('.msg-pane'));
        if (!pane) return null;
        const m = [...pane.querySelectorAll('.msg-pane .msg')].find((x) => x.textContent.includes(${JSON.stringify(marker)}));
        return m ? { msg: m.textContent.slice(0, 120) } : null;
      })()`);
      if (st && st.msg.indexOf('✓') === 0) return st;
      await sleep(500);
    }
    return null;
  };

  // ---- 历史弹窗助手（round50 模式 + scope 扩展）----
  const openHist = async () => {
    for (let i = 0; i < 6; i += 1) {
      const b = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        if (!pane) return null;
        const btn = [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.trim() === '历史');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (b) { await lclick(b.x, b.y); break; }
      await sleep(400);
    }
    for (let i = 0; i < 10; i += 1) {
      const open = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
        return !!m;
      })()`);
      if (open) return true;
      await sleep(350);
    }
    return false;
  };
  const histInfo = () => ev(`(() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
    if (!m) return null;
    const rows = [...m.querySelectorAll('[data-dh-hist="row"]')];
    const clearBtn = m.querySelector('[data-dh-hist="clear"]');
    const scope = m.querySelector('[data-dh-hist="scope"]');
    return {
      n: rows.length,
      first: rows.length ? {
        text: rows[0].textContent.slice(0, 160),
        chip: rows[0].querySelector('[data-dh-hist="ms"]') ? rows[0].querySelector('[data-dh-hist="ms"]').textContent : '',
      } : null,
      conns: [...m.querySelectorAll('[data-dh-hist="conn"]')].map((x) => x.textContent),
      stats: m.querySelector('[data-dh-hist="stats"]') ? m.querySelector('[data-dh-hist="stats"]').textContent : '',
      clearDisabled: clearBtn ? clearBtn.disabled : null,
      hasScope: !!scope,
      scopeText: scope ? scope.textContent : '',
    };
  })()`);
  const closeHist = async () => {
    const x = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const c = m.querySelector('.ant-modal-close');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (x) { await lclick(x.x, x.y); await sleep(500); }
  };
  const clearHistVia = async () => {
    const b = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      if (!m) return null;
      const btn = m.querySelector('[data-dh-hist="clear"]');
      if (!btn || btn.disabled) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    for (let i = 0; i < 10; i += 1) {
      const ok = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('清空当前连接的查询历史') >= 0);
        if (!m) return null;
        const btn = [...m.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '清空');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (ok) {
        await lclick(ok.x, ok.y);
        await sleep(600);
        return true;
      }
      await sleep(350);
    }
    return false;
  };
  // 范围下拉切换（antd Select 需 mousedown 先行；选项 label：全部连接 / 演示 SQLite 库（当前） / 1）
  const pickScope = async (label) => {
    const pos = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      const sel = m ? m.querySelector('[data-dh-hist="scope"] .ant-select-selector') : null;
      if (!sel) return null;
      const r = sel.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!pos) return false;
    await press(pos.x, pos.y, 'left', 1);
    await sleep(500);
    for (let i = 0; i < 8; i += 1) {
      const opt = await ev(`(() => {
        const opts = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')];
        const o = opts.find((x) => x.textContent.replace(/\\s+/g, '').indexOf(${JSON.stringify(label)}) === 0);
        if (!o) return null;
        const r = o.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (opt) { await lclick(opt.x, opt.y); await sleep(500); return true; }
      await sleep(350);
    }
    return false;
  };
  // 行定位（按 marker 找行，返回可点坐标）
  const rowPos = async (marker) => ev(`(() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
    const row = m ? [...m.querySelectorAll('[data-dh-hist="row"]')].find((x) => x.textContent.includes(${JSON.stringify(marker)})) : null;
    if (!row) return null;
    const r = row.getBoundingClientRect();
    return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) };
  })()`);

  // ---- T0 清空当前连接历史（幂等）----
  if (await openHist()) {
    const info = await histInfo();
    if (info && info.n > 0) await clearHistVia();
    await closeHist();
    pass('T0 当前连接历史已清空（可重入前置）');
  } else fail('T0 历史弹窗', '未打开');

  // ---- 种子 mssql 历史（CDP 直写 localStorage，两条按时间倒序）----
  const seeded = await ev(`(() => {
    const now = Date.now();
    const arr = [
      { sql: 'SELECT legacy_r52m1 AS v FROM dbo.Login', t: now - 60000, ms: 47, rows: 2, ok: true },
      { sql: 'SELECT legacy_r52m2 AS v FROM dbo.DeleteLog', t: now - 120000, ms: 33, rows: 0, ok: true },
    ];
    localStorage.setItem('dh_hist_c-mssql-1', JSON.stringify(arr));
    return JSON.parse(localStorage.getItem('dh_hist_c-mssql-1')).length;
  })()`);
  seeded === 2 ? pass('T0b mssql 历史种子 2 条（dh_hist_c-mssql-1）') : fail('T0b 种子', String(seeded));

  // ---- sqlite 跑一条（r52a）----
  if (!(await paste('SELECT COUNT(*) AS n_r52a FROM employees'))) fail('运行前置', '粘贴未落地');
  else if (!(await clickRun())) fail('运行前置', '运行按钮未找到');
  else {
    await clickMsgTab();
    const st = await waitFresh('r52a');
    st ? pass('运行前置 r52a 完成') : fail('运行前置', 'r52a 未完成');
  }

  // ---- T1 默认范围 = 当前连接（round50 行为不变）----
  if (await openHist()) {
    const info = await histInfo();
    info && info.hasScope && info.scopeText.indexOf('当前') >= 0 && info.n === 1 && info.conns.length === 0
      && info.first && /ms$|ms /.test(info.first.chip) && info.clearDisabled === false
      ? pass('T1 默认当前连接：仅 1 条 sqlite、无 chip、耗时 chip 照旧、清空可用')
      : fail('T1 默认范围', JSON.stringify(info));
  } else fail('T1 弹窗', '未打开');

  // ---- T2 切「全部连接」聚合 ----
  if (!(await pickScope('全部连接'))) fail('T2 切换', '下拉未选中 全部连接');
  else {
    const info = await histInfo();
    const uniq = Array.from(new Set(info ? info.conns : []));
    const okA = info && info.n === 3 && info.conns.length === 3
      && uniq.indexOf('演示 SQLite 库') >= 0 && uniq.indexOf('1') >= 0
      && info.first && info.first.text.indexOf('r52a') >= 0;
    okA ? pass('T2a 聚合 3 条按时间归并（首条=最新 sqlite r52a），行内 chip 含两个连接名')
      : fail('T2a 聚合行', JSON.stringify(info));
    const okB = info && /计时 3 次/.test(info.stats) && info.stats.indexOf('2 个连接') >= 0 && info.clearDisabled === true;
    okB ? pass('T2b 统计行含连接数（' + (info ? info.stats : '') + '）· 聚合态清空禁用')
      : fail('T2b 统计/清空', JSON.stringify(info));
  }

  // ---- T3 聚合视图点击他连接条目 → 载入编辑器 ----
  const rp = await rowPos('legacy_r52m1');
  if (!rp) fail('T3 行定位', '未找到 legacy_r52m1 行');
  else {
    await lclick(rp.x, rp.y);
    await sleep(700);
    const doc = await docText();
    const closed = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.indexOf('查询历史') >= 0);
      return !m;
    })()`);
    doc.indexOf('legacy_r52m1') >= 0 && closed
      ? pass('T3 跨连接条目点击 → 载入编辑器 + 弹窗关闭')
      : fail('T3 载入', JSON.stringify({ doc: String(doc).slice(0, 80), closed }));
  }

  // ---- T4 重开弹窗：范围回默认当前连接 ----
  if (await openHist()) {
    const info = await histInfo();
    info && info.scopeText.indexOf('当前') >= 0 && info.n === 1 && info.conns.length === 0 && info.clearDisabled === false
      ? pass('T4 重开回默认范围：1 条 sqlite、清空恢复可用')
      : fail('T4 重开默认', JSON.stringify(info));
  } else fail('T4 弹窗', '未打开');

  // ---- T5 切到具体他连接（mssql '1'）----
  if (!(await pickScope('1'))) fail('T5 切换', '下拉未选中 mssql 连接');
  else {
    const info = await histInfo();
    info && info.n === 2 && info.conns.length === 0 && info.first && info.first.text.indexOf('legacy_r52m1') >= 0
      && info.clearDisabled === true
      ? pass('T5 他连接单看：仅其 2 条、无 chip、首条 legacy_r52m1、清空禁用')
      : fail('T5 他连接', JSON.stringify(info));
  }
  await closeHist();

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
