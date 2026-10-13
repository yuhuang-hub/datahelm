// 用真实鼠标事件（Input.dispatchMouseEvent）复现：编辑单元格 A → 点击另一行单元格 B → 是否自动保存
const CRI = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const b = await CRI({ port: 9222 });
  const { Runtime, Page, Input } = b;
  await Runtime.enable();
  await Page.enable();
  const ev = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 250));
    return r.result.value;
  };
  // 真实点击（带焦点转移）
  const realClick = async (expr) => {
    const q = await ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
    if (!q) return false;
    const { x, y } = JSON.parse(q);
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  };

  // 确保 employees 表已打开（若没有则打开）
  const hasGrid = await ev(`!!document.querySelector('.grid-area .ant-table-row')`);
  if (!hasGrid) {
    const titles = () => ev(`[...document.querySelectorAll('.node-title')].map((n) => n.textContent.trim())`);
    let t = await titles();
    if (!t.some((x) => x === '表')) {
      await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
      await sleep(1500);
    }
    t = await titles();
    if (!t.includes('employees')) {
      await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => { const n = r.querySelector('.node-title'); return n && /^表/.test(n.textContent.trim()); }); if (!row) return 0; const s = row.querySelector('.ant-tree-switcher'); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 1; })()`);
      await sleep(1500);
    }
    await ev(`(() => { const n = [...document.querySelectorAll('.node-title')].find((x) => x.textContent.trim() === 'employees'); if (n) n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1; })()`);
    await sleep(2000);
  }

  const ROWS = `[...document.querySelectorAll('.grid-area .ant-table-row')]`;
  const cellOf = (rowI, cellI) => `(${ROWS}[${rowI}] ? ${ROWS}[${rowI}].querySelectorAll('.cell')[${cellI}] : null)`;
  const origName = await ev(`(() => { const c = ${cellOf(0, 1)}; return c ? c.textContent.trim() : null; })()`);
  console.log('row0 name 原值:', origName);
  if (!origName) process.exit(1);

  // 1. 真实点击 row0.name
  console.log('click A:', await realClick(cellOf(0, 1)));
  await sleep(500);
  const editorA = await ev(`!!document.querySelector('.grid-area input.cell-edit-input')`);
  console.log('A 编辑器打开:', editorA);
  // 2. 真实输入文本
  await Input.insertText({ text: origName + 'ZZ' });
  await sleep(300);
  const draft = await ev(`document.querySelector('.grid-area input.cell-edit-input') ? document.querySelector('.grid-area input.cell-edit-input').value : null`);
  console.log('输入后 draft:', draft);
  // 3. 真实点击 row1.name
  console.log('click B:', await realClick(cellOf(1, 1)));
  await sleep(1800);
  const after = await ev(`(() => {
    const msg = [...document.querySelectorAll('.ant-message-notice')].map((m) => m.textContent.trim()).join('/');
    const r0 = ${ROWS}[0] ? ${ROWS}[0].textContent.slice(0, 26) : '';
    const r1Editing = !!document.querySelector('.grid-area input.cell-edit-input');
    const dirty = document.querySelectorAll('.grid-area .cell.dirty').length;
    return { msg, r0, r1Editing, dirty };
  })()`);
  console.log('点击 B 后:', JSON.stringify(after));
  // 4. 刷新验证落库
  await ev(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const btn = [...document.querySelectorAll('.tab-toolbar button')].find((x) => normT(x.textContent) === '刷新'); if (btn) btn.click(); return 1; })()`);
  await sleep(1200);
  const persisted = await ev(`(() => { const c = ${cellOf(0, 1)}; return c ? c.textContent.trim() : null; })()`);
  console.log('刷新后 row0 name:', persisted, persisted === origName + 'ZZ' ? '→ 已自动落库 ✓' : '→ 未落库 ✗');

  const shot = await Page.captureScreenshot({ format: 'png' });
  fs.writeFileSync('D:/DataHelm/.tmp-repro.png', Buffer.from(shot.data, 'base64'));
  b.close();
  process.exit(0);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
