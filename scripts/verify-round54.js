'use strict';
// v0927.52 结果对比「按键对齐」验证（固定基准快照 × 当前结果，按同名列对齐）：
//  T1 位置对齐（默认）：倒序同数据 → 有差异（行错位）；切「按键对齐」→ 按 id 对齐 完全一致 · 0 diff
//  T2 键对齐单格差异（倒序 + 首行 name 改动）：不同 1 格 · 两侧各 1 高亮 · B 侧文本=键对齐改动
//  T3 仅A 行（剔末行 3 行）：匹配 3 行 · 仅A 1 · 仅B 0 · 不同 3 格；A 侧 3 高亮 + B 侧 3 缺格
//  T4 键列切换 name：统计前缀 按 name 对齐 · 匹配 3 行
//  T5 切回位置对齐：回到位置对齐既有语义（不同 3 格（行数不同））
//  S0 版本 v0927.52 / S5 无控制台错误
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

  // ---- 打开 sqlite → employees → 新建查询（可重入）----
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
  const runSql = async (sql, marker) => {
    if (!(await paste(sql))) return { err: 'paste' };
    if (!(await clickRun())) return { err: 'run' };
    await clickMsgTab();
    const st = await waitFresh(marker);
    return st ? { ok: true } : { err: 'wait:' + marker };
  };

  // ---- 对比弹窗助手 ----
  const openCmp = async () => {
    for (let i = 0; i < 6; i += 1) {
      const b = await ev(`(() => {
        const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
        const btn = pane ? pane.querySelector('[data-dh-q="cmp"]') : null;
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (b) { await lclick(b.x, b.y); break; }
      await sleep(400);
    }
    for (let i = 0; i < 10; i += 1) {
      const open = await ev(`(() => {
        const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
        return !!m;
      })()`);
      if (open) return true;
      await sleep(350);
    }
    return false;
  };
  const cmpInfo = () => ev(`(() => {
    const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
    if (!m) return null;
    const pin = m.querySelector('[data-dh-cmp="pin"]');
    const modeItem = m.querySelector('[data-dh-cmp="mode"] .ant-select-selection-item');
    return {
      stats: (m.querySelector('[data-dh-cmp="stats"]') || {}).textContent || '',
      mode: modeItem ? modeItem.textContent.trim() : '',
      hasKeysel: !!m.querySelector('[data-dh-cmp="keysel"]'),
      pinDisabled: pin ? pin.disabled : null,
      diffCells: m.querySelectorAll('.dh-cmp-table td.dh-diff-cell').length,
      missCells: m.querySelectorAll('.dh-cmp-table td.dh-diff-miss').length,
      rowsB: m.querySelectorAll('[data-dh-cmp="sideB"] tbody tr').length,
      diffB: (() => { const t = m.querySelector('[data-dh-cmp="sideB"] td.dh-diff-cell'); return t ? t.textContent : null; })(),
    };
  })()`);
  const closeCmp = async () => {
    const x = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
      if (!m) return null;
      const c = m.querySelector('.ant-modal-close');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (x) { await lclick(x.x, x.y); await sleep(500); }
  };
  const pinVia = async () => {
    const b = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
      if (!m) return null;
      const btn = m.querySelector('[data-dh-cmp="pin"]');
      if (!btn || btn.disabled) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    await sleep(450);
    return true;
  };
  // 通用下拉选择（mode / keysel；antd Select 需 mousedown 先行）
  const pickCmp = async (which, label) => {
    const pos = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
      const sel = m ? m.querySelector('[data-dh-cmp=${JSON.stringify(which)}] .ant-select-selector') : null;
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
        const o = opts.find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)});
        if (!o) return null;
        const r = o.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (opt) { await lclick(opt.x, opt.y); await sleep(500); return true; }
      await sleep(350);
    }
    return false;
  };

  // ---- 基准：q1（4 行升序）固定 ----
  let r = await runSql('SELECT id, name, salary FROM employees ORDER BY id /* r54a */', 'r54a');
  if (r.err) { fail('前置', r.err); await client.close(); return; }
  if (!(await openCmp())) { fail('前置', '对比弹窗未打开'); await client.close(); return; }
  if (!(await pinVia())) { fail('前置', '固定为基准失败'); await client.close(); return; }
  await closeCmp();

  // ---- T1 倒序同数据：位置对齐有差异 → 按键对齐完全一致 ----
  r = await runSql('SELECT id, name, salary FROM employees ORDER BY id DESC /* r54b */', 'r54b');
  if (r.err) fail('T1 运行', r.err);
  else if (await openCmp()) {
    let info = await cmpInfo();
    const m0 = info && info.mode === '位置对齐' ? (info.stats.match(/不同 (\d+) 格/) || [])[1] : null;
    const posOk = m0 !== null && Number(m0) >= 8; // 行错位下 id+name 至少 8 格不同
    posOk ? pass('T1a 位置对齐（默认）：倒序同数据显示行错位差异（不同 ' + m0 + ' 格）')
      : fail('T1a 位置对齐', JSON.stringify(info));
    if (!(await pickCmp('mode', '按键对齐'))) fail('T1b 切模式', '下拉未选中 按键对齐');
    else {
      info = await cmpInfo();
      info && info.mode === '按键对齐' && info.hasKeysel && info.stats === '按 id 对齐 · 匹配 4 行 · 仅A 0 · 仅B 0 · 完全一致' && info.diffCells === 0
        ? pass('T1b 按键对齐：同数据倒序 → 按 id 对齐 完全一致 · 0 diff')
        : fail('T1b 按键对齐', JSON.stringify(info));
    }
    await closeCmp();
  } else fail('T1 弹窗', '未打开');

  // ---- T2 键对齐单格差异（倒序 + 首行 name 改动）----
  r = await runSql("SELECT id, CASE WHEN id = (SELECT MIN(id) FROM employees) THEN '键对齐改动' ELSE name END AS name, salary FROM employees ORDER BY id DESC /* r54c */", 'r54c');
  if (r.err) fail('T2 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.mode === '按键对齐' && info.stats.indexOf('按 id 对齐 · 匹配 4 行 · 仅A 0 · 仅B 0 · 不同 1 格') === 0
      && info.diffCells === 2 && info.missCells === 0 && info.diffB === '键对齐改动'
      ? pass('T2 键对齐单格差异：不同 1 格 · 两侧各 1 高亮 · B 侧值=键对齐改动')
      : fail('T2 单格差异', JSON.stringify(info));
    await closeCmp();
  } else fail('T2 弹窗', '未打开');

  // ---- T3 仅A 行（剔末行 3 行）----
  r = await runSql('SELECT id, name, salary FROM employees WHERE id != (SELECT MAX(id) FROM employees) ORDER BY id /* r54d */', 'r54d');
  if (r.err) fail('T3 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats === '按 id 对齐 · 匹配 3 行 · 仅A 1 · 仅B 0 · 不同 3 格'
      && info.diffCells === 3 && info.missCells === 3 && info.rowsB === 4
      ? pass('T3 仅A 行：匹配 3 · 仅A 1 · 仅B 0 · 不同 3 格；A 3 高亮 + B 3 缺格')
      : fail('T3 仅A 行', JSON.stringify(info));
    // T4/T5 复用本弹窗（键列切换 + 切回位置对齐）
    if (!(await pickCmp('keysel', 'name'))) fail('T4 键列切换', '下拉未选中 name');
    else {
      const info = await cmpInfo();
      info && info.stats.indexOf('按 name 对齐 · 匹配 3 行') === 0
        ? pass('T4 键列可切换（' + info.stats + '）')
        : fail('T4 键列切换', JSON.stringify(info));
    }
    if (!(await pickCmp('mode', '位置对齐'))) fail('T5 切回', '下拉未选中 位置对齐');
    else {
      const info = await cmpInfo();
      info && info.stats === '基准 4 行 × 3 列 · 当前 3 行 × 3 列 · 不同 3 格（行数不同）'
        ? pass('T5 切回位置对齐：既有语义不变（不同 3 格（行数不同））')
        : fail('T5 位置对齐', JSON.stringify(info));
    }
    await closeCmp();
  } else fail('T3 弹窗', '未打开');

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
