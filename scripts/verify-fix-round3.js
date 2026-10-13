// 第三轮验证：树不截断+横向滚动+图标居中 / 自动保存（点其他行 + 回车两条路径，真实事件）
const CRI = require('chrome-remote-interface');
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const CONN_ID = '14617468-7a69-46db-a148-9e8e8118dcb9';
const LONG_TABLE = 'very_long_table_name_for_scrollbar_test_abcdefghijklmnopqrstuvwxyz_2026';

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
  const realClick = async (expr) => {
    const q = await ev(`(() => { const el = ${expr}; if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
    if (!q) return false;
    const { x, y } = JSON.parse(q);
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return true;
  };
  const shot = async (n) => {
    await sleep(300);
    const r = await Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync('D:/DataHelm/.tmp-' + n + '.png', Buffer.from(r.data, 'base64'));
  };

  await sleep(2000);
  // 展开树 + 打开 employees
  const titles = () => ev(`[...document.querySelectorAll('.node-title')].map((n) => n.textContent.trim())`);
  await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
  await sleep(1500);
  await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => { const n = r.querySelector('.node-title'); return n && /^表/.test(n.textContent.trim()); }); if (!row) return 0; const s = row.querySelector('.ant-tree-switcher'); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 1; })()`);
  await sleep(1200);
  await ev(`(() => { const n = [...document.querySelectorAll('.node-title')].find((x) => x.textContent.trim() === 'employees'); if (n) n.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return 1; })()`);
  await sleep(2000);

  // ---------- 1. 树：建长名表 → 刷新 → 不截断 + 横向滚动 + 对齐 ----------
  const created = await ev(`(async () => { try { const r = await window.api.db.call('${CONN_ID}', 'query', { sqlText: 'CREATE TABLE IF NOT EXISTS ${LONG_TABLE} (id INTEGER)' }); return JSON.stringify(r && r.ok); } catch (e) { return 'ERR:' + e.message; } })()`);
  console.log('建临时表:', created);
  await ev(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const btn = [...document.querySelectorAll('button[title="刷新全部"]')][0]; if (btn) btn.click(); return 1; })()`);
  await sleep(500);
  await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => r.textContent.includes('演示 SQLite 库')); const s = row && row.querySelector('.ant-tree-switcher'); if (s) { s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); } return 1; })()`);
  await sleep(1500);
  await ev(`(() => { const row = [...document.querySelectorAll('.ant-tree-treenode')].find((r) => { const n = r.querySelector('.node-title'); return n && /^表/.test(n.textContent.trim()); }); if (!row) return 0; const s = row.querySelector('.ant-tree-switcher'); s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return 1; })()`);
  await sleep(1200);

  const treeCheck = await ev(`(() => {
    const wrap = document.querySelector('.tree-wrap');
    const title = [...document.querySelectorAll('.node-title')].find((n) => n.textContent.includes('very_long_table_name'));
    if (!title) return { found: false };
    const row = title.closest('.ant-tree-treenode');
    const icon = row.querySelector('.ant-tree-iconEle');
    const rt = title.getBoundingClientRect(), ri = icon.getBoundingClientRect();
    return {
      found: true,
      text: title.textContent.trim().slice(0, 40),
      truncated: title.scrollWidth > title.clientWidth + 1,
      wrapScrollable: wrap.scrollWidth > wrap.clientWidth,
      wrapScrollW: wrap.scrollWidth, wrapClientW: wrap.clientWidth,
      rowW: Math.round(row.getBoundingClientRect().width),
      iconCenterY: Math.round(ri.top + ri.height / 2),
      titleCenterY: Math.round(rt.top + rt.height / 2),
      singleLine: rt.height <= 26,
    };
  })()`);
  step('R1 长表名完整显示不截断', treeCheck.found && !treeCheck.truncated && treeCheck.singleLine, JSON.stringify(treeCheck));
  step('R2 树出横向滚动条', treeCheck.wrapScrollable, `scrollW=${treeCheck.wrapScrollW} clientW=${treeCheck.wrapClientW}`);
  step('R3 图标与文字垂直居中', Math.abs(treeCheck.iconCenterY - treeCheck.titleCenterY) <= 2, `iconY=${treeCheck.iconCenterY} titleY=${treeCheck.titleCenterY}`);
  await shot('tree-scroll');

  // 删临时表 + 收起展开
  await ev(`(async () => { try { await window.api.db.call('${CONN_ID}', 'query', { sqlText: 'DROP TABLE IF EXISTS ${LONG_TABLE}' }); return 'dropped'; } catch (e) { return 'ERR:' + e.message; } })()`);
  console.log('临时表已删');

  // ---------- 2. 自动保存（真实事件，限定当前激活标签页） ----------
  // 切到 employees 标签（用户可能开着其他表）
  await ev(`(() => { const tab = [...document.querySelectorAll('.ant-tabs-tab')].find((t) => t.textContent.trim() === 'employees'); if (tab) { tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); tab.click(); } return 1; })()`);
  await sleep(800);
  const PANE = `.ant-tabs-tabpane-active`;
  const ROWS = `[...document.querySelectorAll('${PANE} .grid-area .ant-table-row')]`;
  const cellOf = (rowI, cellI) => `(${ROWS}[${rowI}] ? ${ROWS}[${rowI}].querySelectorAll('.cell')[${cellI}] : null)`;
  const cellText = async (rowI, cellI) => ev(`(() => { const c = ${cellOf(rowI, cellI)}; return c ? c.textContent.trim() : null; })()`);
  const msgText = () => ev(`[...document.querySelectorAll('.ant-message-notice')].map((m) => m.textContent.trim()).join('/')`);
  const refresh = async () => {
    await ev(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const btn = [...document.querySelectorAll('${PANE} .tab-toolbar button')].find((x) => normT(x.textContent) === '刷新'); if (btn) btn.click(); return 1; })()`);
    await sleep(1200);
  };
  const typeReplace = async (text) => {
    await Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await Input.dispatchKeyEvent({ type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(150);
    await Input.insertText({ text });
    await sleep(250);
  };
  const pressEnter = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  };

  const orig = await cellText(0, 1); // employees 第一行 name
  console.log('employees row0 name =', orig);
  if (!orig || orig.length > 20) { console.log('FAIL: 列选择异常'); process.exit(1); }

  // 编辑器打开检查（防止坐标点击落空导致后续全部无效）
  await realClick(cellOf(0, 1));
  await sleep(450);
  const editorOk = await ev(`!!document.querySelector('${PANE} .grid-area input.cell-edit-input')`);
  if (!editorOk) { step('S0 点击后编辑器打开', false, ''); process.exit(1); }
  await ev(`(() => { const i = document.querySelector('${PANE} .grid-area input.cell-edit-input'); if (i) i.blur(); return 1; })()`);
  await sleep(300);

  // 路径一：点其他行触发
  await realClick(cellOf(0, 1));
  await sleep(400);
  await typeReplace(orig + 'AA');
  await realClick(cellOf(1, 1));
  await sleep(1600);
  const m1 = await msgText();
  await refresh();
  const v1 = await cellText(0, 1);
  step('S1 点击其他行→自动落库', m1.includes('已自动保存') && v1 === orig + 'AA', `msg=${m1} 值=${v1}`);

  // 路径二：回车触发（不点别处）
  await realClick(cellOf(0, 1));
  await sleep(400);
  await typeReplace(orig + 'BB');
  await pressEnter();
  await sleep(1600);
  const m2 = await msgText();
  await refresh();
  const v2 = await cellText(0, 1);
  step('S2 回车→自动落库', m2.includes('已自动保存') && v2 === orig + 'BB', `msg=${m2} 值=${v2}`);

  // 路径三：回车暂存后再点其他单元格也落库（覆盖原缺口场景）
  await realClick(cellOf(0, 1));
  await sleep(400);
  await typeReplace(orig + 'CC');
  await pressEnter();
  await sleep(600); // 尚未点别处（此时其实已按 S2 规则落库；若未落库，点击后应补存）
  await realClick(cellOf(2, 1));
  await sleep(1600);
  const m3 = await msgText();
  await refresh();
  const v3 = await cellText(0, 1);
  step('S3 回车+点击其他行→均已落库', (m3.includes('已自动保存') || v3 === orig + 'CC') && v3 === orig + 'CC', `msg=${m3} 值=${v3}`);

  // 恢复原值
  await realClick(cellOf(0, 1));
  await sleep(400);
  await typeReplace(orig);
  await pressEnter();
  await sleep(1600);
  await refresh();
  const restored = await cellText(0, 1);
  step('S4 数据已还原', restored === orig, '当前=' + restored);

  b.close();
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\n== ${fails.length} 项失败 ==` : '\n== 全部通过 ==');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => { console.error('SCRIPT ERROR:', e.message); process.exit(2); });
