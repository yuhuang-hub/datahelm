'use strict';
// v0927.52 字段明细行「编辑字段」定位 — UI 端到端验证（9227 测试实例；夹具已备：
//   sqlite .tmp-ud7/demo-test.db w34_col（id/nm/qty/uk + w34_ix）；mssql master.dbo w34_col_m（id/nm/mgr/qty））
//  U1 sqlite：字段明细行双击 → 设计页签打开 · 内部「字段」页签激活 · 该行高亮(row-focus=字段名)
//  U1b 手动切到「索引」后再次双击另一字段 → 重新跳回「字段」并高亮（重复定位）
//  U2 sqlite：字段右键「编辑字段」→ 菜单项存在且定位
//  U3 sqlite：主键列（id）双击同样定位
//  U4 mssql：字段右键「编辑字段」→ 设计器字段页签 + 高亮
//  U5 无控制台错误
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
  const lclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'left', 1); await sleep(300); };
  const rclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'right', 1); await sleep(500); };
  // 双击：两次按压（第二次 clickCount=2 触发 dblclick）
  const dblAt = async (p) => { await press(p.x, p.y, 'left', 1); await sleep(90); await press(p.x, p.y, 'left', 2); await sleep(700); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const ensureOpen = async (title, idx = 0) => {
    // 4→12 次重试：mssql 表清单冷加载可能超 2s
    const p = await waitTree(title, idx, 12);
    if (!p) return false;
    const isOpen = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
    if (isOpen) return true;
    const sw = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!sw) return false;
    await lclick(sw.x, sw.y);
    await sleep(1400);
    return true;
  };
  // 字段明细行标题是「名称+类型」连写（node-dt 子 span）：按前缀匹配
  const leafPos = async (name) => {
    const p = await ev(`(() => {
      const rows = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent.startsWith(${JSON.stringify(name)}));
      const r = rows[0];
      if (!r) return null;
      r.scrollIntoView({ block: 'nearest' });
      const b = r.getBoundingClientRect();
      return b.height > 0 ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null;
    })()`);
    return p;
  };
  const clickMenu = async (kw, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)})); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  // 外层激活页签标题（排除设计器内层 design-tabs）
  const outerActive = async () => ev(`(() => { const t = [...document.querySelectorAll('.ant-tabs-tab-active')].filter((x) => !x.closest('.design-tabs'))[0]; return t ? t.textContent.replace(/\\s+/g, '') : ''; })()`);
  // 可见设计器状态：内部激活页签 + row-focus 行（首个文本输入值 = 字段名列；字段表首列是行选择 checkbox 需跳过）
  const designState = async () => ev(`(() => {
    const ps = [...document.querySelectorAll('.ant-tabs-tabpane-active')].filter((x) => x.querySelector && x.querySelector('.design-tabs'));
    const p = ps[0];
    if (!p) return { open: false };
    const t = p.querySelector('.design-tabs .ant-tabs-tab-active');
    const f = p.querySelector('.design-tabs .row-focus');
    const fi = f && [...f.querySelectorAll('input')].find((i) => i.type !== 'checkbox' && i.type !== 'radio');
    return { open: true, sec: t ? t.textContent.replace(/\\s+/g, '') : '', focus: !!f, fv: fi ? fi.value : '' };
  })()`);

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- 展开 sqlite：连接 → 表分类 → w34_col → 字段分组 ----
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '找不到连接节点'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  if (!(await ensureOpen('w34_col', 0))) { fail('U0', '找不到表 w34_col'); await client.close(); return; }
  if (!(await ensureOpen('字段', 0))) { fail('U0', '字段分组未展开'); await client.close(); return; }

  // U1 字段明细行双击 → 设计器字段页定位
  {
    const p = await leafPos('nm');
    if (!p) fail('U1', '找不到 nm 字段明细行');
    else {
      await dblAt(p);
      await sleep(400);
      const oa = await outerActive();
      const st = await designState();
      oa === '设计w34_col' && st.open && st.sec === '字段' && st.focus && st.fv === 'nm'
        ? pass('U1 双击字段明细 → 设计页签 · 字段页签 · 行高亮')
        : fail('U1', JSON.stringify({ oa, st }));
    }
  }

  // U1b 手动切「索引」→ 再双击另一字段 qty → 跳回字段并高亮（重复定位能力）
  {
    const tabP = await ev(`(() => { const t = [...document.querySelectorAll('.design-tabs .ant-tabs-tab')].find((x) => x.textContent.trim() === '索引'); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!tabP) fail('U1b', '索引页签未找到');
    else {
      await lclick(tabP.x, tabP.y);
      await sleep(400);
      let mid = await designState();
      if (!mid.open || mid.sec !== '索引') fail('U1b', '切索引页签失败 ' + JSON.stringify(mid));
      else {
        const p = await leafPos('qty');
        if (!p) fail('U1b', 'qty 字段行丢失');
        else {
          await dblAt(p);
          await sleep(400);
          const st = await designState();
          st.open && st.sec === '字段' && st.focus && st.fv === 'qty'
            ? pass('U1b 再次双击另一字段 → 重新定位字段页签并高亮')
            : fail('U1b', JSON.stringify(st));
        }
      }
    }
  }

  // U2 字段右键「编辑字段」→ 菜单项存在且定位 uk
  {
    const p = await leafPos('uk');
    if (!p) fail('U2', '找不到 uk 字段明细行');
    else {
      await rclick(p.x, p.y);
      if (!(await clickMenu('编辑字段'))) fail('U2', '点不到 编辑字段');
      else {
        await sleep(600);
        const oa = await outerActive();
        const st = await designState();
        oa === '设计w34_col' && st.open && st.sec === '字段' && st.focus && st.fv === 'uk'
          ? pass('U2 右键编辑字段 → 字段页签 + 行高亮')
          : fail('U2', JSON.stringify({ oa, st }));
      }
    }
  }

  // U3 主键列 id 双击同样定位
  {
    const p = await leafPos('id');
    if (!p) fail('U3', '找不到 id 字段明细行');
    else {
      await dblAt(p);
      await sleep(400);
      const st = await designState();
      st.open && st.sec === '字段' && st.focus && st.fv === 'id'
        ? pass('U3 主键列双击 → 字段页签 + 行高亮')
        : fail('U3', JSON.stringify(st));
    }
  }

  // ---- mssql：字段右键编辑（先折叠 sqlite w34_col 避免字段分组重名）----
  {
    const p = await waitTree('w34_col', 0, 3);
    if (p) {
      const isOpen = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w34_col'); const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
      if (isOpen) {
        const sw = await ev(`(() => { const t = [...document.querySelectorAll('.tree-wrap .node-title')].find((x) => x.textContent === 'w34_col'); const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); const r = s && s.getBoundingClientRect(); return r && r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
        if (sw) { await lclick(sw.x, sw.y); await sleep(700); }
      }
    }
  }
  if (!(await ensureOpen('1', 0))) fail('U4', '找不到 mssql 连接节点');
  else if (!(await ensureOpen('master', 0))) fail('U4', 'master 库未展开');
  else if (!(await ensureOpen('表', 1))) fail('U4', 'mssql 表分类未展开');
  else if (!(await ensureOpen('w34_col_m', 0))) fail('U4', '找不到表 w34_col_m');
  else if (!(await ensureOpen('字段', 0))) fail('U4', 'mssql 字段分组未展开');
  else {
    const p = await leafPos('mgr');
    if (!p) fail('U4', '找不到 mgr 字段明细行');
    else {
      await rclick(p.x, p.y);
      if (!(await clickMenu('编辑字段'))) fail('U4', '点不到 编辑字段');
      else {
        await sleep(600);
        const oa = await outerActive();
        const st = await designState();
        oa === '设计w34_col_m' && st.open && st.sec === '字段' && st.focus && st.fv === 'mgr'
          ? pass('U4 mssql 右键编辑字段 → 设计器字段页签 + 行高亮')
          : fail('U4', JSON.stringify({ oa, st }));
      }
    }
  }

  // U5 无控制台错误（页面 error 级）
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('U5 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('U5 无控制台错误');

  await client.close();
  console.log('done');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
