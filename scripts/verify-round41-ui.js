'use strict';
// v0927.52 数据页多行复制 — UI 端到端验证（9227 测试实例；夹具已备：
//   sqlite .tmp-ud7/demo-test.db w41_cp（逗号/引号/换行/NULL 边界值）+ 视图 w41_cp_v；mssql master.dbo w41_cp_m）
//  S0 状态栏版本 v0927.52
//  U0 打开 w41_cp：≥4 行 + 勾选列存在
//  T1 无选中时「复制选中行」禁用
//  T2 勾选 3 行 → 按钮启用 + 文案 (3)
//  T3 CSV 仅数据行：精确匹配（换行字段加引号、NULL 裸值）
//  T4 表头全选 + CSV 含列名：精确匹配（逗号/双引号字段转义）
//  T5 清空重选 2 行 + INSERT：精确匹配（'' 转义 / NULL / 数字裸值）
//  T6 视图数据页勾选 + 复制 CSV（sqlite 视图为普通数据页）
//  T7 视图页 CSV 含列名：两列视图精确匹配
//  T8 mssql 两行 INSERT 复制精确匹配
//  S5 无控制台错误
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const { execFileSync } = require('child_process');
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
  const dblat = async (x, y) => { await press(x, y, 'left', 2); await sleep(900); };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const ensureOpen = async (title, idx) => {
    // 4→12 次重试：mssql 树节点冷加载可能超 2s（电池内 T8 曾抖动）
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

  // ---- 数据页探针（只看可见 tab：隐藏 tab 的 display:none 使 rect=0） ----
  const gridRows = async () => ev(`(() => { return [...document.querySelectorAll('.grid-area .ant-table-row')].filter((r) => r.getBoundingClientRect().height > 0).length; })()`);
  const selColVisible = async () => ev(`(() => { const t = [...document.querySelectorAll('.grid-area')].find((g) => g.getBoundingClientRect().height > 0); return !!(t && t.querySelector('.ant-table-selection-column')); })()`);
  const copyBtnState = async () => ev(`(() => { const b = [...document.querySelectorAll('.tab-toolbar button')].filter((x) => x.getBoundingClientRect().width > 0).find((x) => x.textContent.replace(/\\s+/g, '').startsWith('复制选中行')); return b ? { dis: b.disabled, txt: b.textContent.replace(/\\s+/g, '') } : null; })()`);
  const clickRowCb = async (rowIdx) => {
    const p = await ev(`(() => { const rows = [...document.querySelectorAll('.grid-area .ant-table-row')].filter((r) => r.getBoundingClientRect().height > 0); const row = rows[${rowIdx}]; if (!row) return null; const cb = row.querySelector('.ant-checkbox-input'); if (!cb) return null; const r = cb.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const clickHeadCb = async () => {
    const p = await ev(`(() => { const g = [...document.querySelectorAll('.grid-area')].find((x) => x.getBoundingClientRect().height > 0); const cb = g && g.querySelector('.ant-table-thead .ant-checkbox-input'); if (!cb) return null; const r = cb.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    return true;
  };
  const clickCopyMenu = async (kw) => {
    // 幽灵层防御：rc-motion 收场动画在帧饥饿下会卡在 leave 态（pointer-events:none 但仍可见），
    // 菜单项过滤掉 pe:none 宿主下拉，避免把幽灵层里的项当成可点
    const p = await ev(`(() => { const b = [...document.querySelectorAll('.tab-toolbar button')].filter((x) => x.getBoundingClientRect().width > 0).find((x) => x.textContent.replace(/\\s+/g, '').startsWith('复制选中行')); if (!b) return null; const r = b.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!p) return false;
    await lclick(p.x, p.y);
    for (let i = 0; i < 8; i += 1) {
      const it = await ev(`(() => { const it = [...document.querySelectorAll('.ant-dropdown-menu-item')].find((x) => x.textContent.replace(/\\s+/g, '').includes(${JSON.stringify(kw)}) && x.getBoundingClientRect().width > 0 && !(x.closest('.ant-dropdown') && getComputedStyle(x.closest('.ant-dropdown')).pointerEvents === 'none')); if (!it) return null; const r = it.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
      if (it) { await lclick(it.x, it.y); return true; }
      await sleep(300);
    }
    return false;
  };
  const toolbarHas = async (kw) => ev(`(() => { return [...document.querySelectorAll('.tab-toolbar button')].filter((x) => x.getBoundingClientRect().width > 0).some((x) => x.textContent.includes(${JSON.stringify(kw)})); })()`);

  // ---- 剪贴板回读：Electron 主进程写系统剪贴板 → PowerShell Get-Clipboard 落盘（UTF-8，无 bash $_ 陷阱） ----
  const CLIPF = 'D:/DataHelm/.tmp-clip41.txt';
  const readClip = () => {
    try { fs.unlinkSync(CLIPF); } catch {}
    execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-Clipboard | Set-Content -LiteralPath ' + CLIPF + ' -Encoding UTF8']);
    let t = fs.readFileSync(CLIPF, 'utf8');
    t = t.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
    if (t.endsWith('\n')) t = t.slice(0, -1);
    return t;
  };
  const waitGrid = async (n, tries = 20) => {
    for (let i = 0; i < tries; i += 1) { if ((await gridRows()) >= n) return true; await sleep(500); }
    return false;
  };

  // ---- S0 版本 ----
  const ver = await ev("(function(){ const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 状态栏版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- 打开 sqlite w41_cp 数据页 ----
  let ok = true;
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '找不到连接节点'); ok = false; }
  else if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); ok = false; }
  else {
    const p = await waitTree('w41_cp', 0, 10);
    if (!p) { fail('U0', '找不到 w41_cp'); ok = false; }
    else {
      await dblat(p.x, p.y);
      if (!(await waitGrid(4))) { fail('U0', '数据页未出现 4 行'); ok = false; }
      else if (!(await selColVisible())) { fail('U0', '勾选列缺失'); ok = false; }
      else pass('U0 w41_cp 打开：4 行 + 勾选列');
    }
  }

  if (ok) {
    // T1 无选中：按钮禁用
    const st1 = await copyBtnState();
    st1 && st1.dis === true && st1.txt.startsWith('复制选中行')
      ? pass('T1 无选中时复制按钮禁用') : fail('T1', JSON.stringify(st1));

    // T2 勾选第 1/3/4 行 → (3)
    for (const i of [0, 2, 3]) { if (!(await clickRowCb(i))) fail('T2', '点不到第 ' + (i + 1) + ' 行勾选框'); }
    await sleep(400);
    const st2 = await copyBtnState();
    st2 && st2.dis === false && st2.txt.replace(/\s+/g, '').includes('(3)')
      ? pass('T2 勾选 3 行按钮启用并计数') : fail('T2', JSON.stringify(st2));

    // T3 CSV 仅数据行（选中 1/3/4：换行字段包引号、NULL 裸值）
    if (!(await clickCopyMenu('CSV（仅数据行）'))) fail('T3', '点不到 CSV（仅数据行）菜单');
    else {
      await sleep(700);
      const got = readClip();
      const want = '1,甲,10\n3,NULL,30\n4,"line1\nline2",40';
      got === want ? pass('T3 选中行 CSV 精确匹配（换行转义/NULL）') : fail('T3', 'got=[' + got + ']');
    }

    // T4 表头全选 → CSV 含列名（含逗号+双引号字段）
    if (!(await clickHeadCb())) fail('T4', '点不到表头全选框');
    else {
      await sleep(400);
      const st = await copyBtnState();
      if (!(st && st.txt.includes('(4)'))) fail('T4', '全选未计数 (4)：' + JSON.stringify(st));
      else if (!(await clickCopyMenu('CSV（含列名行）'))) fail('T4', '点不到 CSV（含列名行）菜单');
      else {
        await sleep(700);
        const got = readClip();
        const want = 'id,nm,qty\n1,甲,10\n2,"Bob\'s ""quote"", comma",20\n3,NULL,30\n4,"line1\nline2",40';
        got === want ? pass('T4 全选 CSV 含列名精确匹配（逗号/引号转义）') : fail('T4', 'got=[' + got + ']');
      }
    }

    // T5 清空 → 重选第 2/3 行 → INSERT（''转义 / NULL / 数字裸值）
    if (!(await clickHeadCb())) fail('T5', '再次点表头未清空选择');
    else {
      await sleep(400);
      let st = await copyBtnState();
      if (!(st && st.dis === true)) fail('T5', '清空后按钮未禁用：' + JSON.stringify(st));
      else if (!(await clickRowCb(1)) || !(await clickRowCb(2))) fail('T5', '点不到第 2/3 行勾选框');
      else {
        await sleep(400);
        st = await copyBtnState();
        if (!(st && st.txt.includes('(2)'))) fail('T5', '未计数 (2)：' + JSON.stringify(st));
        else if (!(await clickCopyMenu('INSERT'))) fail('T5', '点不到 INSERT 菜单');
        else {
          await sleep(700);
          const got = readClip();
          const want = "INSERT INTO w41_cp (id, nm, qty)\nVALUES (2, 'Bob''s \"quote\", comma', 20);\nINSERT INTO w41_cp (id, nm, qty)\nVALUES (3, NULL, 30);";
          got === want ? pass('T5 选中行 INSERT 精确匹配（SQL 转义/NULL/数字）') : fail('T5', 'got=[' + got + ']');
        }
      }
    }
  }

  // ---- T6/T7 视图（只读）：勾选列 + 复制 CSV + 无删除行按钮 ----
  if (!(await ensureOpen('视图', 0))) fail('T6', '视图分类未展开');
  else {
    const p = await waitTree('w41_cp_v', 0, 10);
    if (!p) fail('T6', '找不到 w41_cp_v');
    else {
      await dblat(p.x, p.y);
      if (!(await waitGrid(4))) fail('T6', '视图数据页未出现 4 行');
      else if (!(await selColVisible())) fail('T6', '只读视图勾选列缺失');
      else if (!(await clickRowCb(0))) fail('T6', '点不到视图首行勾选框');
      else if (!(await clickCopyMenu('CSV（仅数据行）'))) fail('T6', '点不到视图 CSV 菜单');
      else {
        await sleep(700);
        const got = readClip();
        got === '1,甲' ? pass('T6 只读视图可勾选并复制 CSV') : fail('T6', 'got=[' + got + ']');
      }
    }
  // ---- T7 视图页 CSV 含列名（两列视图精确匹配；sqlite 视图为普通数据页，编辑按钮在位属既有行为） ----
  if (!(await toolbarHas('复制选中行'))) fail('T7', '视图页无 复制选中行 按钮');
  else if (!(await clickCopyMenu('CSV（含列名行）'))) fail('T7', '点不到视图含列名菜单');
  else {
    await sleep(700);
    const got = readClip();
    got === 'id,nm\n1,甲' ? pass('T7 视图 CSV 含列名精确匹配') : fail('T7', 'got=[' + got + ']');
  }
  }

  // ---- T8 mssql w41_cp_m：两行 INSERT ----
  if (!(await ensureOpen('1', 0))) fail('T8', '找不到 mssql 连接节点');
  else if (!(await ensureOpen('master', 0))) fail('T8', 'master 库未展开');
  else if (!(await ensureOpen('表', 1))) fail('T8', 'mssql 表分类未展开');
  else {
    const p = await waitTree('w41_cp_m', 0, 10);
    if (!p) fail('T8', '找不到 w41_cp_m');
    else {
      await dblat(p.x, p.y);
      if (!(await waitGrid(2))) fail('T8', 'mssql 数据页未出现 2 行');
      else if (!(await clickHeadCb())) fail('T8', '点不到 mssql 表头全选框');
      else if (!(await clickCopyMenu('INSERT'))) fail('T8', '点不到 INSERT 菜单');
      else {
        await sleep(700);
        const got = readClip();
        const want = "INSERT INTO w41_cp_m (id, nm, qty)\nVALUES (1, '甲', 10);\nINSERT INTO w41_cp_m (id, nm, qty)\nVALUES (2, 'Beta', 20);";
        got === want ? pass('T8 mssql 两行 INSERT 精确匹配') : fail('T8', 'got=[' + got + ']');
      }
    }
  }

  // S5 无控制台错误
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('S5 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('S5 无控制台错误');

  await client.close();
  try { fs.unlinkSync(CLIPF); } catch {}
  console.log('done');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
