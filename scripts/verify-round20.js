'use strict';
// v0927.52 导入向导验证（9229 实例，sqlite 演示库）：
//  W1 打开 employees 数据页 → 工具栏「导入向导…」→ 四步弹窗（文件/目标/字段映射/执行）
//  W2 CSV 解析预览：4 列 4 行
//  W3 新建表 dh_imp_t1：类型推断 整数/文本/整数/文本 → 导入 4 行
//  W4 SQL 验证 COUNT=4、id=1 → 张三（引号转义与数值绑定）
//  W8 数据页网格滚动条统一（overflow-x=scroll、scrollbar-color=auto）
//  W5 JSON → 新建表 dh_imp_j1 → 2 行（qty 整数 / price 小数）
//  W6 现有表追加：切目标表下拉 → dh_imp_t1 → 自动映射 → 追加 2 行 → COUNT=6
//  W7 表分类右键菜单含「导入向导…」
//  S0 版本 v0927.52；S5 无控制台错误
const CDP = require('chrome-remote-interface');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const client = await CDP({ port: Number(process.env.CDP_PORT || 9229) });
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
  const lclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(300); };
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(420); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const liveModal = (body) => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => { const m = x.querySelector('.ant-modal'); return m && !/ant-zoom-leave/.test(m.className) && getComputedStyle(x).display !== 'none'; }); if (!w) return null; const host = w; return (${body}); })()`);
  // 全弹窗找按钮（解析预览/选择文件在内容区，下一步/开始导入/关闭在 footer）
  const modalBtn = async (kw) => {
    const b = await liveModal(`(() => { const b = [...host.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const modalCloseHard = async () => {
    await modalBtn('取消');
    await sleep(300);
    await ev(`(() => { document.querySelectorAll('.ant-modal-wrap').forEach((w) => w.remove()); return 1; })()`);
    await sleep(300);
  };
  const keyTap = async (code, vk, key) => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', code, key, windowsVirtualKeyCode: vk });
    await Input.dispatchKeyEvent({ type: 'keyUp', code, key, windowsVirtualKeyCode: vk });
    await sleep(100);
  };
  const pickOptionKeys = async (label, maxSteps = 24) => {
    for (let i = 0; i < maxSteps; i += 1) {
      const act = await ev(`(() => {
        const dd = document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
        if (!dd) return { open: false };
        const a = dd.querySelector('.ant-select-item-option-active');
        return { open: true, t: a ? a.textContent.trim() : null };
      })()`);
      if (!act.open) return false;
      if (act.t === label) { await keyTap('Enter', 13, 'Enter'); await sleep(450); return true; }
      await keyTap('ArrowDown', 40, 'ArrowDown');
    }
    return false;
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

  const setInputByPlaceholder = (kw, v) => ev(`(() => {
    const i = [...document.querySelectorAll('.ant-modal input')].find((x) => x.placeholder && x.placeholder.includes(${JSON.stringify(kw)}));
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, ${JSON.stringify(v)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  const radioClick = async (label) => {
    const p = await liveModal(`(() => { const r = [...host.querySelectorAll('.ant-radio-wrapper')].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!r) return null; const b = r.getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };

  const clickTab = async (kw) => {
    const p = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(kw)})); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };

  const toolbarBtn = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-toolbar .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };

  const ctrlA = async () => {
    await Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    await sleep(120);
  };
  const runSqlInEditor = async (sql) => {
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 点编辑器容器而非 .cm-content：长行会把 cm-content 横向滚出视口（rect.x 为负），
      // 负坐标点击静默落空、焦点停在 BODY，insertText 就进不去
      const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.max(12, Math.round(r.x + 80)), y: Math.max(12, Math.round(r.y + 25)) }; })()`);
      if (!ed) return false;
      await lclick(ed.x, ed.y);
      await ctrlA();
      await Input.insertText({ text: sql });
      await sleep(300);
      // 落地校验：模态关闭后焦点偶发丢失，insertText 落空会重跑旧 SQL——没落上就重点一次
      const cur = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); return e ? e.textContent : ''; })()`);
      if (norm(cur).includes(norm(sql).slice(0, 20))) {
        const runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (!runBtn) return false;
        await lclick(runBtn.x, runBtn.y);
        await sleep(700);
        return true;
      }
    }
    return false;
  };
  const gridCell = (r0, c0) => ev(`(() => {
    const row = [...document.querySelectorAll('.ant-tabs-tabpane-active .dh-grid .ant-table-tbody .ant-table-row')].filter((x) => x.offsetParent)[${r0}];
    if (!row) return null;
    const cell = row.querySelectorAll('.cell')[${c0}];
    return cell ? cell.textContent : null;
  })()`);
  const waitCell = async (tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const v = await gridCell(0, 0);
      if (v != null && v !== '') return v;
      await sleep(500);
    }
    return null;
  };

  // 向导通用流程：打开（数据页工具栏）→ 填路径 → 解析预览 → 下一步 → （新建表 | 现有表）→ 映射下一步 → 执行下一步
  // 任一步失败先强制关掉弹窗，避免遮罩挡住后续点击
  const wizardNewTable = async (file, tbl, statCols, statRows) => {
    if (!(await toolbarBtn('导入向导'))) { await modalCloseHard(); return { ok: false, at: '打开' }; }
    if (!(await setInputByPlaceholder('文件路径', file))) { await modalCloseHard(); return { ok: false, at: '路径' }; }
    if (!(await modalBtn('解析预览'))) { await modalCloseHard(); return { ok: false, at: '解析' }; }
    let stat = '';
    for (let i = 0; i < 16 && !stat; i += 1) { stat = (await liveModal(`(() => { const e = host.querySelector('.imp-stat'); return e ? e.textContent : ''; })()`)) || ''; if (!stat) await sleep(400); }
    if (!stat.includes(`${statCols} 列`) || !stat.includes(`${statRows} 行`)) { await modalCloseHard(); return { ok: false, at: '预览统计', stat }; }
    if (!(await modalBtn('下一步'))) { await modalCloseHard(); return { ok: false, at: '目标步', stat }; }
    // 从数据页进入时预设「现有表」：切到 新建表
    const mode = await liveModal(`(() => { const r = host.querySelectorAll('.ant-radio-wrapper'); return r.length; })()`);
    if (!mode) { await modalCloseHard(); return { ok: false, at: '单选缺失', stat }; }
    if (!(await radioClick('新建表'))) { await modalCloseHard(); return { ok: false, at: '切新建表', stat }; }
    if (!(await setInputByPlaceholder('新表名', tbl))) { await modalCloseHard(); return { ok: false, at: '表名', stat }; }
    if (!(await modalBtn('下一步'))) { await modalCloseHard(); return { ok: false, at: '映射步', stat }; }
    return { ok: true, stat };
  };
  const wizardRun = async () => {
    if (!(await modalBtn('下一步'))) { await modalCloseHard(); return { ok: false, at: '执行步' }; }
    if (!(await modalBtn('开始导入'))) { await modalCloseHard(); return { ok: false, at: '开始导入' }; }
    let out = null;
    for (let i = 0; i < 40 && !out; i += 1) {
      out = await liveModal(`(() => { const o = host.querySelector('.imp-ok'); const e = host.querySelector('.imp-err'); return o ? { ok: o.textContent } : e ? { err: e.textContent } : null; })()`);
      if (!out) await sleep(450);
    }
    if (!out) { await modalCloseHard(); return { ok: false, at: '等待结果' }; }
    await modalBtn('关闭');
    await sleep(400);
    await ev(`(() => { document.querySelectorAll('.ant-modal-wrap').forEach((w) => { const m = w.querySelector('.ant-modal'); if (m && /ant-zoom-leave/.test(m.className)) w.remove(); }); return 1; })()`);
    return out;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- 打开 sqlite → 表 → employees（数据页）----
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  await sleep(300);
  p = await treePos('employees');
  await dblclick(p.x, p.y);
  await sleep(1400);

  // W8 数据页网格滚动条统一（虚拟表自绘模拟条：常显 + 11px + 浅灰圆角 thumb）——
  // 无溢出时组件不渲染滚动条，改在查询页造 30 列宽结果后断言（见 W8 主体）
  await ev(`(() => { const g = document.querySelector('.ant-tabs-tabpane-active .dh-grid'); return !!g; })()`)
    ? pass('W8 前置：数据页网格在位')
    : fail('W8 前置', '无 .dh-grid');

  // W1 工具栏「导入向导…」→ 四步弹窗
  const w1 = await toolbarBtn('导入向导');
  if (!w1) fail('W1 工具栏「导入向导…」', '按钮缺失');
  else {
    const mt = await liveModal(`(() => ({ t: host.querySelector('.ant-modal-title') ? host.querySelector('.ant-modal-title').textContent : '', steps: [...host.querySelectorAll('.ant-steps-item-title')].map((x) => x.textContent) }))()`);
    mt && mt.t && mt.t.includes('导入向导') && JSON.stringify(mt.steps) === JSON.stringify(['文件', '目标', '字段映射', '执行'])
      ? pass('W1 导入向导弹窗（标题 + 四步）')
      : fail('W1 导入向导弹窗', JSON.stringify(mt));
    await ev(`(() => { const c = document.querySelector('.ant-modal-close'); if (c) c.click(); return 1; })()`);
    await sleep(400);
  }

  // W2+W3 CSV → 新建表 dh_imp_t1
  const w2 = await wizardNewTable('D:/DataHelm/.tmp-ud7/imp-src.csv', 'dh_imp_t1', 4, 4);
  if (!w2.ok) fail('W2 解析/目标步骤', JSON.stringify(w2));
  else {
    w2.stat.includes('4 列') && w2.stat.includes('4 行')
      ? pass('W2 CSV 解析预览（4 列 · 4 行）')
      : fail('W2 CSV 预览', String(w2.stat));
    const kindsArr = await liveModal(`(() => [...host.querySelectorAll('.imp-map .ant-select-selection-item')].map((x) => x.textContent.trim()))()`);
    JSON.stringify(kindsArr) === JSON.stringify(['整数', '文本', '整数', '文本'])
      ? pass('W3a 类型推断（整数/文本/整数/文本）')
      : fail('W3a 类型推断', JSON.stringify(kindsArr));
    const r4 = await wizardRun();
    r4.ok && /导入完成：4 行/.test(r4.ok)
      ? pass('W3b 新建表 dh_imp_t1 导入 4 行')
      : fail('W3b 导入执行', JSON.stringify(r4));
  }

  // W4 SQL 验证
  const nq = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '新建查询'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  await lclick(nq.x, nq.y);
  let qready = false;
  for (let i = 0; i < 20 && !qready; i += 1) { qready = !!(await ev("!!document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content')")); if (!qready) await sleep(500); }
  if (qready && (await runSqlInEditor('SELECT COUNT(*) AS n FROM dh_imp_t1'))) {
    const v = await waitCell();
    v === '4' ? pass('W4a SELECT COUNT(*) FROM dh_imp_t1 = 4') : fail('W4a COUNT', String(v));
    await runSqlInEditor('SELECT name AS nm FROM dh_imp_t1 WHERE id = 1');
    const nm = await waitCell();
    nm === '张三' ? pass('W4b id=1 → 张三（引号转义 + 数值绑定）') : fail('W4b 取值', String(nm));
  } else fail('W4 查询执行前置', 'editor=' + qready);

  // W8 宽结果集（30 列）→ 自绘模拟滚动条：常显 + 11px + 浅灰圆角 thumb
  if (await runSqlInEditor(`SELECT ${Array.from({ length: 30 }, (_, i) => (i + 1) + ' AS c' + (i + 1)).join(', ')}`)) {
    await sleep(500);
    const sb = await ev(`(() => {
      const g = document.querySelector('.ant-tabs-tabpane-active .dh-grid');
      if (!g) return null;
      const bar = g.querySelector('.ant-table-tbody-virtual-scrollbar-horizontal');
      if (!bar) return { missing: true };
      const thumb = bar.querySelector('.ant-table-tbody-virtual-scrollbar-thumb');
      const bc = getComputedStyle(bar);
      const tc = thumb ? getComputedStyle(thumb) : null;
      return { vis: bc.visibility, h: bc.height, thumbBg: tc ? tc.backgroundColor : null, thumbBr: tc ? tc.borderRadius : null };
    })()`);
    sb && !sb.missing && sb.vis === 'visible' && sb.h === '11px' && /195, 203, 212/.test(String(sb.thumbBg)) && sb.thumbBr === '6px'
      ? pass('W8 结果网格横向滚动条（常显 · 11px · #c3cbd4 圆角 6px）')
      : fail('W8 网格滚动条', JSON.stringify(sb));
  } else fail('W8 前置', '宽查询未执行');

  // W5 JSON → 新建表 dh_imp_j1
  await clickTab('employees');
  await sleep(400);
  const w5 = await wizardNewTable('D:/DataHelm/.tmp-ud7/imp-src.json', 'dh_imp_j1', 3, 2);
  if (!w5.ok) fail('W5 JSON 解析/目标步骤', JSON.stringify(w5));
  else {
    const kindsArr = await liveModal(`(() => [...host.querySelectorAll('.imp-map .ant-select-selection-item')].map((x) => x.textContent.trim()))()`);
    JSON.stringify(kindsArr) === JSON.stringify(['文本', '整数', '小数'])
      ? pass('W5a JSON 推断（文本/整数/小数）')
      : fail('W5a JSON 推断', JSON.stringify(kindsArr));
    const r5 = await wizardRun();
    r5.ok && /导入完成：2 行/.test(r5.ok)
      ? pass('W5b 新建表 dh_imp_j1 导入 2 行')
      : fail('W5b 导入执行', JSON.stringify(r5));
  }

  // W6 现有表追加：预设目标 employees → 下拉切 dh_imp_t1 → 自动映射 → 追加 2 行
  await clickTab('employees');
  await sleep(400);
  const w6ok = await toolbarBtn('导入向导')
    && await setInputByPlaceholder('文件路径', 'D:/DataHelm/.tmp-ud7/imp-append.csv')
    && await modalBtn('解析预览');
  if (!w6ok) fail('W6 前置', '打开/解析失败');
  else {
    let stat = '';
    for (let i = 0; i < 14 && !stat; i += 1) { stat = (await liveModal(`(() => { const e = host.querySelector('.imp-stat'); return e ? e.textContent : ''; })()`)) || ''; if (!stat) await sleep(400); }
    stat.includes('4 列') && stat.includes('2 行') ? pass('W6a 追加 CSV 解析（4 列 · 2 行）') : fail('W6a 解析', String(stat));
    await modalBtn('下一步'); // → 目标（预设 现有表 employees）
    const preset = await liveModal(`(() => { const e = host.querySelector('.ant-select-selection-item'); return e ? e.textContent.trim() : null; })()`);
    preset === 'employees' ? pass('W6b 数据页入口预设现有表 employees') : fail('W6b 预设目标', String(preset));
    // 打开目标表下拉 → 键盘导航选 dh_imp_t1
    const sel = await liveModal(`(() => { const e = host.querySelector('.ant-select-selector'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    await press(sel.x, sel.y, 'left', 1);
    await sleep(450);
    const picked = await pickOptionKeys('dh_imp_t1');
    if (!picked) fail('W6c 目标下拉选 dh_imp_t1', '未选中');
    else {
      pass('W6c 目标下拉选 dh_imp_t1');
      await sleep(600); // 列元数据加载 + 映射重建
      await modalBtn('下一步'); // → 映射
      const hint = await liveModal(`(() => { const e = [...host.querySelectorAll('.imp-hint')].pop(); return e ? e.textContent : ''; })()`);
      hint && hint.includes('已映射 4') ? pass('W6d 自动映射 4 字段') : fail('W6d 自动映射', String(hint));
      const r6 = await wizardRun();
      r6.ok && /导入完成：2 行/.test(r6.ok)
        ? pass('W6e 现有表追加 2 行（逐批参数化）')
        : fail('W6e 追加执行', JSON.stringify(r6));
    }
  }

  // W6f 总数 = 6
  await clickTab('查询');
  await sleep(400);
  if (await runSqlInEditor('SELECT COUNT(*) AS n FROM dh_imp_t1')) {
    const v = await waitCell();
    v === '6' ? pass('W6f 追加后 COUNT = 6') : fail('W6f COUNT', String(v));
  } else fail('W6f 前置', '编辑器输入未落地');

  // W7 表分类右键菜单含 导入向导…
  const cat = await treePos('表');
  if (!cat) fail('W7 表分类定位', '未找到');
  else {
    await rclick(cat.x, cat.y);
    const items = await ev(`(() => { const d = document.querySelector('.ctx-menu'); return d ? [...d.querySelectorAll('.ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, '')) : null; })()`);
    items && items.includes('导入向导…')
      ? pass('W7 表分类菜单含「导入向导…」（' + items.slice(0, 5).join('/') + '…）')
      : fail('W7 表分类菜单', JSON.stringify(items));
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(250);
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
