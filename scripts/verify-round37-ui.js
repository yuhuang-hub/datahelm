'use strict';
// v0927.53 重命名标签页 — UI 端到端验证（9227 新实例；无需夹具，employees 基线表即可）
//  U0 备标签：连接右键「新建查询」×2 + 双击 employees 开数据页 → [查询1, 查询2, employees]
//  T1 右键 employees → 菜单含 重命名（清单精确）；点开弹窗预填 employees → 改名 员工表 → 标题变、激活不变、数据网格仍在
//  T2 右键 员工表 → 重命名 → 清空输入回车 → 警告「标签名不能为空」+ 弹窗不关 + 标题不变；再输入 员工表A → 成功
//  T3 右键 查询1 → 重命名 → 输入后点「取消」→ 弹窗关闭、标题保持 查询1
//  T4 固定 员工表A + 查询2 置脏 → 重命名 查询2 → 草稿查询：脏点保留、固定态保留、编辑器内容不丢（改名不重挂面板）
//  T5 右键已固定 员工表A → 重命名 → 核心表：改名成功、仍置顶带图钉、不抢激活
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
  const enter = async () => kPress({ key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  const del = async () => kPress({ key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
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
  // 外层标签页：过滤幽灵 tab
  const tabList = async () => ev(`(() => [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].filter((t) => t.querySelector('[data-tab-key]')).map((t) => { const s = t.querySelector('[data-tab-key]'); return { title: s.textContent.replace(/\\s+/g, ''), dirty: !!t.querySelector('.tab-dot'), pinned: s.getAttribute('data-tab-pin') === '1', pinIcon: !!t.querySelector('.tab-pin'), remove: !!t.querySelector('.ant-tabs-tab-remove') }; }))()`);
  const tabPos = async (title) => ev(`(() => { const t = [...document.querySelectorAll('.main-tabs .ant-tabs-tab')].find((x) => { const s = x.querySelector('[data-tab-key]'); return s && s.textContent.replace(/\\s+/g, '').startsWith(${JSON.stringify(title)}); }); if (!t) return null; const r = t.getBoundingClientRect(); return r.width > 0 ? { x: Math.round(r.x + Math.min(r.width - 8, 36)), y: Math.round(r.y + r.height / 2) } : null; })()`);
  const activeTab = async () => ev(`(() => { const t = document.querySelector('.main-tabs .ant-tabs-tab-active'); const s = t && t.querySelector('[data-tab-key]'); return s ? s.textContent.replace(/\\s+/g, '') : ''; })()`);
  const menuItem = async (label) => ev(`(() => { const it = [...document.querySelectorAll('.ctx-menu .ant-menu-item')].find((i) => i.textContent.replace(/\\s+/g, '') === ${JSON.stringify(label)}); if (!it) return null; const r = it.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), disabled: it.className.includes('ant-menu-item-disabled') }; })()`);
  const clickItem = async (label) => { const it = await menuItem(label); if (!it || it.disabled) return false; await lclick(it.x, it.y); return true; };
  const menuLabels = async () => ev(`[...document.querySelectorAll('.ctx-menu .ant-menu-item')].map((i) => i.textContent.replace(/\\s+/g, ''))`);
  const newQueryAt = async (connP) => { await rclick(connP.x, connP.y); return clickItem('新建查询'); };
  // 重命名弹窗（普通 Modal，非 confirm）
  const renameModal = async () => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('重命名标签页')); if (!w) return null; return { title: (w.querySelector('.ant-modal-title') || {}).textContent || '' }; })()`);
  const renameInput = async () => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('重命名标签页')); if (!w) return null; const i = w.querySelector('input.ant-input'); if (!i) return null; const r = i.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
  const renameValue = async () => ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('重命名标签页')); if (!w) return null; const i = w.querySelector('input.ant-input'); return i ? i.value : null; })()`);
  const hasWarn = async () => ev(`(() => { const n = [...document.querySelectorAll('.ant-message-notice')].filter((x) => x.textContent.includes('不能为空')); return n.length > 0; })()`);
  const gridRows = async () => ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.dh-grid')); if (!p) return -1; return [...p.querySelectorAll('.dh-grid .ant-table-row')].filter((r) => r.querySelectorAll('.cell').length > 0).length; })()`);
  const editorText = async () => ev(`(() => { const p = [...document.querySelectorAll('.ant-tabs-tabpane-active')].find((x) => x.querySelector('.query-editor-wrap')); if (!p) return ''; return [...p.querySelectorAll('.cm-content .cm-line')].map((l) => l.textContent).join(' '); })()`);
  // 走 重命名 菜单 → 弹窗打开（返回输入框坐标）
  const openRename = async (title) => {
    const p = await tabPos(title);
    if (!p) return null;
    await rclick(p.x, p.y);
    if (!(await clickItem('重命名'))) return null;
    await sleep(500);
    return renameInput();
  };

  // ---- 等主窗揭示 + S0 版本 ----
  let ok = false;
  for (let i = 0; i < 40 && !ok; i += 1) { ok = await ev("!!document.querySelector('.top-toolbar .tb-btn')"); if (!ok) await sleep(500); }
  const ver = await ev("(() => { const s = document.querySelector('.statusbar'); return s ? s.textContent : ''; })()");
  /v0927.53/.test(ver) ? pass('S0 版本 v0927.53') : fail('S0 版本', String(ver).slice(0, 120));

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

  // ---- T1 重命名数据页签：弹窗预填 + 改名生效 + 数据面板不受影响 ----
  {
    const p = await tabPos('employees');
    if (!p) fail('T1', '找不到标签 employees');
    else {
      await rclick(p.x, p.y);
      const labels = await menuLabels();
      if (labels.join(',') !== '固定标签页,重命名,恢复关闭的标签页,关闭,关闭其他,关闭右侧,关闭全部') fail('T1', '菜单清单不符 ' + JSON.stringify(labels));
      else if (!(await clickItem('重命名'))) fail('T1', '点不到 重命名');
      else {
        await sleep(500);
        const pre = await renameValue();
        if (pre !== 'employees') fail('T1 预填', '输入框应预填 employees，实际 ' + JSON.stringify(pre));
        else {
          const ip = await renameInput();
          await lclick(ip.x, ip.y);
          await ctrlA();
          await Input.insertText({ text: '员工表' });
          await enter();
          await sleep(600);
          const ts = await tabList();
          const act = await activeTab();
          const rows = await gridRows();
          ts.map((t) => t.title).join(',') === '查询1,查询2,员工表' && act === '员工表' && rows >= 4
            ? pass('T1 重命名生效：标题/激活不变/数据网格 4 行仍在')
            : fail('T1 结果', JSON.stringify({ ts, act, rows }));
        }
      }
    }
  }

  // ---- T2 空名拦截：警告 + 弹窗不关 + 标题不变；再输入合法名成功 ----
  {
    const ip = await openRename('员工表');
    if (!ip) fail('T2', '重命名弹窗未打开');
    else {
      await lclick(ip.x, ip.y);
      await ctrlA();
      await del();
      await enter();
      await sleep(600);
      const still = await renameModal();
      const warn = await hasWarn();
      let ts = await tabList();
      if (!still || !warn || ts.map((t) => t.title).join(',') !== '查询1,查询2,员工表') {
        fail('T2 空名', JSON.stringify({ still, warn, ts }));
      } else {
        await Input.insertText({ text: '员工表A' });
        await enter();
        await sleep(600);
        ts = await tabList();
        !(await renameModal()) && ts.map((t) => t.title).join(',') === '查询1,查询2,员工表A'
          ? pass('T2 空名拦截（警告+不关窗+标题不变），再输入成功')
          : fail('T2 结果', JSON.stringify(ts));
      }
    }
  }

  // ---- T3 取消：弹窗关闭、标题保持 ----
  {
    const ip = await openRename('查询1');
    if (!ip) fail('T3', '重命名弹窗未打开');
    else {
      await lclick(ip.x, ip.y);
      await ctrlA();
      await Input.insertText({ text: '临时名' });
      const btn = await ev(`(() => { const w = [...document.querySelectorAll('.ant-modal-wrap')].find((x) => getComputedStyle(x).display !== 'none' && x.textContent.includes('重命名标签页')); if (!w) return null; const b = [...w.querySelectorAll('.ant-modal-footer .ant-btn')].find((x) => x.textContent.replace(/\\s+/g, '') === '取消'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
      if (!btn) fail('T3', '取消按钮未找到');
      else {
        await lclick(btn.x, btn.y);
        await sleep(600);
        const ts = await tabList();
        !(await renameModal()) && ts.map((t) => t.title).join(',') === '查询1,查询2,员工表A'
          ? pass('T3 取消 → 弹窗关闭、标题保持')
          : fail('T3 结果', JSON.stringify(ts));
      }
    }
  }

  // ---- T4 脏点/固定态保留 + 编辑器内容不丢（改名不重挂面板） ----
  {
    const ep = await tabPos('员工表A');
    await rclick(ep.x, ep.y);
    if (!(await clickItem('固定标签页'))) fail('T4', '点不到 固定标签页');
    else {
      await sleep(400);
      const q2 = await tabPos('查询2');
      if (!q2) fail('T4', '找不到标签 查询2');
      else {
        await lclick(q2.x, q2.y);
        const focused = await ev(`(() => { const cm = document.querySelector('.ant-tabs-tabpane-active .cm-editor .cm-content'); if (!cm) return false; cm.focus(); return document.activeElement === cm; })()`);
        if (!focused) fail('T4', '编辑器未聚焦');
        else {
          await Input.insertText({ text: 'SELECT 1' });
          await sleep(700);
          const ip = await openRename('查询2');
          if (!ip) fail('T4', '重命名弹窗未打开');
          else {
            await lclick(ip.x, ip.y);
            await ctrlA();
            await Input.insertText({ text: '草稿查询' });
            await enter();
            await sleep(600);
            const ts = await tabList();
            const act = await activeTab();
            const edt = await editorText();
            const draft = ts.find((t) => t.title === '草稿查询');
            ts.map((t) => t.title).join(',') === '员工表A,查询1,草稿查询' && draft && draft.dirty && ts[0].pinned && ts[0].pinIcon && act === '草稿查询' && /SELECT 1/.test(edt)
              ? pass('T4 改名保留脏点/固定态/编辑器内容，激活不变')
              : fail('T4 结果', JSON.stringify({ ts, act, edt }));
          }
        }
      }
    }
  }

  // ---- T5 重命名已固定页签：成功 + 仍置顶带图钉 + 不抢激活 ----
  {
    const ip = await openRename('员工表A');
    if (!ip) fail('T5', '重命名弹窗未打开');
    else {
      await lclick(ip.x, ip.y);
      await ctrlA();
      await Input.insertText({ text: '核心表' });
      await enter();
      await sleep(600);
      const ts = await tabList();
      const act = await activeTab();
      ts.map((t) => t.title).join(',') === '核心表,查询1,草稿查询' && ts[0].pinned && ts[0].pinIcon && act === '草稿查询'
        ? pass('T5 重命名固定页签 → 核心表，仍置顶带图钉，不抢激活')
        : fail('T5 结果', JSON.stringify({ ts, act }));
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
