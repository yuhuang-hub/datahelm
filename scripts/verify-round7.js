'use strict';
// v0920.7 四项验证：
//  S1 设计表「类型」列 AutoComplete 正常宽度/可见/可编辑（原 16px 窄条）
//  S2 设计表行拖拽排序 → SQLite 重建表同步列顺序 → 数据保留
//  S3 查询编辑器横向滚动条常显（overflow-x:scroll + 轨道占位）+ 自定义美化
//  S4 编辑器右键 一键美化 SQL / 一键压缩 SQL（整档与运行验证）
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
  sb.includes('v0927.52') ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ---- 打开 sqlite → 表 → employees ----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { fail('前置', '未找到 employees'); await client.close(); return; }

  // ---- S1 类型列（v0920.8 起：Select 下拉）----
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(2400);
  const typeProbe = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const row = pane && pane.querySelector('.design-table .ant-table-tbody tr.ant-table-row');
    if (!row) return { err: 'no row' };
    const sel = row.querySelector('.ant-select');
    if (!sel) return { err: 'no select' };
    const item = sel.querySelector('.ant-select-selection-item');
    return { w: Math.round(sel.getBoundingClientRect().width), value: item ? item.textContent.trim() : null };
  })()`);
  typeProbe.w >= 100 && typeProbe.value === 'INTEGER'
    ? pass(`S1a 类型列下拉框正常（宽 ${typeProbe.w}px / 当前值 ${typeProbe.value}）`)
    : fail('S1a 类型列', JSON.stringify(typeProbe));
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
  await press(700, 700, 'left', 1);

  // ---- S2 拖拽排序 ----
  const handles = await ev(`document.querySelectorAll('.ant-tabs-tabpane-active .design-table .drag-handle').length`);
  const rowsN = await ev(`document.querySelectorAll('.ant-tabs-tabpane-active .design-table .ant-table-tbody tr.ant-table-row').length`);
  handles === rowsN && rowsN === 5 ? pass(`S2a 每行有拖拽手柄（${handles}/${rowsN}）`) : fail('S2a 拖拽手柄', `${handles}/${rowsN}`);

  // 合成拖拽：真实 mousedown 点亮 armed，再派发 dragstart/dragover/drop 到 React 行处理器
  const dragFirstBelowSecond = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    const tr0 = rows[0], tr1 = rows[1];
    const nameOf = (tr) => { const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名'); return i ? i.value : '?'; };
    return { from: nameOf(tr0), to: nameOf(tr1) };
  })()`);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: 40, y: 200, button: 'left', clickCount: 1 }); // 无害位置，armed 由手柄 mousedown 设置
  // 先真实 mousedown 在手柄上（触发 setArmed(true)），随后合成 drag 事件
  const hp = await ev(`(() => {
    const h = document.querySelector('.ant-tabs-tabpane-active .design-table .ant-table-tbody tr.ant-table-row .drag-handle');
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(250); // 等 armed=true 重渲染（行 draggable）
  const dropped = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    const tr0 = rows[0], tr1 = rows[1];
    const dt = new DataTransfer();
    tr0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r1 = tr1.getBoundingClientRect();
    const y = Math.round(r1.y + r1.height * 0.75); // 下一半 → 插到其后
    tr1.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    tr1.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    return true;
  })()`);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(350);
  const order = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    return rows.map((tr) => { const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名'); return i ? i.value : '?'; });
  })()`);
  order[0] === dragFirstBelowSecond.to && order[1] === dragFirstBelowSecond.from
    ? pass(`S2b 拖拽生效（${dragFirstBelowSecond.from} 拖到 ${dragFirstBelowSecond.to} 后：${order.join(', ')}）`)
    : fail('S2b 拖拽生效', `dropped=${dropped} 顺序=${order.join(',')} 预期 ${dragFirstBelowSecond.to},${dragFirstBelowSecond.from}`);

  // v0927.52：预览只读——先切 SQL 预览页签读重建 SQL（不保存）；「保存」直接执行
  const innerTab = await ev(`(() => { const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === 'SQL 预览'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!innerTab) {
    fail('S2c 前置', 'SQL 预览页签未找到');
  } else {
    await lclick(innerTab.x, innerTab.y);
    let preview = null;
    for (let i = 0; i < 12 && !preview; i += 1) {
      await sleep(450);
      preview = await ev(`(() => { const p = document.querySelector('.sql-preview'); const t = p ? p.textContent : ''; return t && t !== '-- 没有检测到变更' ? t : null; })()`);
    }
    preview && /employees__rebuild/.test(preview) && /CREATE TABLE/.test(preview) && /INSERT INTO/.test(preview)
      ? pass('S2c 预览生成重建表 SQL（__rebuild + CREATE + INSERT 保留数据，只读预览）')
      : fail('S2c 预览 SQL', (preview || 'null').slice(0, 160));
    const saveBtn = await ev(`(() => {
      const pane = document.querySelector('.ant-tabs-tabpane-active');
      const b = [...pane.querySelectorAll('.tab-toolbar .ant-btn')].find((x) => x.textContent.includes('保存'));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (saveBtn) {
      await lclick(saveBtn.x, saveBtn.y);
      let back = false;
      for (let i = 0; i < 20 && !back; i += 1) {
        await sleep(450);
        back = await ev(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
      }
      if (!back) fail('S2c 保存', '保存后未回到字段页（直接执行未完成）');
    } else {
      fail('S2c 前置', '保存按钮未找到');
    }
  }
  await sleep(1200);
  const orderAfter = await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    return rows.map((tr) => { const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名'); return i ? i.value : '?'; });
  })()`);
  orderAfter[0] === dragFirstBelowSecond.to
    ? pass(`S2d 执行后设计器已重载（首列=${orderAfter[0]}）`)
    : fail('S2d 执行后重载', orderAfter.join(','));

  // 树在 onChanged 后会刷新（节点短暂消失/替换），轮询等待 employees 回来
  const treePosRetry = async (title, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const q = await treePos(title);
      if (q) return q;
      await sleep(700);
    }
    return null;
  };
  // 刷新替换行元素会吞掉合成双击：等到两次测量位置一致（树已稳定）才返回
  const treePosStable = async (title, tries = 8) => {
    let last = null;
    for (let i = 0; i < tries; i += 1) {
      const q = await treePos(title);
      if (q && last && Math.abs(q.x - last.x) <= 1 && Math.abs(q.y - last.y) <= 1) return q;
      last = q;
      await sleep(650);
    }
    return null;
  };

  // 打开数据页验证：列顺序已同步 + 4 行数据仍在（经右键「打开表」——双击在树刷新后存在合成竞态，另行由回归覆盖）
  p = await treePosStable('employees');
  if (!p) { fail('S2 前置', '树刷新后未稳定找回 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  let openedTable = await clickMenu('打开表');
  if (!openedTable) {
    await rclick(p.x, p.y);
    openedTable = await clickMenu('打开表');
  }
  if (!openedTable) {
    const dump = await ev(`(() => {
      const m = document.querySelector('.ctx-menu');
      return m ? [...m.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : 'NO-MENU';
    })()`);
    fail('S2 前置', '菜单无 打开表：' + JSON.stringify(dump));
  }
  await sleep(1500);
  // 外层激活面板 = 直接子级是 .tab-body 且含 .dh-grid（区分查询页内部结果 Tabs 的同名激活面板）
  // DataTab 网格为 virtual 模式：行是 div.ant-table-row 且异步虚拟化，轮询等待
  let data = null;
  for (let i = 0; i < 6; i += 1) {
    data = await ev(`(() => {
      const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.dh-grid'));
      if (!pane) return { rows: 0 };
      const ths = [...pane.querySelectorAll('.dh-grid .ant-table-thead th')].map((t) => t.textContent.trim());
      const rows = pane.querySelectorAll('.dh-grid .ant-table-row').length;
      return { firstCol: ths[1] || ths[0], rows };
    })()`);
    if (data.rows > 0) break;
    await sleep(700);
  }
  data.rows === 4 ? pass(`S2e 数据保留（${data.rows} 行）`) : fail('S2e 数据保留', JSON.stringify(data));
  // DataTab 表头为「列名+类型」样式（如 nameTEXT），前缀匹配列名即可
  String(data.firstCol || '').startsWith(dragFirstBelowSecond.to)
    ? pass(`S2f 表列顺序已同步（首个数据列=${data.firstCol}）`)
    : fail('S2f 列顺序同步', JSON.stringify(data));

  // ---- S3 滚动条常显 + 美化 ----
  p = await treePosRetry('employees');
  await rclick(p.x, p.y);
  await clickMenu('新建查询');
  await sleep(900);
  const sc = await ev(`(() => {
    const s = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-scroller');
    if (!s) return { err: 'no scroller' };
    const cs = getComputedStyle(s);
    return { ox: cs.overflowX, oy: cs.overflowY, gutW: s.offsetWidth - s.clientWidth, gutH: s.offsetHeight - s.clientHeight };
  })()`);
  sc.ox === 'scroll'
    ? pass(`S3a 横向滚动条强制常显（overflow-x=${sc.ox}）`)
    : fail('S3a overflow-x', JSON.stringify(sc));
  sc.gutW >= 8 && sc.gutH >= 8
    ? pass(`S3b 滚动条轨道常占位（横 ${sc.gutW}px / 纵 ${sc.gutH}px，不悬浮不隐藏）`)
    : fail('S3b 轨道占位', JSON.stringify(sc));
  const edPos = await ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
  })()`);
  await lclick(edPos.x, edPos.y);
  await ctrlA();
  await Input.insertText({ text: 'SELECT ' + 'long_col_x'.repeat(30) + ' FROM employees' });
  await sleep(400);
  const sc2 = await ev(`(() => {
    const s = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-scroller');
    return { clientW: s.clientWidth, scrollW: s.scrollWidth };
  })()`);
  sc2.scrollW > sc2.clientW ? pass(`S3c 长行横向溢出可滚（scrollW=${sc2.scrollW} > clientW=${sc2.clientW}）`) : fail('S3c 横向溢出', JSON.stringify(sc2));

  // ---- S4 美化 / 压缩 ----
  await ctrlA();
  await Input.insertText({ text: 'select id,name from employees where id=1' });
  await sleep(300);
  const docText = () => ev(`[...document.querySelectorAll('.ant-tabs-tabpane-active .query-editor-wrap .cm-content .cm-line')].map((l) => l.textContent).join('\\n')`);
  await rclick(edPos.x, edPos.y);
  const items4 = await menuItemsText();
  items4 && items4.some((t) => t.includes('美化SQL')) && items4.some((t) => t.includes('压缩SQL'))
    ? pass(`S4a 右键含 美化/压缩 SQL（共 ${items4.length} 项）`)
    : fail('S4a 菜单项', JSON.stringify(items4));
  await clickMenu('美化SQL');
  await sleep(400);
  let doc = await docText();
  /^SELECT id,\nname\nFROM employees\nWHERE id = 1\n$/.test(doc)
    ? pass('S4b 美化生效（按子句断行 + 关键字大写）')
    : fail('S4b 美化生效', JSON.stringify(doc));
  await rclick(edPos.x, edPos.y);
  await clickMenu('压缩SQL');
  await sleep(400);
  doc = await docText();
  // 压缩保留原大小写（美化已大写关键字），仅去换行与多余空白
  doc === 'SELECT id,name FROM employees WHERE id=1'
    ? pass('S4c 压缩生效（单行还原，保留大小写）')
    : fail('S4c 压缩生效', JSON.stringify(doc));
  // 运行压缩后的 SQL，验证语义未破坏
  await rclick(edPos.x, edPos.y);
  await clickMenu('运行（Ctrl+Enter）');
  await sleep(1200);
  const runRes = await ev(`(() => {
    // 设计器内层页签也带 -active 类：必须限定「直接子级是 .tab-body 且含编辑器」的查询外层面板
    const pane = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector(':scope > .tab-body') && x.querySelector('.query-editor-wrap'));
    if (!pane) return { tabs: [], rows: 0 };
    const tabs = [...pane.querySelectorAll('.ant-tabs-tab')].map((t) => t.textContent.replace(/\\s+/g, ''));
    const rows = pane.querySelectorAll('.dh-grid .ant-table-row').length;
    return { tabs, rows };
  })()`);
  runRes.tabs.some((t) => t.includes('结果1(1)')) && runRes.rows === 1
    ? pass('S4d 美化/压缩后 SQL 可运行（结果 1 行）')
    : fail('S4d 运行验证', JSON.stringify(runRes));

  // ---- S6 设计器外键表滚动条：统一查询页样式（经典常显、轨道占位），横向滚动条不再悬浮遮挡末行输入框 ----
  const dtab = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.includes('设计 employees')); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!dtab) fail('S6 外键滚动条', '设计页签不在');
  else {
    await lclick(dtab.x, dtab.y);
    await sleep(600);
    const fkTab = await ev(`(() => { const t = [...document.querySelectorAll('.ant-tabs-tabpane-active .design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === '外键'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!fkTab) fail('S6 外键滚动条', '外键页签不在');
    else {
      await lclick(fkTab.x, fkTab.y);
      await sleep(500);
      const addBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .obj-toolbar .ant-btn')].find((x) => x.textContent.includes('添加外键')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (addBtn) { await lclick(addBtn.x, addBtn.y); await sleep(500); }
      const s6 = await ev(`(() => {
        const b = document.querySelector('.ant-tabs-tabpane-active .obj-table .ant-table-content') || document.querySelector('.ant-tabs-tabpane-active .obj-table .ant-table-body');
        if (!b) return { err: 'no body' };
        const cs = getComputedStyle(b);
        const br = b.getBoundingClientRect();
        const input = document.querySelector('.ant-tabs-tabpane-active .obj-table .ant-table-tbody input');
        const ir = input ? input.getBoundingClientRect() : null;
        return { ox: cs.overflowX, oy: cs.overflowY, gutW: b.offsetWidth - b.clientWidth, gutH: b.offsetHeight - b.clientHeight,
          inputOK: ir ? br.bottom - ir.bottom >= 6 : null };
      })()`);
      s6 && s6.ox === 'scroll' && s6.gutW >= 8 && s6.inputOK !== false
        ? pass(`S6 外键表横向滚动条常显占位（overflow=${s6.ox}，横轨 ${s6.gutW}px，输入框不被遮挡）`)
        : fail('S6 外键滚动条', JSON.stringify(s6));
    }
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
