'use strict';
// v0920.6 四项修复验证：
//  T1 树右键菜单不再被窗口截断（滚动到底部/右缘右键，菜单 rect 完全在视口内）
//  T2 单元格未改值不再标脏/触发自动保存；改回原值清脏
//  T3 SQL 编辑器高度撑满（原 26px）+ 横向滚动存在
//  T4 编辑器右键菜单（运行/全选/注释切换等）
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
    if (r.exceptionDetails) return { err: 'exception' };
    return r.result.value;
  };
  const press = async (x, y, btn, cnt) => {
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: btn, clickCount: cnt });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: btn, clickCount: cnt });
  };
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(320); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(400); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
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
  const ctxRectInViewport = () => ev(`(() => {
    const d = document.querySelector('.ctx-menu');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { ok: r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), h: Math.round(r.height), vh: window.innerHeight, vw: window.innerWidth };
  })()`);
  const menuItemsText = () => ev(`(() => {
    const d = document.querySelector('.ctx-menu');
    return d ? [...d.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null;
  })()`);
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // ---- 打开 sqlite → 表 → employees ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.53') ? pass('T0 状态栏 v0927.53') : fail('T0 状态栏 v0927.53', sb);
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  await sleep(300);
  p = await treePos('employees');
  await dblclick(p.x, p.y);
  await sleep(1300);

  // ---- T1 菜单不截断：滚动树到底，最后一行右键 ----
  await ev(`(() => { const w = document.querySelector('.tree-wrap'); if (w) w.scrollTop = w.scrollHeight; return 1; })()`);
  await sleep(400);
  p = await treePos('employees', 'blank'); // 行最右端
  if (!p) fail('T1 未找到 employees');
  else {
    await rclick(p.x, p.y);
    const rect = await ctxRectInViewport();
    rect && rect.ok && rect.h > 100
      ? pass(`T1 底部右缘右键菜单完整在视口内（h=${rect.h}, top=${rect.top}, bottom=${rect.bottom}/${rect.vh}）`)
      : fail('T1 菜单截断', JSON.stringify(rect));
    await press(650, 640, 'left', 1); await sleep(300);
  }

  // ---- T2 未改值不标脏 ----
  const cellPos = (r, c) => ev(`(() => {
    const cell = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[${r}]?.querySelectorAll('.cell')[${c}];
    if (!cell) return null;
    const b = cell.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  })()`);
  const dirtyText = () => ev(`(() => { const s = document.querySelector('.tab-toolbar .ctx'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const hasAutoSaveMsg = () => ev(`[...document.querySelectorAll('.ant-message-notice')].some((n) => n.textContent.includes('已自动保存'))`);
  const c11 = await cellPos(0, 0);
  const c12 = await cellPos(0, 1);
  const origVal = await ev(`(([...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x)=>x.offsetParent)[0] || {}).querySelectorAll('.cell')[0] || {}).textContent`);
  await lclick(c11.x, c11.y); // 进入编辑
  await lclick(c12.x, c12.y); // 不改直接点到下一格
  await sleep(1000);
  let d1 = await dirtyText();
  let msg1 = await hasAutoSaveMsg();
  !d1.includes('有未保存更改') && !msg1 ? pass('T2a 未改值：无未保存标记、无自动保存') : fail('T2a 未改值', d1 + ' msg=' + msg1);

  // 改值 → 自动保存生效
  const c13 = await cellPos(0, 2);
  const origV3 = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x)=>x.offsetParent)[0].querySelectorAll('.cell')[2].textContent`);
  await lclick(c13.x, c13.y);
  await ctrlA();
  await Input.insertText({ text: 'ZZTEST' });
  await lclick(c11.x, c11.y); // 切格触发提交+自动保存
  await sleep(1500);
  const msg2 = await hasAutoSaveMsg();
  msg2 ? pass('T2b 改值仍自动保存') : fail('T2b 改值仍自动保存');
  // 改回原值 → 恢复
  await sleep(500);
  const c13b = await cellPos(0, 2);
  await lclick(c13b.x, c13b.y);
  await ctrlA();
  await Input.insertText({ text: origV3 });
  await lclick(c11.x, c11.y);
  await sleep(1500);
  const valNow = await ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x)=>x.offsetParent)[0].querySelectorAll('.cell')[2].textContent`);
  valNow === origV3 ? pass('T2c 改回原值成功（' + origV3 + '）') : fail('T2c 改回原值', valNow + ' vs ' + origV3);

  // ---- 新建查询 ----
  p = await treePos('employees');
  await rclick(p.x, p.y);
  const q = await ev(`(() => {
    const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.includes('新建查询'));
    if (!it) return null;
    const r = it.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(q.x, q.y);
  await sleep(700);

  // ---- T3 编辑器高度 + 横向滚动 ----
  const ed = await ev(`(() => {
    const wrap = document.querySelector('.query-editor-wrap');
    const e = wrap.querySelector('.cm-editor');
    return { wrapH: Math.round(wrap.getBoundingClientRect().height), edH: Math.round(e.getBoundingClientRect().height), pad: getComputedStyle(wrap.querySelector('.cm-content')).paddingBottom };
  })()`);
  ed.edH > 100 && ed.edH >= ed.wrapH - 2 ? pass(`T3a 编辑器撑满（wrap=${ed.wrapH}, editor=${ed.edH}, pad=${ed.pad}）`) : fail('T3a 编辑器高度', JSON.stringify(ed));
  const cmP = await ev(`(() => {
    const e = document.querySelector('.query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 60), y: Math.round(r.y + Math.min(30, r.height / 2)) };
  })()`);
  await lclick(cmP.x, cmP.y);
  await ctrlA();
  await Input.insertText({ text: 'SELECT ' + 'long_col_x'.repeat(30) + ' FROM employees' });
  await sleep(500);
  const sc = await ev(`(() => {
    const s = document.querySelector('.query-editor-wrap .cm-scroller');
    return { clientW: s.clientWidth, scrollW: s.scrollWidth, clientH: s.clientHeight };
  })()`);
  sc.scrollW > sc.clientW && sc.clientH > 100 ? pass(`T3b 长行横向溢出存在且编辑器高（scrollW=${sc.scrollW} > clientW=${sc.clientW}, clientH=${sc.clientH}）`) : fail('T3b 横向滚动', JSON.stringify(sc));

  // ---- T4 编辑器右键菜单 ----
  await rclick(cmP.x + 100, cmP.y);
  const items4 = await menuItemsText();
  const need4 = ['运行（Ctrl+Enter）', '运行选中', '注释/取消注释', '全选', '复制选中', '剪切选中', '粘贴', '清空编辑器', '查询历史'];
  const ok4 = items4 && need4.every((k) => items4.some((t) => t.includes(k)));
  ok4 ? pass('T4a 编辑器右键菜单项齐全（' + items4.length + ' 项）') : fail('T4a 编辑器右键菜单项', JSON.stringify(items4));
  // 点 全选 → 注释 → 再点 注释 取消
  const clickMenu = async (kw) => {
    const it = await ev(`(() => {
      const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.includes(${JSON.stringify(kw)}));
      if (!it) return null;
      const r = it.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!it) return false;
    await lclick(it.x, it.y);
    return true;
  };
  await clickMenu('全选');
  // 选中层绘制在高负载下可滞后（菜单关→dispatch→CM 重绘排队）：轮询 2.4s，T4c/T4d 兜底功能证明
  let selCount = 0;
  for (let i = 0; i < 8 && !(selCount > 0); i += 1) {
    await sleep(300);
    selCount = await ev(`document.querySelectorAll('.query-editor-wrap .cm-selectionBackground').length`);
  }
  selCount > 0 ? pass('T4b 全选生效（selection 块 ' + selCount + '）') : fail('T4b 全选生效');
  await rclick(cmP.x + 100, cmP.y);
  await clickMenu('注释');
  await sleep(300);
  const line1 = await ev(`document.querySelector('.query-editor-wrap .cm-content').textContent.slice(0, 3)`);
  line1.startsWith('--') ? pass('T4c 注释生效（' + line1 + '…）') : fail('T4c 注释生效', line1);
  await rclick(cmP.x + 100, cmP.y);
  await clickMenu('注释');
  await sleep(300);
  const line1b = await ev(`document.querySelector('.query-editor-wrap .cm-content').textContent.slice(0, 3)`);
  !line1b.startsWith('--') ? pass('T4d 取消注释生效（' + line1b + '…）') : fail('T4d 取消注释', line1b);

  // 菜单在编辑器下部弹出也不截断（避开原生横向滚动条区域）
  const cmLow = await ev(`(() => {
    const e = document.querySelector('.query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + r.width - 40), y: Math.round(r.y + r.height - 60) };
  })()`);
  await rclick(cmLow.x, cmLow.y);
  const rect4 = await ctxRectInViewport();
  rect4 && rect4.ok ? pass('T4e 编辑器菜单也在视口内（bottom=' + rect4.bottom + '/' + rect4.vh + '）') : fail('T4e 编辑器菜单截断', JSON.stringify(rect4));
  await press(650, 640, 'left', 1);

  errors.length === 0 ? pass('T5 无控制台错误') : fail('T5 无控制台错误', errors.slice(0, 3).join(' || '));
  console.log('---- done ----');
  client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
