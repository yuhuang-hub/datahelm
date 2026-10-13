'use strict';
// v0927.52 恢复关闭的标签页 — UI 端到端验证（9227 新实例；无需夹具，employees 基线表即可）
//  U0 备标签：连接右键「新建查询」×2 + 双击 employees 开数据页 → [查询1, 查询2, employees]
//  T1 右键 查询1：菜单含 恢复关闭的标签页（清单精确）且空栈时禁用
//  T2 单关 → 恢复：关 查询1 → [查询2, employees]；菜单 恢复关闭的标签页 → 追加到末尾 [查询2, employees, 查询1]，激活=查询1
//  T3 查询代码随行：输入 → 保存为「统计A」→ 再编辑置脏 → 关闭（放弃并关闭）→ 恢复：编辑器内容在 + 脏点在（对保存基线计脏）
//  T4 Ctrl+Shift+T：关 查询2 → 快捷键恢复到末尾并激活；空栈再按无效且无错误
//  T5 LIFO：连关两个 → 恢复先回后关的，再回先关的
//  T6 批量关闭入栈：从 employees 关闭其他（q2/q1 入栈）→ 恢复出后关的 查询1
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
  const kPress = async (o) => {
    await Input.dispatchKeyEvent(Object.assign({ type: 'rawKeyDown' }, o));
    await Input.dispatchKeyEvent(Object.assign({ type: 'keyUp' }, o));
  };
  const ctrlA = async () => kPress({ modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
  const ctrlShiftT = async () => kPress({ modifiers: 10, key: 'T', code: 'KeyT', windowsVirtualKeyCode: 84 });
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
  const tabList = async () => ev(`(() => [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].filter((t) => t.querySelector('[data-tab-key]')).map((t) => { const s = t.querySelector('[data-tab-key]'); return { title: s.textContent.replace(/\\s+/g, ''), dirty: !!t.querySelector('.tab-dot'), pinned: s.getAttribute('data-tab-pin') === '1' }; }))()`);
  const tabPos = async (title) => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => { const s = x.querySelector('[data-tab-key]'); return s && s.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)}); }); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + Math.min(r.width - 8, 36)), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const activeTab = async () => ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active'); const s = t && t.querySelector('[data-tab-key]'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const menuItem = async (label) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: it.className.includes('ant-menu-item-disabled') }; })()`);
  // 右键菜单项渲染有竞速：带重试查找 + 点击（点空菜单时重查）
  const clickItem = async (label, tries = 8) => {
    for (let i = 0; i < tries; i += 1) {
      const it = await menuItem(label);
      if (it && !it.disabled) { await lclick(it.x, it.y); return true; }
      await sleep(350);
    }
    return false;
  };
  const menuLabels = async () => ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);
  const newQueryAt = async (connP) => { await rclick(connP.x, connP.y); return clickItem('新建查询'); };
  const editorText = async () => ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.query-editor-wrap')); if (!p) return ''; return [...p.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join(' '); })()`);
  const focusEditor = async () => ev(`(() => { const cm = document.querySelector('.ant-tabs-tabpane-active .cm-editor .cm-content'); if (!cm) return false; cm.focus(); return document.activeElement === cm; })()`);
  const neutralClick = async () => { const p = await ev(`(() => { const e = document.querySelector('.statusbar'); const r = e.getBoundingClientRect(); return { x: Math.round(r.x + 200), y: Math.round(r.y + r.height / 2) }; })()`); await lclick(p.x, p.y); };
  // 确认弹窗「放弃并关闭」
  const confirmAbandon = async () => {
    for (let i = 0; i < 10; i += 1) {
      const b = await ev(`(() => { const x = [...document.querySelectorAll('.ant-modal-confirm-btns .ant-btn')].find((y) => y.textContent.includes('放弃并关闭')); if (!x) return null; const r = x.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (b) { await lclick(b.x, b.y); return true; }
      await sleep(300);
    }
    return false;
  };
  const closeViaMenu = async (title) => { const p = await tabPos(title); if (!p) return false; await rclick(p.x, p.y); return clickItem('关闭'); };
  const reopenViaMenu = async (fromTitle) => { const p = await tabPos(fromTitle); if (!p) return false; await rclick(p.x, p.y); return clickItem('恢复关闭的标签页'); };

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927\.52/.test(ver) ? pass('S0 版本 v0927.52') : fail('S0 版本', String(ver).slice(0, 120));

  // ---- U0 备标签 ----
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
    ts.length === 3 && ts.map((t) => t.title).join(',') === '查询1,查询2,employees'
      ? pass('U0 备标签 3 个（2 查询 + 数据）')
      : fail('U0', JSON.stringify(ts));
  }

  // ---- T1 菜单清单 + 空栈禁用 ----
  {
    const p = await tabPos('查询1');
    if (!p) fail('T1', '找不到标签 查询1');
    else {
      await rclick(p.x, p.y);
      const labels = await menuLabels();
      const rp = await menuItem('恢复关闭的标签页');
      if (labels.join(',') !== '固定标签页,重命名,恢复关闭的标签页,关闭,关闭其他,关闭右侧,关闭全部') fail('T1', '菜单清单不符 ' + JSON.stringify(labels));
      else if (!rp || !rp.disabled) fail('T1', '空栈应禁用 ' + JSON.stringify(rp));
      else {
        await neutralClick();
        await sleep(300);
        pass('T1 菜单含 恢复关闭的标签页（清单精确）且空栈禁用');
      }
    }
  }

  // ---- T2 单关 → 菜单恢复：追加到末尾并激活 ----
  {
    if (!(await closeViaMenu('查询1'))) fail('T2', '点不到 关闭');
    else {
      await sleep(500);
      let ts = await tabList();
      const midOk = ts.map((t) => t.title).join(',') === '查询2,employees';
      if (!midOk) fail('T2 关闭', JSON.stringify(ts));
      else if (!(await reopenViaMenu('查询2'))) fail('T2', '点不到 恢复关闭的标签页');
      else {
        await sleep(600);
        ts = await tabList();
        const act = await activeTab();
        ts.map((t) => t.title).join(',') === '查询2,employees,查询1' && act === '查询1'
          ? pass('T2 关闭 查询1 → 恢复 → 追加到末尾并激活')
          : fail('T2 结果', JSON.stringify({ ts, act }));
      }
    }
  }

  // ---- T3 查询代码随行：保存 → 编辑置脏 → 关闭 → 恢复（内容 + 脏点都在） ----
  {
    const q1 = await tabPos('查询1');
    await lclick(q1.x, q1.y);
    await sleep(300);
    if (!(await focusEditor())) fail('T3', '编辑器未聚焦');
    else {
      await ctrlA();
      await Input.insertText({ text: 'SELECT 100' });
      await sleep(500);
      // 保存为 统计A
      const sv = await ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.query-editor-wrap')); if (!p) return null; const b = [...p.querySelectorAll('.tab-toolbar .ant-btn')].find((y) => y.textContent.replace(/\\s+/g, '') === '保存查询'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!sv) fail('T3', '保存查询按钮未找到');
      else {
        await lclick(sv.x, sv.y);
        await sleep(600);
        const ip = await ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('保存查询')); if (!w) return null; const i = w.querySelector('input.ant-input'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        if (!ip) fail('T3', '保存弹窗未打开');
        else {
          await lclick(ip.x, ip.y);
          await ctrlA();
          await Input.insertText({ text: '统计A' });
          const okBtn = await ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('保存查询')); if (!w) return null; const b = [...w.querySelectorAll('.ant-modal-footer .ant-btn')].find((y) => y.textContent.replace(/\\s+/g, '') === '保存'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
          await lclick(okBtn.x, okBtn.y);
          await sleep(1200);
          await neutralClick(); // 等 toast 消失并清焦点
          await sleep(1500);
          // 再编辑置脏
          if (!(await focusEditor())) fail('T3', '编辑器未聚焦（保存后）');
          else {
            await ctrlA();
            await Input.insertText({ text: 'SELECT 100 UNION SELECT 200' });
            await sleep(700);
            let ts = await tabList();
            const q1d = ts.find((t) => t.title === '查询1');
            if (!q1d || !q1d.dirty) fail('T3', '编辑后未见脏点 ' + JSON.stringify(ts));
            else if (!(await closeViaMenu('查询1'))) fail('T3', '点不到 关闭（脏）');
            else if (!(await confirmAbandon())) fail('T3', '放弃并关闭 未出现');
            else {
              await sleep(600);
              ts = await tabList();
              if (ts.map((t) => t.title).join(',') !== '查询2,employees') fail('T3 关闭', JSON.stringify(ts));
              else if (!(await reopenViaMenu('查询2'))) fail('T3', '点不到 恢复关闭的标签页');
              else {
                await sleep(700);
                ts = await tabList();
                const act = await activeTab();
                const edt = await editorText();
                const r1 = ts.find((t) => t.title === '查询1');
                ts.map((t) => t.title).join(',') === '查询2,employees,查询1' && act === '查询1' && r1 && r1.dirty && /UNION/.test(edt)
                  ? pass('T3 恢复回灌编辑器（含未保存编辑）且对保存基线计脏')
                  : fail('T3 结果', JSON.stringify({ ts, act, edt }));
              }
            }
          }
        }
      }
    }
  }

  // ---- T4 Ctrl+Shift+T ----
  {
    if (!(await closeViaMenu('查询2'))) fail('T4', '点不到 关闭');
    else {
      await sleep(500);
      await neutralClick();
      await sleep(200);
      await ctrlShiftT();
      await sleep(700);
      let ts = await tabList();
      const act = await activeTab();
      const midOk = ts.map((t) => t.title).join(',') === 'employees,查询1,查询2' && act === '查询2';
      if (!midOk) fail('T4 快捷键恢复', JSON.stringify({ ts, act }));
      else {
        await ctrlShiftT(); // 空栈再按：无变化无错误
        await sleep(600);
        ts = await tabList();
        ts.map((t) => t.title).join(',') === 'employees,查询1,查询2'
          ? pass('T4 Ctrl+Shift+T 恢复到末尾并激活；空栈再按无效')
          : fail('T4 空栈', JSON.stringify(ts));
      }
    }
  }

  // ---- T5 LIFO：后关的先回 ----
  {
    if (!(await closeViaMenu('查询1'))) fail('T5', '关 查询1 失败');
    else if (!(await confirmAbandon())) fail('T5', '查询1 脏确认未出现');
    else if (!(await closeViaMenu('查询2'))) fail('T5', '关 查询2 失败');
    else {
      await sleep(500);
      if (!(await reopenViaMenu('employees'))) fail('T5', '点不到 恢复关闭的标签页 #1');
      else {
        await sleep(600);
        let ts = await tabList();
        if (ts.map((t) => t.title).join(',') !== 'employees,查询2') fail('T5 第一次恢复', JSON.stringify(ts));
        else if (!(await reopenViaMenu('employees'))) fail('T5', '点不到 恢复关闭的标签页 #2');
        else {
          await sleep(600);
          ts = await tabList();
          const act = await activeTab();
          ts.map((t) => t.title).join(',') === 'employees,查询2,查询1' && act === '查询1'
            ? pass('T5 LIFO：后关的 查询2 先回，再回 查询1')
            : fail('T5 结果', JSON.stringify({ ts, act }));
        }
      }
    }
  }

  // ---- T6 批量关闭入栈：关闭其他（q2/q1）→ 恢复出后关的 查询1 ----
  {
    const ep = await tabPos('employees');
    await rclick(ep.x, ep.y);
    if (!(await clickItem('关闭其他'))) fail('T6', '点不到 关闭其他');
    else if (!(await confirmAbandon())) fail('T6', '批量关闭脏确认未出现');
    else {
      await sleep(600);
      let ts = await tabList();
      if (ts.map((t) => t.title).join(',') !== 'employees') fail('T6 关闭其他', JSON.stringify(ts));
      else if (!(await reopenViaMenu('employees'))) fail('T6', '点不到 恢复关闭的标签页');
      else {
        await sleep(600);
        ts = await tabList();
        const act = await activeTab();
        ts.map((t) => t.title).join(',') === 'employees,查询1' && act === '查询1'
          ? pass('T6 批量关闭入栈，LIFO 恢复出后关的 查询1')
          : fail('T6 结果', JSON.stringify({ ts, act }));
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
