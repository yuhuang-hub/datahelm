'use strict';
// v0927.52 三处修复验证（9229 新实例，sqlite 演示库）：
//  G1 未打开连接：新建查询/表/视图/ER图/用户 全禁用；表 title=请先打开数据库连接；连接/查询列表/备份可用
//  G2 双击打开 sqlite 连接后：表/视图/新建查询/用户 恢复可用（ER 仍禁用待选表）；表 title 恢复查看语义
//  D1 设计器保存直接执行：改字段名→SQL 预览只读（无「执行变更」按钮）→「保存」不跳预览、回「字段」页+已执行消息+新名回读→还原
//  V1 新建视图长表名：卡片头表名省略号截断+title 提示，「全选」标签不折行（单行高度），卡片宽≤340，全选可点
//  B1/S5 无边界误触发 + 无控制台错误 / S0 版本 v0927.52
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LONG = 'dh_vd_very_long_table_name_for_header_overflow_check';
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(280); };
  const dblclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(80); await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 2); await sleep(1300); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const insertText = (t) => Input.insertText({ text: t });
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const waitTree = async (title, idx = 0, tries = 14) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const tbBtn = (kw) => `(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); return b ? { dis: b.disabled, title: b.getAttribute('title') || '' } : null; })()`;
  const tbPos = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    return p;
  };
  const msgs = () => ev(`[...document.querySelectorAll('.ant-message-notice-content')].map((m) => m.textContent).join(' | ')`);

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- G1 未打开连接：全禁用 ----
  const g1 = await ev(`(() => { const bs = [...document.querySelectorAll('.top-toolbar .tb-btn')]; return { dis: bs.filter((b) => b.disabled).map((b) => b.textContent.replace(/\\s+/g, '')), ena: bs.filter((b) => !b.disabled).map((b) => b.textContent.replace(/\\s+/g, '')) }; })()`);
  JSON.stringify(g1 && g1.dis) === JSON.stringify(['新建查询', '表', '视图', 'ER图', '用户']) && JSON.stringify(g1 && g1.ena) === JSON.stringify(['连接', '查询列表', '结构同步', '数据同步', '备份'])
    ? pass('G1 未打开连接：新建查询/表/视图/ER图/用户 禁用；连接/查询列表/结构同步/数据同步/备份 可用')
    : fail('G1 初始禁用态', JSON.stringify(g1));
  const t1 = await ev(tbBtn('表'));
  t1 && t1.dis === true && t1.title === '请先打开数据库连接'
    ? pass('G1b 表按钮禁用提示 = 请先打开数据库连接')
    : fail('G1b 表按钮提示', JSON.stringify(t1));

  // ---- G2 打开 sqlite 连接后恢复 ----
  let p = await waitTree('演示 SQLite 库', 0, 10);
  if (!p) fail('G2 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    let g2 = null;
    for (let i = 0; i < 16 && !(g2 && g2.t && g2.t.dis === false); i += 1) {
      await sleep(500);
      g2 = { t: await ev(tbBtn('表')), v: await ev(tbBtn('视图')), q: await ev(tbBtn('新建查询')), u: await ev(tbBtn('用户')), e: await ev(tbBtn('ER图')) };
    }
    g2 && g2.t && g2.t.dis === false && g2.v && g2.v.dis === false && g2.q && g2.q.dis === false && g2.u && g2.u.dis === false && g2.e && g2.e.dis === true
      ? pass('G2 打开 sqlite 后：表/视图/新建查询/用户 恢复可用（ER 仍禁用）')
      : fail('G2 打开后可用态', JSON.stringify(g2));
    g2 && g2.t && g2.t.title === '查看选中（或活动标签页）的库的表列表'
      ? pass('G2b 表按钮 title 恢复查看语义')
      : fail('G2b 表按钮 title', JSON.stringify(g2 && g2.t));
  }

  // ---- D1 设计器保存直接执行 ----
  const dRun = async () => {
    // 打开对象列表 → employees 行「设计」
    const tb = await tbPos('表');
    if (!tb) { fail('D1 前置', '表按钮不可用'); return; }
    await lclick(tb.x, tb.y);
    let designBtn = null;
    for (let i = 0; i < 16 && !designBtn; i += 1) {
      designBtn = await ev(`(() => { const row = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === 'employees'; }); if (!row) return null; const b = [...row.querySelectorAll('button')].find((y) => y.textContent.trim() === '设计'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!designBtn) await sleep(450);
    }
    if (!designBtn) { fail('D1 前置', 'employees 设计按钮未找到'); return; }
    await lclick(designBtn.x, designBtn.y);
    let fields = 0;
    for (let i = 0; i < 20 && !fields; i += 1) {
      fields = await ev(`document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row input[placeholder="字段名"]').length`);
      if (!fields) await sleep(500);
    }
    if (!fields) { fail('D1 前置', '设计器字段未加载'); return; }

    const rename = async (from, to) => {
      const inp = await ev(`(() => { const i = [...document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row input[placeholder="字段名"]')].find((x) => x.value === ${JSON.stringify(from)}); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!inp) return false;
      await lclick(inp.x, inp.y);
      await ctrlA();
      await insertText(to);
      await sleep(300);
      return true;
    };
    const clickSave = async () => {
      const b = await ev(`(() => { const pane = document.querySelector('.ant-tabs-tabpane-active'); const x = pane && [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((y) => y.textContent.trim() === '保存'); if (!x) return null; const r = x.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!b) return false;
      await lclick(b.x, b.y);
      return true;
    };
    const innerActive = () => ev(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() : null; })()`);

    // 改 name → name_x
    if (!(await rename('name', 'name_x'))) { fail('D1 改字段名', 'name 输入框未找到'); return; }

    // SQL 预览：只读（无「执行变更」按钮、有「刷新预览」），文本含重建 SQL
    const pvTab = await ev(`(() => { const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === 'SQL 预览'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!pvTab) { fail('D1 前置', 'SQL 预览页签未找到'); return; }
    await lclick(pvTab.x, pvTab.y);
    let pvText = null;
    for (let i = 0; i < 14 && !pvText; i += 1) {
      await sleep(450);
      pvText = await ev(`(() => { const p = document.querySelector('.sql-preview'); const t = p ? p.textContent : ''; return t && t !== '-- 没有检测到变更' ? t : null; })()`);
    }
    pvText && /name_x/.test(pvText) && /employees__rebuild|ALTER TABLE/i.test(pvText)
      ? pass('D1a SQL 预览只读生成（含 name_x 重建 SQL）')
      : fail('D1a SQL 预览', (pvText || 'null').slice(0, 200));
    const pvBtns = await ev(`(() => { const host = document.querySelector('.ant-tabs-tabpane-active .sql-tab'); if (!host) return null; return [...host.querySelectorAll('.obj-toolbar .ant-btn')].map((b) => b.textContent.trim()); })()`);
    pvBtns && !pvBtns.includes('执行变更') && pvBtns.includes('刷新预览')
      ? pass('D1b 预览页无「执行变更」按钮（只读 + 刷新预览）')
      : fail('D1b 预览页按钮', JSON.stringify(pvBtns));

    // 保存 → 直接执行：不跳预览、回到「字段」页、出已执行消息、新名回读
    if (!(await clickSave())) { fail('D1 保存', '保存按钮未找到'); return; }
    let back = false;
    let doneMsg = '';
    for (let i = 0; i < 22 && !back; i += 1) {
      await sleep(450);
      back = (await innerActive()) === '字段';
      if (!doneMsg) doneMsg = String(await msgs());
      if (back && !/已执行/.test(doneMsg)) doneMsg = String(await msgs());
    }
    back && /已执行/.test(doneMsg)
      ? pass('D1c 保存直接执行：回「字段」页 + 「已执行 N 条语句」消息（不跳预览）')
      : fail('D1c 保存直接执行', JSON.stringify({ back, doneMsg: doneMsg.slice(0, 120) }));
    let hasNew = false;
    for (let i = 0; i < 12 && !hasNew; i += 1) {
      hasNew = await ev(`[...document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row input[placeholder="字段名"]')].some((x) => x.value === 'name_x')`);
      if (!hasNew) await sleep(500);
    }
    hasNew ? pass('D1d 重载后字段名回读 name_x') : fail('D1d 字段回读', 'name_x 未出现');

    // 还原 name_x → name
    if (!(await rename('name_x', 'name'))) { fail('D1 还原', 'name_x 输入框未找到'); return; }
    if (!(await clickSave())) { fail('D1 还原保存', '保存按钮未找到'); return; }
    let back2 = false;
    for (let i = 0; i < 22 && !back2; i += 1) {
      await sleep(450);
      back2 = await ev(`[...document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row input[placeholder="字段名"]')].some((x) => x.value === 'name')`);
    }
    back2 ? pass('D1e 还原回 name 并执行') : fail('D1e 还原', 'name 未恢复');

    // 干净关闭设计页（保存后无脏 → 无确认框）
    const rm = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('设计 employees')); if (!t) return null; const i = t.querySelector('.ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (rm) {
      await lclick(rm.x, rm.y);
      await sleep(700);
      const noConfirm = !(await ev(`!!document.querySelector('.ant-modal-confirm')`));
      noConfirm ? pass('D1f 设计页保存后干净关闭（无确认）') : fail('D1f 关闭', '出现未保存确认（意外）');
    } else fail('D1f 关闭', '设计页签关闭按钮未找到');
  };
  await dRun();

  // ---- V1 新建视图：长表名卡片头 ----
  const vRun = async () => {
    // 对象列表切「视图」→ 页内「新建视图」
    const seg = await ev(`(() => { const it = [...document.querySelectorAll('[data-dh-kind] .ant-segmented-item')].find((x) => x.textContent.trim() === '视图'); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!seg) { fail('V1 前置', '视图分段未找到'); return; }
    await lclick(seg.x, seg.y);
    let newBtn = null;
    for (let i = 0; i < 12 && !newBtn; i += 1) {
      newBtn = await ev(`(() => { const b = document.querySelector('[data-dh-objs] [data-dh-new]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!newBtn) await sleep(450);
    }
    if (!newBtn) { fail('V1 前置', '新建视图按钮未找到'); return; }
    await lclick(newBtn.x, newBtn.y);
    let side = false;
    for (let i = 0; i < 16 && !side; i += 1) {
      side = await ev(`!!document.querySelector('.dh-vd-side-list')`);
      if (!side) await sleep(500);
    }
    if (!side) { fail('V1 前置', '视图设计器未打开'); return; }

    // 添加长表名表 + employees
    for (const t of [LONG, 'employees']) {
      const add = await ev(`(() => { const b = document.querySelector('[data-dh-vd-add=${JSON.stringify(t)}]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!add) { fail('V1 前置', '添加按钮未找到 ' + t); return; }
      await lclick(add.x, add.y);
    }
    let card = null;
    for (let i = 0; i < 16 && !card; i += 1) {
      card = await ev(`(() => { const c = document.querySelector('[data-dh-vd-card=${JSON.stringify(LONG)}]'); return c ? !!c.querySelector('.dh-vd-card-hd') : null; })()`);
      if (!card) await sleep(500);
    }
    if (!card) { fail('V1 前置', '长表名卡片未出现'); return; }

    const m = await ev(`(() => {
      const c = document.querySelector('[data-dh-vd-card=${JSON.stringify(LONG)}]');
      const hd = c.querySelector('.dh-vd-card-hd');
      const b = hd.querySelector('b');
      const cb = hd.querySelector('.ant-checkbox-wrapper');
      const cs = getComputedStyle(b);
      const br = c.getBoundingClientRect();
      return { ellipsis: cs.textOverflow, nowrap: cs.whiteSpace, sw: b.scrollWidth, cw: b.clientWidth, title: b.getAttribute('title'), txt: b.textContent,
        cbH: Math.round(cb.getBoundingClientRect().height), cbTxt: cb.textContent.trim(), cardW: Math.round(br.width),
        alias: (hd.querySelector('.alias') || {}).textContent };
    })()`);
    m && m.ellipsis === 'ellipsis' && m.nowrap === 'nowrap' && m.sw > m.cw && m.title === LONG
      ? pass('V1a 长表名省略号截断（scrollWidth ' + m.sw + ' > clientWidth ' + m.cw + '，title 提示全名）')
      : fail('V1a 表名截断', JSON.stringify(m));
    m && m.cbH <= 24 && m.cbTxt === '全选'
      ? pass('V1b 「全选」复选框单行不折行（高度 ' + m.cbH + 'px）')
      : fail('V1b 全选折行', JSON.stringify(m));
    m && m.cardW <= 342 ? pass('V1c 卡片宽度受控（' + m.cardW + 'px ≤ 340+2）') : fail('V1c 卡片宽', JSON.stringify(m && m.cardW));

    // 交互证明：点全选 → 勾上
    const cbPos = await ev(`(() => { const c = document.querySelector('[data-dh-vd-card=${JSON.stringify(LONG)}] .ant-checkbox-wrapper'); const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await lclick(cbPos.x, cbPos.y);
    await sleep(400);
    const chk = await ev(`(() => { const i = document.querySelector('input[data-dh-vd-all=${JSON.stringify(LONG)}]'); return i ? i.checked : null; })()`);
    chk === true ? pass('V1d 长表名卡片「全选」可正常点击勾选') : fail('V1d 全选点击', String(chk));

    // 关闭视图设计页（脏 → 确认 → 放弃并关闭）
    const rm = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('新建视图')); if (!t) return null; const i = t.querySelector('.ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (rm) {
      await lclick(rm.x, rm.y);
      await sleep(600);
      const okBtn = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; if (!w) return null; const b = [...w.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (okBtn) await lclick(okBtn.x, okBtn.y);
      await sleep(600);
      const gone = !(await ev(`[...document.querySelectorAll('.main-tabs .ant-tabs-tab')].some((x) => x.textContent.includes('新建视图'))`));
      gone ? pass('V1e 视图设计页脏关闭（放弃并关闭）') : fail('V1e 关闭视图页', '仍在');
    } else fail('V1e 关闭视图页', '关闭按钮未找到');
  };
  await vRun();

  // ---- S5 ----
  await sleep(600);
  if (!errors.length) pass('S5 无控制台错误'); else fail('S5 无控制台错误', errors.slice(0, 3).join(' | '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
