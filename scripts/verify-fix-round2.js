// 验证 4 项修复：树图标同行 / 复选框列宽 / 网格线 / 点其他行自动保存
const CRI = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

async function main() {
  const b = await CRI({ port: 9222 });
  const { Runtime, Page } = b;
  await Runtime.enable();
  await Page.enable();
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  };
  const shot = async (name) => {
    await sleep(300);
    const r = await Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync('D:/DataHelm/.tmp-' + name + '.png', Buffer.from(r.data, 'base64'));
  };

  await sleep(2000);
  // 展开：连接 -> 表 -> employees
  const titles = () => ev(`[...document.querySelectorAll('.node-title')].map((n) => n.textContent.trim())`);
  let t = await titles();
  if (!t.some((x) => x === '表')) {
    await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
    await sleep(1500);
  }
  t = await titles();
  if (!t.some((x) => x === 'employees')) {
    await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => { const n = r.querySelector('.node-title'); return n && /^表/.test(n.textContent.trim()); }); if (!row) return 0; const s = row.querySelector('.ant-tree-switcher'); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 1; })()`);
    await sleep(1500);
  }
  await ev(`(() => { const n = [...document.querySelectorAll('.node-title')].find((x) => x.textContent.trim() === 'employees'); if (n) n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1; })()`);
  await sleep(2000);

  // ---- 1. 树图标与文字同行 ----
  const geo = await ev(`(() => {
    const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.trim() === 'employees');
    if (!row) return null;
    const icon = row.querySelector('.ant-tree-iconEle .anticon') || row.querySelector('.ant-tree-iconEle');
    const title = row.querySelector('.node-title');
    if (!icon || !title) return { missing: true, hasIcon: !!icon, hasTitle: !!title, rowHtml: row.innerHTML.slice(0, 150) };
    const ri = icon.getBoundingClientRect(), rt = title.getBoundingClientRect();
    return { iconTop: Math.round(ri.top), iconLeft: Math.round(ri.left), titleTop: Math.round(rt.top), titleLeft: Math.round(rt.left), rowH: Math.round(row.getBoundingClientRect().height) };
  })()`);
  const sameLine = geo && geo.iconTop !== undefined
    && geo.titleLeft > geo.iconLeft
    && geo.rowH < 34
    && Math.abs((geo.iconTop + 8) - (geo.titleTop + 13)) <= 4; // 比较垂直中心（16px 图标 vs 26px 行）
  step('T1 树图标与文字同行', !!sameLine, JSON.stringify(geo));

  // ---- 2. 复选框列宽 ----
  const widths = await ev(`(() => {
    const sel = document.querySelector('.grid-area .ant-table-selection-column');
    const firstRow = document.querySelector('.grid-area .ant-table-row');
    const cells = firstRow ? [...firstRow.querySelectorAll('.ant-table-cell')].map((c) => Math.round(c.getBoundingClientRect().width)) : [];
    return { selW: sel ? Math.round(sel.getBoundingClientRect().width) : null, cells };
  })()`);
  step('G1 复选框列宽≈36', widths.selW !== null && Math.abs(widths.selW - 36) <= 6, JSON.stringify(widths));

  // ---- 3. 网格线 ----
  const borders = await ev(`(() => {
    const cell = document.querySelector('.grid-area .ant-table-row .ant-table-cell:nth-child(2)');
    const head = document.querySelector('.grid-area .ant-table-thead .ant-table-cell');
    if (!cell || !head) return null;
    const cb = getComputedStyle(cell), hb = getComputedStyle(head);
    return { cellRight: cb.borderRightWidth + ' ' + cb.borderRightStyle, cellBottom: cb.borderBottomWidth + ' ' + cb.borderBottomStyle, headBottom: hb.borderBottomWidth + ' ' + hb.borderBottomStyle };
  })()`);
  step('G2 单元格网格线', !!borders && /1px/.test(borders.cellRight) && /solid/.test(borders.cellRight) && /solid/.test(borders.cellBottom), JSON.stringify(borders));
  await shot('grid-fixed');

  // ---- 4. 自动保存（改 employees 第一行 name，验证落库后改回）----
  const ROWS = `[...document.querySelectorAll('.grid-area .ant-table-row')]`;
  const cellOf = (rowI, cellI) => `(${ROWS}[${rowI}] ? ${ROWS}[${rowI}].querySelectorAll('.cell')[${cellI}] : null)`;
  const origName = await ev(`(() => { const c = ${cellOf(0, 1)}; return c ? c.textContent.trim() : null; })()`);
  if (!origName) { step('A0 找到第一行 name 单元格', false, ''); process.exit(1); }

  // 点击 row0.name → 编辑 → 输入 origZZ → 点击 row1.name（触发 blur 自动保存）
  await ev(`(() => { const c = ${cellOf(0, 1)}; c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
  await sleep(400);
  const typed = await ev(`(() => {
    const i = document.querySelector('.grid-area input.cell-edit-input');
    if (!i) return false;
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(origName + 'ZZ')});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(200);
  // 点击 row1 的 name 单元格（合成事件不会转移焦点，先显式 blur 触发提交，模拟真实点击顺序）
  await ev(`(() => { const i = document.querySelector('.grid-area input.cell-edit-input'); if (i) i.blur(); return 1; })()`);
  await sleep(100);
  await ev(`(() => { const c = ${cellOf(1, 1)}; c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
  await sleep(1500);
  const afterAuto = await ev(`(() => {
    const msg = [...document.querySelectorAll('.ant-message-notice')].map((m) => m.textContent.trim()).join('/');
    const r0 = ${ROWS}[0] ? ${ROWS}[0].textContent : '';
    const r1Edit = !!document.querySelector('.grid-area input.cell-edit-input');
    const dirtyLeft = document.querySelectorAll('.grid-area .cell.dirty').length;
    return { msg, r0: r0.slice(0, 30), r1Edit, dirtyLeft };
  })()`);
  step('A1 点其他行触发自动保存', typed && afterAuto.msg.includes('已自动保存'), JSON.stringify(afterAuto).slice(0, 140));

  // 刷新重载，确认已落库
  await ev(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const btn = [...document.querySelectorAll('.tab-toolbar button')].find((b) => normT(b.textContent) === '刷新'); if (btn) btn.click(); return 1; })()`);
  await sleep(1200);
  const persisted = await ev(`(() => { const c = ${cellOf(0, 1)}; return c ? c.textContent.trim() : null; })()`);
  step('A2 修改已写入数据库(刷新后仍在)', persisted === origName + 'ZZ', '刷新后=' + persisted);
  await shot('autosave');

  // 改回原值
  await ev(`(() => { const c = ${cellOf(0, 1)}; c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
  await sleep(400);
  await ev(`(() => { const i = document.querySelector('.grid-area input.cell-edit-input'); if (!i) return false; Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(origName)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  await ev(`(() => { const i = document.querySelector('.grid-area input.cell-edit-input'); if (i) i.blur(); return 1; })()`);
  await sleep(100);
  await ev(`(() => { const c = ${cellOf(1, 1)}; c.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); c.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 1; })()`);
  await sleep(1500);
  await ev(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const btn = [...document.querySelectorAll('.tab-toolbar button')].find((b) => normT(b.textContent) === '刷新'); if (btn) btn.click(); return 1; })()`);
  await sleep(1200);
  const restored = await ev(`(() => { const c = ${cellOf(0, 1)}; return c ? c.textContent.trim() : null; })()`);
  step('A3 已改回原值', restored === origName, '当前=' + restored);

  b.close();
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\n== ${fails.length} 项失败 ==` : '\n== 全部通过 ==');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(2); });
