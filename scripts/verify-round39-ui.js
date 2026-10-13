'use strict';
// v0927.52 标签页拖拽排序 — UI 端到端验证（9227 新实例；无需夹具，employees 基线表即可）
//  U0 备标签：连接右键「新建查询」×2 + 双击 employees 开数据页 → [查询1, 查询2, employees]
//  T1 拖 查询1 → 投放 employees：源取目标位（目标及后续右移）→ [查询2, 查询1, employees]，激活不变
//  T2 拖 employees（尾）→ 投放 查询2（头）：→ [employees, 查询2, 查询1]，激活不变
//  T3 固定 查询1 → [查询1(p), employees, 查询2]；拖 查询2 → 投放 查询1：非固定不得插入固定组，钳制到固定组后
//      → [查询1, 查询2, employees]（固定仍居首）
//  T4 拖 固定 查询1 → 投放 查询2（非固定区）：固定不得出组，钳制回固定组首 → 顺序不变
//  T5 激活 查询2 输入置脏 → 拖 employees → 投放 查询2：→ [查询1, employees, 查询2]，脏点随行、激活不被抢
//  T6 自我投放 no-op；dragstart→dragend（取消）后裸 drop 不触发换位
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
  const pass = (n) => console.log('PASS', n);
  const fail = (n, d) => { console.log('FAIL', n, d || ''); process.exitCode = 1; };

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
  const tabList = async () => ev(`(() => [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].filter((t) => t.querySelector('[data-tab-key]')).map((t) => { const s = t.querySelector('[data-tab-key]'); return { title: s.textContent.replace(/\\s+/g, ''), dirty: !!t.querySelector('.tab-dot'), pinned: s.getAttribute('data-tab-pin') === '1', drag: s.getAttribute('draggable') === 'true' }; }))()`);
  const tabPos = async (title) => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => { const s = x.querySelector('[data-tab-key]'); return s && s.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)}); }); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + Math.min(r.width - 8, 36)), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const activeTab = async () => ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active'); const s = t && t.querySelector('[data-tab-key]'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const menuItem = async (label) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: it.className.includes('ant-menu-item-disabled') }; })()`);
  const clickItem = async (label) => { const it = await menuItem(label); if (!it || it.disabled) return false; await lclick(it.x, it.y); return true; };
  const newQueryAt = async (connP) => { await rclick(connP.x, connP.y); return clickItem('新建查询'); };

  // ---- 合成 HTML5 拖拽：dragstart → dragover → drop → dragend（React 合成事件走根委托，普通 Event 即可触发） ----
  const tabKeyOf = async (title) => ev(`(() => { const s = [...document.querySelectorAll('.main-tabs [data-tab-key]')].find((x) => x.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)})); return s ? s.getAttribute('data-tab-key') : null; })()`);
  const fire = async (key, type) => ev(`(() => { const s = document.querySelector('[data-tab-key="' + ${JSON.stringify(key)} + '"]'); if (!s) return false; s.dispatchEvent(new Event('${type}', { bubbles: true, cancelable: true })); return true; })()`);
  const drag = async (srcTitle, dstTitle) => {
    const sk = await tabKeyOf(srcTitle);
    const dk = await tabKeyOf(dstTitle);
    if (!sk || !dk) return null;
    await fire(sk, 'dragstart');
    await fire(dk, 'dragover');
    await fire(dk, 'drop');
    await fire(sk, 'dragend');
    await sleep(400);
    return true;
  };

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 备标签：2 个查询页 + 1 个数据页，页签可拖拽 ----
  const connP = await waitTree('演示 SQLite 库', 0);
  if (!connP) { fail('U0', '找不到连接节点'); await client.close(); return; }
  for (let i = 0; i < 2; i += 1) {
    if (!(await newQueryAt(connP))) { fail('U0', '点不到 新建查询 #' + (i + 1)); await client.close(); return; }
    await sleep(500);
  }
  if (!(await ensureOpen('演示 SQLite 库', 0)) || !(await ensureOpen('表', 0))) { fail('U0', '连接/表分类未展开'); await client.close(); return; }
  const empP = await waitTree('employees', 0);
  if (!empP) { fail('U0', '找不到 employees'); await client.close(); return; }
  await dblAt(empP);
  await sleep(600);
  {
    const ts = await tabList();
    const act = await activeTab();
    const allDrag = ts.every((t) => t.drag);
    ts.length === 3 && ts.map((t) => t.title).join(',') === '查询1,查询2,employees' && act === 'employees' && allDrag
      ? pass('U0 备标签 3 个（2 查询 + 数据），页签均带 draggable')
      : fail('U0', JSON.stringify({ ts, act, allDrag }));
  }

  // ---- T1 拖 查询1 → employees：源取目标位 ----
  {
    const r = await drag('查询1', 'employees');
    if (r !== true) fail('T1', '找不到拖拽源/目标');
    else {
      const ts = await tabList();
      const act = await activeTab();
      ts.map((t) => t.title).join(',') === '查询2,查询1,employees' && act === 'employees'
        ? pass('T1 拖前→后：查询1 落 employees 位，目标右移，激活不变')
        : fail('T1 结果', JSON.stringify({ ts, act }));
    }
  }

  // ---- T2 拖尾 employees → 头 查询2 ----
  {
    const r = await drag('employees', '查询2');
    if (r !== true) fail('T2', '找不到拖拽源/目标');
    else {
      const ts = await tabList();
      const act = await activeTab();
      ts.map((t) => t.title).join(',') === 'employees,查询2,查询1' && act === 'employees'
        ? pass('T2 拖尾→头：employees 落 查询2 位，激活不变')
        : fail('T2 结果', JSON.stringify({ ts, act }));
    }
  }

  // ---- T3 非固定不得插入固定组：先固定 查询1，再把 查询2 投到它上面 ----
  {
    const p = await tabPos('查询1');
    if (!p) fail('T3', '找不到标签 查询1');
    else {
      await rclick(p.x, p.y);
      if (!(await clickItem('固定标签页'))) fail('T3', '点不到 固定标签页');
      else {
        await sleep(400);
        let ts = await tabList();
        if (ts.map((t) => t.title).join(',') !== '查询1,employees,查询2') fail('T3 固定后', JSON.stringify(ts));
        else {
          const r = await drag('查询2', '查询1');
          if (r !== true) fail('T3', '找不到拖拽源/目标');
          else {
            ts = await tabList();
            const act = await activeTab();
            ts.map((t) => t.title).join(',') === '查询1,查询2,employees' && ts[0].pinned
              ? pass('T3 非固定投放固定组 → 钳制到固定组后，固定仍居首')
              : fail('T3 结果', JSON.stringify({ ts, act }));
          }
        }
      }
    }
  }

  // ---- T4 固定不得出组：拖 固定 查询1 → 投放非固定区 查询2 ----
  {
    const r = await drag('查询1', '查询2');
    if (r !== true) fail('T4', '找不到拖拽源/目标');
    else {
      const ts = await tabList();
      const act = await activeTab();
      ts.map((t) => t.title).join(',') === '查询1,查询2,employees' && ts[0].pinned && act === 'employees'
        ? pass('T4 固定投放非固定区 → 钳制回固定组首，顺序不变')
        : fail('T4 结果', JSON.stringify({ ts, act }));
    }
  }

  // ---- T5 脏点随行 + 激活不被抢：激活 查询2 置脏，拖 employees → 查询2 ----
  {
    const q = await tabPos('查询2');
    if (!q) fail('T5', '找不到标签 查询2');
    else {
      await lclick(q.x, q.y);
      const focused = await ev(`(() => { const cm = document.querySelector('.ant-tabs-tabpane-active .cm-editor .cm-content'); if (!cm) return false; cm.focus(); return document.activeElement === cm; })()`);
      if (!focused) fail('T5', '编辑器未聚焦');
      else {
        await Input.insertText({ text: 'SELECT 1' });
        await sleep(700);
        let ts = await tabList();
        const dirtyTab = ts.find((t) => t.title === '查询2');
        if (!dirtyTab || !dirtyTab.dirty) fail('T5', '输入后未见脏点 ' + JSON.stringify(ts));
        else {
          const r = await drag('employees', '查询2');
          if (r !== true) fail('T5', '找不到拖拽源/目标');
          else {
            ts = await tabList();
            const act = await activeTab();
            const d2 = ts.find((t) => t.title === '查询2');
            ts.map((t) => t.title).join(',') === '查询1,employees,查询2' && d2 && d2.dirty && act === '查询2'
              ? pass('T5 换位后脏点随行、激活保持 查询2')
              : fail('T5 结果', JSON.stringify({ ts, act }));
          }
        }
      }
    }
  }

  // ---- T6 自我投放 no-op + 取消拖拽后裸 drop 不换位 ----
  {
    const ek = await tabKeyOf('employees');
    const qk = await tabKeyOf('查询2');
    if (!ek || !qk) fail('T6', '找不到标签键');
    else {
      await fire(ek, 'dragstart');
      await fire(ek, 'dragover');
      await fire(ek, 'drop');
      await fire(ek, 'dragend');
      await sleep(300);
      const half = await tabList();
      const noSelf = half.map((t) => t.title).join(',') === '查询1,employees,查询2';
      // dragstart → dragend（模拟取消）后 ref 已清；随后的裸 drop 不得换位
      await fire(ek, 'dragstart');
      await fire(ek, 'dragend');
      await fire(qk, 'dragover');
      await fire(qk, 'drop');
      await sleep(300);
      const fin = await tabList();
      const act = await activeTab();
      noSelf && fin.map((t) => t.title).join(',') === '查询1,employees,查询2'
        ? pass('T6 自我投放与取消后裸 drop 均 no-op')
        : fail('T6 结果', JSON.stringify({ noSelf, fin, act }));
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
