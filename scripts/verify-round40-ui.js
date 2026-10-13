'use strict';
// v0927.52 对象树过滤 — UI 端到端验证（9227 测试实例；夹具已备：
//   sqlite .tmp-ud7/demo-test.db employees（基线）+ w40_alpha(id/nm40/qty)/w40_beta/w40_gamma + 视图 w40_alpha_v）
//  T1 过滤 w40_：三张 w40 表可见，employees 隐藏，表分类仍在
//  T2 过滤 employ：employees 可见，w40_* 全隐藏
//  T3 大小写不敏感：W40_AL 命中 w40_alpha
//  T4 过滤 w40_alpha：表 + 视图 w40_alpha_v 同时可见（视图分类自动加载+自动展开，无需手动展开）
//  T5 无命中 zzz：无表叶子可见，连接行仍在，不崩溃
//  T6 清空过滤：全部表恢复可见
//  T7 字段级：过滤 nm40 → w40_alpha > 字段 > nm40 可见（祖先链保留+自动展开），employees 隐藏
//  S5 无控制台错误
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
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  // 可见性：按 node-title 文本精确匹配（字段行带类型后缀 → mode=prefix）
  const visExpr = (title, mode) => `(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => ${mode === 'prefix' ? `x.textContent.startsWith(${JSON.stringify(title)})` : `x.textContent === ${JSON.stringify(title)}`}); return ts.some((x) => x.getBoundingClientRect().height > 0); })()`;
  const visible = (title, mode) => ev(visExpr(title, mode));
  const waitVis = async (title, mode, tries = 16, want = true) => {
    for (let i = 0; i < tries; i += 1) {
      const v = await visible(title, mode);
      if (v === want) return true;
      await sleep(450);
    }
    return false;
  };
  const titles = async () => ev(`(() => [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.getBoundingClientRect().height > 0).map((x) => x.textContent.replace(/\\s+/g, '')))()`);

  // 设过滤词：原型 value setter + input 事件（React 受控输入标准驱动法；'' 即清空）
  const setFilter = async (text) => ev(`(() => { const i = document.querySelector('.sidebar-search input'); if (!i) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ${JSON.stringify(text)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const ensureOpen = async (title, idx = 0) => {
    const isOpen = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
    if (isOpen) return true;
    const sw = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!sw) return false;
    await lclick(sw.x, sw.y);
    await sleep(1400);
    return true;
  };

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 连接 + 展开表分类，基线表全部可见 ----
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '连接节点未展开'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  const baseOk = (await waitTree('w40_alpha', 0, 6)) && (await waitTree('employees', 0, 3));
  baseOk ? pass('U0 基线：employees + w40_* 表全部在树') : fail('U0', '基线表缺失');

  // ---- T1 前缀过滤 ----
  await setFilter('w40_');
  (await waitVis('w40_alpha')) && (await waitVis('w40_beta')) && (await waitVis('w40_gamma'))
    ? pass('T1a 过滤 w40_：三张 w40 表可见')
    : fail('T1a', JSON.stringify(await titles()));
  !(await visible('employees')) ? pass('T1b employees 被过滤隐藏') : fail('T1b', 'employees 仍在');
  (await visible('表')) ? pass('T1c 表分类保留') : fail('T1c', '表分类消失');

  // ---- T2 换关键字 ----
  await setFilter('employ');
  (await waitVis('employees')) ? pass('T2a 过滤 employ：employees 可见') : fail('T2a', JSON.stringify(await titles()));
  !(await visible('w40_alpha')) && !(await visible('w40_beta')) ? pass('T2b w40_* 全部隐藏') : fail('T2b', 'w40 表仍可见');

  // ---- T3 大小写不敏感 ----
  await setFilter('W40_AL');
  (await waitVis('w40_alpha')) ? pass('T3 大小写不敏感：W40_AL 命中 w40_alpha') : fail('T3', JSON.stringify(await titles()));

  // ---- T4 表+视图同名前缀：视图分类自动加载并自动展开 ----
  await setFilter('w40_alpha');
  const v4 = (await waitVis('w40_alpha')) && (await waitVis('w40_alpha_v'));
  v4 ? pass('T4 过滤 w40_alpha：表与视图 w40_alpha_v 同时可见（视图分类自动加载+展开）') : fail('T4', JSON.stringify(await titles()));

  // ---- T5 无命中 ----
  await setFilter('zzz_no_such');
  await sleep(900);
  const t5 = await titles();
  const noLeaf = !t5.some((x) => ['w40_alpha', 'w40_beta', 'w40_gamma', 'employees', 'w40_alpha_v'].includes(x));
  noLeaf ? pass('T5a 无命中：无对象叶子可见') : fail('T5a', JSON.stringify(t5));
  (await visible('演示 SQLite 库')) ? pass('T5b 连接行始终保留') : fail('T5b', '连接行消失');

  // ---- T6 清空恢复 ----
  await setFilter('');
  (await waitVis('w40_beta')) && (await waitVis('employees')) ? pass('T6 清空过滤：全部表恢复') : fail('T6', JSON.stringify(await titles()));

  // ---- T7 字段级：命中列保留祖先链并自动展开 ----
  if (!(await ensureOpen('w40_alpha', 0))) fail('T7 前置', 'w40_alpha 未展开');
  else if (!(await ensureOpen('字段', 0))) fail('T7 前置', 'w40_alpha 字段分组未展开');
  else {
    await setFilter('nm40');
    const col = await waitVis('nm40', 'prefix');
    const anc = col && (await visible('w40_alpha')) && (await visible('字段'));
    const hid = !(await visible('employees'));
    anc && hid ? pass('T7 字段级过滤：nm40 命中且祖先链（w40_alpha/字段）保留，employees 隐藏') : fail('T7', JSON.stringify({ col: !!col, anc: !!anc, hid }));
  }
  await setFilter('');

  // S5 控制台错误
  await sleep(600);
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length === 0 ? pass('S5 无控制台错误') : fail('S5 控制台错误', errs.slice(0, 4).join(' | ').slice(0, 300));

  console.log('ROUND40-DONE');
  try { await client.close(); } catch {}
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
