'use strict';
// v0927.53 结果集对比验证（固定基准快照 × 当前结果并排 diff）：
//  T1 空态：未固定基准提示 + 固定按钮禁用（无结果集）+ 无 diff 格
//  T2 固定基准：B=结果1（4 行）→ 固定为基准 → A 帽含 结果1/固定 + 统计 完全一致 · 0 diff
//  T3 单格差异（CASE 改首行 name）：统计 不同 1 格；两侧各 1 个高亮 td（共 2）；B 侧文本=对比改动、A 侧≠
//  T4 行数不同（3 行 vs 基准 4 行）：不同 3 格（行数不同）；A 侧 3 高亮 + B 侧 3 缺格灰显；B 表渲染 4 行
//  T5 列数不同（2 列 vs 基准 3 列）：不同 4 格（列数不同）；4 高亮 + 4 缺格
//  T6 完全一致（同数据重跑，仅注释标记不同）：完全一致 · 0 diff · 0 miss
//  T7 多结果切换（一次运行两语句 → 结果1/结果2）：默认 B=结果1 完全一致；下拉切 结果2 → 不同 3 格（行数不同）
//  S0 版本 v0927.53 / S5 无控制台错误
// 注：每条 SQL 尾部注释 marker 用于 waitFresh 消息面板完成判定（结果网格行数在 T6 会因旧行数相同而误判）
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
  if (!/v0927.53/.test(sb)) fail('S0 状态栏 v0927.53', sb);
  else pass('S0 状态栏 v0927.53');

  // ---- 打开 sqlite → employees → 新建查询（可重入，同 round49/50）----
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
  // paste 自带「点编辑器 → Ctrl+A → 插入」全流程 + 落地校验重试（弹窗交互会把焦点带离编辑器）
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
  // 激活「消息」内层页签：rc-tabs 惰性挂载，成功运行自动切 结果1，消息 pane 不点开不在 DOM
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
  // 等待含 marker 的成功消息（单次 evaluate 原子读；marker 每条 SQL 唯一，杜绝残留假命中）
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

  // ---- 对比弹窗四件套 ----
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
    return {
      stats: (m.querySelector('[data-dh-cmp="stats"]') || {}).textContent || '',
      capA: (m.querySelector('[data-dh-cmp="capA"]') || {}).textContent || '',
      capB: (m.querySelector('[data-dh-cmp="capB"]') || {}).textContent || '',
      pinDisabled: pin ? pin.disabled : null,
      diffCells: m.querySelectorAll('.dh-cmp-table td.dh-diff-cell').length,
      missCells: m.querySelectorAll('.dh-cmp-table td.dh-diff-miss').length,
      rowsB: m.querySelectorAll('[data-dh-cmp="sideB"] tbody tr').length,
      diffB: (() => { const t = m.querySelector('[data-dh-cmp="sideB"] td.dh-diff-cell'); return t ? t.textContent : null; })(),
      diffA: (() => { const t = m.querySelector('[data-dh-cmp="sideA"] td.dh-diff-cell'); return t ? t.textContent : null; })(),
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
  // B 侧下拉切换（antd Select 必须 mousedown 打开，click 不响应）
  const pickB = async (label) => {
    const pos = await ev(`(() => {
      const m = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.querySelector('[data-dh-cmp="modal"]'));
      const sel = m ? m.querySelector('[data-dh-cmp="selB"] .ant-select-selector') : null;
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

  // ---- T1 空态 ----
  if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats.indexOf('尚未固定基准') >= 0 && info.capA.indexOf('未固定') >= 0 && info.pinDisabled === true && info.diffCells === 0
      ? pass('T1 空态：未固定基准提示 + 固定按钮禁用 + 0 diff')
      : fail('T1 空态', JSON.stringify(info));
    await closeCmp();
  } else fail('T1 弹窗', '未打开');

  // ---- T2 固定基准（q1：4 行 × 3 列）----
  let r = await runSql('SELECT id, name, salary FROM employees ORDER BY id /* r51a */', 'r51a');
  if (r.err) fail('T2 运行', r.err);
  else if (await openCmp()) {
    let info = await cmpInfo();
    const okB = info && info.capB.indexOf('结果1') >= 0 && info.capB.indexOf('（4 行）') >= 0 && info.pinDisabled === false;
    if (!okB) fail('T2 B 侧', JSON.stringify(info));
    else if (!(await pinVia())) fail('T2 固定', '按钮不可点');
    else {
      info = await cmpInfo();
      info && info.capA.indexOf('结果1') >= 0 && info.capA.indexOf('固定') >= 0 && info.stats.indexOf('完全一致') >= 0 && info.diffCells === 0
        ? pass('T2 固定基准：A=结果1 快照 · 统计完全一致 · 0 diff')
        : fail('T2 固定后', JSON.stringify(info));
    }
    await closeCmp();
  } else fail('T2 弹窗', '未打开');

  // ---- T3 单格差异 ----
  r = await runSql("SELECT id, CASE WHEN id = (SELECT MIN(id) FROM employees) THEN '对比改动' ELSE name END AS name, salary FROM employees ORDER BY id /* r51b */", 'r51b');
  if (r.err) fail('T3 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats.indexOf('4 行 × 3 列') >= 0 && info.stats.indexOf('不同 1 格') >= 0 && info.stats.indexOf('（行数不同）') < 0
      && info.diffCells === 2 && info.missCells === 0 && info.diffB === '对比改动' && info.diffA !== null && info.diffA !== '对比改动'
      ? pass('T3 单格差异：不同 1 格 · 两侧各 1 高亮 td · B 侧值=对比改动')
      : fail('T3 单格差异', JSON.stringify(info));
    await closeCmp();
  } else fail('T3 弹窗', '未打开');

  // ---- T4 行数不同（3 行 vs 基准 4 行；剔除末行保前缀对齐，只剩第 4 行缺格）----
  r = await runSql('SELECT id, name, salary FROM employees WHERE id != (SELECT MAX(id) FROM employees) ORDER BY id /* r51c */', 'r51c');
  if (r.err) fail('T4 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats.indexOf('当前 3 行 × 3 列') >= 0 && info.stats.indexOf('不同 3 格（行数不同）') >= 0
      && info.diffCells === 3 && info.missCells === 3 && info.rowsB === 4 && info.capB.indexOf('结果1（3 行）') >= 0
      ? pass('T4 行数不同：不同 3 格（行数不同）· A 侧 3 高亮 + B 侧 3 缺格 · B 表按 4 行对齐')
      : fail('T4 行数不同', JSON.stringify(info));
    await closeCmp();
  } else fail('T4 弹窗', '未打开');

  // ---- T5 列数不同（2 列 vs 基准 3 列）----
  r = await runSql('SELECT id, name FROM employees ORDER BY id /* r51d */', 'r51d');
  if (r.err) fail('T5 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats.indexOf('当前 4 行 × 2 列') >= 0 && info.stats.indexOf('不同 4 格（列数不同）') >= 0
      && info.diffCells === 4 && info.missCells === 4
      ? pass('T5 列数不同：不同 4 格（列数不同）· 4 高亮 + 4 缺格')
      : fail('T5 列数不同', JSON.stringify(info));
    await closeCmp();
  } else fail('T5 弹窗', '未打开');

  // ---- T6 完全一致（同数据重跑，仅注释标记不同）----
  r = await runSql('SELECT id, name, salary FROM employees ORDER BY id /* r51e */', 'r51e');
  if (r.err) fail('T6 运行', r.err);
  else if (await openCmp()) {
    const info = await cmpInfo();
    info && info.stats.indexOf('完全一致') >= 0 && info.diffCells === 0 && info.missCells === 0
      ? pass('T6 同数据重跑：快照跨运行存活 · 完全一致 · 0 diff 0 miss')
      : fail('T6 完全一致', JSON.stringify(info));
    await closeCmp();
  } else fail('T6 弹窗', '未打开');

  // ---- T7 多结果下拉切换（一次运行两语句 → 结果1 4行 / 结果2 3行，结果2 剔除末行保前缀）----
  r = await runSql('SELECT id, name, salary FROM employees ORDER BY id /* r51f */; SELECT id, name, salary FROM employees WHERE id != (SELECT MAX(id) FROM employees) ORDER BY id /* r51g */', 'r51f');
  if (r.err) fail('T7 运行', r.err);
  else {
    await clickMsgTab();
    const st2 = await waitFresh('r51g');
    if (!st2) fail('T7 第二语句', '未完成');
    else if (await openCmp()) {
      let info = await cmpInfo();
      const ok1 = info && info.capB.indexOf('结果1（4 行）') >= 0 && info.stats.indexOf('完全一致') >= 0;
      ok1 ? pass('T7a 默认 B=结果1 与基准一致') : fail('T7a 默认 B', JSON.stringify(info));
      if (!(await pickB('结果2'))) fail('T7b 切换', '下拉未选中 结果2');
      else {
        info = await cmpInfo();
        info && info.capB.indexOf('结果2（3 行）') >= 0 && info.stats.indexOf('不同 3 格（行数不同）') >= 0 && info.diffCells === 3 && info.missCells === 3
          ? pass('T7b 下拉切 结果2：不同 3 格（行数不同）· 3 高亮 + 3 缺格')
          : fail('T7b 切换后', JSON.stringify(info));
      }
      await closeCmp();
    } else fail('T7 弹窗', '未打开');
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
