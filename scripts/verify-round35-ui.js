'use strict';
// v0927.53 标签页右键菜单 — UI 端到端验证（9227 新实例；无需夹具，employees 基线表即可）
//  U0 备标签：连接右键「新建查询」×3 + 双击 employees 开数据页 → 4 个标签，活动=employees
//  T1 右键「查询 2」→ 菜单四项齐全 → 关闭右侧 → 剩 [查询1, 查询2]，活动=查询2
//  T2 右键「查询 1」→ 关闭其他 → 剩 [查询1]
//  T3 右键末位标签 → 关闭右侧禁用；ESC 关菜单不误伤 → 「关闭」→ 剩 [查询1, 查询4]，活动=查询4
//  T4 查询页输入 SQL 置脏（tab-dot）→ 关闭全部 → 脏确认弹窗（N 个中有 1 个未保存）→ 放弃并关闭 → 0 标签空态
//  T5 菜单外点击关闭菜单，标签不受影响
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
  const rclick = async (x, y) => { await press(x.x !== undefined ? x.x : x, x.y !== undefined ? x.y : y, 'right', 1); await sleep(500); };
  const dblAt = async (p) => { await press(p.x, p.y, 'left', 1); await sleep(90); await press(p.x, p.y, 'left', 2); await sleep(900); };
  const esc = async () => {
    await Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(300);
  };
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

  const treePos = async (title, idx = 0) => ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; if (!t) return null; t.scrollIntoView({ block: 'nearest' }); const r = t.getBoundingClientRect(); return r.height > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const waitTree = async (title, idx = 0, tries = 16) => {
    for (let i = 0; i < tries; i += 1) { const p = await treePos(title, idx); if (p) return p; await sleep(500); }
    return null;
  };
  const ensureOpen = async (title, idx = 0) => {
    const p = await waitTree(title, idx, 4);
    if (!p) return false;
    const isOpen = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const w = t && t.closest('.ant-tree-node-content-wrapper'); return !!(w && w.className.includes('-open')); })()`);
    if (isOpen) return true;
    const sw = await ev(`(() => { const ts = [...document.querySelectorAll('.tree-wrap .node-title')].filter((x) => x.textContent === ${JSON.stringify(title)}); const t = ts[${idx}]; const row = t && t.closest('.ant-tree-treenode'); const s = row && row.querySelector('.ant-tree-switcher'); if (!s) return null; const r = s.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } : null; })()`);
    if (!sw) return false;
    await lclick(sw.x, sw.y);
    await sleep(1400);
    return true;
  };
  // 外层标签页（main-tabs）：标题列表（含脏点）/ 定位 / 活动标题
  // 注意：antd editable-card 会渲染若干无 [data-tab-key] 的幽灵 tab（加号位/测量位），必须过滤
  const tabList = async () => ev(`(() => [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].filter((t) => t.querySelector('[data-tab-key]')).map((t) => { const s = t.querySelector('[data-tab-key]'); return { title: s.textContent.replace(/\\s+/g, ''), dirty: !!t.querySelector('.tab-dot') }; }))()`);
  const tabPos = async (title) => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => { const s = x.querySelector('[data-tab-key]'); return s && s.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)}); }); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + Math.min(r.width - 8, 36)), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const activeTab = async () => ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active'); const s = t && t.querySelector('[data-tab-key]'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const menuOpen = async () => ev(`!!document.querySelector('.ctx-menu')`);
  // 精确匹配菜单项：返回坐标 + 禁用态
  const menuItem = async (label) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: it.className.includes('ant-menu-item-disabled') }; })()`);
  const clickItem = async (label) => { const it = await menuItem(label); if (!it || it.disabled) return false; await lclick(it.x, it.y); return true; };
  const menuLabels = async () => ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 备标签：3 个查询页 + 1 个数据页 ----
  const connP = await waitTree('演示 SQLite 库', 0);
  if (!connP) { fail('U0', '找不到连接节点'); await client.close(); return; }
  for (let i = 0; i < 3; i += 1) {
    await rclick(connP.x, connP.y);
    if (!(await clickItem('新建查询'))) { fail('U0', '点不到 新建查询 #' + (i + 1)); await client.close(); return; }
    await sleep(500);
  }
  // 右键菜单只建查询页不展开树；「表」分类要先把连接展开
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '连接未展开'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  const empP = await waitTree('employees', 0);
  if (!empP) { fail('U0', '找不到 employees'); await client.close(); return; }
  await dblAt(empP);
  await sleep(600);
  {
    const ts = await tabList();
    const act = await activeTab();
    ts.length === 4 && ts.map((t) => t.title).join(',') === '查询1,查询2,查询3,employees' && act === 'employees'
      ? pass('U0 备标签 4 个（3 查询 + 数据），活动=employees')
      : fail('U0', JSON.stringify({ ts, act }));
  }

  // ---- T1 关闭右侧 ----
  {
    const p = await tabPos('查询2');
    if (!p) fail('T1', '找不到标签 查询2');
    else {
      await rclick(p.x, p.y);
      const open = await menuOpen();
      const labels = await menuLabels();
      const right = await menuItem('关闭右侧');
      if (!open || labels.join(',') !== '固定标签页,重命名,恢复关闭的标签页,关闭,关闭其他,关闭右侧,关闭全部') fail('T1', '菜单项不全 ' + JSON.stringify({ open, labels }));
      else if (!right || right.disabled) fail('T1', '关闭右侧应可用 ' + JSON.stringify(right));
      else if (!(await clickItem('关闭右侧'))) fail('T1', '点不到 关闭右侧');
      else {
        await sleep(500);
        const ts = await tabList();
        const act = await activeTab();
        ts.map((t) => t.title).join(',') === '查询1,查询2' && act === '查询2'
          ? pass('T1 关闭右侧 → 剩查询1/查询2，活动=查询2')
          : fail('T1 结果', JSON.stringify({ ts, act }));
      }
    }
  }

  // ---- T2 关闭其他 ----
  {
    const p = await tabPos('查询1');
    if (!p) fail('T2', '找不到标签 查询1');
    else {
      await rclick(p.x, p.y);
      if (!(await clickItem('关闭其他'))) fail('T2', '点不到 关闭其他');
      else {
        await sleep(500);
        const ts = await tabList();
        const act = await activeTab();
        ts.length === 1 && ts[0].title === '查询1' && act === '查询1'
          ? pass('T2 关闭其他 → 仅剩查询1')
          : fail('T2 结果', JSON.stringify({ ts, act }));
      }
    }
  }

  // ---- T3 末位标签：关闭右侧禁用 + ESC + 「关闭」 ----
  {
    const c2 = await waitTree('演示 SQLite 库', 0);
    for (let i = 0; i < 2; i += 1) {
      await rclick(c2.x, c2.y);
      if (!(await clickItem('新建查询'))) { fail('T3', '点不到 新建查询 #' + (i + 1)); break; }
      await sleep(500);
    }
    const p = await tabPos('查询5');
    if (!p) fail('T3', '找不到标签 查询5');
    else {
      await rclick(p.x, p.y);
      const right = await menuItem('关闭右侧');
      if (!right) fail('T3', '菜单无 关闭右侧');
      else if (!right.disabled) fail('T3', '末位标签 关闭右侧 应禁用');
      else {
        await esc();
        const still = await menuOpen();
        const ts0 = await tabList();
        if (still) fail('T3', 'ESC 未关闭菜单');
        else if (ts0.length !== 3) fail('T3', 'ESC 后标签数变化 ' + JSON.stringify(ts0));
        else {
          await rclick(p.x, p.y);
          if (!(await clickItem('关闭'))) fail('T3', '点不到 关闭');
          else {
            await sleep(500);
            const ts = await tabList();
            const act = await activeTab();
            ts.map((t) => t.title).join(',') === '查询1,查询4' && act === '查询4'
              ? pass('T3 末位禁用+ESC不误伤；关闭 → 剩查询1/查询4，活动=查询4')
              : fail('T3 结果', JSON.stringify({ ts, act }));
          }
        }
      }
    }
  }

  // ---- T4 置脏 + 关闭全部（统一确认） ----
  {
    const focused = await ev(`(() => { const cm = document.querySelector('.ant-tabs-tabpane-active .cm-editor .cm-content'); if (!cm) return false; cm.focus(); return document.activeElement === cm; })()`);
    if (!focused) fail('T4', '编辑器未聚焦');
    else {
      await Input.insertText({ text: 'SELECT 1' });
      await sleep(700);
      let ts = await tabList();
      const dirtyTab = ts.find((t) => t.title === '查询4');
      if (!dirtyTab || !dirtyTab.dirty) fail('T4', '输入后未见脏点 ' + JSON.stringify(ts));
      else {
        const p = await tabPos('查询4');
        if (!p) fail('T4', '找不到标签 查询4');
        else {
          await rclick(p.x, p.y);
          if (!(await clickItem('关闭全部'))) fail('T4', '点不到 关闭全部');
          else {
            await sleep(500);
            const mt = await ev(`(() => { const m = document.querySelector('.ant-modal-confirm-title'); const c = document.querySelector('.ant-modal-confirm-content'); return { title: m ? m.textContent : '', content: c ? c.textContent : '' }; })()`);
            if (!mt.title.includes('未保存') || !/2 个标签中有 1 个未保存/.test(mt.title)) fail('T4', '确认弹窗文案 ' + JSON.stringify(mt));
            else {
              const okBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((x) => x.textContent.includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
              if (!okBtn) fail('T4', '确认按钮未找到');
              else {
                await lclick(okBtn.x, okBtn.y);
                await sleep(600);
                const ts2 = await tabList();
                const empty = await ev(`!!document.querySelector('.empty-pane')`);
                ts2.length === 0 && empty ? pass('T4 脏确认（2 中 1 未保存）→ 全部关闭 → 空态') : fail('T4 结果', JSON.stringify({ ts2, empty }));
              }
            }
          }
        }
      }
    }
  }

  // ---- T5 菜单外点击关闭菜单 ----
  {
    const c3 = await waitTree('演示 SQLite 库', 0);
    await rclick(c3.x, c3.y);
    if (!(await clickItem('新建查询'))) fail('T5', '点不到 新建查询');
    else {
      await sleep(500);
      const p = await tabPos('查询6');
      if (!p) fail('T5', '找不到标签 查询6');
      else {
        await rclick(p.x, p.y);
        if (!(await menuOpen())) fail('T5', '菜单未弹出');
        else {
          const ep = await ev(`(() => { const e = document.querySelector('.empty-pane') || document.querySelector('.main-area'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(r.height - 10, r.height / 2)) }; })()`);
          await lclick(ep.x, ep.y);
          await sleep(400);
          const gone = !(await menuOpen());
          const ts = await tabList();
          gone && ts.length === 1 ? pass('T5 菜单外点击关闭菜单，标签不受影响') : fail('T5', JSON.stringify({ gone, ts }));
        }
      }
    }
  }

  // S5 无控制台错误（页面 error 级）
  await sleep(400);
  const errs = errors.filter((x) => !/favicon|DevTools/.test(x));
  errs.length ? fail('S5 控制台错误', JSON.stringify(errs.slice(0, 3))) : pass('S5 无控制台错误');

  await client.close();
  console.log('done');
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
