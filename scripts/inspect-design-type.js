'use strict';
// 探查设计表「类型」列 AutoComplete：几何尺寸 / 值 / 可编辑性
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9227) });
  const { Input, Runtime } = client;
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception?.description || '').slice(0, 300) };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(320); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(420); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);

  // 展开 sqlite → 表 → employees
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { console.log('未找到 employees'); process.exit(1); }
  await rclick(p.x, p.y);
  const labels = await ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);
  console.log('菜单项:', JSON.stringify(labels));
  const designLabel = (labels || []).find((t) => t.includes('设计'));
  if (!designLabel) { console.log('无设计菜单项'); process.exit(1); }
  await ev(`(() => {
    const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes('设计'));
    it.click(); return true;
  })()`);
  await sleep(1500);

  // 设计表标签页应为激活态
  const active = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    return pane ? pane.className : null;
  })()`);
  console.log('激活 pane:', active);

  // 检查类型列：表头位置 + 每行 AutoComplete 几何/值
  const probe = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    if (!pane) return { err: 'no pane' };
    const ths = [...pane.querySelectorAll('.ant-table-thead th')].map((t) => t.textContent.trim());
    const rows = [...pane.querySelectorAll('.ant-table-tbody tr')].filter((r) => r.getBoundingClientRect().height > 0);
    const out = { headers: ths, rowCount: rows.length, cells: [] };
    for (const r of rows.slice(0, 3)) {
      const sel = r.querySelector('.ant-select');
      const inp = r.querySelector('.ant-select input');
      const nameInput = r.querySelector('input');
      if (!sel) { out.cells.push({ noSelect: true, html: r.innerHTML.slice(0, 120) }); continue; }
      const rect = sel.getBoundingClientRect();
      const cs = getComputedStyle(sel);
      const ics = inp ? getComputedStyle(inp) : null;
      out.cells.push({
        selRect: { w: Math.round(rect.width), h: Math.round(rect.height) },
        selDisplay: cs.display, selWidth: cs.width, selMinWidth: cs.minWidth, selFlex: cs.flex,
        inputSize: inp ? { size: inp.size, w: Math.round(inp.getBoundingClientRect().width), value: inp.value, disabled: inp.disabled, readOnly: inp.readOnly } : null,
        inputCss: ics ? { width: ics.width, flex: ics.flex } : null,
        firstInputValue: nameInput ? nameInput.value : null,
      });
    }
    return out;
  })()`);
  console.log(JSON.stringify(probe, null, 1));

  // 尝试点击类型输入并打字
  const typePos = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const sel = pane && pane.querySelector('.ant-table-tbody tr .ant-select');
    if (!sel) return null;
    const r = sel.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(30, r.width / 2)), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (typePos) {
    await lclick(typePos.x, typePos.y);
    await Input.insertText({ text: 'INTEGER' });
    await sleep(400);
    const after = await ev(`(() => {
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      const sel = pane.querySelector('.ant-table-tbody tr .ant-select');
      const inp = sel ? sel.querySelector('input') : null;
      const ae = document.activeElement;
      return { value: inp ? inp.value : null, focused: ae === inp, focusClass: ae ? ae.className.slice(0, 60) : '', dd: !!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)') };
    })()`);
    console.log('点击+打字后:', JSON.stringify(after));
  } else console.log('无法定位类型控件');

  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
