'use strict';
// v0920.8 三项验证：
//  S1 设计表「类型」列 Select 下拉（宽度/当前值/搜索选择/方言类型动态选项）
//  S2 输入框通用右键菜单（撤销/重做/剪切/复制/粘贴/全选，以设计表字段名输入框为准）
//  S3 查询编辑器 Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y 撤销重做（含 setValue 后历史保留 + 编辑器菜单含撤销重做）
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
  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const key = async (k, code, vk, mods) => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods });
    await sleep(220);
  };
  const ctrlZ = () => key('z', 'KeyZ', 90, 2);
  const ctrlShiftZ = () => key('Z', 'KeyZ', 90, 10);
  const ctrlY = () => key('y', 'KeyY', 89, 2);
  const treePos = (title) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const f = rows.find((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    if (!f) return null;
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const menuItemsText = () => ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);
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

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.53') ? pass('S0 状态栏 v0927.53') : fail('S0 状态栏 v0927.53', sb);

  // ---- 打开 sqlite → 表 → employees → 设计表 ----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { fail('前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(1300);

  // ---- S1 类型列下拉 ----
  const probe = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = pane ? [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')] : [];
    return rows.map((tr) => {
      const sel = tr.querySelector('.ant-select');
      const item = sel && sel.querySelector('.ant-select-selection-item');
      return { w: sel ? Math.round(sel.getBoundingClientRect().width) : 0, v: item ? item.textContent.trim() : null };
    });
  })()`);
  probe.length === 5 && probe.every((x) => x.w >= 100 && x.v)
    ? pass(`S1a 5 行类型下拉齐全（首行 ${probe[0].v}，宽 ${probe[0].w}px）`)
    : fail('S1a 类型下拉', JSON.stringify(probe));
  const selPos = await ev(`(() => {
    const sel = document.querySelector('.ant-tabs-tabpane-active .design-table .ant-table-tbody tr.ant-table-row .ant-select');
    const r = sel.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  const pickType = async (txt) => {
    await lclick(selPos.x, selPos.y); // 打开下拉并聚焦搜索框
    await sleep(350);
    await Input.insertText({ text: txt });
    await sleep(350);
    const o = await ev(`(() => {
      const o = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')]
        .find((x) => x.textContent.trim() === ${JSON.stringify(txt)});
      if (!o) return null;
      const r = o.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (!o) return false;
    await lclick(o.x, o.y);
    await sleep(350);
    return true;
  };
  const curType = () => ev(`(() => {
    const t = document.querySelector('.ant-tabs-tabpane-active .design-table .ant-table-tbody tr.ant-table-row .ant-select-selection-item');
    return t ? t.textContent.trim() : null;
  })()`);
  (await pickType('TEXT')) && (await curType()) === 'TEXT' ? pass('S1b 类型可从下拉选为 TEXT') : fail('S1b 改类型 TEXT');
  (await pickType('INTEGER')) && (await curType()) === 'INTEGER' ? pass('S1c 类型还原 INTEGER') : fail('S1c 还原 INTEGER');
  // 方言特有类型（不在预设列表，如 sqlite 的 REAL）应作为动态选项出现在首位
  const KNOWN = ['INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'VARCHAR', 'CHAR', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT', 'DATE', 'DATETIME', 'TIMESTAMP', 'TIME', 'DECIMAL', 'NUMERIC', 'FLOAT', 'DOUBLE', 'BOOLEAN', 'BLOB', 'JSON', 'UUID', 'SERIAL', 'BIGSERIAL'];
  const dynIdx = probe.findIndex((x) => x.v && !KNOWN.includes(x.v));
  if (dynIdx >= 0) {
    const dynV = probe[dynIdx].v;
    const dp = await ev(`(() => {
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
      const sel = rows[${dynIdx}].querySelector('.ant-select');
      const r = sel.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    await lclick(dp.x, dp.y);
    await sleep(500);
    const first = await ev(`(() => {
      const o = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option');
      return o ? o.textContent.trim() : null;
    })()`);
    first === dynV ? pass(`S1d 方言类型 ${dynV} 动态出现在选项首位`) : fail('S1d 动态选项', `${first} != ${dynV}`);
    await press(700, 700, 'left', 1);
    await sleep(300);
  } else {
    pass('S1d 当前表无方言特有类型，动态选项逻辑跳过');
  }

  // ---- S2 输入框通用右键菜单（设计表首行字段名）----
  const inpInfo = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const row = pane.querySelector('.design-table .ant-table-tbody tr.ant-table-row');
    const inp = [...row.querySelectorAll('input')].find((x) => x.placeholder === '字段名');
    const r = inp.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(inpInfo.x, inpInfo.y);
  await ctrlA();
  await Input.insertText({ text: 'NAME2' });
  await sleep(250);
  const valOf = () => ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const row = pane.querySelector('.design-table .ant-table-tbody tr.ant-table-row');
    const inp = [...row.querySelectorAll('input')].find((x) => x.placeholder === '字段名');
    return inp ? { v: inp.value, s0: inp.selectionStart, s1: inp.selectionEnd } : null;
  })()`);
  let v = await valOf();
  v.v === 'NAME2' ? pass('S2 前置 字段名改为 NAME2') : fail('S2 前置', JSON.stringify(v));
  await rclick(inpInfo.x, inpInfo.y);
  const mItems = await menuItemsText();
  ['撤销', '重做', '剪切', '复制', '粘贴', '全选'].every((k) => mItems.some((t) => t === k)) && !mItems.some((t) => t.includes('运行'))
    ? pass(`S2a 通用输入菜单 6 项齐全（${mItems.join('/')}）`)
    : fail('S2a 菜单项', JSON.stringify(mItems));
  await clickMenu('全选');
  await sleep(200);
  v = await valOf();
  v.s0 === 0 && v.s1 === 5 ? pass('S2b 全选生效（选中 0..5）') : fail('S2b 全选', JSON.stringify(v));
  await rclick(inpInfo.x, inpInfo.y);
  await clickMenu('剪切');
  await sleep(250);
  v = await valOf();
  v.v === '' ? pass('S2c 剪切生效（值清空，内容入剪贴板）') : fail('S2c 剪切', JSON.stringify(v));
  await rclick(inpInfo.x, inpInfo.y);
  await clickMenu('粘贴');
  await sleep(300);
  v = await valOf();
  v.v === 'NAME2' ? pass('S2d 粘贴生效（剪贴板内容回填）') : fail('S2d 粘贴', JSON.stringify(v));
  await rclick(inpInfo.x, inpInfo.y);
  await clickMenu('撤销');
  await sleep(250);
  v = await valOf();
  v.v === '' ? pass('S2e 菜单撤销粘贴') : fail('S2e 撤销', JSON.stringify(v));
  await rclick(inpInfo.x, inpInfo.y);
  await clickMenu('重做');
  await sleep(250);
  v = await valOf();
  v.v === 'NAME2' ? pass('S2f 菜单重做粘贴') : fail('S2f 重做', JSON.stringify(v));
  // 还原字段名
  await lclick(inpInfo.x, inpInfo.y);
  await ctrlA();
  await Input.insertText({ text: 'id' });
  await sleep(200);
  v = await valOf();
  v.v === 'id' ? null : fail('S2 还原字段名', JSON.stringify(v));

  // ---- S3 查询编辑器撤销/重做 ----
  p = await treePos('employees');
  await rclick(p.x, p.y);
  await clickMenu('新建查询');
  await sleep(900);
  const edPos = await ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
  })()`);
  const docText = () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
  await lclick(edPos.x, edPos.y);
  await ctrlA();
  await Input.insertText({ text: 'abc' });
  await sleep(300);
  let doc = await docText();
  doc === 'abc' ? pass('S3 前置 编辑器输入 abc') : fail('S3 前置', JSON.stringify(doc));
  await ctrlZ();
  doc = await docText();
  doc.indexOf('-- 在此输入') === 0 ? pass('S3a Ctrl+Z 撤销（回到占位文本）') : fail('S3a Ctrl+Z', JSON.stringify(doc));
  await ctrlShiftZ();
  doc = await docText();
  doc === 'abc' ? pass('S3b Ctrl+Shift+Z 重做') : fail('S3b Ctrl+Shift+Z', JSON.stringify(doc));
  await ctrlZ();
  await ctrlY();
  doc = await docText();
  doc === 'abc' ? pass('S3c Ctrl+Y 重做（等价快捷键）') : fail('S3c Ctrl+Y', JSON.stringify(doc));
  // 工具栏「清空」= 程序化 setValue：其后 Ctrl+Z 仍可撤销，证明历史未被重渲染清空（原根因回归）
  const clearBtn = await ev(`(() => {
    // 设计器内层页签也带 -active：限定查询外层面板（含编辑器）
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
    if (!pane) return null;
    const b = [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.includes('清空'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(clearBtn.x, clearBtn.y);
  await sleep(300);
  doc = await docText();
  // 文档为空时 CodeMirror 会把 placeholder 渲染进 .cm-line，两种都算已清空
  (doc === '' || doc === '-- SQL 编辑器：Ctrl+Enter 运行，输入表名/列名/片段（ssf、sel、up…）自动补全') ? null : fail('S3d 前置 清空', JSON.stringify(doc));
  await ctrlZ();
  doc = await docText();
  doc === 'abc' ? pass('S3d 清空(setValue)后 Ctrl+Z 可撤销 → 历史未被重渲染清空') : fail('S3d 清空后撤销', JSON.stringify(doc));
  await rclick(edPos.x, edPos.y);
  const em = await menuItemsText();
  em.some((t) => t.includes('撤销（Ctrl+Z）')) && em.some((t) => t.includes('重做（Ctrl+Shift+Z）')) && em.some((t) => t.includes('运行'))
    ? pass(`S3e 编辑器专属菜单含 撤销/重做（共 ${em.length} 项，未被通用菜单覆盖）`)
    : fail('S3e 编辑器菜单', JSON.stringify(em));
  await lclick(650, 640);

  errors.length === 0 ? pass('S4 无控制台错误') : fail('S4 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
