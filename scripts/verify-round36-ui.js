'use strict';
// v0927.53 固定标签页 — UI 端到端验证（9227 新实例；无需夹具，employees 基线表即可）
//  U0 备标签：连接右键「新建查询」×2 + 双击 employees 开数据页 → [查询1, 查询2, employees]
//  T1 右键 employees → 固定标签页 → 置顶排序 [employees(p), 查询1, 查询2]，图钉标记在、X 消失、激活键不变
//  T2 右键已固定 employees → 菜单首项=取消固定、关闭禁用；右键查询2 → 关闭全部 → 仅剩 employees（固定受保护）
//  T3 新建查询×2 → [employees(p), 查询3, 查询4]；右键查询3 → 关闭右侧 → [employees(p), 查询3]；中键点 employees 不误关
//  T4 右键 employees → 取消固定 → 图钉消失、X 回来、移到末尾 [查询3, employees]
//  T5 新建查询4 置脏 + 固定 employees → 右键查询3 → 关闭全部 → 确认「2 个标签中有 1 个未保存」→ 仅剩 employees
//  T6 固定后菜单外点击关闭菜单，标签与固定态不受影响
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
  const mclick = async (p) => { await press(p.x, p.y, 'middle', 1); await sleep(500); };
  const dblAt = async (p) => { await press(p.x, p.y, 'left', 1); await sleep(90); await press(p.x, p.y, 'left', 2); await sleep(900); };
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
  // 外层标签页：过滤幽灵 tab；pinned 读 data-tab-pin；remove=关闭 X 是否渲染
  const tabList = async () => ev(`(() => [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].filter((t) => t.querySelector('[data-tab-key]')).map((t) => { const s = t.querySelector('[data-tab-key]'); return { title: s.textContent.replace(/\\s+/g, ''), dirty: !!t.querySelector('.tab-dot'), pinned: s.getAttribute('data-tab-pin') === '1', pinIcon: !!t.querySelector('.tab-pin'), remove: !!t.querySelector('.ant-tabs-tab-remove') }; }))()`);
  const tabPos = async (title) => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => { const s = x.querySelector('[data-tab-key]'); return s && s.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)}); }); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + Math.min(r.width - 8, 36)), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const activeTab = async () => ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active'); const s = t && t.querySelector('[data-tab-key]'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const menuOpen = async () => ev(`!!document.querySelector('.ctx-menu')`);
  const menuItem = async (label) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: it.className.includes('ant-menu-item-disabled') }; })()`);
  const clickItem = async (label) => { const it = await menuItem(label); if (!it || it.disabled) return false; await lclick(it.x, it.y); return true; };
  const menuLabels = async () => ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);
  const newQueryAt = async (connP) => { await rclick(connP.x, connP.y); return clickItem('新建查询'); };

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 备标签：2 个查询页 + 1 个数据页 ----
  const connP = await waitTree('演示 SQLite 库', 0);
  if (!connP) { fail('U0', '找不到连接节点'); await client.close(); return; }
  for (let i = 0; i < 2; i += 1) {
    if (!(await newQueryAt(connP))) { fail('U0', '点不到 新建查询 #' + (i + 1)); await client.close(); return; }
    await sleep(500);
  }
  if (!(await ensureOpen('演示 SQLite 库', 0))) { fail('U0', '连接未展开'); await client.close(); return; }
  if (!(await ensureOpen('表', 0))) { fail('U0', '表分类未展开'); await client.close(); return; }
  const empP = await waitTree('employees', 0);
  if (!empP) { fail('U0', '找不到 employees'); await client.close(); return; }
  await dblAt(empP);
  await sleep(600);
  {
    const ts = await tabList();
    const act = await activeTab();
    ts.length === 3 && ts.map((t) => t.title).join(',') === '查询1,查询2,employees' && act === 'employees'
      ? pass('U0 备标签 3 个（2 查询 + 数据），活动=employees')
      : fail('U0', JSON.stringify({ ts, act }));
  }

  // ---- T1 固定 employees：置顶 + 图钉 + 无 X + 激活不变 ----
  {
    const p = await tabPos('employees');
    if (!p) fail('T1', '找不到标签 employees');
    else {
      await rclick(p.x, p.y);
      const labels = await menuLabels();
      if (!labels.includes('固定标签页')) fail('T1', '菜单无 固定标签页 ' + JSON.stringify(labels));
      else if (!(await clickItem('固定标签页'))) fail('T1', '点不到 固定标签页');
      else {
        await sleep(500);
        const ts = await tabList();
        const act = await activeTab();
        const emp = ts[0];
        ts.map((t) => t.title).join(',') === 'employees,查询1,查询2' && emp && emp.pinned && emp.pinIcon && !emp.remove && act === 'employees'
          ? pass('T1 固定 → 置顶排序+图钉在+X 消失+激活不变')
          : fail('T1 结果', JSON.stringify({ ts, act }));
      }
    }
  }

  // ---- T2 已固定：取消固定项 + 关闭禁用；关闭全部保护固定页签 ----
  {
    const p = await tabPos('employees');
    await rclick(p.x, p.y);
    const labels = await menuLabels();
    const close = await menuItem('关闭');
    if (!labels.includes('取消固定')) fail('T2', '菜单无 取消固定 ' + JSON.stringify(labels));
    else if (!close || !close.disabled) fail('T2', '固定页签的 关闭 应禁用 ' + JSON.stringify(close));
    else {
      await lclick(300, 500); // 关菜单
      await sleep(300);
      const q2 = await tabPos('查询2');
      if (!q2) fail('T2', '找不到标签 查询2');
      else {
        await rclick(q2.x, q2.y);
        if (!(await clickItem('关闭全部'))) fail('T2', '点不到 关闭全部');
        else {
          await sleep(500);
          const ts = await tabList();
          const act = await activeTab();
          ts.length === 1 && ts[0].title === 'employees' && ts[0].pinned && act === 'employees'
            ? pass('T2 固定受保护：关闭全部后仅剩 employees')
            : fail('T2 结果', JSON.stringify({ ts, act }));
        }
      }
    }
  }

  // ---- T3 新查询追加在固定之后；关闭右侧不动固定；中键不误关固定 ----
  {
    const c2 = await waitTree('演示 SQLite 库', 0);
    for (let i = 0; i < 2; i += 1) {
      if (!(await newQueryAt(c2))) { fail('T3', '点不到 新建查询 #' + (i + 1)); break; }
      await sleep(500);
    }
    let ts = await tabList();
    if (!(ts.length === 3 && ts.map((t) => t.title).join(',') === 'employees,查询3,查询4' && ts[0].pinned)) {
      fail('T3', '新查询应追加在固定之后 ' + JSON.stringify(ts));
    } else {
      const p = await tabPos('查询3');
      if (!p) fail('T3', '找不到标签 查询3');
      else {
        await rclick(p.x, p.y);
        if (!(await clickItem('关闭右侧'))) fail('T3', '点不到 关闭右侧');
        else {
          await sleep(500);
          ts = await tabList();
          const midOk0 = ts.length === 2 && ts.map((t) => t.title).join(',') === 'employees,查询3';
          if (!midOk0) fail('T3 关闭右侧', JSON.stringify(ts));
          else {
            const ep = await tabPos('employees');
            await mclick(ep);
            const ts2 = await tabList();
            ts2.length === 2 && ts2[0].title === 'employees' && ts2[0].pinned
              ? pass('T3 追加序/关闭右侧/中键保护固定页签')
              : fail('T3 中键', JSON.stringify(ts2));
          }
        }
      }
    }
  }

  // ---- T4 取消固定：图钉消失 + X 回来 + 位次不变（稳定分区） ----
  {
    const p = await tabPos('employees');
    if (!p) fail('T4', '找不到标签 employees');
    else {
      await rclick(p.x, p.y);
      if (!(await clickItem('取消固定'))) fail('T4', '点不到 取消固定');
      else {
        await sleep(500);
        const ts = await tabList();
        const act = await activeTab();
        const emp = ts.find((t) => t.title === 'employees');
        // 激活键不因取消固定而变（T3 建新查询后活动页是 查询3，取消固定 employees 不抢激活）
        ts.map((t) => t.title).join(',') === 'employees,查询3' && emp && !emp.pinned && !emp.pinIcon && emp.remove && act === '查询3'
          ? pass('T4 取消固定 → 位次不变+图钉消失+X 回来+不抢激活')
          : fail('T4 结果', JSON.stringify({ ts, act }));
      }
    }
  }

  // ---- T5 脏标签 + 固定保护：关闭全部确认只数非固定 ----
  {
    const c3 = await waitTree('演示 SQLite 库', 0);
    if (!(await newQueryAt(c3))) fail('T5', '点不到 新建查询');
    else {
      await sleep(500);
      // 激活新查询页并输入 SQL 置脏（T3 已建 查询3/查询4，本页序号是 5）
      const q = await tabPos('查询5');
      if (!q) fail('T5', '找不到标签 查询4');
      else {
        await lclick(q.x, q.y);
        const focused = await ev(`(() => { const cm = document.querySelector('.ant-tabs-tabpane-active .cm-editor .cm-content'); if (!cm) return false; cm.focus(); return document.activeElement === cm; })()`);
        if (!focused) fail('T5', '编辑器未聚焦');
        else {
          await Input.insertText({ text: 'SELECT 1' });
          await sleep(700);
          let ts = await tabList();
          const dirtyTab = ts.find((t) => t.title === '查询5');
          if (!dirtyTab || !dirtyTab.dirty) fail('T5', '输入后未见脏点 ' + JSON.stringify(ts));
          else {
            // 固定 employees，随后从 查询3 发起 关闭全部：可关 = 查询3 + 查询4(脏)，employees 受保护
            const ep = await tabPos('employees');
            await rclick(ep.x, ep.y);
            if (!(await clickItem('固定标签页'))) fail('T5', '点不到 固定标签页');
            else {
              await sleep(400);
              const q3 = await tabPos('查询3');
              await rclick(q3.x, q3.y);
              if (!(await clickItem('关闭全部'))) fail('T5', '点不到 关闭全部');
              else {
                await sleep(500);
                const mt = await ev(`(() => { const m = document.querySelector('.ant-modal-confirm-title'); return m ? m.textContent : ''; })()`);
                if (!/2 个标签中有 1 个未保存/.test(mt)) fail('T5', '确认弹窗文案 ' + JSON.stringify(mt));
                else {
                  const okBtn = await ev(`(() => { const b = [...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((x) => x.textContent.includes('放弃并关闭')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
                  if (!okBtn) fail('T5', '确认按钮未找到');
                  else {
                    await lclick(okBtn.x, okBtn.y);
                    await sleep(600);
                    ts = await tabList();
                    const act = await activeTab();
                    ts.length === 1 && ts[0].title === 'employees' && ts[0].pinned && act === 'employees'
                      ? pass('T5 脏确认只数非固定（2 中 1）→ 仅剩固定 employees')
                      : fail('T5 结果', JSON.stringify({ ts, act }));
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  // ---- T6 菜单外点击关闭菜单：固定态不受影响 ----
  {
    const p = await tabPos('employees');
    if (!p) fail('T6', '找不到标签 employees');
    else {
      await rclick(p.x, p.y);
      if (!(await menuOpen())) fail('T6', '菜单未弹出');
      else {
        const sp = await ev(`(() => { const e = document.querySelector('.statusbar'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 80), y: Math.round(r.y + r.height / 2) }; })()`);
        await lclick(sp.x, sp.y);
        await sleep(400);
        const gone = !(await menuOpen());
        const ts = await tabList();
        gone && ts.length === 1 && ts[0].pinned ? pass('T6 菜单外点击关闭菜单，固定态不变') : fail('T6', JSON.stringify({ gone, ts }));
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
