'use strict';
// v0927.52 树目录扩展 + 工具栏选择联动 + 模型 验证（9229 新实例，sqlite 演示库 + mssql master）：
//  TB1 初始：表/视图可用（sqlite 兜底上下文），ER 图禁用（未选中表）
//  TB2 选中 mssql master 库节点 → 表/视图可用、ER 仍禁用（选中具体表才开）
//  TB3 选中表节点 dh_ix_t → ER 图可用 → 点击打开「ER 图 · master」
//  TB4 回选 master 库节点 → ER 图再次禁用
//  V1 工具栏「视图」→ 新建视图（可视化设计器）：添加表侧栏含 dh_ix_t
//  C1 sqlite「索引」目录 dh_ix_a + 右键查看源码 = CREATE INDEX
//  C2 sqlite 索引删除 → 目录空（employees 的 PK 自动索引不显示）
//  C3 mssql「索引」目录 dh_ix_a + 查看源码含 CREATE INDEX ... [dbo].[dh_ix_t]
//  M1 sqlite「模型」目录：新建模型 → 节点出现；双击 → 打开「模型 · dh_model_1」ER 页
//  M2 master ER 页「保存为模型」→ mssql 模型目录出现 dh_model_2
//  M3 删除模型 dh_model_2 → 刷新后消失
//  S5 无控制台错误
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
  const rclick = async (x, y) => { await press(x, y, 'right', 1); await sleep(450); };
  const dblclick = async (x, y) => { await press(x, y, 'left', 1); await sleep(80); await press(x, y, 'left', 2); await sleep(1300); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const liveModal = (body) => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => { const m = x.querySelector('.ant-modal'); return m && !/ant-zoom-leave/.test(m.className) && getComputedStyle(x).display !== 'none'; }); if (!w) return null; const host = w; return (${body}); })()`);
  const modalBtn = async (kw) => {
    const b = await liveModal(`(() => { const b = [...host.querySelectorAll('.ant-btn')].find((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}); }); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!b) return false;
    await lclick(b.x, b.y);
    return true;
  };
  const setInputByPlaceholder = (kw, v) => ev(`(() => {
    const i = [...document.querySelectorAll('.ant-modal input')].find((x) => x.placeholder && x.placeholder.includes(${JSON.stringify(kw)}));
    if (!i) return false;
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(i, ${JSON.stringify(v)});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // 树行坐标（occurrence 用于同名分类区分连接：sqlite 在前 idx=0，mssql 在后 idx=1）；先 scrollIntoView 再量坐标
  const treePos = (title, idx = 0) => ev(`(() => {
    const rows = [...document.querySelectorAll('.tree-wrap .ant-tree-treenode')].filter((r) => r.querySelector('.node-title') && r.getBoundingClientRect().height > 0);
    const hits = rows.filter((r) => r.querySelector('.node-title').textContent === ${JSON.stringify(title)});
    const f = hits[${idx}];
    if (!f) return null;
    f.scrollIntoView({ block: 'nearest' });
    const t = f.querySelector('.node-title').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  })()`);
  const waitTree = async (title, idx = 0, tries = 24) => {
    for (let i = 0; i < tries; i += 1) {
      const p = await treePos(title, idx);
      if (p) return p;
      await sleep(500);
    }
    return null;
  };
  const menuItem = async (kw) => {
    const p = await ev(`(() => { const m = document.querySelector('.ctx-menu'); if (!m) return null; const it = [...m.querySelectorAll('.ant-menu-item')].find((x) => x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const confirmBtn = async (kw) => {
    // 不能用 offsetParent 过滤：modal-wrap 是 position:fixed，offsetParent 恒为 null
    const p = await ev(`(() => { const ws = [...document.querySelectorAll('.ant-modal-wrap')].filter((x) => getComputedStyle(x).display !== 'none'); const w = ws[ws.length - 1]; if (!w) return null; const c = w.querySelector('.ant-modal-confirm'); if (!c) return null; const b = [...c.querySelectorAll('.ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const tbState = () => ev(`(() => { const g = (k) => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === k); return b ? !b.disabled : null; }; return { t: g('表'), v: g('视图'), e: g('ER图') }; })()`);
  const topBtn = async (kw) => {
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.top-toolbar .tb-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === ${JSON.stringify(kw)}); if (!b || b.disabled) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const activeTabTitle = () => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.className.includes('ant-tabs-tab-active')); return t ? t.textContent.replace(/\\s+/g, '') : null; })()`);
  const clickTab = async (kw) => {
    const p = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(kw)})); if (!t) return null; const r = t.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const closeTabByTitle = async (kw) => {
    const p = await ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => x.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(kw)})); if (!t) return null; const rm = t.querySelector('.ant-tabs-tab-remove') || t; const r = rm.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    await sleep(600);
    await confirmBtn('放弃并关闭'); // 脏页确认（干净页无弹窗，此调用无操作）
    await sleep(400);
    return true;
  };

  // ---- 等主窗揭示 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) {
    ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')");
    if (!ok) await sleep(500);
  }

  // S0 版本
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // TB1 初始可用态（v0927.52：未打开连接时表/视图/ER 图全禁用）
  const tb1 = await tbState();
  tb1 && tb1.t === false && tb1.v === false && tb1.e === false
    ? pass('TB1 初始（未打开连接）：表/视图/ER 图全部禁用')
    : fail('TB1 初始可用态', JSON.stringify(tb1));

  // ---- TB2 展开 mssql 连接，选中 master 库节点 ----
  let p = await waitTree('1');
  if (!p) fail('TB2 前置', 'mssql 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('master');
    if (!p) fail('TB2 展开 mssql', 'master 行未出现');
    else {
      await lclick(p.x, p.y); // 单击选中（不展开）
      await sleep(500);
      const tb2 = await tbState();
      tb2 && tb2.t === true && tb2.v === true && tb2.e === false
        ? pass('TB2 选中 master 库节点：表/视图可用，ER 仍禁用')
        : fail('TB2 选中库后可用态', JSON.stringify(tb2));
    }
  }

  // ---- TB3 选中表节点 dh_ix_t → ER 可用 → 打开 ER 图 ----
  // 先展开 master（单击只选中不展开），再展开「表」分类
  p = await waitTree('master');
  if (!p) fail('TB3 前置', 'master 行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表');
    if (!p) fail('TB3 展开 master', 'mssql 表分类未找到');
    else {
    await dblclick(p.x, p.y);
    p = await waitTree('dh_ix_t');
    if (!p) fail('TB3 展开表分类', 'dh_ix_t 未出现');
    else {
      await lclick(p.x, p.y); // 选中表节点
      await sleep(500);
      const tb3 = await tbState();
      if (!(tb3 && tb3.e === true)) fail('TB3 选中表后 ER 可用', JSON.stringify(tb3));
      else {
        pass('TB3 选中表节点 dh_ix_t：ER 图变为可用');
        if (await topBtn('ER图')) {
          let title = null;
          for (let i = 0; i < 20 && !title; i += 1) { title = await activeTabTitle(); if (!title) await sleep(400); }
          const canvas = await ev("!!document.querySelector('.ant-tabs-tabpane-active .er-canvas')");
          title && title.startsWith('ER图·master') && canvas
            ? pass('TB3b 工具栏 ER 打开「ER 图 · master」画布')
            : fail('TB3b ER 页', JSON.stringify({ title, canvas }));
        } else fail('TB3b 点击 ER 按钮', '按钮不可用或未找到');
      }
    }
    }
  }

  // ---- TB4 回选 master 库节点 → ER 再禁用 ----
  p = await waitTree('master');
  if (p) {
    await lclick(p.x, p.y);
    await sleep(500);
    const tb4 = await tbState();
    tb4 && tb4.e === false && tb4.t === true
      ? pass('TB4 回选库节点：ER 再次禁用（表/视图仍可用）')
      : fail('TB4 回选库后可用态', JSON.stringify(tb4));
  } else fail('TB4 前置', 'master 行未找到');

  // ---- V1 工具栏「视图」→ 对象列表页（v0927.52 起语义：查看已有清单，非新建；新建入口在页内）----
  if (await topBtn('视图')) {
    let t = null;
    for (let i = 0; i < 20 && !t; i += 1) { t = await activeTabTitle(); if (!t) await sleep(400); }
    let paneOk = false;
    for (let i = 0; i < 16 && !paneOk; i += 1) {
      paneOk = await ev(`(() => { const p = document.querySelector('.ant-tabs-tabpane-active [data-dh-objs]'); if (!p) return false; const it = [...document.querySelectorAll('[data-dh-kind] .ant-segmented-item')].find((x) => x.className.includes('ant-segmented-item-selected')); return !!it && it.textContent.trim() === '视图'; })()`);
      if (!paneOk) await sleep(500);
    }
    t === '视图·master' && paneOk
      ? pass('V1 工具栏视图 → 对象列表页「视图 · master」（新语义）')
      : fail('V1 对象列表页', JSON.stringify({ t, paneOk }));
    await closeTabByTitle('视图·master');
  } else fail('V1 工具栏视图按钮', '不可用或未找到');

  // ---- C1/C2 sqlite 索引目录 ----
  // ---- C0/C1 sqlite：树无「索引」分类；对象列表表行展开（v0927.52：结构随表行查看） ----
  p = await waitTree('演示 SQLite 库');
  if (!p) fail('C1 前置', 'sqlite 连接行未找到');
  else {
    await dblclick(p.x, p.y);
    p = await waitTree('表', 0);
    if (!p) fail('C1 前置', 'sqlite 表分类未找到');
    else {
      const noIdxCat = !(await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].some((x) => x.textContent === '索引')`));
      noIdxCat ? pass('C0 树中「索引」分类已移除（sqlite）') : fail('C0 树索引分类', '仍存在');
      await lclick(p.x, p.y); // 选中表分类 → 工具栏上下文 = sqlite
      if (await topBtn('表')) {
        let det = null;
        for (let i = 0; i < 20 && !det; i += 1) {
          det = await ev(`(() => { const t = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === 'dh_ix_t'; }); if (!t || !t.querySelector('.ant-table-row-expand-icon')) return null; const r = t.querySelector('.ant-table-row-expand-icon').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
          if (!det) await sleep(400);
        }
        if (!det) fail('C1 展开', 'dh_ix_t 行未找到');
        else {
          await lclick(det.x, det.y);
          let groups = null;
          for (let i = 0; i < 20 && !groups; i += 1) {
            groups = await ev(`(() => { const d = document.querySelector('[data-dh-detail="dh_ix_t"]'); if (!d) return null; const gs = [...d.querySelectorAll('.objs-dg')].map((g) => ({ k: g.getAttribute('data-dh-dg'), n: g.querySelectorAll('.objs-dg-item').length })); return gs.length === 6 ? gs : null; })()`);
            if (!groups) await sleep(400);
          }
          const idxItem = await ev(`(() => { const d = document.querySelector('[data-dh-detail="dh_ix_t"] [data-dh-dg="索引"]'); return d ? [...d.querySelectorAll('.objs-dg-item')].map((x) => x.textContent).join(';') : null; })()`);
          const colItem = await ev(`(() => { const d = document.querySelector('[data-dh-detail="dh_ix_t"] [data-dh-dg="字段"]'); return d ? [...d.querySelectorAll('.objs-dg-item')].map((x) => x.textContent).join(';') : null; })()`);
          groups && /dh_ix_a/.test(String(idxItem)) && /id.*主键/.test(String(colItem))
            ? pass('C1 sqlite 表行展开：6 组齐全 + 索引含 dh_ix_a + 字段 id·主键')
            : fail('C1 展开', JSON.stringify({ groups, idxItem, colItem }).slice(0, 240));
        }
      } else fail('C1 工具栏表按钮', '不可用');
    }
  }

  // ---- C2 mssql：树无「索引」分类（master 展开）+ 跟随后展开 dh_ix_t ----
  p = await waitTree('master');
  if (!p) fail('C2 前置', 'master 未找到');
  else {
    const noIdx2 = !(await ev(`[...document.querySelectorAll('.tree-wrap .node-title')].some((x) => x.textContent === '索引')`));
    noIdx2 ? pass('C2 树中「索引」分类已移除（mssql）') : fail('C2 树索引分类', '仍存在');
    await lclick(p.x, p.y); // 对象列表自动跟随 master
    let det = null;
    for (let i = 0; i < 24 && !det; i += 1) {
      det = await ev(`(() => { const c = document.querySelector('[data-dh-objs] .ctx'); if (!c || !c.textContent.includes('master')) return null; const t = [...document.querySelectorAll('[data-dh-objs] tbody tr')].find((x) => { const n = x.querySelector('.objs-name'); return n && n.textContent === 'dh_ix_t'; }); if (!t || !t.querySelector('.ant-table-row-expand-icon')) return null; const r = t.querySelector('.ant-table-row-expand-icon').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!det) await sleep(500);
    }
    if (!det) fail('C2 展开', 'master 列表 dh_ix_t 行未找到');
    else {
      await lclick(det.x, det.y);
      let idxItem = null;
      for (let i = 0; i < 20 && !idxItem; i += 1) {
        idxItem = await ev(`(() => { const d = document.querySelector('[data-dh-detail="dh_ix_t"] [data-dh-dg="索引"]'); return d ? [...d.querySelectorAll('.objs-dg-item')].map((x) => x.textContent).join(';') : null; })()`);
        if (!idxItem) await sleep(400);
      }
      const nGroups = await ev(`document.querySelectorAll('[data-dh-detail="dh_ix_t"] .objs-dg').length`);
      idxItem && /dh_ix_a/.test(String(idxItem)) && nGroups === 6
        ? pass('C2 mssql 表行展开：索引含 dh_ix_a（nm）+ 6 组齐全')
        : fail('C2 展开', JSON.stringify({ idxItem, nGroups }).slice(0, 200));
    }
  }

  // ---- M1 sqlite 模型目录：新建 + 打开 ----
  p = await waitTree('模型', 0);
  if (!p) fail('M1 sqlite 模型目录', '分类未出现');
  else {
    await dblclick(p.x, p.y); // 展开（空）
    const cat = await treePos('模型', 0);
    await rclick(cat.x, cat.y);
    if (await menuItem('新建模型')) {
      await sleep(400);
      await setInputByPlaceholder('模型名', 'dh_model_1');
      await modalBtn('确定');
      const node = await waitTree('dh_model_1', 0, 20);
      if (!node) fail('M1 新建模型', '节点未出现');
      else {
        pass('M1 新建模型 dh_model_1 出现在「模型」目录');
        await dblclick(node.x, node.y);
        let t = null;
        for (let i = 0; i < 20 && !t; i += 1) { t = await activeTabTitle(); if (!t) await sleep(400); }
        const boxN = await ev("document.querySelectorAll('.ant-tabs-tabpane-active [data-dh-er-table]').length");
        t === '模型·dh_model_1' && boxN >= 1
          ? pass('M1b 双击模型 → 「模型 · dh_model_1」ER 画布（' + boxN + ' 表盒子）')
          : fail('M1b 模型 ER 页', JSON.stringify({ t, boxN }));
        await closeTabByTitle('模型·dh_model_1');
      }
    } else fail('M1 新建模型菜单', '未找到');
  }

  // ---- M2 master ER 页「保存为模型」 ----
  if (await clickTab('ER图')) {
    await sleep(400);
    const btn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-tabs-tabpane-active .tab-toolbar .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '保存为模型'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
    if (!btn) fail('M2 保存为模型按钮', '未找到');
    else {
      await lclick(btn.x, btn.y);
      await sleep(400);
      await setInputByPlaceholder('模型名', 'dh_model_2');
      await modalBtn('保存');
      await sleep(600);
      const cat = await waitTree('模型', 1); // mssql 的模型目录
      if (!cat) fail('M2 mssql 模型目录', '未出现');
      else {
        await dblclick(cat.x, cat.y);
        const node = await waitTree('dh_model_2', 0, 16);
        node ? pass('M2 ER 页「保存为模型」→ mssql 模型目录出现 dh_model_2') : fail('M2 模型节点', 'dh_model_2 未出现');

        // M3 删除模型
        const node2 = await treePos('dh_model_2', 0);
        if (node2) {
          await rclick(node2.x, node2.y);
          if (await menuItem('删除模型')) {
            await sleep(300);
            await confirmBtn('确定');
            let gone = false;
            for (let i = 0; i < 16 && !gone; i += 1) { gone = !(await treePos('dh_model_2', 0)); if (!gone) await sleep(500); }
            gone ? pass('M3 删除模型 dh_model_2 后消失') : fail('M3 删除模型', '仍存在');
          } else fail('M3 删除模型菜单', '未找到');
        } else fail('M3 前置', 'dh_model_2 行丢失');
      }
    }
  } else fail('M2 前置', 'ER 图页签未找到');

  // S5 控制台错误
  errors.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errors[0]);
  await client.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
