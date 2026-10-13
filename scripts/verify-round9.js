'use strict';
// v0920.9 三项验证（sqlite 实例）：
//  S1 通用输入菜单：点空白关闭 + ESC 关闭
//  S2 设计器十页签齐全；索引新增→执行→重建表时索引保留→索引删除（全链路含 SQL 预览页签）
//  S3 触发器：模板创建→列表→查看 DDL→删除
//  S4 未保存绿点 + 关闭确认（设计页与查询页；干净页签直接关）
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
  // 设计器当前激活页（外层）里的元素查询
  const dEv = (js) => ev(`(() => { const p = document.querySelector('.ant-tabs-tabpane-active'); return p ? (${js}) : null; })()`);
  const designTabByName = async (name) => {
    const t = await ev(`(() => {
      const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (t) {
      await lclick(t.x, t.y);
      await sleep(400);
    }
    return !!t;
  };
  const clickDesignBtn = async (kw) => {
    // 宿主取外层激活页签（含 tab-toolbar 与内层各页签），只点可见按钮
    const b = await ev(`(() => {
      const host = document.querySelector('.ant-tabs-tabpane-active');
      if (!host || !host.querySelector('.design-tabs')) return null;
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
  // v0927.52：保存 = 直接执行 applyAlter（不再跳 SQL 预览）；完成信号 = 内层页签回到「字段」
  const saveAndExecute = async (label) => {
    if (!(await clickDesignBtn('保存'))) {
      fail(label, '找不到 保存 按钮');
      return false;
    }
    let back = false;
    for (let i = 0; i < 24 && !back; i += 1) {
      await sleep(450);
      if (i >= 2) back = await dEv(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
    }
    await sleep(1500);
    if (!back) fail(label, '保存后未回到字段页（执行未完成）');
    return back;
  };
  // 只读预览：切 SQL 预览页签按当前差异刷新（before 对比防上一次的陈旧文本）
  const previewSql = async () => {
    const before = await sqlPreviewText();
    await designTabByName('SQL 预览');
    let t = null;
    for (let i = 0; i < 14; i += 1) {
      t = await sqlPreviewText();
      if (t && t !== before) break;
      await sleep(450);
    }
    return t || null;
  };
  const idxNames = () => dEv(`(() => {
    return [...document.querySelectorAll('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row input')].map((i) => i.value);
  })()`);
  const treePosRetry = async (title, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const q = await treePos(title);
      if (q) return q;
      await sleep(700);
    }
    return null;
  };

  // 兜底：清理卡死在关闭动画（ant-zoom-leave）的模态框 wrap——它会全屏遮挡后续点击
  const clearFrozenModals = () => ev(`(() => {
    let n = 0;
    document.querySelectorAll('.ant-modal-wrap').forEach((w) => {
      const m = w.querySelector('.ant-modal');
      if (m && /ant-zoom-leave/.test(m.className)) { w.remove(); n += 1; }
    });
    return n;
  })()`);

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.52') ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ---- 打开 sqlite → employees → 设计表 ----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { fail('前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(1500);

  // ---- S1 通用输入菜单关闭 ----
  const inpInfo = await dEv(`(() => {
    const row = document.querySelector('.design-table .ant-table-tbody tr.ant-table-row');
    const inp = row && [...row.querySelectorAll('input')].find((x) => x.placeholder === '字段名');
    if (!inp) return null;
    const r = inp.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await rclick(inpInfo.x, inpInfo.y);
  let items = await menuItemsText();
  const menuOpen1 = items && items.includes('粘贴');
  await lclick(400, 300); // 空白处左键
  await sleep(250);
  let menuGone = !(await ev(`document.querySelector('.ctx-menu')`));
  menuOpen1 && menuGone ? pass('S1a 点空白处关闭菜单') : fail('S1a 空白关闭', JSON.stringify({ menuOpen1, menuGone }));
  await rclick(inpInfo.x, inpInfo.y);
  await esc();
  menuGone = !(await ev(`document.querySelector('.ctx-menu')`));
  menuGone ? pass('S1b ESC 关闭菜单') : fail('S1b ESC 关闭');
  await lclick(400, 300);
  await sleep(200);

  // ---- S2 十页签 + 索引链路 ----
  const tabs = await ev(`[...document.querySelectorAll('.design-tabs .ant-tabs-tab')].map((t) => t.textContent.trim())`);
  const WANT = ['字段', '索引', '外键', '唯一键', '检查', '触发器', '选项', '存储', '注释', 'SQL 预览'];
  JSON.stringify(tabs) === JSON.stringify(WANT)
    ? pass('S2a 设计器十页签齐全')
    : fail('S2a 页签', JSON.stringify(tabs));

  await designTabByName('索引');
  let names = await idxNames();
  Array.isArray(names) && names.length === 0 ? pass('S2b 索引页初始为空') : fail('S2b 索引初始', JSON.stringify(names));
  await clickDesignBtn('添加索引');
  await sleep(300);
  // 填名称
  const nameInput = await dEv(`(() => {
    const i = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row input');
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(nameInput.x, nameInput.y);
  await insertText('idx_emp_name');
  await sleep(250);
  // 选列：点列 Select → 搜索 name → 点选项
  const colSel = await dEv(`(() => {
    const row = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row');
    const sel = row.querySelector('.ant-select');
    const r = sel.getBoundingClientRect();
    return { x: Math.round(r.x + Math.min(r.width / 2, 60)), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(colSel.x, colSel.y);
  await sleep(400);
  await insertText('name');
  await sleep(400);
  const opt = await ev(`(() => {
    const o = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option')].find((x) => x.textContent.trim() === 'name');
    if (!o) return null;
    const r = o.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!opt) {
    fail('S2c 前置', '列下拉无 name 选项');
  } else {
    await lclick(opt.x, opt.y);
    await sleep(250);
  }
  await press(400, 300, 'left', 1); // 收起下拉
  await sleep(300);
  const tags = await dEv(`[...document.querySelectorAll('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row .ant-select-selection-item')].map((t) => t.textContent)`);
  (await saveAndExecute('S2c 新增索引'))
    ? pass(`S2c 索引 idx_emp_name(name) 已创建（选中列：${(tags || []).join(',')}）`)
    : null;
  await designTabByName('索引');
  names = await idxNames();
  names && names.includes('idx_emp_name') ? pass('S2d 执行后索引出现在列表') : fail('S2d 索引列表', JSON.stringify(names));

  // 重建表时索引保留：拖动列序 → 预览应含 __rebuild 且索引会被重建
  await designTabByName('字段');
  const hp = await dEv(`(() => {
    const h = document.querySelector('.design-table .ant-table-tbody tr.ant-table-row .drag-handle');
    const r = h.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(250);
  await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    const tr0 = rows[0], tr1 = rows[1];
    const dt = new DataTransfer();
    tr0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r1 = tr1.getBoundingClientRect();
    const y = Math.round(r1.y + r1.height * 0.75);
    tr1.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    tr1.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    return true;
  })()`);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(400);
  let pv = await previewSql();
  pv && /employees__rebuild/.test(pv) && /idx_emp_name/i.test(pv)
    ? pass('S2e 重建表 SQL 保留索引（__rebuild + idx_emp_name 重建）')
    : fail('S2e 重建保留索引', (pv || 'null').slice(0, 200));
  await saveAndExecute('S2e');
  await designTabByName('索引');
  names = await idxNames();
  names && names.includes('idx_emp_name') ? pass('S2f 重建后索引仍在') : fail('S2f 重建后索引', JSON.stringify(names));
  // 数据保留
  await designTabByName('字段');
  const rowNames = await dEv(`(() => {
    return [...document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')].map((tr) => {
      const i = [...tr.querySelectorAll('input')].find((x) => x.placeholder === '字段名');
      return i ? i.value : '?';
    });
  })()`);
  Array.isArray(rowNames) && rowNames.length === 5 ? pass(`S2g 列仍为 5 列（${rowNames.join(',')}）`) : fail('S2g 列数', JSON.stringify(rowNames));

  // 还原列序 + 删除索引（还原现场）
  await Input.dispatchMouseEvent({ type: 'mousePressed', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(250);
  await ev(`(() => {
    const pane = document.querySelector('.ant-tabs-tabpane-active');
    const rows = [...pane.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row')];
    const tr0 = rows[0], tr1 = rows[1];
    const dt = new DataTransfer();
    tr0.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
    const r1 = tr1.getBoundingClientRect();
    const y = Math.round(r1.y + r1.height * 0.75); // 拖回下方（还原 id,name 顺序）
    tr1.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    tr1.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: Math.round(r1.x + 50), clientY: y, dataTransfer: dt }));
    return true;
  })()`);
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: hp.x, y: hp.y, button: 'left', clickCount: 1 });
  await sleep(400);
  await designTabByName('索引');
  const delBtn = await dEv(`(() => {
    const row = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row');
    const b = row && row.querySelector('.ant-btn-dangerous');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(delBtn.x, delBtn.y);
  await sleep(250);
  pv = await previewSql();
  pv && /DROP INDEX IF EXISTS "idx_emp_name"/.test(pv) ? pass('S2h 删除索引生成 DROP INDEX') : fail('S2h DROP INDEX', (pv || 'null').slice(0, 160));
  await saveAndExecute('S2h');
  await sleep(1800);

  // ---- S3 触发器 ----
  await designTabByName('触发器');
  let trigRows = await dEv(`document.querySelectorAll('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row').length`);
  trigRows === 0 ? pass('S3a 触发器初始为空') : fail('S3a 触发器初始', String(trigRows));
  await clickDesignBtn('新建触发器');
  await sleep(500);
  const genBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('.ant-modal .ant-btn')].find((x) => x.textContent.trim() === '生成模板');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(genBtn.x, genBtn.y);
  await sleep(300);
  const bodyText = await ev(`(() => { const t = document.querySelector('.ant-modal textarea'); return t ? t.value : null; })()`);
  bodyText && /CREATE TRIGGER "trig_employees_1"/.test(bodyText) && /FOR EACH ROW/.test(bodyText)
    ? pass('S3b 生成 SQLite 触发器模板')
    : fail('S3b 模板', JSON.stringify(bodyText));
  const runBtn = await ev(`(() => {
    const b = document.querySelector('.ant-modal .ant-modal-footer .ant-btn-primary');
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(runBtn.x, runBtn.y);
  await sleep(1200);
  trigRows = await dEv(`document.querySelectorAll('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row').length`);
  trigRows === 1 ? pass('S3c 触发器已创建并出现在列表') : fail('S3c 创建后列表', String(trigRows));
  // 带重试的点按：浮层竞态（弹窗动画/遮罩残留/表格重渲染）时先确认落点未被遮挡再点
  const clickRetry = async (js, checkJs, tries = 4, wait = 600) => {
    for (let i = 0; i < tries; i += 1) {
      const b = await ev(js);
      if (b && b.x != null) {
        const covered = await ev(`(() => { const el = document.elementFromPoint(${b.x}, ${b.y}); return !el || !(el.closest('button') || el.closest('.ant-menu-item') || el.closest('.ant-tabs-tab')); })()`);
        if (!covered) {
          await lclick(b.x, b.y);
          if (await ev(checkJs)) return true;
        }
      }
      await sleep(wait);
    }
    return false;
  };
  await clearFrozenModals();
  const eyeOk = await clickRetry(
    `(() => { const b = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row button[title="查看定义"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    `!!document.querySelector('.ant-modal .sql-preview')`
  );
  if (eyeOk) {
    const ddl = await ev(`(() => { const p = document.querySelector('.ant-modal .sql-preview'); return p ? p.textContent : null; })()`);
    ddl && /CREATE TRIGGER/i.test(ddl) ? pass('S3d 查看触发器 DDL') : fail('S3d DDL', (ddl || 'null').slice(0, 120));
    // 点 X 关闭并确认关闭（ESC 偶发不生效/留下冻结动画层）
    const closed = await clickRetry(
      `(() => { const b = document.querySelector('.ant-modal .ant-modal-close'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
      `!document.querySelector('.ant-modal')`
    );
    if (!closed) {
      await esc();
      await sleep(400);
    }
    await clearFrozenModals();
  } else {
    fail('S3d 查看按钮', '点击后 DDL 弹窗未出现（重试 3 次）');
  }
  await clearFrozenModals();
  const delOk = await clickRetry(
    `(() => { const b = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row button[title="删除"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    `!!document.querySelector('.ant-modal-confirm')`
  );
  if (!delOk) {
    const dump = await ev(`(() => { const b = document.querySelector('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row button[title="删除"]'); if (!b) return { noBtn: true }; const r = b.getBoundingClientRect(); const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return { top: el ? el.outerHTML.slice(0, 160) : null, wraps: [...document.querySelectorAll('.ant-modal-wrap')].map((w) => (w.querySelector('.ant-modal') || {}).className || '?').slice(0, 3) }; })()`);
    console.log('S3e delT 被遮挡:', JSON.stringify(dump));
  }
  if (delOk) {
    await sleep(500); // 等确认框入场动画稳定，避免点到缩放中的按钮
    let delConfirmed = false;
    for (let attempt = 0; attempt < 4 && !delConfirmed; attempt += 1) {
      const b = await ev(`(() => { const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '删除'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      const diag = await ev(`(() => ({
        confirms: document.querySelectorAll('.ant-modal-confirm').length,
        allBtns: [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].map((x) => x.textContent),
        top: (${b && b.x != null} && document.elementFromPoint(${b ? b.x : 0}, ${b ? b.y : 0})) ? document.elementFromPoint(${b ? b.x : 0}, ${b ? b.y : 0}).outerHTML.slice(0, 80) : null
      }))()`);
      console.log('S3e attempt', attempt, 'btn:', JSON.stringify(b), 'diag:', JSON.stringify(diag));
      if (b && b.x != null) {
        await lclick(b.x, b.y);
        await sleep(700);
        delConfirmed = await ev(`!document.querySelector('.ant-modal-confirm')`);
      } else {
        await sleep(600);
      }
    }
    if (!delConfirmed) {
      fail('S3e 前置', '确认框 删除 按钮点击未生效');
    }
    await sleep(1200);
  }
  // 兜底：确认框意外残留则 ESC 关闭
  if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) {
    await esc();
    await sleep(400);
  }
  trigRows = await dEv(`document.querySelectorAll('.design-tabs .obj-table .ant-table-tbody tr.ant-table-row').length`);
  trigRows === 0 ? pass('S3e 触发器已删除') : fail('S3e 删除', String(trigRows));

  // ---- S4 未保存绿点 + 关闭确认 ----
  await clearFrozenModals();
  // 设计页：改字段名 → 绿点 → 关闭确认 → 取消 → 再关 → 放弃并关闭
  await designTabByName('字段');
  const nameIn = await dEv(`(() => {
    // 必须按 placeholder 过滤：行内第一个 input 是 rowSelection 复选框（value='on'，rect 0×0）
    const i = [...document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row input')].find((x) => x.placeholder === '字段名');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!nameIn) {
    fail('S4 前置', '设计器字段页无输入行（设计器标签可能已意外关闭）');
    await client.close();
    return;
  }
  await lclick(nameIn.x, nameIn.y);
  await ctrlA();
  await insertText('id_renamed');
  await sleep(400);
  let dot = await ev(`!!document.querySelector('.main-tabs .ant-tabs-tab-active .tab-dot')`);
  dot ? pass('S4a 设计页修改后标签绿点') : fail('S4a 绿点');
  const closeIcon = await ev(`(() => {
    const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!closeIcon) {
    fail('S4b 前置', '未找到标签关闭按钮');
    await client.close();
    return;
  }
  await lclick(closeIcon.x, closeIcon.y);
  await sleep(600);
  let confirmText = await ev(`(() => { const m = document.querySelector('.ant-modal-confirm'); return m ? m.textContent.replace(/\\s+/g, '').slice(0, 80) : null; })()`);
  confirmText && confirmText.includes('未保存') ? pass('S4b 关闭时提示未保存') : fail('S4b 关闭提示', JSON.stringify(confirmText));
  const cancelBtn = await ev(`(() => {
    const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '取消');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(cancelBtn.x, cancelBtn.y);
  await sleep(400);
  let designOpen = await ev(`!!document.querySelector('.design-tabs')`);
  designOpen ? pass('S4c 取消后标签保留') : fail('S4c 取消保留');
  await lclick(closeIcon.x, closeIcon.y);
  await sleep(600);
  await clearFrozenModals();
  const gone = await clickRetry(
    `(() => { const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].filter((x) => x.textContent.replace(/\\s+/g, '') === '放弃并关闭' && x.getBoundingClientRect().width > 0).pop(); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    `!document.querySelector('.design-tabs')`
  );
  designOpen = await ev(`!!document.querySelector('.design-tabs')`);
  gone && !designOpen ? pass('S4d 放弃并关闭生效') : fail('S4d 放弃关闭', gone ? '点击后标签仍在' : '按钮点击未生效');

  // 查询页：输入→绿点→关闭确认；干净查询页直接关
  await clearFrozenModals();
  p = await treePosRetry('employees');
  await rclick(p.x, p.y);
  const qMenuOk = await clickMenu('新建查询');
  if (!qMenuOk) {
    // 菜单可能被残留遮挡层拦截：清理后重试一次
    await clearFrozenModals();
    await rclick(p.x, p.y);
    if (!(await clickMenu('新建查询'))) {
      fail('S4e 前置', '新建查询菜单无法打开');
      await client.close();
      return;
    }
  }
  await sleep(900);
  const edPos = await ev(`(() => {
    const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content');
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) };
  })()`);
  await lclick(edPos.x, edPos.y);
  await ctrlA();
  await insertText('select 1');
  await sleep(400);
  dot = await ev(`!!document.querySelector('.main-tabs .ant-tabs-tab-active .tab-dot')`);
  dot ? pass('S4e 查询页修改后绿点') : fail('S4e 查询绿点');
  const closeQ = await ev(`(() => {
    const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove');
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  await lclick(closeQ.x, closeQ.y);
  await sleep(600);
  confirmText = await ev(`(() => { const m = document.querySelector('.ant-modal-confirm'); return m ? m.textContent.replace(/\\s+/g, '').slice(0, 80) : null; })()`);
  confirmText && confirmText.includes('未保存') ? pass('S4f 查询页关闭提示') : fail('S4f 查询关闭提示', JSON.stringify(confirmText));
  const okQ = await clickRetry(
    `(() => { const b = [...document.querySelectorAll('.ant-modal-confirm .ant-btn')].filter((x) => x.textContent.replace(/\\s+/g, '') === '放弃并关闭' && x.getBoundingClientRect().width > 0).pop(); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`,
    `!document.querySelector('.query-editor-wrap')`
  );
  if (!okQ) {
    fail('S4f 后续', '放弃并关闭 未生效');
    await client.close();
    return;
  }
  await sleep(500);
  // 干净查询页：直接关闭，不应弹确认
  await clearFrozenModals();
  p = await treePosRetry('employees');
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) {
    fail('S4g 前置', '第二个 新建查询 无法打开');
  }
  await sleep(900);
  const closeQ2 = await ev(`(() => {
    const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove');
    if (!i) return null;
    const r = i.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!closeQ2) {
    fail('S4g 前置', '未找到查询页关闭按钮');
  } else {
    await lclick(closeQ2.x, closeQ2.y);
    await sleep(500);
  }
  const noConfirm = !(await ev(`!!document.querySelector('.ant-modal-confirm')`));
  noConfirm ? pass('S4g 未修改查询页直接关闭（无确认）') : fail('S4g 干净页直接关');

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
