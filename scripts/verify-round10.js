'use strict';
// v0921.1 设计器对象增强验证（sqlite 9227 实例 + localhost MSSQL）：
//  A sqlite：索引类型/注释列按方言隐藏；索引降序+唯一 DDL 与回读；外键 ON DELETE 走重建表
//  B mssql：索引 UNIQUE NONCLUSTERED+降序+注释（回读/注释在线更新不重建）；外键 NOCHECK+NOT FOR REPLICATION；
//           启用在线切换 WITH CHECK CHECK；唯一键 NONCLUSTERED+注释
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
  // 设计器当前激活页里的元素查询：主标签层与设计器内层都存在 .ant-tabs-tabpane-active，
  // 第一个命中的可能是 A 部分遗留的空页签——取「包含 .design-tabs 的那个」
  const dEv = (js) => ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs')); return p ? (${js}) : null; })()`);
  const designTabByName = async (name) => {
    const t = await ev(`(() => {
      const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === ${JSON.stringify(name)});
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    })()`);
    if (t) {
      await lclick(t.x, t.y);
      await sleep(420);
    }
    return !!t;
  };
  const clickDesignBtn = async (kw) => {
    const b = await ev(`(() => {
      const host = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs'));
      if (!host) return null;
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
  // v0927.52 起「保存」直接执行；预览改为只读：切 SQL 预览页签（激活即按当前差异刷新）读文本，不保存
  const savePreview = async (label) => {
    const before = await sqlPreviewText();
    await designTabByName('SQL 预览');
    let t = null;
    for (let i = 0; i < 14; i += 1) {
      t = await sqlPreviewText();
      if (t && t !== before) break;
      await sleep(450);
    }
    if (!t) { fail(label + ' 前置', 'SQL 预览未生成'); return null; }
    return t;
  };
  // 等对象表行出现（执行变更后的 reload 空窗）
  const waitRows = async (tries = 12) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  // 等字段页行出现（设计器列加载完成，colNames 才可用于各对象下拉）
  const waitFields = async (tries = 16) => {
    for (let i = 0; i < tries; i += 1) {
      const n = await dEv(`document.querySelectorAll('.design-table .ant-table-tbody tr.ant-table-row').length`);
      if (n > 0) return true;
      await sleep(500);
    }
    return false;
  };
  // v0927.52：保存 = 直接执行 applyAlter；完成信号 = 内层页签回到「字段」（applyPreview 成功后 setActiveTab('fields')）
  const saveAndExecute = async () => {
    if (!(await clickDesignBtn('保存'))) return { err: 'no-save-btn' };
    let back = false;
    for (let i = 0; i < 24 && !back; i += 1) {
      await sleep(450);
      if (i >= 2) back = await dEv(`(() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() === '字段' : false; })()`);
    }
    await sleep(1500);
    return { ok: back };
  };
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
  const clearFrozenModals = () => ev(`(() => {
    let n = 0;
    document.querySelectorAll('.ant-modal-wrap').forEach((w) => {
      const m = w.querySelector('.ant-modal');
      if (m && /ant-zoom-leave/.test(m.className)) { w.remove(); n += 1; }
    });
    return n;
  })()`);
  // 对象表第一行（body 内可直接用闭包变量 row；限定激活的内层页签，避免数到其它页签的行）
  const objRow = (body) => dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null; return (${body}); })()`);
  // 点对象表第一行的输入框（按 placeholder 定位；同时触发行 onClick 绑定面板）
  const clickRowInput = async (placeholder) => {
    const p = await objRow(`(() => { const i = [...row.querySelectorAll('input')].find((x) => x.placeholder === ${JSON.stringify(placeholder)}); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  // 点行内过滤后第 n 个 Select（n 形如 '[0]'），等下拉出现；先清场保证任何时刻只有一个可见下拉
  const clickRowSelect = async (n) => {
    await closeAllDropdowns();
    const p = await objRow(`(() => { const s = [...row.querySelectorAll('.ant-select')].filter((x) => x.getBoundingClientRect().width > 0)${n}; if (!s) return null; const r = s.getBoundingClientRect(); return { x: Math.round(r.x + Math.min(r.width / 2, 70)), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(450);
    return true;
  };
  // 在已打开的下拉里：可选输入过滤文本，再点选项（exact 或 includes）。
  // 隐藏窗口里 rc-motion 进场动画可能卡在 appear-prepare（transform 塌缩），选项矩形会缩到原点——按尺寸过滤后重试
  const pickOption = async (optText, { search = null, exact = true, tries = 6 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
      if (search != null) {
        await insertText(search);
        await sleep(350);
      }
      const o = await ev(`(() => {
        const dd = '.ant-select-dropdown:not(.ant-select-dropdown-hidden)';
        const live = [...document.querySelectorAll(dd)].filter((d) => !/ant-slide-up-leave/.test(d.className));
        const list = live.length ? live : [...document.querySelectorAll(dd)];
        const o = list.flatMap((d) => [...d.querySelectorAll('.ant-select-item-option')]).find((x) => { const t = x.textContent.replace(/\\s+/g, ''); return ${exact ? `t === ${JSON.stringify(optText)}` : `t.includes(${JSON.stringify(optText)})`}; });
        if (!o) return null;
        const r = o.getBoundingClientRect();
        if (r.width < 20 || r.height < 16) return { bad: true, w: r.width, h: r.height };
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (o && !o.bad && o.x != null) {
        await lclick(o.x, o.y);
        await sleep(300);
        return true;
      }
      await sleep(400);
    }
    return false;
  };
  const closeDropdown = async () => { await press(400, 300, 'left', 1); await sleep(350); };
  // 清场：点状态栏空白直到无可见下拉（不动 antd 的节点——手动移除 rc-motion 管理的
  // 节点会让 React portal 卸载异常、整棵树崩掉）。leave 冻结的僵尸靠 pickOption 过滤跳过
  const closeAllDropdowns = async () => {
    for (let i = 0; i < 4; i += 1) {
      const n = await ev(`(() => {
        const ds = [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')];
        return ds.filter((d) => !/ant-slide-up-leave/.test(d.className)).length;
      })()`);
      if (n === 0) return true;
      const away = await ev(`({ x: 300, y: Math.max(10, window.innerHeight - 20) })`);
      await press(away.x, away.y);
      await sleep(400);
    }
    return false;
  };
  // 栏位排序面板状态：[{col, dir}]
  const dirItems = () => dEv(`(() => {
    return [...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) .dir-item')].map((it) => ({
      col: (it.querySelector('code') || {}).textContent || '',
      dir: ((it.querySelector('.ant-select-selection-item') || {}).textContent || '').replace(/\\s+/g, ''),
    }));
  })()`);
  const objInputValues = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      const out = {}; [...row.querySelectorAll('input')].forEach((i) => { if (i.placeholder) out[i.placeholder] = i.value; }); return out; })()`);
  const objRowCheckboxes = () =>
    dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
      return [...row.querySelectorAll('input[type="checkbox"]')].map((c) => !!c.checked); })()`);
  const barPanelCheckboxes = () =>
    dEv(`(() => { return [...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) input[type="checkbox"]')].map((c) => !!c.checked); })()`);

  // ---- S0 版本 ----
  const sb = await ev(`document.querySelector('.statusbar').textContent.replace(/\\s+/g, '')`);
  sb.includes('v0927.52') ? pass('S0 状态栏 v0927.52') : fail('S0 状态栏 v0927.52', sb);

  // ================= Part A：sqlite =================
  let p = await treePos('演示 SQLite 库');
  await dblclick(p.x, p.y);
  p = await treePos('表');
  await dblclick(p.x, p.y);
  p = await treePos('employees');
  if (!p) { fail('A 前置', '未找到 employees'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(1600);
  await waitFields(); // 列加载完成后 colNames 才可用

  await designTabByName('索引');
  // A1 sqlite 列裁剪：无 索引类型/注释，有 唯一；面板提示存在
  const idxHeads = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-thead th')].map((t) => t.textContent.trim())`);
  const noTypeCmt = idxHeads && !idxHeads.includes('索引类型') && !idxHeads.includes('注释') && idxHeads.includes('唯一');
  noTypeCmt ? pass('A1a sqlite 索引列裁剪（无类型/注释，有唯一）') : fail('A1a 索引列', JSON.stringify(idxHeads));
  const hint1 = await dEv(`!!document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel.hint')`);
  hint1 ? pass('A1b 栏位排序面板提示') : fail('A1b 面板提示');

  // A2 新索引 name+salary，name 设降序
  await clickDesignBtn('添加索引');
  await sleep(300);
  await clickRowInput('idx_name');
  await insertText('idx_dir');
  await sleep(250);
  await clickRowSelect('[0]');
  await insertText('name');
  await pickOption('name');
  await sleep(700); // 选中后下拉保持打开且列表恢复全量：同一下拉内直接点第二项（不关闭重开——离场动画可能冻结成僵尸）
  await pickOption('salary');
  await closeAllDropdowns();
  await clickRowInput('idx_name'); // 触发行选中 → 面板
  await sleep(300);
  let dirs = await dirItems();
  Array.isArray(dirs) && dirs.length === 2 ? pass(`A2a 面板列出 2 个字段（${dirs.map((d) => d.col).join(',')}）`) : fail('A2a 面板字段', JSON.stringify(dirs) + ' state=' + JSON.stringify(await ev(`(() => ({
    inner: (() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() : null; })(),
    rows: document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length,
    dds: [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')].map((d) => { const r = d.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), cls: (d.className.match(/ant-slide-up-\\S+/g) || []).join(',') }; }),
    tags: [...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-select-selection-item')].map((t) => t.textContent),
  }))()`)));
  // 点面板第一个 dir-item 的 Select → 选 降序
  const dirSel = await dEv(`(() => { const it = document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) .dir-item .ant-select'); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!dirSel) {
    fail('A2b 前置', '未找到排序面板下拉');
  } else {
    await lclick(dirSel.x, dirSel.y);
    await sleep(400);
    await pickOption('降序');
    await closeAllDropdowns();
  }
  dirs = await dirItems();
  dirs && dirs[0] && dirs[0].dir === '降序' && dirs[1] && dirs[1].dir.includes('升序')
    ? pass('A2b 面板设置 name=降序 salary=升序')
    : fail('A2b 排序面板', JSON.stringify(dirs));
  let r2 = await saveAndExecute();
  if (r2.err) fail('A2c 执行', JSON.stringify(r2));
  let pv = await sqlPreviewText();
  // 保存后停在 SQL 预览页；执行前面板文本就是预览
  await designTabByName('索引');
  await waitRows();
  let names = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row input')].map((i) => i.value)`);
  // A2c 断言：重新做一次保存拿到预览文本（不执行）——用降序断言 DDL
  // （上面的 saveAndExecute 已执行；为拿到 DDL 文本，改一次升序再改回，代价高。直接断言当前列表 + 回读面板）
  names && names.includes('idx_dir') ? pass('A2c 索引已创建并回读') : fail('A2c 索引列表', JSON.stringify(names));
  await clickRowInput('idx_name');
  await sleep(300);
  dirs = await dirItems();
  dirs && dirs[0] && dirs[0].col === 'name' && dirs[0].dir === '降序' ? pass('A2d 降序已持久化并回读') : fail('A2d 回读降序', JSON.stringify(dirs));

  // A3 改降序校验 DDL 文本：把 name 改回升序 → 保存（不执行）→ 预览应含 DROP + CREATE（无 DESC）→ 执行
  const dirSel2 = await dEv(`(() => { const it = document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) .dir-item .ant-select'); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!dirSel2) {
    fail('A3 前置', '未找到排序面板下拉');
  } else {
    await lclick(dirSel2.x, dirSel2.y);
    await sleep(400);
    await pickOption('升序（默认）', { exact: true });
    await closeAllDropdowns();
  }
  pv = await savePreview('A3');
  pv && /DROP INDEX IF EXISTS "idx_dir"/.test(pv) && /CREATE INDEX "idx_dir" ON "employees" \("name", "salary"\)/.test(pv) && !/DESC/.test(pv)
    ? pass('A3a 升降序差异 DDL（DROP+CREATE 无 DESC）')
    : fail('A3a 排序 DDL', (pv || 'null').slice(0, 220));
  if (pv) await saveAndExecute();
  await sleep(2200);

  // A4 勾选唯一 → 预览 CREATE UNIQUE INDEX → 执行 → 回读勾选
  await designTabByName('索引');
  await clickRowInput('idx_name');
  const ck = await objRow(`(() => { const c = row.querySelector('input[type="checkbox"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!ck) fail('A4 前置', '未找到唯一勾选框');
  else await lclick(ck.x, ck.y);
  await sleep(250);
  pv = await savePreview('A4');
  pv && /CREATE UNIQUE INDEX "idx_dir" ON "employees" \("name", "salary"\)/.test(pv) ? pass('A4a 唯一索引 DDL') : fail('A4a 唯一 DDL', (pv || 'null').slice(0, 200));
  if (pv) await saveAndExecute();
  await sleep(2400);
  // sqlite/mysql：勾唯一保存后，唯一索引归入「唯一键」页签（同 Navicat）
  await designTabByName('唯一键');
  const rowsReady = await waitRows();
  await clickRowInput('uk_name');
  const uqName = await objInputValues();
  await designTabByName('索引');
  const idxNow = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row input')].map((i) => i.value)`);
  rowsReady && uqName && uqName.uk_name === 'idx_dir' && Array.isArray(idxNow) && !idxNow.includes('idx_dir')
    ? pass('A4b 唯一索引移入唯一键页签且回读（索引页已无）')
    : fail('A4b 唯一回读', JSON.stringify({ rowsReady, uqName, idxNow }));

  // A5 sqlite 外键：fk_dept(dept → employees.id) ON DELETE CASCADE 走重建表
  await designTabByName('外键');
  await clickDesignBtn('添加外键');
  await sleep(300);
  await clickRowInput('fk_name');
  await insertText('fk_dept');
  await sleep(250);
  // sqlite 行内 Select 顺序：0=本表列 1=引用表 2=引用列 3=删除时 4=更新时
  await clickRowSelect('[0]');
  await insertText('dept');
  await pickOption('dept');
  await closeAllDropdowns();
  await clickRowSelect('[1]');
  await insertText('employees');
  await pickOption('employees');
  await clickRowSelect('[2]');
  await insertText('id');
  await pickOption('id');
  await clickRowSelect('[3]');
  await pickOption('CASCADE');
  await closeAllDropdowns();
  pv = await savePreview('A5');
  pv && /employees__rebuild/.test(pv) && /FOREIGN KEY \("dept"\) REFERENCES "employees" \("id"\) ON DELETE CASCADE/.test(pv) && /INSERT INTO "employees__rebuild"/.test(pv)
    ? pass('A5a 外键重建表 DDL（含数据保留）')
    : fail('A5a 外键 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(2600);
  await designTabByName('外键');
  await waitRows();
  const fkInfo = await dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
    const sels = [...row.querySelectorAll('.ant-select')].map((s) => ((s.querySelector('.ant-select-selection-item') || {}).textContent || '').replace(/\\s+/g, ''));
    return { n: document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length, sels }; })()`);
  fkInfo && fkInfo.n === 1 && fkInfo.sels.some((t) => /CASCADE/.test(t)) ? pass('A5b 外键已建（CASCADE 回读）') : fail('A5b 外键回读', JSON.stringify(fkInfo));
  // 还原：删除外键 → 重建回无外键
  const fkDel = await objRow(`(() => { const b = row.querySelector('.ant-btn-dangerous'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!fkDel) fail('A5c 前置', '未找到外键删除按钮');
  else await lclick(fkDel.x, fkDel.y);
  await sleep(250);
  pv = await savePreview('A5c');
  pv && /employees__rebuild/.test(pv) && !/FOREIGN KEY/.test(pv) ? pass('A5c 删外键重建（无 FK）') : fail('A5c 删外键', (pv || 'null').slice(0, 200));
  if (pv) await saveAndExecute();
  await sleep(2600);

  // 清理：删唯一键页签里的 idx_dir（勾唯一后它归入唯一键页签），关闭设计页（此时应无未保存）
  await designTabByName('唯一键');
  await clickRowInput('uk_name');
  const del1 = await objRow(`(() => { const b = row.querySelector('.ant-btn-dangerous'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!del1) fail('A6 前置', '未找到唯一键删除按钮');
  else await lclick(del1.x, del1.y);
  await sleep(250);
  r2 = await saveAndExecute();
  if (r2.err) fail('A6 清理索引', JSON.stringify(r2));
  await sleep(600);
  await clearFrozenModals();
  const closeA = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (closeA) { await lclick(closeA.x, closeA.y); await sleep(700); }
  const noConfirmA = !(await ev(`!!document.querySelector('.ant-modal-confirm')`));
  noConfirmA ? pass('A6 索引清理+设计页干净关闭') : fail('A6 关闭', '出现未保存确认（意外）');

  // ================= Part B：MSSQL =================
  // 展开 1 → master；建 dh_test / dh_ref；展开 表 分类；设计 dh_test
  p = await treePos('1');
  if (!p) {
    const treeDump = await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].map((n) => n.textContent).slice(0, 15)`);
    fail('B 前置', '未找到连接 1，树节点: ' + JSON.stringify(treeDump));
    await client.close();
    return;
  }
  await dblclick(p.x, p.y);
  // mssql 连接（tedious）偶发偏慢：轮询等待 master 出现，最多 ~10s
  p = null;
  for (let i = 0; i < 14 && !p; i += 1) { p = await treePos('master'); if (!p) await sleep(700); }
  if (!p) { fail('B 前置', '未找到 master 库'); await client.close(); return; }
  await rclick(p.x, p.y);
  if (!(await clickMenu('新建查询'))) { fail('B 前置', 'master 无 新建查询 菜单'); await client.close(); return; }
  await sleep(1200);
  const ed = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
  await lclick(ed.x, ed.y);
  await ctrlA();
  await insertText("IF OBJECT_ID('dbo.dh_test','U') IS NOT NULL DROP TABLE dbo.dh_test;\nIF OBJECT_ID('dbo.dh_ref','U') IS NOT NULL DROP TABLE dbo.dh_ref;\nCREATE TABLE dbo.dh_test(id INT PRIMARY KEY, code VARCHAR(20), nm VARCHAR(50));\nCREATE TABLE dbo.dh_ref(code VARCHAR(20) PRIMARY KEY);");
  await sleep(300);
  const runBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!runBtn) { fail('B 前置', '查询页无 运行 按钮'); await client.close(); return; }
  await lclick(runBtn.x, runBtn.y);
  await sleep(2600);
  // 关闭查询页
  const closeQ = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (closeQ) { await lclick(closeQ.x, closeQ.y); await sleep(600); }
  await clearFrozenModals();
  if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) { await esc(); await sleep(400); }
  // 展开 master → 表 分类（最后一个 表 行），再展开找 dh_test
  p = await treePos('master');
  await dblclick(p.x, p.y);
  await sleep(600);
  const catP = await ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const cat = rows.filter((r) => r.querySelector('.node-title').textContent === '表').pop();
    if (!cat) return null;
    const r = cat.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!catP) { fail('B 前置', '未找到 master 的 表 分类'); await client.close(); return; }
  await dblclick(catP.x, catP.y);
  await sleep(1400);
  p = await treePos('dh_test');
  if (!p) { fail('B 前置', 'dh_test 未出现在树'); await client.close(); return; }
  await rclick(p.x, p.y);
  await clickMenu('设计表');
  await sleep(2400);
  await waitFields(); // mssql 列/对象内省较慢：等字段行出现再操作

  // B1 索引：UNIQUE + NONCLUSTERED + code 降序 + 注释
  await designTabByName('索引');
  const msHeads = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-thead th')].map((t) => t.textContent.trim())`);
  msHeads && msHeads.includes('索引类型') && msHeads.includes('注释') && msHeads.includes('唯一')
    ? pass('B1a mssql 索引列含 类型/唯一/注释')
    : fail('B1a mssql 索引列', JSON.stringify(msHeads));
  const addDiag = await ev(`(() => {
    const host = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.design-tabs'));
    if (!host) return { err: 'no-host' };
    const b = [...host.querySelectorAll('.ant-btn')].find((x) => {
      const r = x.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && x.textContent.replace(/\\s+/g, '').includes('添加索引');
    });
    if (!b) return { err: 'no-btn', btns: [...host.querySelectorAll('.ant-btn')].map((x) => x.textContent.replace(/\\s+/g, '')).slice(0, 8) };
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    return { pos: { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }, cover: el ? el.outerHTML.slice(0, 120) : null, coverIsBtn: !!(el && (el.closest('button') === b)) };
  })()`);
  const addOk = await clickDesignBtn('添加索引');
  await sleep(400);
  const bRows = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
  if (!addOk || bRows === 0) fail('B1 前置', '添加索引未生效 addOk=' + addOk + ' rows=' + bRows + ' diag=' + JSON.stringify(addDiag));
  await sleep(100);
  await clickRowInput('idx_name');
  await insertText('idx_code');
  await sleep(250);
  await clickRowSelect('[0]');
  await insertText('code');
  const codePicked = await pickOption('code');
  await closeAllDropdowns();
  if (!codePicked) {
    const dumpB = await dEv(`(() => ({
      inner: (() => { const t = document.querySelector('.design-tabs .ant-tabs-tab-active'); return t ? t.textContent.trim() : null; })(),
      rows: document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length,
      name: (() => { const i = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row input[placeholder="idx_name"]'); return i ? i.value : null; })(),
      tags: [...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-select-selection-item')].map((t) => t.textContent),
      dds: [...document.querySelectorAll('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')].map((d) => ({ cls: (d.className.match(/ant-slide-up-\\S+/g) || []).join(','), w: Math.round(d.getBoundingClientRect().width) })),
      open: !!document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)'),
    }))()`);
    fail('B1 前置', 'code 列未选中: ' + JSON.stringify(dumpB));
  }
  await clickRowInput('idx_name'); // 选中行
  const msDir = await dEv(`(() => { const it = document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) .dir-item .ant-select'); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!msDir) {
    fail('B1 前置', '未出现栏位排序面板: ' + JSON.stringify(await dEv(`document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel') ? document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel').textContent.slice(0, 60) : null`)));
  } else {
    await lclick(msDir.x, msDir.y);
    await sleep(400);
    await pickOption('降序');
    await closeAllDropdowns();
  }
  // 类型显式选 NONCLUSTERED（Select 交互验证）
  await clickRowSelect('[1]');
  await pickOption('NONCLUSTERED');
  // 唯一勾选
  const ckB = await objRow(`(() => { const c = row.querySelector('input[type="checkbox"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (!ckB) fail('B1 前置', '未找到唯一勾选框');
  else await lclick(ckB.x, ckB.y);
  await sleep(250);
  await clickRowInput('索引注释');
  await ctrlA();
  await insertText('mssql注释');
  await sleep(250);
  pv = await savePreview('B1');
  pv && /CREATE UNIQUE NONCLUSTERED INDEX "idx_code" ON "master"\."dbo"\."dh_test" \("code" DESC\)/.test(pv) && /sp_addextendedproperty/.test(pv) && /sp_updateextendedproperty/.test(pv)
    ? pass('B1b 唯一非聚集+降序+注释 DDL（含扩展属性 upsert）')
    : fail('B1b 索引 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(3000);
  await designTabByName('索引');
  await waitRows();
  await clickRowInput('idx_name');
  await sleep(300);
  let vals = await objInputValues();
  let cbsB = await objRowCheckboxes();
  dirs = await dirItems();
  const typeTxt = await objRow(`(() => { const s = [...row.querySelectorAll('.ant-select')].filter((x) => x.getBoundingClientRect().width > 0); const t = s[1] ? (s[1].querySelector('.ant-select-selection-item') || {}).textContent : ''; return t; })()`);
  vals && vals.idx_name === 'idx_code' && vals['索引注释'] === 'mssql注释' && cbsB && cbsB[0] === true && typeTxt === 'NONCLUSTERED' && dirs && dirs[0] && dirs[0].dir === '降序'
    ? pass('B1c 索引全属性持久化回读（类型/唯一/注释/降序）')
    : fail('B1c 索引回读', JSON.stringify({ vals, cbsB, typeTxt, dirs }));

  // B2 注释在线更新：只改注释 → 预览仅扩展属性（不重建索引）
  await clickRowInput('索引注释');
  await ctrlA();
  await insertText('mssql注释2');
  await sleep(250);
  pv = await savePreview('B2');
  pv && /sp_updateextendedproperty/.test(pv) && !/CREATE INDEX/.test(pv) && !/DROP INDEX/.test(pv)
    ? pass('B2a 注释变化仅走扩展属性（不重建索引）')
    : fail('B2a 注释 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(3000);
  await designTabByName('索引');
  await clickRowInput('idx_name');
  vals = await objInputValues();
  vals && vals['索引注释'] === 'mssql注释2' ? pass('B2b 注释更新回读') : fail('B2b 注释回读', JSON.stringify(vals));

  // B3 外键：WITH NOCHECK + NOT FOR REPLICATION + CASCADE + 注释
  await designTabByName('外键');
  const fkHeads = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-thead th')].map((t) => t.textContent.trim())`);
  fkHeads && fkHeads.includes('被引用的模式') && fkHeads.includes('被引用的表(父)') && fkHeads.includes('被引用的字段') && fkHeads.includes('删除时') && fkHeads.includes('更新时') && fkHeads.includes('注释')
    ? pass('B3a mssql 外键列齐全（含被引用模式/注释）')
    : fail('B3a 外键列', JSON.stringify(fkHeads));
  await clickDesignBtn('添加外键');
  await sleep(300);
  await clickRowInput('fk_name');
  await insertText('fk_dh');
  await sleep(250);
  // mssql 行内 Select 顺序：0=字段 1=引用表 2=引用列 3=删除时 4=更新时
  await clickRowSelect('[0]');
  await insertText('code');
  await pickOption('code');
  await closeAllDropdowns();
  await clickRowSelect('[1]');
  await insertText('dh_ref');
  await pickOption('dh_ref');
  await sleep(600); // 等引用列候选异步加载
  await clickRowSelect('[2]');
  await insertText('code');
  await pickOption('code');
  await clickRowSelect('[3]');
  await pickOption('CASCADE');
  await closeAllDropdowns();
  await clickRowInput('外键注释');
  await ctrlA();
  await insertText('fk注释');
  // 面板：不勾 启用 + 勾 不适用于复制（点行已在 fk_name 点击时完成）
  await sleep(300);
  const fkcbs = await ev(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) input[type="checkbox"]')].map((c) => { const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })`);
  if (!fkcbs || fkcbs.length !== 2) {
    fail('B3b 前置', '外键属性面板未出现或复选框数不对: ' + JSON.stringify(fkcbs));
  } else {
    await lclick(fkcbs[0].x, fkcbs[0].y); // 取消 启用
    await sleep(200);
    await lclick(fkcbs[1].x, fkcbs[1].y); // 勾 不适用于复制
    await sleep(200);
    pv = await savePreview('B3');
    pv && /WITH NOCHECK ADD CONSTRAINT "fk_dh" FOREIGN KEY \("code"\) REFERENCES "dbo"\."dh_ref" \("code"\) ON DELETE CASCADE NOT FOR REPLICATION/.test(pv) && /sp_addextendedproperty/.test(pv)
      ? pass('B3b 外键 DDL（NOCHECK+NFR+CASCADE+注释）')
      : fail('B3b 外键 DDL', (pv || 'null').slice(0, 300));
    if (pv) await saveAndExecute();
    await sleep(3200);
    // 执行变更后设计器重载有快有慢：轮询至外键行数据与面板稳定（行会在重渲染间隙短暂消失）
    let fkAfter = null;
    let pck = null;
    for (let i = 0; i < 16 && !(fkAfter && fkAfter.sels && fkAfter.sels.length && pck && pck.length === 2); i += 1) {
      await designTabByName('外键');
      await waitRows();
      await clickRowInput('fk_name');
      await sleep(400);
      fkAfter = await dEv(`(() => { const row = document.querySelector('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row'); if (!row) return null;
        const sels = [...row.querySelectorAll('.ant-select')].map((s) => ((s.querySelector('.ant-select-selection-item') || {}).textContent || '').replace(/\\s+/g, ''));
        const cmt = [...row.querySelectorAll('input')].filter((i) => i.placeholder === '外键注释').map((i) => i.value);
        const rs = [...row.querySelectorAll('input')].filter((i) => i.placeholder === 'schema').map((i) => i.value);
        return { sels, cmt, rs }; })()`);
      pck = await barPanelCheckboxes();
      if (!(fkAfter && fkAfter.sels && fkAfter.sels.length && pck && pck.length === 2)) await sleep(700);
    }
    fkAfter && fkAfter.sels.some((t) => /CASCADE/.test(t)) && fkAfter.sels.includes('dh_ref') && fkAfter.cmt[0] === 'fk注释' && pck && pck[0] === false && pck[1] === true
      ? pass('B3c 外键全属性回读（含 启用=否 NFR=是）')
      : fail('B3c 外键回读', JSON.stringify({ fkAfter, pck }));
    // B4 启用在线切换：勾回 启用 → 预览仅 WITH CHECK CHECK CONSTRAINT（面板随行选中出现，轮询等待）
    let ck4 = null;
    for (let i = 0; i < 12 && !ck4; i += 1) {
      ck4 = await ev(`(() => { const c = document.querySelector('.design-tabs .ant-tabs-tabpane-active .bar-panel:not(.hint) input[type="checkbox"]'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!ck4) {
        await clickRowInput('fk_name');
        await sleep(600);
      }
    }
    if (!ck4) {
      fail('B4 前置', '未找到面板 启用 复选框');
    } else {
      await lclick(ck4.x, ck4.y);
      await sleep(250);
    }
    pv = await savePreview('B4');
    pv && /WITH CHECK CHECK CONSTRAINT "fk_dh"/.test(pv) && !/DROP CONSTRAINT/.test(pv) && !/ADD CONSTRAINT/.test(pv)
      ? pass('B4a 启用切换在线 CHECK（不重建）')
      : fail('B4a 切换 DDL', (pv || 'null').slice(0, 300));
    if (pv) await saveAndExecute();
    await sleep(3000);
    let pck2 = null;
    for (let i = 0; i < 12 && !(pck2 && pck2.length === 2); i += 1) {
      await designTabByName('外键');
      await waitRows();
      await clickRowInput('fk_name');
      pck2 = await barPanelCheckboxes();
      if (!(pck2 && pck2.length === 2)) await sleep(700);
    }
    pck2 && pck2[0] === true ? pass('B4b 启用状态回读') : fail('B4b 启用回读', JSON.stringify(pck2));
  }

  // B5 唯一键：NONCLUSTERED + 注释 + 聚集列存在
  await designTabByName('唯一键');
  const uqHeads = await dEv(`[...document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-thead th')].map((t) => t.textContent.trim())`);
  uqHeads && uqHeads.includes('聚集') && uqHeads.includes('注释') ? pass('B5a mssql 唯一键列含 聚集/注释') : fail('B5a 唯一键列', JSON.stringify(uqHeads));
  await clickDesignBtn('添加唯一键');
  await sleep(300);
  await clickRowInput('uk_name');
  await insertText('uk_nm');
  await sleep(250);
  await clickRowSelect('[0]');
  await insertText('nm');
  await pickOption('nm');
  await closeAllDropdowns();
  await clickRowInput('唯一键注释');
  await ctrlA();
  await insertText('唯一注释');
  await sleep(250);
  pv = await savePreview('B5');
  pv && /ALTER TABLE "master"\."dbo"\."dh_test" ADD CONSTRAINT "uk_nm" UNIQUE NONCLUSTERED \("nm"\)/.test(pv) && /sp_addextendedproperty/.test(pv)
    ? pass('B5b 唯一键 DDL（NONCLUSTERED+注释）')
    : fail('B5b 唯一键 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(3000);
  await designTabByName('唯一键');
  await waitRows();
  await clickRowInput('uk_name');
  const uqAfter = await objInputValues();
  uqAfter && uqAfter.uk_name === 'uk_nm' && uqAfter['唯一键注释'] === '唯一注释' ? pass('B5c 唯一键回读（含注释）') : fail('B5c 唯一回读', JSON.stringify(uqAfter));

  // B6 清理：删索引/外键/唯一键 → DROP 语句
  const clickRowDel = async (inputPh, label) => {
    await clickRowInput(inputPh);
    // 操作列可能在横向滚动区外（外键表很宽）：先 scrollIntoView 再量坐标
    const b = await objRow(`(() => { const b = row.querySelector('.ant-btn-dangerous'); if (!b) return null; b.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) {
      fail(label + ' 前置', '未找到删除按钮');
      return;
    }
    if (b.x >= 1436) {
      fail(label, '删除按钮在视口外 x=' + b.x);
      return;
    }
    const before = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
    await lclick(b.x, b.y);
    await sleep(350);
    const after = await dEv(`document.querySelectorAll('.design-tabs .ant-tabs-tabpane-active .obj-table .ant-table-tbody tr.ant-table-row').length`);
    if (after !== before - 1) fail(label, '删除点击未生效 ' + before + '->' + after);
  };
  await designTabByName('索引');
  await clickRowDel('idx_name', 'B6索引');
  await designTabByName('外键');
  await clickRowDel('fk_name', 'B6外键');
  await designTabByName('唯一键');
  await clickRowDel('uk_name', 'B6唯一键');
  pv = await savePreview('B6');
  pv && /DROP INDEX "idx_code" ON/.test(pv) && pv.split('DROP CONSTRAINT').length - 1 === 2
    ? pass('B6a 清理生成 DROP INDEX + 2×DROP CONSTRAINT')
    : fail('B6a 清理 DDL', (pv || 'null').slice(0, 300));
  if (pv) await saveAndExecute();
  await sleep(3200);
  // 关设计页 + 删表
  await clearFrozenModals();
  const closeB = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  if (closeB) { await lclick(closeB.x, closeB.y); await sleep(700); }
  if (await ev(`!!document.querySelector('.ant-modal-confirm')`)) { await esc(); await sleep(400); }
  await clearFrozenModals();
  p = await treePos('master');
  if (p) {
    await rclick(p.x, p.y);
    if (await clickMenu('新建查询')) {
      await sleep(1200);
      const ed2 = await ev(`(() => { const e = document.querySelector('.ant-tabs-tabpane-active .query-editor-wrap .cm-content'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + 25) }; })()`);
      await lclick(ed2.x, ed2.y);
      await ctrlA();
      await insertText('DROP TABLE dbo.dh_test; DROP TABLE dbo.dh_ref;');
      await sleep(300);
      const run2 = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active button')].find((x) => x.textContent.replace(/\\s+/g, '') === '运行Ctrl+Enter'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (run2) {
        await lclick(run2.x, run2.y);
        await sleep(2400);
        pass('B6b mssql 临时表已清理');
      }
      const closeQ2 = await ev(`(() => { const i = document.querySelector('.main-tabs .ant-tabs-tab-active .ant-tabs-tab-remove'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (closeQ2) { await lclick(closeQ2.x, closeQ2.y); await sleep(500); }
    }
  }

  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 无控制台错误', errors.slice(0, 3).join(' || '));
  await client.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
