'use strict';
// 导出体系验证：v0920.5 —— DataTab 导出弹窗 / 查询结果导出 / ResultGrid 批量复制 / 树菜单导出数据 / F5 刷新
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
    if (r.exceptionDetails) return { err: String(r.exceptionDetails.exception && r.exceptionDetails.exception.description || 'exception').slice(0, 200) };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(320); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(380); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const keyF5 = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'F5', code: 'F5', windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 116 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'F5', code: 'F5', windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 116 });
  };

  const treePos = (title, where = 'name') => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const r = f.getBoundingClientRect();
    const t = f.querySelector('.node-title').getBoundingClientRect();
    const x = ${JSON.stringify(where)} === 'blank' ? Math.round(r.x + r.width - 15) : Math.round(t.x + t.width / 2);
    return { x, y: Math.round(r.y + r.height / 2) };
  })()`);

  // 按文本点通用按钮（当前 DOM 里任意可见 .ant-btn）
  const clickBtn = async (text) => {
    const p = await ev(`(() => {
      const b = [...document.querySelectorAll('.ant-btn')].find((x) => x.offsetParent && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const clickMenuItem = async (text) => {
    const p = await ev(`(() => {
      const b = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((x) => x.offsetParent && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(text)}));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const modalText = () => ev(`(() => {
    const m = document.querySelector('.ant-modal');
    return m && m.offsetParent ? m.textContent.replace(/\\s+/g, '') : null;
  })()`);
  const msgText = () => ev(`(() => {
    const n = [...document.querySelectorAll('.ant-message-notice')].filter((x) => x.offsetParent);
    return n.map((x) => x.textContent.replace(/\\s+/g, '')).join('|');
  })()`);
  const statusbar = () => ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- V1 版本标记 ----
  const sb = await statusbar();
  sb.includes('v0927.53') ? pass('V1 状态栏 v0927.53') : fail('V1 状态栏 v0927.53', sb);

  // ---- 打开 sqlite 连接 → 表分类 → employees ----
  let p = await treePos('演示 SQLite 库');
  if (!p) { fail('V2 找到连接行'); client.close(); return; }
  await dblclick(p.x, p.y);
  p = await treePos('表');
  if (p) await dblclick(p.x, p.y);
  await sleep(400);
  p = await treePos('employees');
  if (!p) { fail('V2 找到 employees 行'); client.close(); return; }
  await dblclick(p.x, p.y);
  await sleep(1200);

  // ---- V2 工具栏有 导出… ----
  const hasExp = await ev(`[...document.querySelectorAll('.tab-toolbar .ant-btn')].some((b) => b.offsetParent && b.textContent.replace(/\\s+/g, '') === '导出…')`);
  hasExp ? pass('V2 DataTab 工具栏「导出…」按钮') : fail('V2 DataTab 工具栏「导出…」按钮');

  // ---- V3 导出弹窗内容 ----
  await clickBtn('导出…');
  await sleep(500);
  const mt = await modalText();
  mt && mt.includes('导出「employees」数据') && mt.includes('CSV') && mt.includes('JSON') && mt.includes('SQLINSERT') && mt.includes('Markdown') && mt.includes('HTML')
    ? pass('V3 导出弹窗（标题+5格式）')
    : fail('V3 导出弹窗（标题+5格式）', mt && mt.slice(0, 120));
  const mt2 = await modalText();
  mt2 && mt2.includes('全部行（4行）') && mt2.includes('仅当前页（4行）')
    ? pass('V3b 范围：全部行/仅当前页')
    : fail('V3b 范围：全部行/仅当前页', mt2 && mt2.slice(0, 160));

  // ---- V4 SQL 格式 → 表名输入框 ----
  const fmtBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('.ant-modal .ant-radio-button-wrapper')].find((x) => x.textContent.trim() === 'SQL INSERT');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (fmtBtn) { await lclick(fmtBtn.x, fmtBtn.y); await sleep(300); }
  const hasTblInput = await ev(`!!document.querySelector('.ant-modal input[placeholder="TABLE1"]')`);
  hasTblInput && fmtBtn ? pass('V4 SQL 格式显示表名输入框') : fail('V4 SQL 格式显示表名输入框');

  // ---- V5 复制到剪贴板（CSV，走 fetchRows 全部行）----
  await clickBtn('复制到剪贴板');
  let okMsg = '';
  for (let i = 0; i < 12 && !okMsg; i++) { await sleep(250); okMsg = await msgText(); }
  okMsg.includes('已复制4行') ? pass('V5 复制到剪贴板 已复制 4 行') : fail('V5 复制到剪贴板 已复制 4 行', okMsg);
  let mopen = await modalText();
  mopen ? fail('V5b 复制后弹窗应关闭') : pass('V5b 复制后弹窗关闭');

  // ---- V6 树菜单：导出数据… ----
  p = await treePos('employees');
  await rclick(p.x, p.y);
  const treeMenu = await ev(`(() => {
    const d = document.querySelector('.ctx-menu');
    return d ? [...d.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
  })()`);
  treeMenu && treeMenu.some((t) => t.includes('导出数据')) ? pass('V6a 树菜单含「导出数据…」') : fail('V6a 树菜单含「导出数据…」', JSON.stringify(treeMenu));
  await clickMenuItem('导出数据');
  await sleep(500);
  const mt6 = await modalText();
  mt6 && mt6.includes('导出「employees」数据') ? pass('V6b 树菜单导出弹窗打开') : fail('V6b 树菜单导出弹窗打开', mt6 && mt6.slice(0, 120));
  await clickBtn('复制到剪贴板');
  let okMsg6 = '';
  for (let i = 0; i < 12 && !okMsg6; i++) { await sleep(250); okMsg6 = await msgText(); }
  okMsg6.includes('已复制4行') ? pass('V6c 全表抓取+复制 4 行') : fail('V6c 全表抓取+复制 4 行', okMsg6);

  // ---- V7 新建查询 + 运行 + 结果导出 ----
  p = await treePos('employees');
  await rclick(p.x, p.y);
  await clickMenuItem('新建查询');
  await sleep(600);
  // CodeMirror 输入 SQL
  const cm = await ev(`(() => {
    const e = document.querySelector('.query-editor-wrap .cm-content');
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 60), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!cm) { fail('V7 SQL 编辑器未找到'); }
  else {
    await lclick(cm.x, cm.y);
    await sleep(200);
    // 全选占位注释后输入，避免文字插进注释中间导致整句被注释
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(150);
    await Input.insertText({ text: 'SELECT * FROM employees' });
    await sleep(300);
    const ran = await clickBtn('运行');
    await sleep(1200);
    const expBtn = await ev(`[...document.querySelectorAll('.query-results .ant-btn')].some((b) => b.offsetParent && !b.disabled && b.textContent.includes('导出结果'))`);
    expBtn ? pass('V7a 查询运行后「导出结果…」可用') : fail('V7a 查询运行后「导出结果…」可用', 'ran=' + ran);
    await clickBtn('导出结果');
    await sleep(500);
    const mt7 = await modalText();
    mt7 && mt7.includes('导出结果1') ? pass('V7b 结果导出弹窗') : fail('V7b 结果导出弹窗', mt7 && mt7.slice(0, 120));
    // 点弹窗右上角 X 真实关闭（window 派发 Escape 到不了 document 的监听器）
    const x = await ev(`(() => {
      const b = document.querySelector('.ant-modal-close');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (x) await lclick(x.x, x.y);
    await sleep(400);
  }

  // ---- V8 ResultGrid 右键：复制全部 / 导出结果 ----
  const cellP = await ev(`(() => {
    const c = [...document.querySelectorAll('.query-results .ant-tabs-tabpane-active .ant-table-tbody .cell')].find((x) => x.offsetParent);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!cellP) { fail('V8 结果网格单元格未找到'); }
  else {
    await rclick(cellP.x, cellP.y);
    const gm = await ev(`(() => {
      const d = [...document.querySelectorAll('.ant-dropdown')].find((x) => x.offsetParent);
      return d ? [...d.querySelectorAll('.ant-dropdown-menu-item, .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
    })()`);
    gm && gm.some((t) => t.includes('复制全部行（CSV，4行）')) && gm.some((t) => t.includes('导出结果'))
      ? pass('V8 结果网格菜单：复制全部行/导出结果')
      : fail('V8 结果网格菜单：复制全部行/导出结果', JSON.stringify(gm));
    await lclick(650, 640); // 关菜单
    await sleep(300);
  }

  // ---- V9 F5：切回数据表页签（状态=查询完成），按 F5 → 状态变 employees ----
  const dataTab = await ev(`(() => {
    const t = [...document.querySelectorAll('.main-tabs > .ant-tabs-nav .ant-tabs-tab')].find((x) => x.textContent.trim() === 'employees');
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!dataTab) { fail('V9 employees 页签未找到'); }
  else {
    const before = await statusbar();
    await lclick(dataTab.x, dataTab.y);
    await sleep(300);
    const mid = await statusbar();
    await keyF5();
    await sleep(1200);
    const after = await statusbar();
    after.includes('employees：4行') && !mid.includes('employees：4行·第1')
      ? pass('V9 F5 刷新数据表（状态从[' + mid.slice(-24) + ']→employees）')
      : fail('V9 F5 刷新数据表', `mid=${mid.slice(-30)} after=${after.slice(-30)}`);
  }

  // ---- 控制台错误 ----
  errors.length === 0 ? pass('V10 无控制台错误') : fail('V10 无控制台错误', errors.slice(0, 3).join(' || '));

  console.log('---- done ----');
  client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
