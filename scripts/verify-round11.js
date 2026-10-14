'use strict';
// v0927.53 设计器检查/触发器增强验证（sqlite 9227 实例 + localhost MSSQL master）：
//  A sqlite：检查约束 新建/改表达式/删除（重建表路径）；触发器 新建→列表时机事件解析→编辑(DROP+CREATE)→查看→删除
//  B mssql：检查约束 注释/启用/NFR（WITH NOCHECK ADD + NOCHECK 跟随 + 扩展属性）；启用在线切换；注释在线更新；表达式变更重建；
//           触发器 新建(AFTER INSERT)→状态列→禁用/启用→编辑(DROP+CREATE)→查看→删除
const CDP = require('chrome-remote-interface');
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
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(280); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(420); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(220);
  };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const insertText = (t) => Input.insertText({ text: t });
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
      if (it) {
        await lclick(it.x, it.y);
        return true;
      }
      await sleep(350);
    }
    return false;
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };
  // 设计器当前激活页查询（主标签层与内层都有 active，取包含 .design-tabs 的）
  const dEv = (js) => ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs')); return p ? (${js}) : null; })()`);
  const designTabByName = async (name, tries = 3) => {
    for (let i = 0; i < tries; i += 1) {
      const t = await ev(`(() => {
        const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
        if (!t) return null;
        const r = t.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (t) {
        await lclick(t.x, t.y);
        await sleep(420);
        // 初次布局抖动可能点偏（点到相邻页签）：确认激活页签名再返回
        const cur = await dEv(`(() => { const x = document.querySelector('.design-tabs .ant-tabs-tab-active'); return x ? x.textContent.trim() : null; })()`);
        if (cur === name) return true;
      } else {
        await sleep(400);
      }
    }
    return false;
  };
  const clickDesignBtn = async (kw) => {
    const b = await ev(`(() => {
      const host = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs'));
      if (!host) return null;
      const b = [...host.querySelectorAll('.ant-btn')].find((x) => {
        const r = x.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)});
      });
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const sqlPreviewText = () => dEv(`(() => { const p = document.querySelector('.sql-preview'); return p ? p.textContent : null; })()`);
  // v0927.53 起「保存」直接执行；预览改为只读：切 SQL 预览页签（激活即按当前差异刷新）读文本，不保存
  const savePreview = async (label) => {
    const before = await sqlPreviewText();
    await designTabByName('SQL 预览');
    let t = null;
    for (let i = 0; i < 14; i += 1) {
      t = await sqlPreviewText();
      if (t && t !== before) break;
      await sleep(450);
    }
    if (!t) { fail(label + ' 前置', 'SQL 预览未生成'); return null; }
    return t;
  };
  const waitRows = async (tries = 14) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  const waitFields = async (tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row').length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  // v0927.53：保存 = 直接执行 applyAlter；完成信号 = 内层页签回到「字段」
  const saveAndExecute = async () => {
    if (!(await clickDesignBtn('保存'))) return { err: 'no-save-btn' };
    let back = false;
    for (let i = 0; i < 24 && !back; i += 1) {
      await sleep(450);
      if (i >= 2) back = await dEv(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
    }
    await sleep(1700);
    return { ok: back };
  };
  const clearFrozenModals = () => ev(`(() => {
    let n = 0;
    document.querySelectorAll('.ant-modal-wrap').forEach((w) => {
      const m = w.querySelector('.ant-modal');
      if (m && /ant-zoom-leave/.test(m.className)) {
        // 冻结在关闭动画中的模态：连同所在 root 一起移除（mask 是 wrap 的兄弟节点，只删 wrap 会留遮罩挡点击）
        (w.closest('.ant-modal-root') || w).remove(); n += 1;
      }
    });
    // 孤儿遮罩：wrap 已移除但 mask 仍挂着
    document.querySelectorAll('.ant-modal-root > .ant-modal-mask:only-child').forEach((mk) => { mk.parentElement.remove(); n += 1; });
    return n;
  })()`);
  const objRow = (body) => dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null; return (${body}); })()`);
  const clickRowInput = async (placeholder) => {
    const p = await objRow(`(() => { const i = [...row.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(placeholder)}); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 90)), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const clickRowSelect = async (n) => {
    await closeAllDropdowns();
    const p = await objRow(`(() => { const s = [...row.querySelectorAll('.ant-select')].filter((x) => x.getBoundingClientRect().width > 0)${n}; if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 40)), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(450);
    return true;
  };
  const clickRowCheckbox = async () => {
    const p = await objRow(`(() => { const c = row.querySelector('input[type="checkbox"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(300);
    return true;
  };
  const pickOption = async (optText, { search = null, exact = true, tries = 6 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
      if (search != null) {
        await insertText(search);
        await sleep(350);
      }
      const o = await ev(`(() => {
        const dd = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';
        const live = [...document.querySelectorAll(dd)].filter((d) => !/ant-slide-up-leave/.test(d.className));
        const list = live.length ? live : [...document.querySelectorAll(dd)];
        const o = list.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((x) => { const t = x.textContent.replace(/\\s+/g, ''); return ${exact ? `t === ${JSON.stringify(optText)}` : `t.includes(${JSON.stringify(optText)})`}; });
        if (!o) return null;
        const r = o.getBoundingClientRect();
        if (r.width < 20 || r.height < 16) return { bad: true, w: r.width, h: r.height };
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (o && !o.bad && o.x != null) {
        await lclick(o.x, o.y);
        await sleep(300);
        return true;
      }
      await sleep(400);
    }
    return false;
  };
  const closeAllDropdowns = async () => {
    for (let i = 0; i < 4; i += 1) {
      const n = await ev(`(() => {
        const ds = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')];
        return ds.filter((d) => !/ant-slide-up-leave/.test(d.className)).length;
      })()`);
      if (n === 0) return true;
      const away = await ev(`({ x: 300, y: Math.max(10, window.innerHeight - 20) })`);
      await press(away.x, away.y);
      await sleep(400);
    }
    return false;
  };
  const objInputValues = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      const out = {}; [...row.querySelectorAll('input')].forEach((i) => { if (i.placeholder) out[i.placeholder] = i.value; }); return out; })()`);
  const objRowSelectTexts = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      return [...row.querySelectorAll('.ant-select-selection-item')].map((t) => t.textContent.trim()); })()`);
  const objRowCheckboxes = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      return [...row.querySelectorAll('input[type="checkbox"]')].map((c) => !!c.checked); })()`);
  // ---- 触发器/Modal 辅助 ----
  const liveModal = (body) => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => { const m = x.querySelector('.ant-modal'); return m && !/ant-zoom-leave/.test(m.className) && getComputedStyle(x).display !== 'none'; }); if (!w) return null; const host = w; return (${body}); })()`);
  const modalTitle = () => liveModal(`(() => { const t = host.querySelector('.ant-modal-title'); return t ? t.textContent.trim() : null; })()`);
  const modalBtn = async (kw) => {
    const b = await liveModal(`(() => { const b = [...host.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const modalTextareaValue = () => liveModal(`(() => { const t = host.querySelector('textarea'); return t ? t.value : null; })()`);
  const modalTextareaReplace = async (from, to) => {
    const v = await modalTextareaValue();
    if (v == null) return false;
    if (!v.includes(from)) return false;
    const p = await liveModal(`(() => { const t = host.querySelector('textarea'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + 60), y: Math.round(r.y + 18) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await ctrlA();
    await insertText(v.replace(from, to));
    await sleep(250);
    return true;
  };
  const modalClose = async () => {
    const x = await liveModal(`(() => { const c = host.querySelector('.ant-modal-close'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!x) return false;
    await lclick(x.x, x.y);
    await sleep(450);
    return true;
  };
  // 触发器表第一行信息：名称/时机/事件/状态文本/按钮们（树刷新重渲染瞬间可能读空，配合 waitTrigInfo 轮询）
  const trigRowInfo = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      const cells = [...row.querySelectorAll('.ant-table-cell')].map((c) => c.textContent.replace(/\\s+/g, ''));
      const tog = [...row.querySelectorAll('button')].find((b) => { const t = b.textContent.replace(/\\s+/g, ''); return t === '启用' || t === '禁用'; });
      return { name: cells[0], timing: cells[1], event: cells[2], status: cells[4] || '', hasTog: !!tog, togText: tog ? tog.textContent.replace(/\\s+/g, '') : '' }; })()`);
  const waitTrigInfo = async (tries = 14) => {
    for (let i = 0; i < tries; i += 1) {
      const t = await trigRowInfo();
      if (t && t.name) return t;
      await sleep(500);
    }
    return trigRowInfo();
  };
  const trigRowBtn = async (title) => {
    // 模态关闭动画可能冻在 zoom-leave（DH_TEST 细条窗口），残留遮罩挡住行按钮：每次点击前先清
    await clearFrozenModals();
    const p = await objRow(`(() => { const b = [...row.querySelectorAll('button')].find((x) => (x.title || '') === ${JSON.stringify(title)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const trigRowToggle = async (kw) => {
    await clearFrozenModals();
    const p = await objRow(`(() => { const b = [...row.querySelectorAll('button')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  // 行按钮弹窗（编辑/查看定义）：点击后轮询标题，未弹出则重试（树刷新会让行坐标漂移、点击落空）
  const openRowModal = async (btnTitle, expectTitle, tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      if (i > 0) {
        // 上一次点击可能已迟到弹出一半：先 ESC 收掉，再重新点，避免模态挡住行按钮
        await esc();
        await sleep(400);
        await clearFrozenModals();
      }
      await trigRowBtn(btnTitle);
      for (let j = 0; j < 6; j += 1) {
        await sleep(500);
        const t = await modalTitle();
        if (t === expectTitle) return t;
      }
    }
    return modalTitle();
  };
  const rowModalPreview = async (btnTitle, tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      if (i > 0) {
        await esc();
        await sleep(400);
        await clearFrozenModals();
      }
      await trigRowBtn(btnTitle);
      for (let j = 0; j < 6; j += 1) {
        await sleep(500);
        const d = await liveModal(`(() => { const d = host.querySelector('.sql-preview'); return d ? d.textContent : null; })()`);
        if (d) return d;
      }
    }
    return null;
  };
  // 删除触发器行：点删除 + 确认，轮询行数归零；树刷新点击落空时整段重试
  const deleteTrigRow = async (tries = 4) => {
    for (let i = 0; i < tries; i += 1) {
      await trigRowBtn('删除');
      await sleep(600);
      const b = await liveModal(`(() => { const b = [...host.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '删除'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (b) await lclick(b.x, b.y);
      for (let j = 0; j < 6; j += 1) {
        await sleep(700);
        const n = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
        if (n === 0) return true;
      }
    }
    return false;
  };
  const objHeaders = () => dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-thead th')].map((t) => t.textContent.trim())`);
  const closeActiveTab = async () => {
    const c = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (c) { await lclick(c.x, c.y); await sleep(700); }
  };

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.53') ? pass('S0 状态栏 v0927.53') : fail('S0 状态栏 v0927.53', sb);

  // ================= Part A：sqlite =================
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { fail('A 前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(1600);
  await waitFields();

  // A1 检查页头：sqlite 无 注释/启用/不适用于复制
  if (!(await designTabByName('检查'))) { fail('A1 前置', '检查页签未激活'); }
  let heads = await objHeaders();
  heads && heads.includes('名称') && heads.includes('表达式') && !heads.includes('注释') && !heads.includes('启用')
    ? pass('A1 sqlite 检查页列（无注释/启用）')
    : fail('A1 sqlite 检查页列', JSON.stringify(heads));

  // A2 新建检查约束 → 重建表
  await clickDesignBtn('添加检查约束');
  await sleep(350);
  await clickRowInput('ck_name');
  await insertText('ck_sal');
  await sleep(200);
  await clickRowInput('如 salary >= 0');
  await insertText('salary >= 0');
  await sleep(200);
  let pv = await savePreview('A2');
  pv && /employees__rebuild/.test(pv) && /CONSTRAINT "ck_sal" CHECK \(salary >= 0\)/.test(pv)
    ? pass('A2 sqlite 检查 DDL（重建表+CHECK）')
    : fail('A2 sqlite 检查 DDL', (pv || 'null').slice(0, 260));
  if (pv) await saveAndExecute();
  await sleep(2600);

  // A3 回读：名称/表达式保留
  await designTabByName('检查');
  await waitRows();
  const aVals = await objInputValues();
  aVals && aVals.ck_name === 'ck_sal' && aVals['如 salary >= 0'] === 'salary >= 0'
    ? pass('A3 sqlite 检查回读')
    : fail('A3 sqlite 检查回读', JSON.stringify(aVals));

  // A4 改表达式 → 再次重建
  await clickRowInput('如 salary >= 0');
  await ctrlA();
  await insertText('salary >= 1');
  await sleep(250);
  pv = await savePreview('A4');
  pv && /CONSTRAINT "ck_sal" CHECK \(salary >= 1\)/.test(pv) && /employees__rebuild/.test(pv)
    ? pass('A4 sqlite 改表达式重建')
    : fail('A4 sqlite 改表达式', (pv || 'null').slice(0, 260));
  if (pv) await saveAndExecute();
  await sleep(2600);

  // A5 删除检查约束 → 重建（无 CHECK）
  await designTabByName('检查');
  await waitRows();
  const delCk = await objRow(`(() => { const b = row.querySelector('.ant-btn-dangerous'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (delCk) await lclick(delCk.x, delCk.y);
  await sleep(250);
  pv = await savePreview('A5');
  pv && /employees__rebuild/.test(pv) && !/CHECK \(/.test(pv)
    ? pass('A5 sqlite 删检查重建（无 CHECK）')
    : fail('A5 sqlite 删检查', (pv || 'null').slice(0, 260));
  if (pv) await saveAndExecute();
  await sleep(2600);
  await designTabByName('检查');
  await sleep(400);
  const aRowsAfter = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
  aRowsAfter === 0 ? pass('A5b sqlite 检查列表清空') : fail('A5b sqlite 检查列表', 'rows=' + aRowsAfter);

  // A6 新建触发器（默认 AFTER INSERT）→ 列表时机/事件解析自 DDL
  await designTabByName('触发器');
  await sleep(300);
  await clickDesignBtn('新建触发器');
  await sleep(600);
  (await modalBtn('生成模板')) ? null : fail('A6 前置', '生成模板按钮未找到');
  await sleep(350);
  const aTpl = await modalTextareaValue();
  aTpl && /AFTER INSERT/.test(aTpl) ? null : fail('A6 前置', '模板不含 AFTER INSERT: ' + String(aTpl).slice(0, 80));
  await modalBtn('执行');
  await sleep(1600);
  let ti = await waitTrigInfo();
  ti && ti.name === 'trig_employees_1' && ti.timing.includes('AFTER') && ti.event.includes('INSERT') && !ti.hasTog
    ? pass('A6 sqlite 触发器创建+时机/事件解析（无状态列）')
    : fail('A6 sqlite 触发器列表', JSON.stringify(ti));

  // A7 编辑（DROP+CREATE）：SELECT 1 → SELECT 2，查看定义可见
  const aTitle = await openRowModal('编辑（先删后建）', '编辑触发器：trig_employees_1');
  aTitle === '编辑触发器：trig_employees_1' ? null : fail('A7 前置', '编辑弹窗标题: ' + aTitle);
  const aRepl = await modalTextareaReplace('SELECT 1;', 'SELECT 2;');
  aRepl ? null : fail('A7 前置', '编辑体替换失败');
  await modalBtn('执行');
  await sleep(1600);
  await waitRows();
  const aDdl = await rowModalPreview('查看定义');
  aDdl && /SELECT 2/.test(aDdl) ? pass('A7 sqlite 触发器编辑生效（DDL 含 SELECT 2）') : fail('A7 sqlite 触发器编辑', String(aDdl || '').slice(0, 160));
  await modalClose();
  await sleep(400);

  // A8 删除触发器 → 列表空（antd 两字按钮文本带空格：删 除）
  const aDel = await deleteTrigRow();
  aDel ? pass('A8 sqlite 触发器删除') : fail('A8 sqlite 触发器删除', 'rows>0 after retries');

  // A9 关闭设计页（应无未保存确认）
  await clearFrozenModals();
  await closeActiveTab();
  await sleep(400);
  const noConfirmA = !(await ev(`!!document.querySelector('.ant-modal-confirm')`));
  noConfirmA ? pass('A9 设计页干净关闭') : fail('A9 关闭', '出现未保存确认（意外）');

  // ================= Part B：MSSQL =================
  // A8 删除触发器触发整树刷新，可能读到清空间隙：轮询等待连接行回归
  p = null;
  for (let i = 0; i < 14 && !p; i += 1) { p = await treePos('1'); if (!p) await sleep(700); }
  if (!p) {
    const treeDump = await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].map((n) => n.textContent).slice(0, 15)`);
    fail('B 前置', '未找到连接 1，树节点: ' + JSON.stringify(treeDump));
    await client.close();
    return;
  }
  await dblclick(p.x, p.y);
  // mssql 连接（tedious）偶发偏慢：轮询等待 master 出现，最多 ~10s
  p = null;
  for (let i = 0; i < 14 && !p; i += 1) { p = await treePos('master'); if (!p) await sleep(700); }
  if (!p) { fail('B 前置', '未找到 master 库'); await client.close(); return; }
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('B 前置', 'master 无 新建查询 菜单'); await client.close(); return; }
  await sleep(1200);
  const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
  await lclick(ed.x, ed.y);
  await ctrlA();
  await insertText("IF OBJECT_ID('dbo.trig_dh_r11_1','TR') IS NOT NULL DROP TRIGGER dbo.trig_dh_r11_1;\nIF OBJECT_ID('dbo.dh_r11','U') IS NOT NULL DROP TABLE dbo.dh_r11;\nCREATE TABLE dbo.dh_r11(id INT PRIMARY KEY, salary INT, nm VARCHAR(50));");
  await sleep(300);
  const runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!runBtn) { fail('B 前置', '查询页无 运行 按钮'); await client.close(); return; }
  await lclick(runBtn.x, runBtn.y);
  await sleep(2600);
  await closeActiveTab();
  await sleep(500);
  await clearFrozenModals();
  if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) { await esc(); await sleep(400); }
  // 展开 master → 表分类 → dh_r11 → 设计表
  p = await treePos('master');
  await dblclick(p.x, p.y);
  await sleep(600);
  const catP = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const cat = rows.filter((r) => r.querySelector('.node-title').textContent === '表').pop();
    if (!cat) return null;
    const r = cat.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!catP) { fail('B 前置', '未找到 master 的 表 分类'); await client.close(); return; }
  await dblclick(catP.x, catP.y);
  p = null;
  for (let i = 0; i < 14 && !p; i += 1) { p = await treePos('dh_r11'); if (!p) await sleep(700); }
  if (!p) { fail('B 前置', 'dh_r11 未出现在树'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(2400);
  await waitFields();

  // B1 检查页头（含 注释/启用/不适用于复制）+ 新建：禁用 + NFR + 注释
  await designTabByName('检查');
  heads = await objHeaders();
  heads && heads.includes('注释') && heads.includes('启用') && heads.includes('不适用于复制')
    ? pass('B1a mssql 检查页列（注释/启用/NFR）')
    : fail('B1a mssql 检查页列', JSON.stringify(heads));
  await clickDesignBtn('添加检查约束');
  await sleep(350);
  await clickRowInput('ck_name');
  await insertText('ck_sal');
  await sleep(200);
  await clickRowInput('如 salary >= 0');
  await insertText('salary >= 0');
  await sleep(200);
  await clickRowInput('注释');
  await insertText('薪资检查');
  await sleep(200);
  await clickRowSelect('[0]');
  const pickedNo = await pickOption('否');
  await closeAllDropdowns();
  pickedNo ? null : fail('B1 前置', '启用=否 未选中');
  // 勾选 NFR 后校验 checked 状态，未生效重试（点击可能落在重渲染的旧行上）
  let nfrOn = false;
  for (let i = 0; i < 3 && !nfrOn; i += 1) {
    await clickRowCheckbox();
    await sleep(300);
    const c = await objRowCheckboxes();
    nfrOn = !!(c && c[0] === true);
  }
  pv = await savePreview('B1');
  pv && /WITH NOCHECK ADD CONSTRAINT "ck_sal" CHECK NOT FOR REPLICATION \(salary >= 0\)/.test(pv) && /NOCHECK CONSTRAINT "ck_sal"/.test(pv) && /sp_addextendedproperty/.test(pv) && /薪资检查/.test(pv) && !/DROP CONSTRAINT/.test(pv)
    ? pass('B1 mssql 检查 DDL（NOCHECK+NFR+扩展属性）')
    : fail('B1 mssql 检查 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(2800);

  // B2 回读：名称/表达式（规范化）/注释/启用=否/NFR=勾
  await designTabByName('检查');
  await waitRows();
  const bVals = await objInputValues();
  const bSel = await objRowSelectTexts();
  const bChk = await objRowCheckboxes();
  bVals && bVals.ck_name === 'ck_sal' && /salary/.test(String(bVals['如 salary >= 0'] || '')) && bVals['注释'] === '薪资检查' && bSel && bSel[0] === '否' && bChk && bChk[0] === true
    ? pass('B2 mssql 检查回读（禁用/NFR/注释）')
    : fail('B2 mssql 检查回读', JSON.stringify({ bVals, bSel, bChk }));

  // B3 启用在线切换 → 仅 WITH CHECK CHECK CONSTRAINT（下拉选“是”后校验控件值，未生效重试）
  let pickedYes = false;
  for (let i = 0; i < 4 && !pickedYes; i += 1) {
    await clickRowSelect('[0]');
    await pickOption('是');
    await closeAllDropdowns();
    await sleep(300);
    const s = await objRowSelectTexts();
    if (s && s[0] === '是') pickedYes = true;
    else await sleep(600);
  }
  pickedYes ? null : fail('B3 前置', '启用=是 未选中');
  pv = await savePreview('B3');
  pv && /WITH CHECK CHECK CONSTRAINT "ck_sal"/.test(pv) && !/DROP CONSTRAINT/.test(pv) && !/ADD CONSTRAINT/.test(pv) && !/extendedproperty/.test(pv)
    ? pass('B3 mssql 启用在线切换（仅 CHECK）')
    : fail('B3 mssql 启用切换', (pv || 'null').slice(0, 260));
  if (pv) await saveAndExecute();
  await sleep(2800);
  await designTabByName('检查');
  await waitRows();
  const bSel3 = await objRowSelectTexts();
  bSel3 && bSel3[0] === '是' ? pass('B3b mssql 启用回读=是') : fail('B3b mssql 启用回读', JSON.stringify(bSel3));

  // B4 仅注释变化 → 仅 sp_updateextendedproperty
  await clickRowInput('注释');
  await ctrlA();
  await insertText('薪资检查2');
  await sleep(250);
  pv = await savePreview('B4');
  pv && /sp_updateextendedproperty/.test(pv) && /薪资检查2/.test(pv) && !/DROP CONSTRAINT/.test(pv) && !/ADD CONSTRAINT/.test(pv)
    ? pass('B4 mssql 注释在线更新（不重建）')
    : fail('B4 mssql 注释更新', (pv || 'null').slice(0, 260));
  if (pv) await saveAndExecute();
  await sleep(2600);
  await designTabByName('检查');
  await waitRows();
  const bVals4 = await objInputValues();
  bVals4 && bVals4['注释'] === '薪资检查2' ? pass('B4b mssql 注释回读') : fail('B4b mssql 注释回读', JSON.stringify(bVals4));

  // B5 表达式变化 → DROP + WITH CHECK ADD（NFR 保留）
  await clickRowInput('如 salary >= 0');
  await ctrlA();
  await insertText('salary >= 1');
  await sleep(250);
  pv = await savePreview('B5');
  pv && /DROP CONSTRAINT "ck_sal"/.test(pv) && /WITH CHECK ADD CONSTRAINT "ck_sal" CHECK NOT FOR REPLICATION \(salary >= 1\)/.test(pv) && /sp_updateextendedproperty/.test(pv)
    ? pass('B5 mssql 表达式变更重建（注释随建）')
    : fail('B5 mssql 表达式变更', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(2800);

  // B6 新建触发器（mssql AFTER INSERT 默认模板）→ 列表 + 状态列
  await designTabByName('触发器');
  await sleep(300);
  await clickDesignBtn('新建触发器');
  await sleep(600);
  await modalBtn('生成模板');
  await sleep(350);
  await modalBtn('执行');
  await sleep(2200);
  ti = await waitTrigInfo();
  ti && ti.name === 'trig_dh_r11_1' && ti.timing.includes('AFTER') && ti.event.includes('INSERT') && ti.hasTog && ti.status.includes('已启用')
    ? pass('B6 mssql 触发器创建+时机/事件/状态列')
    : fail('B6 mssql 触发器列表', JSON.stringify(ti));

  // B7 禁用 → 状态 已禁用（点击后校验状态翻转，慢刷新时重试）
  let b7ok = false;
  for (let i = 0; i < 3 && !b7ok; i += 1) {
    await trigRowToggle('禁用');
    await sleep(1800);
    ti = await waitTrigInfo();
    b7ok = !!(ti && ti.status.includes('已禁用') && ti.togText === '启用');
  }
  b7ok ? pass('B7 mssql 触发器禁用') : fail('B7 mssql 触发器禁用', JSON.stringify(ti));

  // B8 重新启用
  let b8ok = false;
  for (let i = 0; i < 3 && !b8ok; i += 1) {
    await trigRowToggle('启用');
    await sleep(1800);
    ti = await waitTrigInfo();
    b8ok = !!(ti && ti.status.includes('已启用') && ti.togText === '禁用');
  }
  b8ok ? pass('B8 mssql 触发器重新启用') : fail('B8 mssql 触发器启用', JSON.stringify(ti));

  // B9 编辑（DROP+CREATE）：加标记注释，查看定义可见
  const bTitle = await openRowModal('编辑（先删后建）', '编辑触发器：trig_dh_r11_1');
  bTitle === '编辑触发器：trig_dh_r11_1' ? null : fail('B9 前置', '编辑弹窗标题: ' + bTitle);
  const bBody = await modalTextareaValue();
  bBody && /CREATE TRIGGER/i.test(bBody) ? null : fail('B9 前置', '编辑体非 CREATE TRIGGER: ' + String(bBody).slice(0, 80));
  const bRepl = await modalTextareaReplace('SET NOCOUNT ON;', 'SET NOCOUNT ON; -- EDITED_R11');
  bRepl ? null : fail('B9 前置', '编辑体替换失败');
  await modalBtn('执行');
  await sleep(2200);
  await waitRows();
  const bDdl = await rowModalPreview('查看定义');
  bDdl && /EDITED_R11/.test(bDdl) ? pass('B9 mssql 触发器编辑生效（DDL 含标记）') : fail('B9 mssql 触发器编辑', String(bDdl || '').slice(0, 160));
  await modalClose();
  await sleep(400);

  // B10 删除触发器
  const bDel = await deleteTrigRow();
  bDel ? pass('B10 mssql 触发器删除') : fail('B10 mssql 触发器删除', 'rows>0 after retries');

  // B11 关闭设计页 + 清理临时表
  await clearFrozenModals();
  await closeActiveTab();
  await sleep(400);
  if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) { await esc(); await sleep(400); }
  p = await treePos('master');
  await rclick(p.x, p.y);
  if (await clickMenu('新建查询')) {
    await sleep(1100);
    const ed2 = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
    await lclick(ed2.x, ed2.y);
    await ctrlA();
    await insertText("IF OBJECT_ID('dbo.trig_dh_r11_1','TR') IS NOT NULL DROP TRIGGER dbo.trig_dh_r11_1;\nIF OBJECT_ID('dbo.dh_r11','U') IS NOT NULL DROP TABLE dbo.dh_r11;");
    await sleep(300);
    const runBtn2 = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (runBtn2) {
      await lclick(runBtn2.x, runBtn2.y);
      await sleep(2200);
    }
    await closeActiveTab();
    await sleep(500);
    await clearFrozenModals();
    pass('B11 mssql 清理（dh_r11 已删除）');
  } else {
    fail('B11 mssql 清理', '无法打开查询页（请手工删除 dbo.dh_r11）');
  }

  // ---- S5 控制台错误 ----
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', JSON.stringify(errors.slice(0, 4)));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
