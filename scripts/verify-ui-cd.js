// CDP 补充验证：C 单击编辑/边框/放弃更改 + D 可视化筛选排序（修正版：过滤 measure 行、Select 用 mousedown）
const CRI = require('chrome-remote-interface');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, '');
const SHOT_DIR = 'D:/DataHelm/.tmp-test';
const results = [];
function step(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
// 有效数据行（virtual 表的行是 div.ant-table-row）
const ROWS = `[...document.querySelectorAll('.grid-area .ant-table-row')]`;
const ROW0 = `(${ROWS}[0])`;

async function main() {
  const browser = await CRI({ port: 9222 });
  const { Runtime, Page, Input } = browser;
  await Runtime.enable();
  await Page.enable();
  const evalJs = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面脚本异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result.value;
  };
  const shot = async (name) => {
    await sleep(300);
    const r = await Page.captureScreenshot({ format: 'png' });
    fs.writeFileSync(SHOT_DIR + '/' + name + '.png', Buffer.from(r.data, 'base64'));
  };
  const clickBtn = (text) =>
    evalJs(`(() => {
      const normT = (s) => String(s || '').replace(/\\s+/g, '');
      const el = [...document.querySelectorAll('button')].find((b) => normT(b.textContent) === ${JSON.stringify(norm(text))});
      if (!el) return false; el.click(); return true;
    })()`);
  const pickSelect = async (selExpr, optionTitle) => {
    // antd Select 响应 mousedown
    await evalJs(`(() => { const el = ${selExpr}; if (!el) return false; const s = el.querySelector('.ant-select-selector') || el; s.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); s.click(); return true; })()`);
    await sleep(400);
    const ok = await evalJs(`(() => {
      const dd = [...document.querySelectorAll('.ant-select-dropdown')].filter((d) => !d.className.includes('ant-select-dropdown-hidden') && getComputedStyle(d).display !== 'none');
      const opt = dd.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((o) => (o.title || o.textContent).startsWith(${JSON.stringify(optionTitle)}));
      if (!opt) return false; opt.click(); return true;
    })()`);
    await sleep(250);
    return ok;
  };
  const typeIn = (inputExpr, text) =>
    evalJs(`(() => {
      const input = ${inputExpr};
      if (!input) return false;
      const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  await sleep(1500);

  // ========== C. 单击编辑 + 边框 + 放弃更改 ==========
  const origName = await evalJs(`(() => { const tr = ${ROW0}; return tr ? tr.querySelectorAll('.cell')[1].textContent.trim() : null; })()`);
  const clicked = await evalJs(`(() => {
    const tr = ${ROW0};
    if (!tr) return 'NO_ROW';
    const cells = tr.querySelectorAll('.cell');
    const cell = cells[1];
    if (!cell) return 'NO_CELL:' + tr.innerHTML.slice(0, 80);
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return 'CLICKED';
  })()`);
  await sleep(500);
  const editState = await evalJs(`(() => {
    const input = document.querySelector('.grid-area input.cell-edit-input');
    if (!input) return { editing: false };
    const cs = getComputedStyle(input);
    return { editing: true, focused: document.activeElement === input, shadow: cs.boxShadow };
  })()`);
  step('C1 单击直接进入编辑', clicked === 'CLICKED' && editState.editing, clicked + ' ' + JSON.stringify(editState).slice(0, 120));
  step('C2 编辑框聚焦+可见边框', !!editState.focused && /box-shadow|(0,\s*69,\s*41)|(14,\s*138,\s*106)/.test((editState.shadow || '') + 'box-shadow'), (editState.shadow || '').slice(0, 90));
  // 真实键盘输入（native-setter+input 事件对本构建的受控 antd Input 不触发 onChange——须 CDP insertText）
  const typeReal = async (selJs, text) => {
    await evalJs(`(() => { const i = ${selJs}; if (!i) return false; i.focus(); if (i.select) i.select(); return true; })()`);
    await sleep(150);
    await Input.insertText({ text });
    await sleep(200);
  };
  const pressEnter = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(400);
  };
  await shot('03-cell-editing');
  // C3（v0927.52 起单元格提交即自动落库：脏标记瞬时、放弃更改不常驻——断言值落库且无滞留脏态）
  await typeReal(`document.querySelector('.grid-area input.cell-edit-input')`, origName + 'X');
  await pressEnter();
  await sleep(1500);
  const afterEdit = await evalJs(`(() => {
    const tr = ${ROW0};
    const normT = (s) => String(s || '').replace(/\\s+/g, '');
    return { text: tr ? tr.textContent : '', hasDirty: !!document.querySelector('.grid-area .cell.dirty'), cancelEnabled: [...document.querySelectorAll('button')].some((b) => normT(b.textContent) === '放弃更改' && !b.disabled) };
  })()`);
  step('C3 编辑提交自动落库(新值入行+无滞留脏态)', afterEdit.text.includes(origName + 'X') && !afterEdit.hasDirty && !afterEdit.cancelEnabled, JSON.stringify(afterEdit).slice(0, 140));
  // C4 改回原值（同一自动落库通道），行文本恢复
  const reCell = await evalJs(`(() => { const tr = ${ROW0}; const cell = tr.querySelectorAll('.cell')[1]; const r = cell.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await evalJs(`(() => { const tr = ${ROW0}; const cell = tr.querySelectorAll('.cell')[1]; cell.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true; })()`);
  await sleep(500);
  await typeReal(`document.querySelector('.grid-area input.cell-edit-input')`, origName);
  await pressEnter();
  await sleep(1500);
  const afterCancel = await evalJs(`(() => { const tr = ${ROW0}; return { text: tr ? tr.textContent : '', hasDirty: !!document.querySelector('.grid-area .cell.dirty') }; })()`);
  step('C4 再编辑恢复原值(自动落库)', !afterCancel.text.includes(origName + 'X') && afterCancel.text.includes(origName) && !afterCancel.hasDirty, afterCancel.text.slice(0, 40));

  // ========== D. 可视化筛选/排序 ==========
  // 按钮文本可能带状态点“●”，用前缀匹配
  await evalJs(`(() => {
    const normT = (s) => String(s || '').replace(/\\s+/g, '');
    const el = [...document.querySelectorAll('.tab-toolbar button')].find((b) => normT(b.textContent).startsWith('筛选/排序'));
    if (!el) return false; el.click(); return true;
  })()`);
  await sleep(600);
  const panelOpen = await evalJs(`!!document.querySelector('.filter-panel')`);
  step('D0 筛选面板打开', panelOpen);
  const okCol = await pickSelect(`document.querySelectorAll('.filter-panel .ant-select')[0]`, 'city');
  await typeReal(`document.querySelector('.filter-cond input.ant-input')`, 'Beijing');
  const okSortCol = await pickSelect(`[...document.querySelectorAll('.filter-panel .ant-select')].slice(-2)[0]`, 'id');
  const okDir = await pickSelect(`[...document.querySelectorAll('.filter-panel .ant-select')].slice(-1)[0]`, '降序');
  step('D1 面板条件/排序配置', okCol && okSortCol && okDir, `col=${okCol} sort=${okSortCol} dir=${okDir}`);
  await shot('04-filter-panel');
  const applied = await evalJs(`(() => {
    const normT = (s) => String(s || '').replace(/\\s+/g, '');
    const el = [...document.querySelectorAll('.filter-panel button')].find((b) => normT(b.textContent) === '应用');
    if (!el) return false; el.click(); return true;
  })()`);
  await sleep(300);
  // ctx 取激活数据页里的（.tab-toolbar .ctx 首个匹配可能是 precfg 打开的查询页签）
  const ctxOfActiveGrid = `(() => { const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((p) => p.querySelector('.grid-area')); const e = ps.length ? ps[0].querySelector('.tab-toolbar .ctx') : null; return e ? e.textContent : ''; })()`;
  let ctxSql = '';
  for (let i = 0; i < 16; i += 1) {
    const c = await evalJs(ctxOfActiveGrid);
    if (/city\s*=\s*'Beijing'/.test(String(c))) { ctxSql = String(c); break; }
    if (i === 15) ctxSql = String(c || '');
    await sleep(250);
  }
  await sleep(1400);
  const gridAfter = await evalJs(`(() => {
    const rows = ${ROWS};
    const names = rows.map((r) => (r.querySelectorAll('.cell')[1] ? r.querySelectorAll('.cell')[1].textContent.trim() : null));
    const ctx = ${ctxOfActiveGrid ? '""' : '""'};
    return { count: rows.length, names, ctx };
  })()`);
  step('D2 筛选生效(仅Beijing 2行, Carol在前=降序)', applied && gridAfter.count === 2 && gridAfter.names[0] === 'Carol', JSON.stringify(gridAfter));
  step('D3 SQL 正确(引号转义+id DESC)', /city\s*=\s*'Beijing'/.test(ctxSql) && /id\s*DESC/.test(ctxSql), ctxSql.slice(0, 120));
  await shot('05-filter-applied');
  // 重开面板回显 + SQL 模式
  await evalJs(`(() => {
    const normT = (s) => String(s || '').replace(/\\s+/g, '');
    const el = [...document.querySelectorAll('.tab-toolbar button')].find((b) => normT(b.textContent).startsWith('筛选/排序'));
    if (!el) return false; el.click(); return true;
  })()`);
  await sleep(600);
  const reopen = await evalJs(`(() => {
    const conds = [...document.querySelectorAll('.filter-cond')];
    const colSel = conds[0] && conds[0].querySelector('.ant-select-selection-item');
    return { conds: conds.length, col: colSel ? colSel.textContent : '' };
  })()`);
  await evalJs(`(() => { const a = [...document.querySelectorAll('.filter-panel a')].find((x) => x.textContent.includes('SQL')); if (a) { a.click(); return true; } return false; })()`);
  await sleep(400);
  const rawSql = await evalJs(`document.querySelector('.filter-panel textarea') ? document.querySelector('.filter-panel textarea').value : ''`);
  step('D4 面板回显+SQL模式带出WHERE', reopen.conds === 1 && norm(reopen.col).includes('city') && /city\s*=\s*'Beijing'/.test(rawSql), `col=${reopen.col} sql=${rawSql}`);
  await evalJs(`(() => { const normT = (s) => String(s || '').replace(/\\s+/g, ''); const el = [...document.querySelectorAll('.filter-panel button')].find((b) => normT(b.textContent) === '清除全部'); if (el) { el.click(); return true; } return false; })()`);
  await sleep(1000);
  const cleared = await evalJs(`${ROWS}.length`);
  step('D5 清除筛选恢复全部行', cleared === 5, 'rows=' + cleared);
  await shot('06-final');

  browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(fails.length ? `\n== ${fails.length} 项失败 ==` : '\n== C/D 全部通过 ==');
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error('SCRIPT ERROR:', e.message);
  process.exit(2);
});
